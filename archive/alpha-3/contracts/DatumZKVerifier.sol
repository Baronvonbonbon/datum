// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title DatumZKVerifier
/// @notice Real Groth16 verifier using BN254 precompiles:
///           0x06 — ecAdd (G1 addition)
///           0x07 — ecMul (G1 scalar multiply)
///           0x08 — ecPairing (BN254 pairing check)
///
///         Proof format (256 bytes, ABI-encoded):
///           pi_a  : uint256[2]   — G1 point (64 bytes)
///           pi_b  : uint256[4]   — G2 point in EIP-197 order
///                                  [x_imag, x_real, y_imag, y_real] (128 bytes)
///           pi_c  : uint256[2]   — G1 point (64 bytes)
///
///         Public inputs (3):
///           pub0 = claimHash   — blake256/keccak256(campaignId, publisher, user, eventCount, ...)
///           pub1 = nullifier   — Poseidon(userSecret, campaignId, windowId)
///           pub2 = impressions — impression count; must equal claim.eventCount (enforced by caller)
///           All truncated to BN254 scalar field: uint256(x) % SCALAR_ORDER
///
///         Circuit: circuits/impression.circom
///           3 public inputs (claimHash, nullifier, impressions), 4 private witnesses
///           Constraints: Num2Bits(32) + nonce binding + Poseidon(3) ≈ 293 total
///
///         VK must be set by owner after running scripts/setup-zk.mjs.
///         While unset, verify() returns false (fail-safe).
contract DatumZKVerifier is Ownable2Step {

    // -------------------------------------------------------------------------
    // BN254 constants
    // -------------------------------------------------------------------------

    /// @dev BN254 base field prime (Fp)
    uint256 private constant FIELD_PRIME =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    /// @dev BN254 scalar field order (Fr) — public inputs must be < this
    uint256 private constant SCALAR_ORDER =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // -------------------------------------------------------------------------
    // Verification key
    // -------------------------------------------------------------------------

    /// @dev G2 points stored in EIP-197 order: [x_imag, x_real, y_imag, y_real]
    struct VerifyingKey {
        uint256[2] alpha1;   // G1: [x, y]
        uint256[4] beta2;    // G2: [x_imag, x_real, y_imag, y_real]
        uint256[4] gamma2;   // G2: [x_imag, x_real, y_imag, y_real]
        uint256[4] delta2;   // G2: [x_imag, x_real, y_imag, y_real]
        uint256[2] IC0;      // G1 constant term
        uint256[2] IC1;      // G1 coefficient for public input 0 (claimHash)
        uint256[2] IC2;      // G1 coefficient for public input 1 (nullifier)
        uint256[2] IC3;      // G1 coefficient for public input 2 (impressions)
    }

    VerifyingKey private _vk;
    bool public vkSet;

    /// @notice AUDIT-018: Includes hash of the full VK for on-chain auditability.
    event VerifyingKeySet(bytes32 indexed vkHash);

    constructor() Ownable(msg.sender) {}

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Set Groth16 verification key after trusted setup.
    ///         G2 point arrays must be in EIP-197 order: [x_imag, x_real, y_imag, y_real].
    ///         Run `node scripts/setup-zk.mjs` to generate these values.
    ///         IC3 is the coefficient for the third public input (impressions).
    ///         Re-run setup after any circuit change.
    function setVerifyingKey(
        uint256[2] calldata alpha1,
        uint256[4] calldata beta2,
        uint256[4] calldata gamma2,
        uint256[4] calldata delta2,
        uint256[2] calldata IC0,
        uint256[2] calldata IC1,
        uint256[2] calldata IC2,
        uint256[2] calldata IC3
    ) external onlyOwner {
        _vk.alpha1 = alpha1;
        _vk.beta2   = beta2;
        _vk.gamma2  = gamma2;
        _vk.delta2  = delta2;
        _vk.IC0     = IC0;
        _vk.IC1     = IC1;
        _vk.IC2     = IC2;
        _vk.IC3     = IC3;
        vkSet = true;
        bytes32 vkHash = keccak256(abi.encode(alpha1, beta2, gamma2, delta2, IC0, IC1, IC2, IC3));
        emit VerifyingKeySet(vkHash); // AUDIT-018: include VK hash for auditability
    }

    function _checkOwner() internal view override {
        require(owner() == msg.sender, "E18");
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "E00");
        super.transferOwnership(newOwner);
    }

    function acceptOwnership() public override {
        require(msg.sender == pendingOwner(), "E18");
        _transferOwnership(msg.sender);
    }

    function renounceOwnership() public override onlyOwner {
        revert("E18");
    }

    // -------------------------------------------------------------------------
    // Verify
    // -------------------------------------------------------------------------

    /// @notice Verify a Groth16 proof for an impression claim.
    /// @param proof              256 bytes: ABI-encoded (uint256[2] pi_a, uint256[4] pi_b, uint256[2] pi_c)
    /// @param publicInputsHash   Claim hash from DatumClaimValidator (blake256/keccak256)
    /// @param nullifier          Poseidon(userSecret, campaignId, windowId) — FP-5 replay prevention
    /// @param impressionCount    claim.eventCount — must equal the impressions value the proof was generated with.
    ///                           The pairing check enforces this: a proof generated with impressions=N
    ///                           fails if impressionCount != N, preventing publisher inflation of eventCount.
    /// @return valid  True iff proof is valid for these public inputs under the current VK.
    function verify(bytes calldata proof, bytes32 publicInputsHash, bytes32 nullifier, uint256 impressionCount)
        external
        view
        returns (bool valid)
    {
        if (!vkSet)            return false;
        if (proof.length != 256) return false;

        // Decode proof
        (uint256[2] memory pi_a, uint256[4] memory pi_b, uint256[2] memory pi_c) =
            abi.decode(proof, (uint256[2], uint256[4], uint256[2]));

        // Public inputs truncated to BN254 scalar field
        uint256 pub0 = uint256(publicInputsHash) % SCALAR_ORDER;
        uint256 pub1 = uint256(nullifier) % SCALAR_ORDER;
        uint256 pub2 = impressionCount % SCALAR_ORDER;

        // vk_x = IC0 + IC1*pub0 + IC2*pub1 + IC3*pub2
        // Step 1: IC1 * pub0  (ecMul, precompile 0x07)
        uint256 vkx; uint256 vky;
        {
            (bool ok, bytes memory out) = address(0x07).staticcall(
                abi.encode(_vk.IC1[0], _vk.IC1[1], pub0)
            );
            if (!ok || out.length < 64) return false;
            (vkx, vky) = abi.decode(out, (uint256, uint256));
        }
        // Step 2: IC0 + (IC1*pub0)  (ecAdd, precompile 0x06)
        {
            (bool ok, bytes memory out) = address(0x06).staticcall(
                abi.encode(_vk.IC0[0], _vk.IC0[1], vkx, vky)
            );
            if (!ok || out.length < 64) return false;
            (vkx, vky) = abi.decode(out, (uint256, uint256));
        }
        // Step 3: IC2 * pub1  (ecMul, precompile 0x07)
        uint256 ic2x; uint256 ic2y;
        {
            (bool ok, bytes memory out) = address(0x07).staticcall(
                abi.encode(_vk.IC2[0], _vk.IC2[1], pub1)
            );
            if (!ok || out.length < 64) return false;
            (ic2x, ic2y) = abi.decode(out, (uint256, uint256));
        }
        // Step 4: vk_x + (IC2*pub1)  (ecAdd, precompile 0x06)
        {
            (bool ok, bytes memory out) = address(0x06).staticcall(
                abi.encode(vkx, vky, ic2x, ic2y)
            );
            if (!ok || out.length < 64) return false;
            (vkx, vky) = abi.decode(out, (uint256, uint256));
        }
        // Step 5: IC3 * pub2  (ecMul, precompile 0x07)
        uint256 ic3x; uint256 ic3y;
        {
            (bool ok, bytes memory out) = address(0x07).staticcall(
                abi.encode(_vk.IC3[0], _vk.IC3[1], pub2)
            );
            if (!ok || out.length < 64) return false;
            (ic3x, ic3y) = abi.decode(out, (uint256, uint256));
        }
        // Step 6: vk_x + (IC3*pub2)  (ecAdd, precompile 0x06)
        {
            (bool ok, bytes memory out) = address(0x06).staticcall(
                abi.encode(vkx, vky, ic3x, ic3y)
            );
            if (!ok || out.length < 64) return false;
            (vkx, vky) = abi.decode(out, (uint256, uint256));
        }

        // Negate pi_a for the pairing check: -A = (x, p - y)
        uint256 neg_pi_ay = pi_a[1] == 0 ? 0 : FIELD_PRIME - pi_a[1];

        // Pairing check (precompile 0x08, EIP-197):
        //   e(-A, B) · e(alpha1, beta2) · e(vk_x, gamma2) · e(C, delta2) == 1
        //
        // Each G2 pair slot: [x_imag, x_real, y_imag, y_real] (already in EIP-197 order)
        bytes memory inp = abi.encodePacked(
            // pair 0: (-pi_a, pi_b)
            pi_a[0], neg_pi_ay,
            pi_b[0], pi_b[1], pi_b[2], pi_b[3],
            // pair 1: (alpha1, beta2)
            _vk.alpha1[0], _vk.alpha1[1],
            _vk.beta2[0], _vk.beta2[1], _vk.beta2[2], _vk.beta2[3],
            // pair 2: (vk_x, gamma2)
            vkx, vky,
            _vk.gamma2[0], _vk.gamma2[1], _vk.gamma2[2], _vk.gamma2[3],
            // pair 3: (pi_c, delta2)
            pi_c[0], pi_c[1],
            _vk.delta2[0], _vk.delta2[1], _vk.delta2[2], _vk.delta2[3]
        );

        (bool pok, bytes memory pout) = address(0x08).staticcall(inp);
        if (!pok || pout.length < 32) return false;
        return abi.decode(pout, (uint256)) == 1;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getVK() external view returns (VerifyingKey memory) {
        return _vk;
    }
}
