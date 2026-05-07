// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumZKVerifier
/// @notice Interface for the Groth16 ZK proof verifier.
interface IDatumZKVerifier {
    function verify(bytes calldata proof, bytes32 publicInputsHash, bytes32 nullifier, uint256 impressionCount)
        external view returns (bool valid);
    function vkSet() external view returns (bool);
}
