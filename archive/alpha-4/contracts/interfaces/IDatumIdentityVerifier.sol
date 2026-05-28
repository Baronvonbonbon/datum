// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumIdentityVerifier
/// @notice Minimal interface for the ZK identity-proof verifier used by
///         DatumStakeRootV2.challengeRootBalance. The circuit proves the
///         caller knows a `secret` such that `Poseidon(secret) == commitment`
///         without revealing the secret.
interface IDatumIdentityVerifier {
    function verifyIdentity(bytes calldata proof, bytes32 commitment)
        external view returns (bool);
    function vkSet() external view returns (bool);
}
