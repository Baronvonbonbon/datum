// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./interfaces/IDatumNullifierRegistry.sol";

/// @title  DatumNullifierRegistry
/// @notice FP-5 per-campaign nullifier replay-prevention. Off-chain ZK
///         clients derive `windowId = block.number / nullifierWindowBlocks`
///         and bake it into the nullifier preimage; this contract tracks
///         which nullifiers have been observed and rejects collisions.
///
/// @dev    Settlement is the sole writer via `tryConsume`. The atomic
///         check-and-set replaces the previous split-check/register
///         pattern in the inline implementation -- observable semantics
///         are identical because the only logic that used to sit between
///         the check and the register was a CEI state update that cannot
///         fail (lastClaimHash / lastNonce mapping writes).
///
/// @dev    `nullifierWindowBlocks` is lock-once after first non-zero set.
///         Changing the divisor mid-flight would either DoS every in-flight
///         ZK proof (newly-derived windowIds don't match those baked into
///         the existing proofs) or, worse, let a previously-burned
///         nullifier re-map to a fresh windowId and re-settle.
contract DatumNullifierRegistry is IDatumNullifierRegistry, DatumUpgradable {
    function version() public pure override returns (uint256) { return 1; }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    address public settlement;
    bool public plumbingLocked;

    // ─────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Window size used by off-chain ZK clients to derive windowIds.
    ///         Lock-once after first non-zero set.
    uint256 public nullifierWindowBlocks;

    /// @dev campaignId => nullifier => used
    mapping(uint256 => mapping(bytes32 => bool)) private _used;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event NullifierSubmitted(uint256 indexed campaignId, bytes32 indexed nullifier);
    event NullifierWindowBlocksSet(uint256 oldValue, uint256 newValue);
    event SettlementSet(address indexed settlement);
    event PlumbingLocked();

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E11();
    error OnlySettlement();
    error LockedAlready();
    error WindowFrozen();

    // ─────────────────────────────────────────────────────────────────────
    // Wiring setters
    // ─────────────────────────────────────────────────────────────────────

    function setSettlement(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        settlement = addr;
        emit SettlementSet(addr);
    }

    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert LockedAlready();
        if (settlement == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────

    function setNullifierWindowBlocks(uint256 windowBlocks) external onlyOwner whenNotFrozen {
        if (windowBlocks == 0) revert E11();
        if (nullifierWindowBlocks != 0) revert WindowFrozen();
        emit NullifierWindowBlocksSet(nullifierWindowBlocks, windowBlocks);
        nullifierWindowBlocks = windowBlocks;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Settlement entry point
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDatumNullifierRegistry
    function tryConsume(uint256 campaignId, bytes32 nullifier) external returns (bool) {
        if (msg.sender != settlement) revert OnlySettlement();
        if (nullifier == bytes32(0)) return true; // skip = bypass (matches caller's "no nullifier" path)
        if (_used[campaignId][nullifier]) return false;
        _used[campaignId][nullifier] = true;
        emit NullifierSubmitted(campaignId, nullifier);
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────

    function isNullifierUsed(uint256 campaignId, bytes32 nullifier) external view returns (bool) {
        return _used[campaignId][nullifier];
    }
}
