// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";

/// @title  DatumEmissionEngine
/// @notice Path H emission curve (TOKENOMICS.md §3.3): outer 7-year halvings
///         with inner Bitcoin-difficulty-style adaptive rate.
///
///         Two layers:
///         - **Outer**: epoch budgets halve every 7 calendar years.
///           Budgets [47.5M, 23.75M, 11.875M, ...] sum to exactly 95M.
///           Daily cap = epoch_budget / 2555 days.
///         - **Inner**: per-DOT mint rate adapts every adjustmentPeriod
///           toward `daily_cap / observed_DOT_volume`. Hard-bounded
///           [0.001, 200] DATUM/DOT. Max 2× change per adjustment period.
///
///         All units in 10-decimal base (matches DOT planck and DATUM atomic).
///
/// @dev    Hoisted out of DatumSettlement to keep Settlement under EIP-170.
///         Settlement calls `computeAndClipMint(dotPaid)` per batch and
///         receives the effective mint amount (clipped against budgets).
///         Anyone can call permissionless `rollEpoch()` after the halving
///         interval, and `adjustRate()` after the adjustment period.
contract DatumEmissionEngine is DatumOwnable {

    // ─── Baked monetary constants (non-governable) ──────────────────────────
    /// @notice Outer halving cadence — 7 calendar years. Baked.
    uint256 public constant HALVING_PERIOD_SECONDS = 7 * 365 days;
    /// @notice Days per epoch (7 × 365). Daily cap = epoch budget / DAYS_PER_EPOCH.
    uint256 public constant DAYS_PER_EPOCH         = 2555;
    /// @notice Epoch 0 budget in 10-decimal base units. Subsequent epochs halve.
    uint256 public constant EPOCH_0_BUDGET         = 47_500_000 * 10**10;
    /// @notice Safety cap on epoch count. After this many halvings the
    ///         scheduled budget returns 0 — emission permanently stops.
    uint8   public constant TOTAL_EPOCHS           = 30;

    /// @notice Anti-volatility ceiling on per-period rate change.
    uint16  public constant MAX_ADJUSTMENT_RATIO   = 2;
    /// @notice Absolute floor on per-DOT mint rate (0.001 in 10-decimal base).
    uint256 public constant MIN_RATE               = 10**7;
    /// @notice Absolute ceiling on per-DOT mint rate (200 in 10-decimal base).
    uint256 public constant MAX_RATE               = 200 * 10**10;
    /// @notice Bootstrap rate; adapts on first adjustment.
    uint256 public constant INITIAL_RATE           = 19 * 10**10;

    /// @notice Bounds for the governance-tunable adjustment period.
    uint64  public constant ADJUSTMENT_PERIOD_MIN  = 1 days;
    uint64  public constant ADJUSTMENT_PERIOD_MAX  = 90 days;

    // ─── Outer state (epoch tracking) ───────────────────────────────────────
    uint8   public currentEpoch;
    uint256 public epochStartTime;
    /// @notice Remaining mint budget in the current epoch (drained as mints occur).
    uint256 public remainingEpochBudget;

    // ─── Inner state (daily cap + rate) ─────────────────────────────────────
    /// @notice UTC-midnight of the current day. Used for daily cap rollover.
    uint256 public dayStartTime;
    /// @notice Remaining daily emission budget. Resets to dailyCap() each UTC midnight.
    uint256 public remainingDailyCap;
    /// @notice Mints recorded this day (observability; not load-bearing).
    uint256 public dailyMinted;

    /// @notice Current per-DOT mint rate, in 10-decimal base units (DATUM per DOT).
    uint256 public currentRate;
    /// @notice Last `adjustRate()` invocation time.
    uint256 public lastAdjustmentTime;
    /// @notice Cumulative DOT volume seen since the last rate adjustment.
    uint256 public cumulativeDotThisAdjustmentPeriod;

    /// @notice Adjustment cadence. Governance-tunable within [1d, 90d].
    uint64  public adjustmentPeriodSeconds;

    // ─── Counters ───────────────────────────────────────────────────────────
    /// @notice Total DATUM minted across all epochs (defence-in-depth tally
    ///         independent of DatumMintAuthority.totalMinted).
    uint256 public totalMinted;

    // ─── Authorization ──────────────────────────────────────────────────────
    /// @notice Address allowed to call `computeAndClipMint`. Set once
    ///         (lock-once); typically the live Settlement contract.
    address public settlement;

    // ─── Events ─────────────────────────────────────────────────────────────
    event SettlementSet(address indexed settlement);
    event EpochRolled(uint8 indexed newEpoch, uint256 scheduledBudget, uint256 carriedForward);
    event DayRolled(uint256 newDayStart, uint256 dailyCap);
    event RateAdjusted(uint256 newRate, uint256 observedVolume, uint256 previousRate);
    event MintComputed(uint256 dotPaid, uint256 rawMint, uint256 effectiveMint);
    event AdjustmentPeriodSet(uint64 seconds_);

    // ─── Constructor ────────────────────────────────────────────────────────
    constructor() DatumOwnable() {
        currentEpoch                 = 0;
        epochStartTime               = block.timestamp;
        remainingEpochBudget         = EPOCH_0_BUDGET;
        // Anchor the day to the current UTC midnight so the first rollover lines up.
        dayStartTime                 = (block.timestamp / 1 days) * 1 days;
        remainingDailyCap            = scheduledBudget(0) / DAYS_PER_EPOCH;
        currentRate                  = INITIAL_RATE;
        lastAdjustmentTime           = block.timestamp;
        adjustmentPeriodSeconds      = 1 days;
    }

    // ─── Wiring ─────────────────────────────────────────────────────────────
    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(settlement == address(0), "already set");
        settlement = addr;
        emit SettlementSet(addr);
    }

    // ─── Permissionless mechanics ───────────────────────────────────────────

    /// @notice Returns the **scheduled** epoch budget (not the remaining).
    ///         Used to derive `dailyCap()` so the daily target is stable
    ///         through the epoch even as the remaining budget drains.
    function scheduledBudget(uint8 epoch) public pure returns (uint256) {
        if (epoch >= TOTAL_EPOCHS) return 0;
        return EPOCH_0_BUDGET >> uint256(epoch);
    }

    /// @notice Daily mint cap for the current epoch (DATUM in 10-decimal base).
    function dailyCap() public view returns (uint256) {
        return scheduledBudget(currentEpoch) / DAYS_PER_EPOCH;
    }

    /// @notice Roll into the next epoch. Permissionless; reverts before
    ///         the halving period has elapsed. Any unspent budget in the
    ///         current epoch carries forward to the next.
    function rollEpoch() external {
        require(block.timestamp >= epochStartTime + HALVING_PERIOD_SECONDS, "too early");
        uint256 carry = remainingEpochBudget;
        currentEpoch++;
        epochStartTime = block.timestamp;
        remainingEpochBudget = scheduledBudget(currentEpoch) + carry;
        emit EpochRolled(currentEpoch, scheduledBudget(currentEpoch), carry);
    }

    /// @notice Internal: roll the daily cap to today's UTC midnight if needed.
    function _maybeRollDay() internal {
        uint256 currentDayStart = (block.timestamp / 1 days) * 1 days;
        if (currentDayStart > dayStartTime) {
            dayStartTime = currentDayStart;
            remainingDailyCap = dailyCap();
            dailyMinted = 0;
            emit DayRolled(currentDayStart, remainingDailyCap);
        }
    }

    /// @notice Adapt the per-DOT rate based on observed DOT volume.
    ///         Permissionless; reverts before the adjustment period has elapsed.
    function adjustRate() external {
        require(block.timestamp >= lastAdjustmentTime + uint256(adjustmentPeriodSeconds), "too soon");
        _maybeRollDay();

        uint256 observed = cumulativeDotThisAdjustmentPeriod;
        // Period budget = daily_cap * (adjustment_period_in_days)
        uint256 periodBudget = dailyCap() * uint256(adjustmentPeriodSeconds) / 1 days;

        uint256 target;
        if (observed > 0) {
            // observed is in 10-decimal base (planck DOT); rate is in 10-decimal base too.
            // target_rate = period_budget / observed gives a unitless ratio that, multiplied
            // by future dot_paid, produces budget_share in 10-decimal base. So no extra scaling.
            target = (periodBudget * 10**10) / observed;
        } else {
            // No observation: push up toward MAX_RATE.
            target = currentRate * MAX_ADJUSTMENT_RATIO;
        }

        // Anti-volatility: bound at ±2× of current rate.
        uint256 minNext = currentRate / MAX_ADJUSTMENT_RATIO;
        uint256 maxNext = currentRate * MAX_ADJUSTMENT_RATIO;
        if (target < minNext) target = minNext;
        if (target > maxNext) target = maxNext;

        // Absolute floor + ceiling.
        if (target < MIN_RATE) target = MIN_RATE;
        if (target > MAX_RATE) target = MAX_RATE;

        emit RateAdjusted(target, observed, currentRate);
        currentRate                          = target;
        lastAdjustmentTime                   = block.timestamp;
        cumulativeDotThisAdjustmentPeriod    = 0;
    }

    // ─── Settlement integration ─────────────────────────────────────────────

    /// @notice Called by Settlement on every settled batch. Computes the raw
    ///         mint at current rate, clips it against remaining daily and
    ///         epoch budgets, updates accumulators, and returns the effective
    ///         amount Settlement should actually mint.
    /// @param  dotPaid Total DOT settled in this batch (10-decimal base).
    /// @return effective Effective DATUM to mint (10-decimal base).
    function computeAndClipMint(uint256 dotPaid) external returns (uint256 effective) {
        require(msg.sender == settlement, "not settlement");
        if (dotPaid == 0) return 0;

        _maybeRollDay();

        // Track for next rate adjustment.
        cumulativeDotThisAdjustmentPeriod += dotPaid;

        uint256 raw = (dotPaid * currentRate) / 10**10;
        effective   = raw;
        if (effective > remainingDailyCap)    effective = remainingDailyCap;
        if (effective > remainingEpochBudget) effective = remainingEpochBudget;

        remainingDailyCap    -= effective;
        remainingEpochBudget -= effective;
        dailyMinted          += effective;
        totalMinted          += effective;

        emit MintComputed(dotPaid, raw, effective);
    }

    // ─── Owner-tunable params (within baked bounds) ─────────────────────────
    function setAdjustmentPeriod(uint64 seconds_) external onlyOwner {
        require(seconds_ >= ADJUSTMENT_PERIOD_MIN && seconds_ <= ADJUSTMENT_PERIOD_MAX, "E11");
        adjustmentPeriodSeconds = seconds_;
        emit AdjustmentPeriodSet(seconds_);
    }
}
