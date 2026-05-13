// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumAdvertiserStake.sol";
import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";

/// @title DatumAdvertiserStake
/// @notice CB4: Advertiser-side aggregate stake. Mirrors DatumPublisherStake.
///
///         Advertisers lock native DOT to signal aggregate accountability across
///         every campaign they run. The minimum required stake grows with
///         cumulative DOT spent through their campaigns:
///
///           requiredStake = baseStakePlanck + cumulativeBudgetSpentDOT * planckPerDOTSpent
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
contract DatumAdvertiserStake is IDatumAdvertiserStake, PaseoSafeSender, DatumOwnable {
    /// @notice Settlement contract — authorised to record cumulative budget spent.
    address public settlementContract;

    /// @notice Slash contract — authorised to slash advertiser stakes (AdvertiserGovernance).
    address public slashContract;

    // ── Bonding curve params ───────────────────────────────────────────────────

    uint256 public baseStakePlanck;
    uint256 public planckPerDOTSpent;
    uint256 public unstakeDelayBlocks;

    /// @notice Cap on requiredStake to prevent bonding curve runaway. Default
    ///         10^14 planck = 10,000 DOT, same as publisher stake.
    uint256 public maxRequiredStake = 10**14;

    // ── State ──────────────────────────────────────────────────────────────────

    mapping(address => uint256) private _staked;
    mapping(address => uint256) private _cumulativeBudgetSpentDOT; // measured in DOT units (planck / 10^10)
    mapping(address => UnstakeRequest) private _pendingUnstake;

    constructor(
        uint256 _baseStakePlanck,
        uint256 _planckPerDOTSpent,
        uint256 _unstakeDelayBlocks
    ) {
        require(_unstakeDelayBlocks > 0, "E00");
        baseStakePlanck = _baseStakePlanck;
        planckPerDOTSpent = _planckPerDOTSpent;
        unstakeDelayBlocks = _unstakeDelayBlocks;
    }

    // ── Admin (lock-once on hot-swap-critical refs) ────────────────────────────

    /// @dev Lock-once: only the settlement contract may advance the cumulative
    ///      budget-spent counter. Hot-swap = forge spend to drive required-stake
    ///      up on rivals.
    function setSettlementContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(settlementContract == address(0), "already set");
        settlementContract = addr;
    }

    /// @dev Lock-once: only the slash contract may burn stake.
    function setSlashContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(slashContract == address(0), "already set");
        slashContract = addr;
    }

    function setParams(uint256 _base, uint256 _perDOTSpent, uint256 _delay) external onlyOwner {
        require(_delay > 0, "E00");
        baseStakePlanck = _base;
        planckPerDOTSpent = _perDOTSpent;
        unstakeDelayBlocks = _delay;
        emit ParamsUpdated(_base, _perDOTSpent, _delay);
    }

    function setMaxRequiredStake(uint256 cap) external onlyOwner {
        require(cap > 0, "E00");
        maxRequiredStake = cap;
    }

    receive() external payable { revert("E03"); }

    // ── Advertiser actions ─────────────────────────────────────────────────────

    function stake() external payable {
        require(msg.value > 0, "E11");
        _staked[msg.sender] += msg.value;
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

    function unstake() external nonReentrant {
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
    function recordBudgetSpent(address advertiser, uint256 amountPlanck) external {
        require(msg.sender == settlementContract, "E18");
        uint256 dotUnits = amountPlanck / 10**10; // 1 DOT = 10^10 planck
        if (dotUnits == 0) return;
        _cumulativeBudgetSpentDOT[advertiser] += dotUnits;
        emit BudgetSpentRecorded(advertiser, dotUnits, _cumulativeBudgetSpentDOT[advertiser]);
    }

    // ── Governance slash ───────────────────────────────────────────────────────

    /// @dev R-H1 mirror: slash consumes from pendingUnstake first so a
    ///      fraud-anticipating advertiser can't shield via requestUnstake.
    function slash(address advertiser, uint256 amount, address recipient) external nonReentrant {
        require(msg.sender == slashContract, "E18");
        require(recipient != address(0), "E00");

        uint256 active = _staked[advertiser];
        UnstakeRequest storage pending = _pendingUnstake[advertiser];
        uint256 pendingAmt = pending.amount;
        uint256 totalSlashable = active + pendingAmt;

        if (amount > totalSlashable) amount = totalSlashable;
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
        uint256 base = baseStakePlanck;
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
}
