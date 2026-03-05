// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DatumZKVerifier
/// @notice Stub ZK proof verifier for claim settlement.
///         MVP: accepts any non-empty proof. Post-MVP: replaced with real
///         Groth16/PLONK verifier for second-price auction clearing proofs.
contract DatumZKVerifier {
    /// @notice Verify a ZK proof against a public inputs hash
    /// @param proof The proof bytes (stub: any non-empty bytes pass)
    /// @return valid True if the proof is valid
    function verify(bytes calldata proof, bytes32 /* publicInputsHash */)
        external
        pure
        returns (bool valid)
    {
        return proof.length > 0;
    }
}
