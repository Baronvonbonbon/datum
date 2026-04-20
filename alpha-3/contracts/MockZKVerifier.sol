// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only ZK verifier stub — accepts any non-empty proof as valid.
///      Matches the DatumZKVerifier interface: verify(bytes,bytes32,bytes32) → bool.
contract MockZKVerifier {
    function verify(bytes calldata proof, bytes32 /*publicInputsHash*/, bytes32 /*nullifier*/) external pure returns (bool) {
        return proof.length > 0;
    }
}
