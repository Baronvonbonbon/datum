// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/// @title XcmTransactEncoder
/// @notice Pure SCALE encoder for the XCM v5 message that DatumPeopleChainXcmBridge
///         dispatches to People Chain via the IXcm precompile.
///
/// @dev    Hand-rolled SCALE primitives in Solidity. The message shape is fixed:
///
///         VersionedXcm::V5(Xcm(vec![
///             WithdrawAsset([
///                 MultiAsset { id: AssetId(MultiLocation { parents: 1, interior: Here }),
///                              fun: Fungibility::Fungible(fee) }
///             ]),
///             PayFees { asset: <same MultiAsset> },
///             Transact {
///                 origin_kind: SovereignAccount,
///                 require_weight_at_most: Weight { ref_time, proof_size },
///                 call: DoubleEncodedCall { encoded: [pallet_idx, call_idx, user[0..32]] }
///             }
///         ]))
///
///         "DOT on Hub" = MultiLocation { parents: 1, interior: Here } (one-up to the relay).
///         Variable: user (32 bytes), fee (u128), ref_time (u64), proof_size (u64),
///                   pallet_idx (u8), call_idx (u8). All other bytes are constants.
///
/// @dev    XCM v5 vs v4 differences relevant to this encoder:
///           - VersionedXcm discriminator: V5 = 5 (was V4 = 4).
///           - V5 introduces `PayFees { asset }` (discriminator 48) which replaces
///             the V4 `BuyExecution { fees, weight_limit }` (discriminator 19).
///             PayFees has no weight_limit field — the executor uses the asset
///             as fee budget until exhausted.
///           - Instruction discriminators for WithdrawAsset (0) and Transact (6)
///             are unchanged from V4 to V5. The Transact struct shape is also
///             unchanged: { originKind, requireWeightAtMost, call }.
///           - MultiLocation / MultiAsset / Fungibility / Junctions byte layouts
///             are unchanged from V4 to V5.
///
///         XCM v5 InstructionV5 enum discriminator indices (0-based) used here:
///           WithdrawAsset      = 0
///           Transact           = 6
///           PayFees            = 48   (replaces V4 BuyExecution = 19)
///         Other V5 discriminators reserved for future use:
///           RefundSurplus      = 20
///           DepositAsset       = 13
///           UnpaidExecution    = 47
///         VersionedXcm enum discriminator: V5 = 5
///         OriginKind enum: SovereignAccount = 1
///         JunctionsV5 enum: Here = 0, X1 = 1, ..., X8 = 8
///         FungibilityV5 enum: Fungible = 0
library XcmTransactEncoder {

    // ─────────────────────────────────────────────────────────────────────────
    // SCALE primitives
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice SCALE compact-encode a uint256. Used for vec lengths, asset
    ///         amounts, ref_time, proof_size.
    /// @dev    Mode markers (low 2 bits):
    ///           00 — single byte, value < 64
    ///           01 — two bytes,   value < 2^14
    ///           10 — four bytes,  value < 2^30
    ///           11 — big-int (>= 2^30): leading byte gives extra-byte count,
    ///                followed by LE bytes
    function compact(uint256 value) internal pure returns (bytes memory) {
        if (value < (1 << 6)) {
            // Mode 00: single byte
            return abi.encodePacked(uint8(value << 2));
        } else if (value < (1 << 14)) {
            // Mode 01: two bytes LE
            uint16 v = uint16((value << 2) | 0x01);
            return abi.encodePacked(uint8(v), uint8(v >> 8));
        } else if (value < (1 << 30)) {
            // Mode 10: four bytes LE
            uint32 v = uint32((value << 2) | 0x02);
            return abi.encodePacked(uint8(v), uint8(v >> 8), uint8(v >> 16), uint8(v >> 24));
        } else {
            // Mode 11: variable-length big-int. Count of trailing bytes - 4.
            bytes memory tmp = new bytes(33);
            uint256 n = 0;
            uint256 v = value;
            while (v != 0) {
                tmp[n++] = bytes1(uint8(v & 0xff));
                v >>= 8;
            }
            require(n >= 4 && n <= 67, "compact-range");
            bytes memory out = new bytes(1 + n);
            out[0] = bytes1(uint8(((n - 4) << 2) | 0x03));
            for (uint256 i = 0; i < n; i++) {
                out[1 + i] = tmp[i];
            }
            return out;
        }
    }

    /// @notice Encode a uint8 as a single byte.
    function u8(uint8 v) internal pure returns (bytes memory) {
        return abi.encodePacked(v);
    }

    /// @notice Encode a uint32 little-endian, 4 bytes.
    function u32le(uint32 v) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(v), uint8(v >> 8), uint8(v >> 16), uint8(v >> 24)
        );
    }

    /// @notice Encode raw bytes32 (e.g., AccountId32).
    function bytes32Raw(bytes32 b) internal pure returns (bytes memory) {
        return abi.encodePacked(b);
    }

    /// @notice Encode a SCALE Vec<u8> (compact-length prefix + bytes).
    function vecU8(bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(compact(data.length), data);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // XCM v4 fragments
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Encode MultiLocation { parents: 1, interior: Here } — i.e., the
    ///         relay chain's native asset (DOT on Polkadot Hub, PAS on Paseo Hub).
    /// @dev    parents (u8) || JunctionsV4::Here (enum index 0).
    function locationParentRelay() internal pure returns (bytes memory) {
        // parents = 1, interior = Here (enum 0).
        return abi.encodePacked(uint8(1), uint8(0));
    }

    /// @notice Encode MultiAsset { id: relay-native, fun: Fungible(amount) }.
    function fungibleRelayAsset(uint128 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(
            locationParentRelay(),     // AssetIdV4 = MultiLocationV4
            uint8(0),                  // FungibilityV4 enum: Fungible = 0
            compact(amount)            // Compact<u128>
        );
    }

    /// @notice Encode MultiAssets (Vec<MultiAsset>) holding a single fungible asset.
    function fungibleRelayAssets(uint128 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(
            compact(1),                // Vec length = 1
            fungibleRelayAsset(amount)
        );
    }

    /// @notice Encode XCM v4 instruction WithdrawAsset(assets).
    function withdrawAsset(uint128 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(0),                      // InstructionV4 enum: WithdrawAsset = 0
            fungibleRelayAssets(amount)
        );
    }

    /// @notice Encode XCM v5 instruction PayFees { asset }.
    /// @dev    V5 replacement for V4 BuyExecution. The executor draws from
    ///         this asset (already in holding via WithdrawAsset) as needed
    ///         for execution; no separate weight_limit field.
    function payFees(uint128 fees) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(48),                     // InstructionV5 enum: PayFees = 48
            fungibleRelayAsset(fees)       // single MultiAsset
        );
    }

    /// @notice Legacy V4 BuyExecution. Retained for callers explicitly targeting
    ///         V4-only XCM channels. New code should use payFees() with V5.
    function buyExecutionUnlimited(uint128 fees) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(19),                     // InstructionV4 enum: BuyExecution = 19
            fungibleRelayAsset(fees),
            uint8(0)                       // WeightLimit enum: Unlimited = 0
        );
    }

    /// @notice Encode XCM v4 instruction Transact { origin_kind: SovereignAccount,
    ///         require_weight_at_most: Weight(ref_time, proof_size),
    ///         call: DoubleEncodedCall { encoded: callData } }.
    function transactSovereign(
        uint64 refTime,
        uint64 proofSize,
        bytes memory callData
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(6),                      // InstructionV4 enum: Transact = 6
            uint8(1),                      // OriginKind enum: SovereignAccount = 1
            compact(uint256(refTime)),     // WeightV2.refTime: Compact<u64>
            compact(uint256(proofSize)),   // WeightV2.proofSize: Compact<u64>
            vecU8(callData)                // DoubleEncodedCall.encoded: Vec<u8>
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // People Chain call encoding
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Encode the inner People Chain extrinsic for
    ///         `datum_identity_relay::identity_query(user)`.
    /// @dev    Substrate Call layout: pallet_index (u8) || call_index (u8) ||
    ///         encoded args. The single arg here is AccountId32 = [u8;32].
    function encodeIdentityQueryCall(
        uint8 palletIndex,
        uint8 callIndex,
        bytes32 user
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(palletIndex, callIndex, user);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Top-level message
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Encode the full VersionedXcm::V4(Xcm(vec![...])) message used by
    ///         the bridge.
    /// @param  user        AccountId32 of the user whose identity to query.
    /// @param  feeWei   Fee amount in Hub-native 18-dec wei (the WithdrawAsset/PayFees amount).
    /// @param  refTime     Weight::refTime for the Transact instruction.
    /// @param  proofSize   Weight::proofSize for the Transact instruction.
    /// @param  palletIndex Index of the datum_identity_relay pallet on People Chain.
    /// @param  callIndex   Index of the identity_query dispatchable on that pallet.
    function encodeIdentityQueryXcm(
        bytes32 user,
        uint128 feeWei,
        uint64  refTime,
        uint64  proofSize,
        uint8   palletIndex,
        uint8   callIndex
    ) internal pure returns (bytes memory) {
        bytes memory callData = encodeIdentityQueryCall(palletIndex, callIndex, user);

        // Inner Xcm = Vec<Instruction>. V5 idiomatic shape emits 3 instructions:
        //   [WithdrawAsset, PayFees, Transact]
        bytes memory instructions = abi.encodePacked(
            compact(3),
            withdrawAsset(feeWei),
            payFees(feeWei),
            transactSovereign(refTime, proofSize, callData)
        );

        // VersionedXcm::V5 discriminator = 5.
        return abi.encodePacked(uint8(5), instructions);
    }
}
