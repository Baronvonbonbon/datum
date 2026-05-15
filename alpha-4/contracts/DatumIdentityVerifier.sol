// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "./interfaces/IDatumIdentityVerifier.sol";

/// @title DatumIdentityVerifier
/// @notice Groth16 Solidity verifier for the identity circuit
///         (one public input: `commitment`; one private witness: `secret`;
///         the constraint `Poseidon(secret) == commitment`).
///
///         Used by DatumStakeRootV2.challengeRootBalance to prove
///         on-chain that a challenger owns a specific commitment without
///         revealing the underlying secret. The same primitive may be
///         reused by future contracts that gate behaviour on "the caller
///         is the owner of commitment X" — kept as a standalone contract
///         for reusability.
///
///         Structure mirrors DatumZKVerifier (BN254 pairing via the 0x06,
///         0x07, 0x08 precompiles) but for a 1-public-input circuit. VK
///         is set once via setVerifyingKey and locked.
contract DatumIdentityVerifier is IDatumIdentityVerifier, DatumOwnable {
    // -------------------------------------------------------------------------
    // BN254 constants
    // -------------------------------------------------------------------------

    uint256 private constant FIELD_PRIME =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 private constant SCALAR_ORDER =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // -------------------------------------------------------------------------
    // Verification key (1 public input → IC0 constant + IC1 commitment)
    // -------------------------------------------------------------------------

    /// @dev G2 points stored in EIP-197 order: [x_imag, x_real, y_imag, y_real]
    struct VerifyingKey {
        uint256[2] alpha1;
        uint256[4] beta2;
        uint256[4] gamma2;
        uint256[4] delta2;
        uint256[2] IC0;   // constant term
        uint256[2] IC1;   // commitment
    }

    VerifyingKey private _vk;
    bool public override vkSet;

    event VerifyingKeySet(bytes32 indexed vkHash);

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Set Groth16 verification key after trusted setup.
    ///         Run `node scripts/setup-zk-identity.mjs` to generate calldata.
    ///         Lock-once — to rotate the VK, deploy a new verifier and re-wire
    ///         DatumStakeRootV2.setIdentityVerifier (which is plumbingLocked-
    ///         gated rather than per-call lock-once to support that swap).
    function setVerifyingKey(
        uint256[2] calldata alpha1,
        uint256[4] calldata beta2,
        uint256[4] calldata gamma2,
        uint256[4] calldata delta2,
        uint256[2] calldata IC0,
        uint256[2] calldata IC1
    ) external onlyOwner {
        require(!vkSet, "E01");
        _vk.alpha1 = alpha1;
        _vk.beta2  = beta2;
        _vk.gamma2 = gamma2;
        _vk.delta2 = delta2;
        _vk.IC0 = IC0;
        _vk.IC1 = IC1;
        vkSet = true;
        emit VerifyingKeySet(keccak256(abi.encode(
            alpha1, beta2, gamma2, delta2, IC0, IC1
        )));
    }

    // -------------------------------------------------------------------------
    // Verify
    // -------------------------------------------------------------------------

    /// @notice Verify a Groth16 identity proof.
    /// @param proof      256 bytes: ABI-encoded (uint256[2] pi_a, uint256[4] pi_b, uint256[2] pi_c)
    /// @param commitment Public input — caller asserts ownership of this commitment.
    /// @return valid     True iff the proof verifies under the current VK.
    function verifyIdentity(bytes calldata proof, bytes32 commitment)
        external view override returns (bool)
    {
        if (!vkSet) return false;
        if (proof.length != 256) return false;

        (uint256 vkx, uint256 vky) = _computeVKX(uint256(commitment));
        if (vkx == 0 && vky == 0) return false;

        return _pairing(proof, vkx, vky);
    }

    function _computeVKX(uint256 commitmentRaw)
        internal view returns (uint256 vkx, uint256 vky)
    {
        vkx = _vk.IC0[0];
        vky = _vk.IC0[1];
        (vkx, vky) = _acc(vkx, vky, _vk.IC1[0], _vk.IC1[1], commitmentRaw);
    }

    function _pairing(bytes calldata proof, uint256 vkx, uint256 vky)
        internal view returns (bool)
    {
        (uint256[2] memory pi_a, uint256[4] memory pi_b, uint256[2] memory pi_c) =
            abi.decode(proof, (uint256[2], uint256[4], uint256[2]));

        uint256 neg_pi_ay = pi_a[1] == 0 ? 0 : FIELD_PRIME - pi_a[1];

        bytes memory inp = abi.encodePacked(
            pi_a[0], neg_pi_ay,
            pi_b[0], pi_b[1], pi_b[2], pi_b[3],
            _vk.alpha1[0], _vk.alpha1[1],
            _vk.beta2[0], _vk.beta2[1], _vk.beta2[2], _vk.beta2[3],
            vkx, vky,
            _vk.gamma2[0], _vk.gamma2[1], _vk.gamma2[2], _vk.gamma2[3],
            pi_c[0], pi_c[1],
            _vk.delta2[0], _vk.delta2[1], _vk.delta2[2], _vk.delta2[3]
        );
        (bool pok, bytes memory pout) = address(0x08).staticcall(inp);
        if (!pok || pout.length < 32) return false;
        return abi.decode(pout, (uint256)) == 1;
    }

    function _acc(uint256 vkx, uint256 vky, uint256 icx, uint256 icy, uint256 pubRaw)
        internal view returns (uint256, uint256)
    {
        uint256 pub = pubRaw % SCALAR_ORDER;
        (bool ok, bytes memory out) = address(0x07).staticcall(abi.encode(icx, icy, pub));
        if (!ok || out.length < 64) return (0, 0);
        (uint256 mx, uint256 my) = abi.decode(out, (uint256, uint256));
        (bool ok2, bytes memory out2) = address(0x06).staticcall(abi.encode(vkx, vky, mx, my));
        if (!ok2 || out2.length < 64) return (0, 0);
        return abi.decode(out2, (uint256, uint256));
    }

    function getVK() external view returns (VerifyingKey memory) {
        return _vk;
    }
}
