// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumAdvertiserStake.sol";
import "./DatumFundMigratable.sol";
import "./PaseoSafeSender.sol";

/// @title DatumAdvertiserStake
/// @notice CB4: Advertiser-side aggregate stake. Mirrors DatumPublisherStake.
///
///         Advertisers lock native DOT to signal aggregate accountability across
///         every campaign they run. The minimum required stake grows with
///         cumulative DOT spent through their campaigns:
///
///           requiredStake = baseStakeWei + cumulativeBudgetSpentDOT * planckPerDOTSpent
///
///         (Where DOT is measured at 10^10 planck per DOT, matching the protocol's
///         standard denomination.) The curve caps at maxRequiredStake.
///
///         Campaigns.createCampaign optionally gates on isAdequatelyStaked() —
///         when the advertiserStake address is wired on Campaigns, an under-
///         staked advertiser cannot create new campaigns. Existing campaigns
///         continue to operate (no retroactive enforcement).
///
///         Slash is called by DatumAdvertiserGovernance when a fraud proposal
///         resolves aye. The slash mechanism consumes from pendingUnstake first
///         so a fraud-anticipating advertiser can't shield funds via
///         requestUnstake (same R-H1 pattern as DatumPublisherStake).
contract DatumAdvertiserStake is IDatumAdvertiserStake, PaseoSafeSender, DatumFundMigratable {
    /// v2: parameter-governance Phase B — adds parameterGovernance field
    /// and routes the three parameter setters (setParams, setMaxRequiredStake,
    /// setMaxSlashBpsPerCall) through onlyOwnerOrPG so PG's bicameral
    /// retune flow can adjust them in addition to the owner/Timelock path.
    function version() public pure virtual override returns (uint256) { return 2; }

    /// @notice Settlement contract — authorised to record cumulative budget spent.
    address public settlementContract;

    /// @notice Slash contract — authorised to slash advertiser stakes (AdvertiserGovernance).
    address public slashContract;

    /// @notice ParameterGovernance address authorised to retune the parameter
    ///         setters via its bicameral veto-window flow. Lock-once on first set.
    address public parameterGovernance;
    event ParameterGovernanceSet(address indexed pg);

    /// @dev Owner OR ParameterGovernance — used by the parameter setters that
    ///      should be retunable through PG in addition to the standard
    ///      owner-governance path. Wiring setters remain `onlyOwner` only.
    modifier onlyOwnerOrPG() {
        require(msg.sender == owner() || msg.sender == parameterGovernance, "E18");
        _;
    }

    // ── Bonding curve params ───────────────────────────────────────────────────

    uint256 public baseStakeWei;
    uint256 public planckPerDOTSpent;
    uint256 public unstakeDelayBlocks;

    /// @notice Cap on requiredStake to prevent bonding curve runaway. Default
    ///         10^22 wei = 10,000 DOT (18-dec wei), same as publisher stake.
    uint256 public maxRequiredStake = 10**22;

    /// @dev Phase B bounds for the new dual-permission setters. Wide enough
    ///      for any realistic operational range, narrow enough to block
    ///      governance-attack abuse. All in 18-dec wei (2026-06 denomination
    ///      migration: stakes are native PAS / msg.value, i.e. 18-dec wei).
    uint256 internal constant MAX_BASE_STAKE              = 10**24;     // ~1M DOT (18-dec wei)
    uint256 internal constant MAX_PLANCK_PER_DOT_SPENT    = 10**20;     // ~100 DOT-per-DOT-spent (wei; curve coeff ceiling)
    uint256 internal constant MAX_UNSTAKE_DELAY_BLOCKS    = 5_256_000;  // ~1 year
    uint256 internal constant MAX_REQUIRED_STAKE_CEILING  = 10**25;     // ~10M DOT (18-dec wei)

    // ── State ──────────────────────────────────────────────────────────────────

    mapping(address => uint256) private _staked;
    mapping(address => uint256) private _cumulativeBudgetSpentDOT; // measured in DOT units (planck / 10^10)
    mapping(address => UnstakeRequest) private _pendingUnstake;

    // ── Enumeration for upgrade migration (redeploy-migrate-rewire) ──
    address[] private _stakers;
    mapping(address => bool) private _isStaker;
    // fundsMigratedOut + migrateFundsTo + acceptMigration provided by DatumFundMigratable.

    function _track(address a) internal {
        if (a != address(0) && !_isStaker[a]) { _isStaker[a] = true; _stakers.push(a); }
    }

    constructor(
        uint256 _baseStakeWei,
        uint256 _planckPerDOTSpent,
        uint256 _unstakeDelayBlocks
    ) {
        require(_unstakeDelayBlocks > 0, "E00");
        baseStakeWei = _baseStakeWei;
        planckPerDOTSpent = _planckPerDOTSpent;
        unstakeDelayBlocks = _unstakeDelayBlocks;
    }

    // ── Admin (lock-once on hot-swap-critical refs) ────────────────────────────

    /// @dev Lock-once: only the settlement contract may advance the cumulative
    ///      budget-spent counter. Hot-swap = forge spend to drive required-stake
    ///      up on rivals.
    function setSettlementContract(address addr) external onlyOwner whenPlumbingUnlocked {
        require(addr != address(0), "E00");
        settlementContract = addr;
    }

    /// @dev Lock-once: only the slash contract may burn stake.
    function setSlashContract(address addr) external onlyOwner whenPlumbingUnlocked {
        require(addr != address(0), "E00");
        slashContract = addr;
    }

    /// @notice Lock-once: wire DatumParameterGovernance as the dual-permission
    ///         retune authority. A captured owner cannot rotate PG to a
    ///         malicious target post-bootstrap.
    function setParameterGovernance(address pg) external onlyOwner whenPlumbingUnlocked {
        require(pg != address(0), "E00");
        parameterGovernance = pg;
        emit ParameterGovernanceSet(pg);
    }

    /// @dev Phase B: dual-permission. Bounds tightened — bonding-curve coefficients
    ///      capped to prevent governance from setting absurd values that block all
    ///      stake operations or drive requiredStake arithmetic to overflow.
    function setParams(uint256 _base, uint256 _perDOTSpent, uint256 _delay) external onlyOwnerOrPG {
        require(_delay > 0 && _delay <= MAX_UNSTAKE_DELAY_BLOCKS, "out-of-bounds");
        require(_base <= MAX_BASE_STAKE, "out-of-bounds");
        require(_perDOTSpent <= MAX_PLANCK_PER_DOT_SPENT, "out-of-bounds");
        baseStakeWei = _base;
        planckPerDOTSpent = _perDOTSpent;
        unstakeDelayBlocks = _delay;
        emit ParamsUpdated(_base, _perDOTSpent, _delay);
    }

    function setMaxRequiredStake(uint256 cap) external onlyOwnerOrPG {
        require(cap > 0 && cap <= MAX_REQUIRED_STAKE_CEILING, "out-of-bounds");
        maxRequiredStake = cap;
    }

    /// @notice H-2 audit fix: max fraction of an advertiser's slashable balance
    ///         a single slash call may consume, in bps. Default 5000 (50%).
    uint16 public maxSlashBpsPerCall = 5000;
    event MaxSlashBpsPerCallSet(uint16 bps);

    function setMaxSlashBpsPerCall(uint16 bps) external onlyOwnerOrPG {
        require(bps > 0 && bps <= 10000, "E11");
        maxSlashBpsPerCall = bps;
        emit MaxSlashBpsPerCallSet(bps);
    }

    receive() external payable whenNotFrozen { revert("E03"); }

    // ── Advertiser actions ─────────────────────────────────────────────────────

    function stake() external payable whenNotFrozen {
        require(msg.value > 0, "E11");
        _staked[msg.sender] += msg.value;
        _track(msg.sender);
        emit Staked(msg.sender, msg.value, _staked[msg.sender]);
    }

    function requestUnstake(uint256 amount) external {
        require(amount > 0, "E11");
        require(_staked[msg.sender] >= amount, "E03");
        require(_pendingUnstake[msg.sender].amount == 0, "E68");

        uint256 remaining = _staked[msg.sender] - amount;
        uint256 req = requiredStake(msg.sender);
        require(remaining >= req, "E69");

        _staked[msg.sender] = remaining;
        uint256 avail = block.number + unstakeDelayBlocks;
        _pendingUnstake[msg.sender] = UnstakeRequest({ amount: amount, availableBlock: avail });
        emit UnstakeRequested(msg.sender, amount, avail);
    }

    function unstake() external nonReentrant whenNotFrozen {
        UnstakeRequest memory req = _pendingUnstake[msg.sender];
        require(req.amount > 0, "E01");
        require(block.number >= req.availableBlock, "E70");

        delete _pendingUnstake[msg.sender];

        emit Unstaked(msg.sender, req.amount);
        _safeSend(msg.sender, req.amount);
    }

    // ── Settlement callback ────────────────────────────────────────────────────

    /// @notice Settlement calls this on each settled batch with the DOT amount
    ///         charged to the advertiser's budget. The bonding curve advances
    ///         in whole-DOT units; sub-DOT spend is rounded down (advertisers
    ///         with very low per-batch spend can settle many micro-batches
    ///         before the curve advances by one DOT — acceptable).
    function recordBudgetSpent(address advertiser, uint256 amountWei) external {
        require(msg.sender == settlementContract, "E18");
        uint256 dotUnits = amountWei / 10**18; // 1 DOT = 10^18 wei (18-dec migration; was 10^10 planck)
        if (dotUnits == 0) return;
        _cumulativeBudgetSpentDOT[advertiser] += dotUnits;
        _track(advertiser);
        emit BudgetSpentRecorded(advertiser, dotUnits, _cumulativeBudgetSpentDOT[advertiser]);
    }

    // ── Governance slash ───────────────────────────────────────────────────────

    /// @dev R-H1 mirror: slash consumes from pendingUnstake first so a
    ///      fraud-anticipating advertiser can't shield via requestUnstake.
    function slash(address advertiser, uint256 amount, address recipient) external nonReentrant whenNotFrozen {
        require(msg.sender == slashContract, "E18");
        require(recipient != address(0), "E00");

        uint256 active = _staked[advertiser];
        UnstakeRequest storage pending = _pendingUnstake[advertiser];
        uint256 pendingAmt = pending.amount;
        uint256 totalSlashable = active + pendingAmt;

        if (amount > totalSlashable) amount = totalSlashable;
        // H-2: cap a single slash at maxSlashBpsPerCall of total slashable.
        uint256 callCap = (totalSlashable * uint256(maxSlashBpsPerCall)) / 10000;
        if (amount > callCap) amount = callCap;
        if (amount == 0) return;

        uint256 fromPending = amount < pendingAmt ? amount : pendingAmt;
        if (fromPending > 0) {
            uint256 newPending = pendingAmt - fromPending;
            if (newPending == 0) {
                delete _pendingUnstake[advertiser];
            } else {
                pending.amount = newPending;
            }
        }
        uint256 fromActive = amount - fromPending;
        if (fromActive > 0) {
            _staked[advertiser] = active - fromActive;
        }

        emit Slashed(advertiser, amount, recipient);
        _safeSend(recipient, amount);
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    function staked(address advertiser) external view returns (uint256) {
        return _staked[advertiser];
    }

    function cumulativeBudgetSpent(address advertiser) external view returns (uint256) {
        return _cumulativeBudgetSpentDOT[advertiser];
    }

    function pendingUnstake(address advertiser) external view returns (UnstakeRequest memory) {
        return _pendingUnstake[advertiser];
    }

    function requiredStake(address advertiser) public view returns (uint256) {
        uint256 cap = maxRequiredStake;
        uint256 base = baseStakeWei;
        uint256 perDOT = planckPerDOTSpent;
        uint256 cum = _cumulativeBudgetSpentDOT[advertiser];
        if (perDOT == 0 || cum == 0) {
            return base >= cap ? cap : base;
        }
        if (base >= cap) return cap;
        uint256 headroom = cap - base;
        if (cum > headroom / perDOT) return cap;
        return base + cum * perDOT;
    }

    function isAdequatelyStaked(address advertiser) external view returns (bool) {
        return _staked[advertiser] >= requiredStake(advertiser);
    }

    // ── Upgrade migration (redeploy-migrate-rewire) ──────────────────────────

    function stakerCount() external view returns (uint256) { return _stakers.length; }
    function stakerAt(uint256 i) external view returns (address) { return _stakers[i]; }

    /// @dev Copy bonding-curve params + every staker's stake / cumulative
    ///      budget-spent / pending-unstake from a frozen predecessor. Structural
    ///      refs (settlementContract / slashContract / parameterGovernance) are
    ///      NOT copied — re-wired on the fresh contract. DOT moves via migrateFundsTo.
    function _migrate(address oldContract) internal override {
        DatumAdvertiserStake old = DatumAdvertiserStake(payable(oldContract));
        baseStakeWei = old.baseStakeWei();
        planckPerDOTSpent = old.planckPerDOTSpent();
        unstakeDelayBlocks = old.unstakeDelayBlocks();
        maxRequiredStake = old.maxRequiredStake();
        uint256 n = old.stakerCount();
        for (uint256 i = 0; i < n; i++) {
            address adv = old.stakerAt(i);
            _staked[adv] = old.staked(adv);
            _cumulativeBudgetSpentDOT[adv] = old.cumulativeBudgetSpent(adv);
            _pendingUnstake[adv] = old.pendingUnstake(adv);
            _track(adv);
        }
    }

    /// @notice Sweep native balance to a successor during an upgrade so it can
    ///         honour migrated stakes. Governance-gated, frozen-only, one-shot.
}
