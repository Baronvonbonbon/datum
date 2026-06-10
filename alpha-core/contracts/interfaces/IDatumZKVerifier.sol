// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumZKVerifier
/// @notice Interface for the Groth16 ZK proof verifier.
///         Path A: 7 public inputs — see DatumZKVerifier.sol.
interface IDatumZKVerifier {
    /// @notice Path A primary entrypoint. 7 public inputs in circuit order:
    ///         [claimHash, nullifier, impressions,
    ///          stakeRoot, minStake, interestRoot, requiredCategory]
    function verifyA(bytes calldata proof, uint256[7] calldata pubs)
        external view returns (bool valid);

    /// @notice Legacy 3-pub adapter (pads stakeRoot/etc with 0; will fail against
    ///         Path A circuit proofs). Retained only for callers pre-dating Path A.
    function verify(bytes calldata proof, bytes32 publicInputsHash, bytes32 nullifier, uint256 impressionCount)
        external view returns (bool valid);

    function vkSet() external view returns (bool);
}
