// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only identity verifier stub. Accepts a proof iff the first
///      byte of the proof equals 0x01 (so tests can deterministically
///      construct "valid" and "invalid" proofs without running circom).
///      Production callers MUST use the real DatumIdentityVerifier; this
///      stub exists only to exercise the integration with DatumStakeRootV2.
contract MockIdentityVerifier {
    function verifyIdentity(bytes calldata proof, bytes32 /*commitment*/)
        external pure returns (bool)
    {
        // First byte 0x01 = "valid"; anything else = "invalid".
        // Length must still be 256 to match the real verifier's gate.
        if (proof.length != 256) return false;
        return proof[0] == 0x01;
    }

    function vkSet() external pure returns (bool) { return true; }
}
