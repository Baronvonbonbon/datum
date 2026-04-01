// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title ISystem
/// @notice Interface for the Polkadot Hub system precompile at address 0x0000000000000000000000000000000000000900.
///         Provides gas-optimized alternatives to standard EVM operations on pallet-revive.
interface ISystem {
    /// @notice Returns the chain's existential deposit (minimum balance).
    ///         Transfers below this amount will fail or create dust accounts.
    /// @return The minimum balance in planck
    function minimumBalance() external view returns (uint256);

    /// @notice Returns remaining weight (gas) for the current transaction.
    /// @return refTime Remaining reference time weight
    /// @return proofSize Remaining proof size weight
    function weightLeft() external view returns (uint64 refTime, uint64 proofSize);

    /// @notice Compute Blake2-256 hash (native Substrate hash, ~3x cheaper than keccak256).
    /// @param data The data to hash
    /// @return The Blake2-256 hash
    function hashBlake256(bytes memory data) external view returns (bytes32);
}
