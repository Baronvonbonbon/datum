// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title MockZKVerifier
/// @notice Test-only stub verifier: any non-empty proof is accepted.
///         Used by benchmark/integration tests that don't have real Groth16 proofs.
contract MockZKVerifier {
    function verify(bytes calldata proof, bytes32) external pure returns (bool) {
        return proof.length > 0;
    }
}
