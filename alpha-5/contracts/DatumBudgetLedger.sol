// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumUpgradable.sol";
import "./PaseoSafeSender.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumCampaigns.sol";

/// @title DatumBudgetLedger
/// @notice Per-campaign per-pot budget escrow and daily cap enforcement.
///         Supports three action pots per campaign: 0=view, 1=click, 2=remote-action.
///         Budget is keyed on (campaignId, actionType).
///
///         Campaigns initializes each pot at campaign creation (payable, once per pot).
///         Settlement calls deductAndTransfer with the actionType to deduct the right pot.
///         Lifecycle calls drainToAdvertiser/drainFraction which loop all pots internally.
///
///         Daily cap uses block.timestamp / 86400 as day index (accepted PoC risk).
///         Single _send() site for native transfers.
contract DatumBudgetLedger is IDatumBudgetLedger, PaseoSafeSender, DatumUpgradable {
    function version() public pure virtual override returns (uint256) { return 1; }

    // -------------------------------------------------------------------------
    // Authorization
    // -------------------------------------------------------------------------

    IDatumCampaigns public campaigns;
    address public settlement;
    address public lifecycle;
    /// @notice F-021 fix (2026-05-20): treasury demoted from `immutable` so
    ///         a deployer-EOA bootstrap can rotate to a Safe before
    ///         mainnet. Locked-once via `lockTreasury()` (phase-gated on
    ///         OpenGov) when the production treasury is final. Pre-lock,
    ///         owner can update. Default initialised to `msg.sender`
    ///         (SL-1 legacy behavior) so existing deploy scripts that
    ///         relied on the constructor-time treasury still work.
    address public treasury;
    bool public treasuryLocked;
    event TreasurySet(address indexed treasury);
    event TreasuryLocked();

    /// @notice Cypherpunk posture: the three structural refs (campaigns /
    ///         settlement / lifecycle) are PHASE-CONDITIONAL lock-once —
    ///         governance-re-pointable through Admin/Council, frozen only when
    ///         OpenGov fires `lockPlumbing()`. Replaces the prior unconditional
    ///         set-once guards (which froze the plumbing at deploy and forced a
    ///         full redeploy to re-point, e.g. after a Settlement upgrade).
    ///         Mirrors DatumSettlement / DatumClaimValidator.
    bool public plumbingLocked;
    event PlumbingLocked();

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    struct Budget {
        uint256 remaining;
        uint256 dailyCap;
        uint256 dailySpent;
        uint256 lastSpendDay;
    }

    /// @dev Keyed by (campaignId, actionType). actionType: 0=view, 1=click, 2=remote-action.
    mapping(uint256 => mapping(uint8 => Budget)) private _budgets;

    /// @dev P20: Tracks the last block where a deduction occurred for each campaign (any pot).
    mapping(uint256 => uint256) public lastSettlementBlock;

    /// @dev M-1: Pending advertiser refund balances. drainToAdvertiser records here
    ///      instead of pushing native DOT, so a contract advertiser with a reverting
    ///      fallback cannot DoS Lifecycle / Settlement auto-complete.
    mapping(address => uint256) public pendingAdvertiserRefund;

    // ── Enumeration for upgrade migration (redeploy-migrate-rewire) ──
    // Budgets + refunds live in non-iterable mappings; track the campaign ids
    // that hold budget and the advertisers that hold a pending refund so a
    // successor's `_migrate` can copy each. Native DOT is moved separately by
    // `migrateFundsTo`. Paginate (override migrate()) if the campaign set ever
    // outgrows a single-tx gas budget; the alpha set is small.
    uint256[] private _budgetCampaigns;
    mapping(uint256 => bool) private _budgetTracked;
    address[] private _refundHolders;
    mapping(address => bool) private _refundTracked;

    /// @notice One-shot: true once native DOT has been swept to a successor.
    bool public fundsMigratedOut;
    event FundsMigratedOut(address indexed successor, uint256 amount);

    function _trackBudgetCampaign(uint256 id) internal {
        if (!_budgetTracked[id]) { _budgetTracked[id] = true; _budgetCampaigns.push(id); }
    }
    function _trackRefundHolder(address a) internal {
        if (a != address(0) && !_refundTracked[a]) { _refundTracked[a] = true; _refundHolders.push(a); }
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ContractReferenceChanged(string name, address oldAddr, address newAddr);
    // M-1: AdvertiserRefundQueued / AdvertiserRefundClaimed declared on IDatumBudgetLedger.

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor() {
        treasury = msg.sender; // F-021: initial owner; rotate via setTreasury
        emit TreasurySet(msg.sender);
    }

    /// @notice F-021 fix: rotate the treasury before lockTreasury. Owner-only.
    function setTreasury(address newTreasury) external onlyOwner {
        require(!treasuryLocked, "treasury-locked");
        require(newTreasury != address(0), "E00");
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    /// @notice F-021 fix: lock the treasury permanently. Phase-gated on
    ///         OpenGov; production fires after rotating to the Safe.
    function lockTreasury() external onlyOwner whenOpenGovPhase {
        require(!treasuryLocked, "already-locked");
        treasuryLocked = true;
        emit TreasuryLocked();
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @dev BudgetLedger holds advertiser DOT, so these three refs gate who can
    ///      deduct/refund/sweep it (a rug surface). Per the cypherpunk posture
    ///      they're phase-conditional: re-pointable by the phased governor until
    ///      lockPlumbing() fires at OpenGov, then frozen. The rug surface is
    ///      bounded by the phase ladder + the irreversible OpenGov lock.
    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(!plumbingLocked, "locked");
        emit ContractReferenceChanged("campaigns", address(campaigns), addr);
        campaigns = IDatumCampaigns(addr);
    }

    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(!plumbingLocked, "locked");
        emit ContractReferenceChanged("settlement", settlement, addr);
        settlement = addr;
    }

    function setLifecycle(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(!plumbingLocked, "locked");
        emit ContractReferenceChanged("lifecycle", lifecycle, addr);
        lifecycle = addr;
    }

    /// @notice Cypherpunk end-state lock for the structural-ref surface
    ///         (campaigns / settlement / lifecycle). OpenGov-gated; once fired,
    ///         the three setters revert permanently.
    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        require(!plumbingLocked, "already-locked");
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // -------------------------------------------------------------------------
    // Budget initialization (Campaigns only — once per pot)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function initializeBudget(
        uint256 campaignId,
        uint8   actionType,
        uint256 budget,
        uint256 dailyCap
    ) external payable whenNotFrozen {
        require(msg.sender == address(campaigns), "E25");
        require(actionType <= 2, "E88"); // E88: invalid action type
        require(msg.value == budget, "E16");
        require(_budgets[campaignId][actionType].remaining == 0, "E14"); // prevent double-init

        _budgets[campaignId][actionType] = Budget({
            remaining: budget,
            dailyCap: dailyCap,
            dailySpent: 0,
            lastSpendDay: 0
        });
        if (lastSettlementBlock[campaignId] == 0) {
            lastSettlementBlock[campaignId] = block.number;
        }
        _trackBudgetCampaign(campaignId);

        emit BudgetInitialized(campaignId, actionType, budget, dailyCap);
    }

    // -------------------------------------------------------------------------
    // Budget deduction (Settlement only)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function deductAndTransfer(
        uint256 campaignId,
        uint8   actionType,
        uint256 amount,
        address recipient
    ) external nonReentrant returns (bool exhausted) {
        require(msg.sender == settlement, "E25");
        require(actionType <= 2, "E88");

        Budget storage b = _budgets[campaignId][actionType];
        require(amount <= b.remaining, "E16");

        // Daily cap reset on new day
        uint256 today = block.timestamp / 86400;
        if (today != b.lastSpendDay) {
            b.dailySpent = 0;
            b.lastSpendDay = today;
        }

        require(b.dailySpent + amount <= b.dailyCap, "E26");

        b.dailySpent += amount;
        b.remaining -= amount;
        lastSettlementBlock[campaignId] = block.number;

        emit BudgetDeducted(campaignId, actionType, amount, b.remaining);

        exhausted = (b.remaining == 0);

        _send(recipient, amount);
    }

    // -------------------------------------------------------------------------
    // Budget drain (Lifecycle only — loops all pots internally)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    /// @dev M-1: Records the refund into `pendingAdvertiserRefund` instead of
    ///      pushing native DOT. Advertiser pulls via claimAdvertiserRefund[To].
    function drainToAdvertiser(
        uint256 campaignId,
        address advertiser
    ) external nonReentrant returns (uint256 drained) {
        require(msg.sender == lifecycle, "E25");

        for (uint8 t = 0; t <= 2; t++) {
            uint256 rem = _budgets[campaignId][t].remaining;
            if (rem > 0) {
                _budgets[campaignId][t].remaining = 0;
                drained += rem;
            }
        }

        emit BudgetDrained(campaignId, advertiser, drained);

        if (drained > 0) {
            pendingAdvertiserRefund[advertiser] += drained;
            _trackRefundHolder(advertiser);
            emit AdvertiserRefundQueued(campaignId, advertiser, drained);
        }
    }

    /// @notice M-1: Pull a queued advertiser refund to the advertiser's own address.
    function claimAdvertiserRefund() external nonReentrant whenNotFrozen {
        _claimAdvertiserRefund(msg.sender);
    }

    /// @notice M-1: Pull a queued advertiser refund to a different recipient
    ///         (e.g. cold wallet). Only the advertiser who owns the refund can call.
    function claimAdvertiserRefundTo(address recipient) external nonReentrant whenNotFrozen {
        require(recipient != address(0), "E00");
        _claimAdvertiserRefund(recipient);
    }

    function _claimAdvertiserRefund(address recipient) internal {
        uint256 amount = pendingAdvertiserRefund[msg.sender];
        require(amount > 0, "E03");
        pendingAdvertiserRefund[msg.sender] = 0;
        emit AdvertiserRefundClaimed(msg.sender, recipient, amount);
        _send(recipient, amount);
    }

    /// @inheritdoc IDatumBudgetLedger
    function drainFraction(
        uint256 campaignId,
        address recipient,
        uint256 bps
    ) external nonReentrant returns (uint256 amount) {
        require(msg.sender == lifecycle, "E25");
        require(bps <= 10000, "E16");

        for (uint8 t = 0; t <= 2; t++) {
            uint256 remaining = _budgets[campaignId][t].remaining;
            if (remaining == 0) continue;
            // L-3 / AUDIT-009: ceiling-rounded mulDiv in a single overflow-safe call.
            uint256 potAmount = Math.mulDiv(remaining, bps, 10000, Math.Rounding.Ceil);
            _budgets[campaignId][t].remaining = remaining - potAmount;
            amount += potAmount;
        }

        if (amount > 0) {
            _send(recipient, amount);
        }
    }

    // -------------------------------------------------------------------------
    // Dust sweep (M4) — permissionless, terminal campaigns only
    // -------------------------------------------------------------------------

    event DustSwept(uint256 indexed campaignId, address recipient, uint256 amount);

    /// @notice Sweep rounding dust from terminal campaigns to protocol treasury.
    ///         Permissionless — anyone can call. Only works for terminal campaign statuses (3,4,5).
    function sweepDust(uint256 campaignId) external nonReentrant whenNotFrozen {
        // Check campaign is terminal
        IDatumCampaigns.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(uint8(status) >= 3, "E14"); // 3=Completed, 4=Terminated, 5=Expired

        uint256 dust;
        for (uint8 t = 0; t <= 2; t++) {
            uint256 rem = _budgets[campaignId][t].remaining;
            if (rem > 0) {
                _budgets[campaignId][t].remaining = 0;
                dust += rem;
            }
        }
        require(dust > 0, "E03");

        emit DustSwept(campaignId, treasury, dust);
        _send(treasury, dust);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumBudgetLedger
    function getRemainingBudget(uint256 campaignId, uint8 actionType) external view returns (uint256) {
        return _budgets[campaignId][actionType].remaining;
    }

    /// @inheritdoc IDatumBudgetLedger
    function getTotalRemainingBudget(uint256 campaignId) external view returns (uint256 total) {
        for (uint8 t = 0; t <= 2; t++) {
            total += _budgets[campaignId][t].remaining;
        }
    }

    /// @inheritdoc IDatumBudgetLedger
    function getDailyCap(uint256 campaignId, uint8 actionType) external view returns (uint256) {
        return _budgets[campaignId][actionType].dailyCap;
    }

    // -------------------------------------------------------------------------
    // Upgrade migration (redeploy-migrate-rewire)
    // -------------------------------------------------------------------------

    /// @notice Migration enumeration: campaign ids holding budget + advertisers
    ///         holding a pending refund, plus a full-budget read for `_migrate`.
    function budgetCampaignCount() external view returns (uint256) { return _budgetCampaigns.length; }
    function budgetCampaignAt(uint256 i) external view returns (uint256) { return _budgetCampaigns[i]; }
    function refundHolderCount() external view returns (uint256) { return _refundHolders.length; }
    function refundHolderAt(uint256 i) external view returns (address) { return _refundHolders[i]; }
    function getBudgetFull(uint256 campaignId, uint8 actionType)
        external view returns (uint256 remaining, uint256 dailyCap, uint256 dailySpent, uint256 lastSpendDay)
    {
        Budget storage b = _budgets[campaignId][actionType];
        return (b.remaining, b.dailyCap, b.dailySpent, b.lastSpendDay);
    }

    /// @dev Copy budget + refund ACCOUNTING from a frozen predecessor. Called by
    ///      DatumUpgradable.migrate (governance-gated; old frozen, higher version).
    ///      Copies treasury value + every enumerated campaign's 3 pots +
    ///      lastSettlementBlock + every advertiser's pending refund. Structural
    ///      refs (campaigns/settlement/lifecycle) and the lock flags are NOT
    ///      copied — they are re-wired on the fresh contract (the rewire leg),
    ///      then re-locked at OpenGov. Native DOT moves via `migrateFundsTo`.
    function _migrate(address oldContract) internal override {
        DatumBudgetLedger old = DatumBudgetLedger(payable(oldContract));
        treasury = old.treasury();
        uint256 nc = old.budgetCampaignCount();
        for (uint256 i = 0; i < nc; i++) {
            uint256 id = old.budgetCampaignAt(i);
            for (uint8 t = 0; t <= 2; t++) {
                (uint256 rem, uint256 cap, uint256 spent, uint256 day) = old.getBudgetFull(id, t);
                _budgets[id][t] = Budget({remaining: rem, dailyCap: cap, dailySpent: spent, lastSpendDay: day});
            }
            lastSettlementBlock[id] = old.lastSettlementBlock(id);
            _trackBudgetCampaign(id);
        }
        uint256 nr = old.refundHolderCount();
        for (uint256 i = 0; i < nr; i++) {
            address a = old.refundHolderAt(i);
            pendingAdvertiserRefund[a] = old.pendingAdvertiserRefund(a);
            _trackRefundHolder(a);
        }
    }

    /// @notice Sweep the ledger's entire native balance to a successor during an
    ///         upgrade, so the successor (which received the budget accounting
    ///         via `_migrate`) is solvent. Governance-gated + frozen-only (a live
    ///         ledger can never be drained); one-shot. Uses `acceptMigration`
    ///         because this contract's `receive()` rejects deposits.
    function migrateFundsTo(address successor) external onlyGovernance nonReentrant {
        require(frozen, "not frozen");
        require(!fundsMigratedOut, "already swept");
        require(successor != address(0), "E00");
        fundsMigratedOut = true;
        uint256 bal = address(this).balance;
        emit FundsMigratedOut(successor, bal);
        if (bal > 0) DatumBudgetLedger(payable(successor)).acceptMigration{value: bal}();
    }

    /// @notice Accept a native-DOT inflow from the predecessor being migrated
    ///         FROM. Gated to `migrationSource` (set by migrate()), so only the
    ///         contract this one migrated from can fund it — no open deposits.
    function acceptMigration() external payable {
        require(msg.sender == migrationSource, "not-source");
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    /// @dev Single native-transfer site. Routes through `_safeSend` to
    ///      sidestep the Paseo eth-rpc denomination bug (A2).
    function _send(address to, uint256 amount) internal {
        _safeSend(to, amount);
    }

    /// @notice Reject stray native deposits — there is no internal path that
    ///         requires open `receive()` here. (I-1)
    receive() external payable whenNotFrozen { revert("E03"); }
}
