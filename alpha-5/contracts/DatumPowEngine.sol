// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./interfaces/IDatumPowEngine.sol";

/// @title  DatumPowEngine
/// @notice Per-impression proof-of-work engine, carved out of DatumSettlement
///         so it can be upgraded independently via DatumGovernanceRouter and
///         so Settlement fits under EIP-170 on mainnet.
///
/// @dev    Difficulty driver = a per-user **leaky bucket** of "recent abuse
///         credits" that drains linearly with time. Each settled batch adds
///         `eventCount` to the bucket; the bucket drains 1 unit per
///         `powBucketLeakPerN` blocks. Sustained abuse keeps the bucket full
///         and quadratic difficulty kicks in; slowing or stopping drains the
///         bucket and difficulty decays back to baseline.
///
///         Difficulty curve (all params governable):
///           bucket    = max(0, userPowBucket - (blocksElapsed / powBucketLeakPerN))
///           shift     = powBaseShift                          // absolute floor
///                     + bucket / powLinearDivisor             // gentle linear growth
///                     + (bucket / powQuadDivisor)^2           // quadratic on sustained abuse
///           shift capped at POW_MAX_SHIFT (64 = effectively impossible).
///           target    = (type(uint256).max >> shift) / eventCount
///
///         Per-batch consume: Settlement aggregates `eventCount` across all
///         claims in a `_processBatch` invocation and calls `consumeFor`
///         exactly once. This is semantically identical to the previous
///         per-claim inline updates because successive claims within the
///         same batch all share `lastUpdate == block.number` after the
///         first, so the drain term resolves to zero and only the
///         accumulator advances.
contract DatumPowEngine is IDatumPowEngine, DatumUpgradable {
    function version() public pure override returns (uint256) { return 1; }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Settlement contract permitted to call `consumeFor`. Locked
    ///         once via `lockPlumbing` after wiring is verified.
    address public settlement;

    /// @notice Parallel governance hook authorized to tune the curve.
    ///         Lock-once; intended to be set to `DatumParameterGovernance`.
    address public parameterGovernance;

    /// @notice Cypherpunk plumbing-lock. While false, owner can rewire the
    ///         settlement pointer (testnet / migration). Once true, the
    ///         pointer is frozen forever.
    bool public plumbingLocked;

    // ─────────────────────────────────────────────────────────────────────
    // PoW parameters
    // ─────────────────────────────────────────────────────────────────────

    bool    public enforcePow;
    uint8   public powBaseShift       = 8;
    uint32  public powLinearDivisor   = 60;
    uint32  public powQuadDivisor     = 100;
    uint32  public powBucketLeakPerN  = 1440;
    uint8   public constant POW_MAX_SHIFT = 64;

    mapping(address => uint256) public userPowBucket;
    mapping(address => uint256) public userPowBucketLastUpdate;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event PowEnforcementSet(bool enforced);
    event PowDifficultyCurveSet(uint8 baseShift, uint32 linearDivisor, uint32 quadDivisor, uint32 bucketLeakPerN);
    event SettlementSet(address indexed settlement);
    event ParameterGovernanceSet(address indexed pg);
    event PlumbingLocked();

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E11();
    error E18();
    error AlreadySet();
    error OnlySettlement();
    error LockedAlready();

    // ─────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────

    modifier onlyOwnerOrPG() {
        if (!(msg.sender == owner() || msg.sender == parameterGovernance)) revert E18();
        _;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring setters
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Wire (or rewire pre-lock) the Settlement contract permitted to
    ///         call `consumeFor`. Owner-only; locked by `lockPlumbing`.
    function setSettlement(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        settlement = addr;
        emit SettlementSet(addr);
    }

    /// @notice Wire ParameterGovernance for the difficulty-curve setter.
    ///         Lock-once.
    function setParameterGovernance(address pg) external onlyOwner {
        if (pg == address(0)) revert E00();
        if (plumbingLocked) revert LockedAlready();
        parameterGovernance = pg;
        emit ParameterGovernanceSet(pg);
    }

    /// @notice Cypherpunk lock for the Settlement pointer. Pre-OpenGov this
    ///         is gated to the OpenGov phase via `whenOpenGovPhase`, matching
    ///         the upgrade-ladder pattern.
    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert LockedAlready();
        if (settlement == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoW admin
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Enable / disable per-impression PoW enforcement.
    function setEnforcePow(bool enforced) external onlyOwner whenNotFrozen {
        enforcePow = enforced;
        emit PowEnforcementSet(enforced);
    }

    /// @notice Update the PoW difficulty curve. All four params bounded to
    ///         prevent footguns: baseShift in [1, 32], divisors > 0, leak > 0.
    /// @dev    Callable by owner OR `parameterGovernance` (via PG.execute()).
    function setPowDifficultyCurve(
        uint8 baseShift,
        uint32 linearDivisor,
        uint32 quadDivisor,
        uint32 bucketLeakPerN
    ) external onlyOwnerOrPG whenNotFrozen {
        if (!(baseShift >= 1 && baseShift <= 32)) revert E11();
        if (linearDivisor == 0) revert E11();
        if (quadDivisor == 0) revert E11();
        if (bucketLeakPerN == 0) revert E11();
        powBaseShift = baseShift;
        powLinearDivisor = linearDivisor;
        powQuadDivisor = quadDivisor;
        powBucketLeakPerN = bucketLeakPerN;
        emit PowDifficultyCurveSet(baseShift, linearDivisor, quadDivisor, bucketLeakPerN);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PoW views
    // ─────────────────────────────────────────────────────────────────────

    function _readPowBucket(address user) internal view returns (uint256) {
        uint256 stored = userPowBucket[user];
        if (stored == 0) return 0;
        uint256 lastUpdate = userPowBucketLastUpdate[user];
        if (lastUpdate == 0) return stored;
        uint256 elapsed = block.number - lastUpdate;
        uint256 drained = elapsed / uint256(powBucketLeakPerN);
        return stored > drained ? stored - drained : 0;
    }

    /// @inheritdoc IDatumPowEngine
    function powTargetForUser(address user, uint256 eventCount) public view returns (uint256) {
        if (!enforcePow || eventCount == 0) return type(uint256).max;
        uint256 bucket = _readPowBucket(user);

        // Quadratic with linear floor: shift = base + (bucket/linDiv) + (bucket/quadDiv)^2
        uint256 linearExtra = bucket / uint256(powLinearDivisor);
        uint256 quadInput = bucket / uint256(powQuadDivisor);
        if (quadInput > type(uint32).max) quadInput = type(uint32).max;
        uint256 quadExtra = quadInput * quadInput;

        uint256 shift = uint256(powBaseShift) + linearExtra + quadExtra;
        if (shift >= POW_MAX_SHIFT) return 0;

        return (type(uint256).max >> shift) / eventCount;
    }

    /// @notice Effective bucket level for a user right now (lazy decay applied).
    function userPowBucketEffective(address user) external view returns (uint256) {
        return _readPowBucket(user);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Hot path
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDatumPowEngine
    /// @dev Called once per `_processBatch` in DatumSettlement with the
    ///      sum of `eventCount` across all settled claims for the user.
    ///      Drains the bucket by the elapsed-blocks-since-last-update, then
    ///      adds the batch's events. Drives difficulty for the *next* batch.
    function consumeFor(address user, uint256 eventCount) external {
        if (msg.sender != settlement) revert OnlySettlement();
        if (eventCount == 0) return;

        uint256 stored = userPowBucket[user];
        uint256 lastUpdate = userPowBucketLastUpdate[user];
        uint256 drained;
        if (lastUpdate != 0) {
            drained = (block.number - lastUpdate) / uint256(powBucketLeakPerN);
        }
        uint256 afterDrain = stored > drained ? stored - drained : 0;
        userPowBucket[user] = afterDrain + eventCount;
        userPowBucketLastUpdate[user] = block.number;
    }
}
