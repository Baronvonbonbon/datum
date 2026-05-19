// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  IDatumNullifierRegistry
/// @notice Settlement-facing surface for the FP-5 per-campaign nullifier
///         replay-prevention module. Carved back out of DatumSettlement
///         (was alpha-3 satellite, re-merged in alpha-4, un-merged here
///         to fit Settlement under EIP-170 on mainnet).
interface IDatumNullifierRegistry {
    /// @notice Atomic check-and-set: returns true if `nullifier` was fresh
    ///         (now marked used) and false if it had already been used for
    ///         this campaign. msg.sender must be the wired settlement.
    function tryConsume(uint256 campaignId, bytes32 nullifier) external returns (bool);

    /// @notice Window divisor baked into off-chain ZK nullifier preimages.
    ///         Settlement reads this via `validateConfiguration` to confirm
    ///         the ZK path is correctly configured. Lock-once on the
    ///         underlying contract.
    function nullifierWindowBlocks() external view returns (uint256);
}
