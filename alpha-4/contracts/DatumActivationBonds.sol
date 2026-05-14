// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumActivationBonds.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";
import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";

interface IDatumCampaignsForMute {
    function getCampaignAdvertiser(uint256 campaignId) external view returns (address);
}

/// @title DatumActivationBonds
/// @notice Optimistic-activation collateral. See IDatumActivationBonds.
///
///         Architectural note: routine campaigns no longer require a
///         governance vote to go Active. The advertiser posts a bond at
///         createCampaign, a short timelock runs, and anyone may then
///         activate() the campaign permissionlessly. A challenger who
///         disputes activation posts a counter-bond, escalating the
///         campaign into the GovernanceV2 vote path. Losing-side bond is
///         partially redistributed to the winner; remainder returns to the
///         loser so disputes don't wipe out a defeated party wholesale.
///
///         Cypherpunk lock-once: Campaigns and Lifecycle addresses are
///         set exactly once and frozen. Treasury and governable parameters
///         are owner-mutable (owner is Timelock/Router in the ladder).
contract DatumActivationBonds is IDatumActivationBonds, PaseoSafeSender, DatumOwnable {
    // ── Wiring ────────────────────────────────────────────────────────────────

    /// @notice Campaigns contract — only authority that may call openBond.
    address public campaignsContract;

    /// @notice Treasury recipient for the treasuryBps cut of slashed bond.
    address public treasury;

    // ── Governable parameters ─────────────────────────────────────────────────
    uint256 private _minBond;          // smallest accepted creator bond
    uint64  private _timelockBlocks;   // window during which challenges accepted
    uint16  private _winnerBonusBps;   // bps of loser bond paid as winner bonus
    uint16  private _treasuryBps;      // bps of loser bond paid to treasury

    /// @notice Upper bound on combined winner+treasury bps. Loser always
    ///         retains at least 2000 bps (20%) of their bond on dispute loss
    ///         — prevents governance from configuring a 100% slash that
    ///         removes refund-floor protection (mirrors GovernanceV2 G-M2).
    uint16 public constant MAX_PUNISHMENT_BPS = 8000;

    /// @notice Upper bound on timelock — caps grief window length.
    uint64 public constant MAX_TIMELOCK_BLOCKS = 1_209_600; // ~84 days @ 6s/block

    // ── Per-campaign state ────────────────────────────────────────────────────
    struct State {
        Phase    phase;
        uint64   timelockExpiry;
        address  creator;
        uint128  creatorBond;
        address  challenger;
        uint128  challengerBond;
    }
    mapping(uint256 => State) private _state;

    /// @dev Pull-pattern queue for refunds and bonus payouts. Avoids any
    ///      external call to a hostile contract advertiser from blocking
    ///      settlement (matches DatumChallengeBonds.pendingBondReturn).
    mapping(address => uint256) private _pending;

    // ── Emergency mute state (Phase 2b) ───────────────────────────────────────
    // Independent from the activation challenge state above. A campaign can
    // be muted at most once per Active cycle: a fresh mute requires either no
    // prior mute or a resolved one.
    struct MuteState {
        bool     active;       // true while bond is locked + isMuted=true
        address  muter;
        uint128  bond;
        uint64   openedAt;
    }
    mapping(uint256 => MuteState) private _mute;

    uint256 private _muteMinBond;     // floor; default 10× minBond
    uint64  private _muteMaxBlocks;   // auto-resolve timeout

    // ── Events for parameter changes ──────────────────────────────────────────
    event ContractReferenceChanged(string name, address oldAddr, address newAddr);
    event MinBondSet(uint256 value);
    event TimelockBlocksSet(uint64 value);
    event WinnerBonusBpsSet(uint16 value);
    event TreasuryBpsSet(uint16 value);
    event TreasurySet(address treasury);
    event MuteMinBondSet(uint256 value);
    event MuteMaxBlocksSet(uint64 value);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(
        uint256 minBond_,
        uint64  timelockBlocks_,
        uint16  winnerBonusBps_,
        uint16  treasuryBps_,
        address treasury_
    ) DatumOwnable() {
        require(timelockBlocks_ > 0 && timelockBlocks_ <= MAX_TIMELOCK_BLOCKS, "E11");
        require(uint32(winnerBonusBps_) + uint32(treasuryBps_) <= MAX_PUNISHMENT_BPS, "E11");
        require(treasury_ != address(0) || treasuryBps_ == 0, "E00");
        _minBond = minBond_;
        _timelockBlocks = timelockBlocks_;
        _winnerBonusBps = winnerBonusBps_;
        _treasuryBps = treasuryBps_;
        treasury = treasury_;
        // Mute defaults: ≥ 10× minBond floor (muting a paying campaign is
        // more disruptive than challenging activation, so the bar is higher)
        // and 14400 blocks (~1 day @ 6s/block) to auto-resolve a stuck mute.
        _muteMinBond = minBond_ * 10;
        _muteMaxBlocks = 14400;
    }

    /// @dev Accept refund from Campaigns/Lifecycle on edge paths and from
    ///      challengers posting counter-bond.
    receive() external payable {}

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// @dev Cypherpunk lock-once. The campaigns reference is the only authority
    ///      to mint bonds — hot-swapping it could redirect creator-bond flow.
    function setCampaignsContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(campaignsContract == address(0), "already set");
        emit ContractReferenceChanged("campaigns", campaignsContract, addr);
        campaignsContract = addr;
    }

    function setTreasury(address addr) external onlyOwner {
        // treasury may legitimately be address(0) (treasuryBps must then be 0)
        require(_treasuryBps == 0 || addr != address(0), "E00");
        emit TreasurySet(addr);
        treasury = addr;
    }

    function setMinBond(uint256 v) external onlyOwner {
        _minBond = v;
        emit MinBondSet(v);
    }

    function setTimelockBlocks(uint64 v) external onlyOwner {
        require(v > 0 && v <= MAX_TIMELOCK_BLOCKS, "E11");
        _timelockBlocks = v;
        emit TimelockBlocksSet(v);
    }

    function setPunishmentBps(uint16 winnerBps, uint16 treasuryBps_) external onlyOwner {
        require(uint32(winnerBps) + uint32(treasuryBps_) <= MAX_PUNISHMENT_BPS, "E11");
        require(treasuryBps_ == 0 || treasury != address(0), "E00");
        _winnerBonusBps = winnerBps;
        _treasuryBps = treasuryBps_;
        emit WinnerBonusBpsSet(winnerBps);
        emit TreasuryBpsSet(treasuryBps_);
    }

    function setMuteMinBond(uint256 v) external onlyOwner {
        _muteMinBond = v;
        emit MuteMinBondSet(v);
    }

    function setMuteMaxBlocks(uint64 v) external onlyOwner {
        require(v > 0 && v <= MAX_TIMELOCK_BLOCKS, "E11");
        _muteMaxBlocks = v;
        emit MuteMaxBlocksSet(v);
    }

    // ── Write paths ───────────────────────────────────────────────────────────

    /// @inheritdoc IDatumActivationBonds
    function openBond(uint256 campaignId, address creator) external payable {
        require(msg.sender == campaignsContract, "E19");
        require(creator != address(0), "E00");
        require(msg.value >= _minBond, "E11");
        require(msg.value <= type(uint128).max, "E11");

        State storage s = _state[campaignId];
        require(s.phase == Phase.None, "E94"); // already opened

        s.phase = Phase.Open;
        s.creator = creator;
        s.creatorBond = uint128(msg.value);
        s.timelockExpiry = uint64(block.number) + _timelockBlocks;

        emit BondOpened(campaignId, creator, msg.value, s.timelockExpiry);
    }

    /// @inheritdoc IDatumActivationBonds
    function challenge(uint256 campaignId) external payable nonReentrant {
        State storage s = _state[campaignId];
        require(s.phase == Phase.Open, "E95");
        require(block.number < s.timelockExpiry, "E96"); // timelock closed
        require(msg.sender != s.creator, "E97"); // creator cannot self-challenge
        require(msg.value >= s.creatorBond, "E97"); // ≥ creator's bond
        require(msg.value <= type(uint128).max, "E11");

        s.phase = Phase.Contested;
        s.challenger = msg.sender;
        s.challengerBond = uint128(msg.value);

        emit Challenged(campaignId, msg.sender, msg.value);
    }

    /// @inheritdoc IDatumActivationBonds
    function activate(uint256 campaignId) external nonReentrant {
        State storage s = _state[campaignId];
        require(s.phase == Phase.Open, "E95");
        require(block.number >= s.timelockExpiry, "E96"); // still in timelock

        // Read current status — only activate if still Pending. (If Lifecycle
        // already moved status to Expired, fall through to settle().)
        (uint8 status,,) = IDatumCampaignsMinimal(campaignsContract).getCampaignForSettlement(campaignId);
        require(status == 0, "E20"); // not Pending

        uint256 refund = s.creatorBond;
        address creator = s.creator;
        s.phase = Phase.Resolved;
        s.creatorBond = 0;

        _pending[creator] += refund;
        IDatumCampaignsMinimal(campaignsContract).activateCampaign(campaignId);

        emit Activated(campaignId, msg.sender);
        emit Resolved(campaignId, true, refund, 0, 0);
    }

    /// @inheritdoc IDatumActivationBonds
    function settle(uint256 campaignId) external nonReentrant {
        State storage s = _state[campaignId];
        require(s.phase == Phase.Open || s.phase == Phase.Contested, "E94");

        (uint8 status,,) = IDatumCampaignsMinimal(campaignsContract).getCampaignForSettlement(campaignId);

        // Resolvable terminal states: Active(1), Terminated(4), Expired(5).
        // Pending(0) or Paused(2) or Completed(3) — not yet resolvable here.
        // (Completed implies activation happened — that means we already
        //  resolved at activate() or the campaign was activated by governance,
        //  which is handled by Active branch.)
        if (status == 1) {
            // creator won — campaign Active
            _payoutCreatorWin(campaignId, s);
        } else if (status == 4) {
            // challenger won — campaign Terminated by governance
            require(s.phase == Phase.Contested, "E96"); // can only terminate via vote, which requires contested
            _payoutChallengerWin(campaignId, s);
        } else if (status == 5) {
            // Expired — no-fault timeout. Refund both.
            _payoutNoFault(campaignId, s);
        } else {
            revert("E98");
        }
    }

    /// @inheritdoc IDatumActivationBonds
    function claim() external nonReentrant {
        _claim(msg.sender, msg.sender);
    }

    /// @inheritdoc IDatumActivationBonds
    function claimTo(address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        _claim(msg.sender, recipient);
    }

    function _claim(address account, address recipient) internal {
        uint256 amount = _pending[account];
        require(amount > 0, "E03");
        _pending[account] = 0;
        emit PayoutClaimed(recipient, amount);
        _safeSend(recipient, amount);
    }

    // ── Emergency mute (Phase 2b) ─────────────────────────────────────────────
    //
    //   Phase 2b is the runtime analogue of the activation challenge: anyone
    //   may post a bond to instantly mute an Active campaign while a demote
    //   vote runs in DatumGovernanceV2. Mute is collateralised — if the
    //   campaign survives the vote (status returns to Active) or the mute
    //   times out without a demote, the muter's bond is paid to the
    //   advertiser as compensation for the freeze period. If the campaign is
    //   Terminated, the muter is refunded with a bonus from the slash pool
    //   (claimed via the existing GovernanceV2 slash distribution, not paid
    //   from this contract).
    //
    //   Single-shot per campaign — settleMute must clear before a new mute
    //   can open. ClaimValidator consults isMuted() to reject claims while
    //   the bond is active.

    function mute(uint256 campaignId) external payable nonReentrant {
        MuteState storage m = _mute[campaignId];
        require(!m.active, "E94"); // already muted
        require(msg.value >= _muteMinBond, "E11");
        require(msg.value <= type(uint128).max, "E11");

        (uint8 status,,) = IDatumCampaignsMinimal(campaignsContract)
            .getCampaignForSettlement(campaignId);
        require(status == 1, "E20"); // must be Active

        // Self-mute: muter cannot be the advertiser. Best-effort read; if
        // the campaigns implementation doesn't expose the advertiser, skip
        // the self-mute guard rather than reverting (forward-compat).
        try IDatumCampaignsForMute(campaignsContract).getCampaignAdvertiser(campaignId) returns (address adv) {
            require(adv != msg.sender, "E97");
        } catch { /* leave guard off if getter unavailable */ }

        m.active = true;
        m.muter = msg.sender;
        m.bond = uint128(msg.value);
        m.openedAt = uint64(block.number);

        emit Muted(campaignId, msg.sender, msg.value);
    }

    function settleMute(uint256 campaignId) external nonReentrant {
        MuteState storage m = _mute[campaignId];
        require(m.active, "E95");

        (uint8 status,,) = IDatumCampaignsMinimal(campaignsContract)
            .getCampaignForSettlement(campaignId);

        uint256 bond = m.bond;
        address muter = m.muter;
        bool upheld;
        uint256 payoutAmount;

        if (status == 4) {
            // Terminated — mute upheld. Muter refunded their bond. Any bonus
            // they're entitled to as a voter on the winning side flows
            // through the GovernanceV2 slash pool, not this contract.
            upheld = true;
            payoutAmount = bond;
            _pending[muter] += bond;
        } else if (status == 1) {
            // Still Active — mute rejected only if the timeout has elapsed.
            // Otherwise we're still mid-vote; caller must wait.
            require(block.number >= uint256(m.openedAt) + uint256(_muteMaxBlocks), "E96");
            _payoutMuteRejected(campaignId, m, bond, muter);
            upheld = false;
            payoutAmount = bond; // amount transferred to advertiser
        } else if (status == 5 || status == 3) {
            // Expired or Completed — no-fault for the muter (campaign reached
            // a terminal state outside the demote-vote process). Refund.
            upheld = false;
            payoutAmount = bond;
            _pending[muter] += bond;
        } else {
            // Pending(0) or Paused(2): demote-vote may have moved the
            // campaign out of Active mid-flight; not yet resolvable.
            revert("E98");
        }

        // Clear mute (single-shot per Active cycle).
        m.active = false;
        m.bond = 0;
        m.muter = address(0);
        m.openedAt = 0;

        emit MuteResolved(campaignId, upheld, payoutAmount);
    }

    function _payoutMuteRejected(
        uint256 campaignId,
        MuteState storage m,
        uint256 bond,
        address muter
    ) internal {
        // Bond is slashed to advertiser. If the advertiser getter isn't
        // available (or returns address(0)), route to treasury so the bond
        // can't be permanently stranded.
        address advertiser;
        try IDatumCampaignsForMute(campaignsContract).getCampaignAdvertiser(campaignId) returns (address adv) {
            advertiser = adv;
        } catch {
            advertiser = address(0);
        }
        address recipient = advertiser != address(0) ? advertiser : treasury;
        require(recipient != address(0), "E00"); // both unset — refuse to strand
        _pending[recipient] += bond;
        // Silence unused-var warnings for non-touched fields.
        (muter, m);
    }

    // ── Internal payout maths ─────────────────────────────────────────────────

    function _payoutCreatorWin(uint256 campaignId, State storage s) internal {
        uint256 creatorAmt = s.creatorBond;
        uint256 challengerBond_ = s.challengerBond;
        uint256 bonus;
        uint256 toTreasury;
        uint256 challengerRefund;

        if (challengerBond_ > 0) {
            bonus = challengerBond_ * _winnerBonusBps / 10000;
            toTreasury = challengerBond_ * _treasuryBps / 10000;
            challengerRefund = challengerBond_ - bonus - toTreasury;
        }

        s.phase = Phase.Resolved;
        s.creatorBond = 0;
        s.challengerBond = 0;

        _pending[s.creator] += creatorAmt + bonus;
        if (challengerRefund > 0) _pending[s.challenger] += challengerRefund;
        if (toTreasury > 0) _pending[treasury] += toTreasury;

        emit Resolved(campaignId, true, creatorAmt, bonus, toTreasury);
    }

    function _payoutChallengerWin(uint256 campaignId, State storage s) internal {
        uint256 challengerAmt = s.challengerBond;
        uint256 creatorBond_ = s.creatorBond;
        uint256 bonus = creatorBond_ * _winnerBonusBps / 10000;
        uint256 toTreasury = creatorBond_ * _treasuryBps / 10000;
        uint256 creatorRefund = creatorBond_ - bonus - toTreasury;

        s.phase = Phase.Resolved;
        s.creatorBond = 0;
        s.challengerBond = 0;

        _pending[s.challenger] += challengerAmt + bonus;
        if (creatorRefund > 0) _pending[s.creator] += creatorRefund;
        if (toTreasury > 0) _pending[treasury] += toTreasury;

        emit Resolved(campaignId, false, challengerAmt, bonus, toTreasury);
    }

    function _payoutNoFault(uint256 campaignId, State storage s) internal {
        uint256 cBond = s.creatorBond;
        uint256 chBond = s.challengerBond;
        s.phase = Phase.Resolved;
        s.creatorBond = 0;
        s.challengerBond = 0;
        if (cBond > 0) _pending[s.creator] += cBond;
        if (chBond > 0) _pending[s.challenger] += chBond;
        emit Resolved(campaignId, false, 0, 0, 0);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function phase(uint256 campaignId) external view returns (Phase) {
        return _state[campaignId].phase;
    }

    function isContested(uint256 campaignId) external view returns (bool) {
        return _state[campaignId].phase == Phase.Contested;
    }

    function isOpen(uint256 campaignId) external view returns (bool) {
        return _state[campaignId].phase == Phase.Open;
    }

    function creatorOf(uint256 campaignId) external view returns (address) {
        return _state[campaignId].creator;
    }

    function challengerOf(uint256 campaignId) external view returns (address) {
        return _state[campaignId].challenger;
    }

    function creatorBond(uint256 campaignId) external view returns (uint256) {
        return _state[campaignId].creatorBond;
    }

    function challengerBond(uint256 campaignId) external view returns (uint256) {
        return _state[campaignId].challengerBond;
    }

    function timelockExpiry(uint256 campaignId) external view returns (uint64) {
        return _state[campaignId].timelockExpiry;
    }

    function pending(address account) external view returns (uint256) {
        return _pending[account];
    }

    function minBond() external view returns (uint256) { return _minBond; }
    function timelockBlocks() external view returns (uint64) { return _timelockBlocks; }
    function winnerBonusBps() external view returns (uint16) { return _winnerBonusBps; }
    function treasuryBps() external view returns (uint16) { return _treasuryBps; }

    // ── Mute views ────────────────────────────────────────────────────────────
    function isMuted(uint256 campaignId) external view returns (bool) {
        return _mute[campaignId].active;
    }
    function muterOf(uint256 campaignId) external view returns (address) {
        return _mute[campaignId].muter;
    }
    function muteBondOf(uint256 campaignId) external view returns (uint256) {
        return _mute[campaignId].bond;
    }
    function mutedAtBlock(uint256 campaignId) external view returns (uint64) {
        return _mute[campaignId].openedAt;
    }
    function muteMinBond() external view returns (uint256) { return _muteMinBond; }
    function muteMaxBlocks() external view returns (uint64) { return _muteMaxBlocks; }
}
