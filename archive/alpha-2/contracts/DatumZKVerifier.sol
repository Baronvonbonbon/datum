// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title DatumZKVerifier
/// @notice Stub ZK proof verifier for claim settlement. Unchanged from alpha.
///         MVP: accepts any non-empty proof. Post-MVP: replaced with real
///         Groth16/PLONK verifier for second-price auction clearing proofs.
contract DatumZKVerifier {
    function verify(bytes calldata proof, bytes32 /* publicInputsHash */)
        external
        pure
        returns (bool valid)
    {
        return proof.length > 0;
    }
}
