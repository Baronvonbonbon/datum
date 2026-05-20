// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  ParameterRetuneGuard
/// @notice G-10 first close (2026-05-20): per-parameter cooldown enforced on
///         high-impact economic-parameter setters. Inheriting contracts call
///         `_guardRetune(key)` from each guarded setter; the guard records
///         `lastRetuneBlock[key]` and reverts if the cooldown has not yet
///         elapsed.
///
///         Defense-in-depth layer ON TOP OF the upgrade-ladder Timelock —
///         even if governance is compromised, retunes on critical economic
///         parameters cannot fire faster than `retuneCooldownBlocks`.
///         Stops a fast attack like "compromise governance, snap multiple
///         high-impact parameters in one block, drain the protocol".
///
///         `retuneCooldownBlocks` defaults to 0 (disabled — testnet posture).
///         Production deploys set it to the operational value (e.g. 14400 ≈
///         24h) and optionally fire `lockRetuneCooldown()` to freeze the
///         setter at OpenGov phase. The lock-once mechanism is left to the
///         consuming contract (we don't pull in DatumUpgradable here to keep
///         the mixin minimal and inheritance-friendly).
///
/// @dev    Inheritance pattern:
///           abstract contract MyContract is ParameterRetuneGuard, ... {
///               function setSomeBps(uint16 v) external onlyOwner {
///                   _guardRetune("someBps");
///                   ...
///               }
///           }
///         Keys are arbitrary `bytes32` (typically `keccak256("paramName")`
///         via string literal cast — Solidity widens the conversion).
abstract contract ParameterRetuneGuard {
    /// @notice Block number of the most recent guarded retune per parameter key.
    mapping(bytes32 => uint256) public lastRetuneBlock;

    /// @notice Cooldown window in blocks between guarded retunes on the same
    ///         parameter key. 0 = disabled. Owner-tunable via
    ///         `setRetuneCooldownBlocks` on the inheriting contract.
    uint256 public retuneCooldownBlocks;

    event RetuneGuarded(bytes32 indexed key, uint256 lastBlock, uint256 cooldown);
    event RetuneCooldownBlocksSet(uint256 blocks_);

    error RetuneCooldown();

    /// @notice Inheriting contract calls this from each guarded setter
    ///         BEFORE applying the new value. Records the block as the new
    ///         lastRetuneBlock; reverts if the cooldown hasn't elapsed.
    function _guardRetune(bytes32 key) internal {
        uint256 cd = retuneCooldownBlocks;
        if (cd != 0) {
            uint256 last = lastRetuneBlock[key];
            if (last != 0 && block.number < last + cd) revert RetuneCooldown();
        }
        lastRetuneBlock[key] = block.number;
        emit RetuneGuarded(key, block.number, cd);
    }

    /// @dev Internal setter — inheriting contract exposes this via its own
    ///      owner-gated wrapper. Bounded by `MAX_RETUNE_COOLDOWN_BLOCKS`.
    uint256 internal constant MAX_RETUNE_COOLDOWN_BLOCKS = 432_000; // ~30d

    function _setRetuneCooldownBlocks(uint256 blocks_) internal {
        if (blocks_ > MAX_RETUNE_COOLDOWN_BLOCKS) revert RetuneCooldown();
        retuneCooldownBlocks = blocks_;
        emit RetuneCooldownBlocksSet(blocks_);
    }

    /// @notice View: block at which the next retune on `key` becomes legal.
    ///         Returns 0 if cooldown is disabled.
    function retuneReadyAt(bytes32 key) external view returns (uint256) {
        uint256 cd = retuneCooldownBlocks;
        if (cd == 0) return 0;
        uint256 last = lastRetuneBlock[key];
        if (last == 0) return 0;
        return last + cd;
    }
}
