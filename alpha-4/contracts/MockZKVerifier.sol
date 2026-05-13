// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only ZK verifier stub — accepts any non-empty proof as valid.
///      Matches the DatumZKVerifier interface (Path A: 7-pub verifyA + legacy 3-pub verify).
contract MockZKVerifier {
    function verify(bytes calldata proof, bytes32 /*publicInputsHash*/, bytes32 /*nullifier*/, uint256 /*impressionCount*/) external pure returns (bool) {
        return proof.length > 0;
    }

    function verifyA(bytes calldata proof, uint256[7] calldata /*pubs*/) external pure returns (bool) {
        return proof.length > 0;
    }

    function vkSet() external pure returns (bool) { return true; }
}
