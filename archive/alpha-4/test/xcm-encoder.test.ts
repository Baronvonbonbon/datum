// Phase A spike: SCALE / XCM v5 encoder unit tests for XcmTransactEncoder.
//
// Test vectors are hand-computed from the SCALE codec spec and the XCM v5
// type definitions in @polkadot/types/interfaces/xcm/v5.js. The full-message
// vector at the bottom should be cross-checked against @polkadot/api once
// scripts/build-xcm-reference.ts is wired (Stage 0.5). Until then it is a
// hand-rolled reference auditable against the spec.
//
// V5 vs V4 differences relevant here:
//   - VersionedXcm discriminator: 0x05 (was 0x04).
//   - V5 introduces PayFees { asset } (discriminator 48 = 0x30) replacing
//     V4's BuyExecution { fees, weight_limit } (discriminator 19 = 0x13).
//     PayFees has no weight_limit field — the executor draws from the
//     asset as needed.
//   - Other instructions (WithdrawAsset = 0, Transact = 6) and the
//     MultiLocation / MultiAsset byte layouts are unchanged.

import { expect } from "chai";
import { ethers } from "hardhat";
import { MockXcmEncoderHarness } from "../typechain-types";

describe("XcmTransactEncoder (SCALE primitives + XCM v4 message)", function () {
  let h: MockXcmEncoderHarness;

  before(async function () {
    const F = await ethers.getContractFactory("MockXcmEncoderHarness");
    h = await F.deploy();
  });

  describe("SCALE compact()", function () {
    // Spec: low 2 bits = mode.
    //   00 single byte (v << 2), valid for v < 2^6
    //   01 two bytes LE ((v << 2) | 1), valid for v < 2^14
    //   10 four bytes LE ((v << 2) | 2), valid for v < 2^30
    //   11 big-int: leading byte ((n-4)<<2)|3, then n LE bytes

    it("encodes 0 as single zero byte (mode 00)", async () => {
      expect(await h.compact(0)).to.equal("0x00");
    });
    it("encodes 1 as 0x04 (mode 00)", async () => {
      expect(await h.compact(1)).to.equal("0x04");
    });
    it("encodes 63 as 0xfc (mode 00 max)", async () => {
      expect(await h.compact(63)).to.equal("0xfc");
    });
    it("encodes 64 as 0x0101 (mode 01 min)", async () => {
      expect(await h.compact(64)).to.equal("0x0101");
    });
    it("encodes 16383 as 0xfdff (mode 01 max)", async () => {
      expect(await h.compact(16383)).to.equal("0xfdff");
    });
    it("encodes 16384 as 0x02000100 (mode 10 min)", async () => {
      expect(await h.compact(16384)).to.equal("0x02000100");
    });
    it("encodes 1_073_741_823 as 0xfeffffff (mode 10 max)", async () => {
      expect(await h.compact(1_073_741_823n)).to.equal("0xfeffffff");
    });
    it("encodes 1_073_741_824 as 0x0300000040 (mode 11, n=4)", async () => {
      // 2^30; needs 4 bytes value, leading byte = ((4-4)<<2)|3 = 3.
      expect(await h.compact(1_073_741_824n)).to.equal("0x0300000040");
    });
    it("encodes 5_000_000_000 as 0x070000f2052a01 — wait, let's verify", async () => {
      // 5_000_000_000 = 0x0_1_2A_05_F2_00 = needs 5 bytes.
      // LE: 0x00 0xF2 0x05 0x2A 0x01.
      // Leading: ((5-4)<<2)|3 = 7 = 0x07.
      expect(await h.compact(5_000_000_000n)).to.equal("0x0700f2052a01");
    });
    it("encodes 1_000_000_000 as 0x02286bee (mode 10)", async () => {
      // 1B < 2^30. (1B << 2) | 2 = 4_000_000_002 = 0xEE6B2802. LE.
      expect(await h.compact(1_000_000_000n)).to.equal("0x02286bee");
    });
    it("encodes 100_000 as 0x821a0600 (mode 10)", async () => {
      // 100k < 2^30. (100_000 << 2) | 2 = 400_002 = 0x61A82. LE 4 bytes.
      expect(await h.compact(100_000n)).to.equal("0x821a0600");
    });
  });

  describe("XCM fragments", function () {
    it("locationParentRelay = parents=1 || JunctionsV4::Here", async () => {
      // 0x01 0x00
      expect(await h.locationParentRelay()).to.equal("0x0100");
    });

    it("fungibleRelayAsset(1B) = location || Fungible || compact(1B)", async () => {
      // 0x01 00 (location) || 0x00 (Fungible) || 0x02 28 6B EE (compact 1B)
      expect(await h.fungibleRelayAsset(1_000_000_000n))
        .to.equal("0x010000" + "02286bee");
    });

    it("fungibleRelayAssets(1B) = compact(1) || asset", async () => {
      // compact(1) = 0x04, then the asset bytes.
      expect(await h.fungibleRelayAssets(1_000_000_000n))
        .to.equal("0x04" + "010000" + "02286bee");
    });

    it("withdrawAsset = 0x00 || assets", async () => {
      // Instruction discriminator 0.
      expect(await h.withdrawAsset(1_000_000_000n))
        .to.equal("0x00" + "04" + "010000" + "02286bee");
    });

    it("payFees (V5) = 0x30 || asset", async () => {
      // V5 discriminator 48 = 0x30. Single MultiAsset, no weight_limit field.
      expect(await h.payFees(1_000_000_000n))
        .to.equal("0x30" + "010000" + "02286bee");
    });

    it("buyExecutionUnlimited (legacy V4) = 0x13 || asset || 0x00", async () => {
      // V4 discriminator 19 = 0x13. Retained for callers targeting V4-only
      // channels; new code should use payFees() with V5.
      expect(await h.buyExecutionUnlimited(1_000_000_000n))
        .to.equal("0x13" + "010000" + "02286bee" + "00");
    });

    it("transactSovereign with placeholder call encodes correctly", async () => {
      // 0x06 (Transact) || 0x01 (SovereignAccount) || compact(5B) || compact(100k) || vecU8(callData)
      const callData = "0x3200" + "01".repeat(32);  // pallet=50, call=0, user=01x32
      const result = await h.transactSovereign(5_000_000_000n, 100_000n, callData);
      const expected =
        "0x06" +
        "01" +                          // SovereignAccount
        "0700f2052a01" +                // compact(5B) — mode 11
        "821a0600" +                    // compact(100k) — mode 10
        "88" +                          // compact(34) — length of callData
        "3200" + "01".repeat(32);       // callData
      expect(result).to.equal(expected);
    });

    it("encodeIdentityQueryCall = pallet || call || user", async () => {
      const user = "0x" + "01".repeat(32);
      expect(await h.encodeIdentityQueryCall(50, 0, user))
        .to.equal("0x3200" + "01".repeat(32));
    });
  });

  describe("encodeIdentityQueryXcm — full message (V5)", function () {
    it("produces the expected VersionedXcm::V5 byte string", async () => {
      const user = "0x" + "01".repeat(32);
      const fee = 1_000_000_000n;     // 1B planck
      const refTime = 5_000_000_000n;
      const proofSize = 100_000n;
      const palletIdx = 50;
      const callIdx = 0;

      const result = await h.encodeIdentityQueryXcm(
        user, fee, refTime, proofSize, palletIdx, callIdx
      );

      // Hand-rolled reference (V5):
      // 05            -- VersionedXcm::V5
      // 0c            -- compact(3) for Vec<Instruction> len
      //
      // WithdrawAsset:
      //   00          -- discriminator 0
      //   04          -- compact(1) for Vec<MultiAsset> len
      //   010000      -- MultiLocation(parents=1, Here) + Fungibility::Fungible
      //   02286bee    -- compact(1B)
      //
      // PayFees (V5):
      //   30          -- discriminator 48
      //   010000      -- MultiLocation
      //   02286bee    -- compact(1B)
      //   (no weight_limit field — V5 PayFees is just { asset })
      //
      // Transact:
      //   06          -- discriminator 6
      //   01          -- OriginKind::SovereignAccount
      //   0700f2052a01  -- compact(5B)
      //   821a0600    -- compact(100k)
      //   88          -- compact(34) for callData len
      //   3200 + 01x32 -- call(pallet=50, call=0, user)
      const expected =
        "0x05" +
        "0c" +
        // WithdrawAsset
        "00" + "04" + "010000" + "02286bee" +
        // PayFees
        "30" + "010000" + "02286bee" +
        // Transact
        "06" + "01" + "0700f2052a01" + "821a0600" + "88" + "3200" + "01".repeat(32);

      expect(result).to.equal(expected);
    });

    it("byte length matches the hand-rolled sum (66 bytes for V5)", async () => {
      const user = "0x" + "ab".repeat(32);
      const result = await h.encodeIdentityQueryXcm(
        user, 1_000_000_000n, 5_000_000_000n, 100_000n, 50, 0
      );
      // 1 (V5) + 1 (vec len) + 9 (WithdrawAsset) + 8 (PayFees) + 47 (Transact) = 66
      // (V5 PayFees is 1 byte shorter than V4 BuyExecution — no weight_limit.)
      const byteLen = (result.length - 2) / 2;
      expect(byteLen).to.equal(66);
    });

    it("starts with V5 discriminator (0x05)", async () => {
      const user = "0x" + "ab".repeat(32);
      const result = await h.encodeIdentityQueryXcm(
        user, 1_000_000_000n, 5_000_000_000n, 100_000n, 50, 0
      );
      expect(result.slice(0, 4)).to.equal("0x05");
    });

    it("user bytes appear verbatim at the end", async () => {
      const user = "0x" + "ab".repeat(32);
      const result = await h.encodeIdentityQueryXcm(
        user, 1_000_000_000n, 5_000_000_000n, 100_000n, 50, 0
      );
      const tail = "0x" + result.slice(-64);
      expect(tail).to.equal(user);
    });

    it("varying the fee changes the WithdrawAsset + PayFees amount fields", async () => {
      const user = "0x" + "01".repeat(32);
      // Pick two fees that both fit in compact mode 10 (< 2^30) so the byte
      // length stays the same. Crossing the mode-10→mode-11 boundary would
      // add a byte per occurrence (fee appears twice in the message).
      const r1 = await h.encodeIdentityQueryXcm(
        user, 500_000_000n, 5_000_000_000n, 100_000n, 50, 0
      );
      const r2 = await h.encodeIdentityQueryXcm(
        user, 800_000_000n, 5_000_000_000n, 100_000n, 50, 0
      );
      expect(r1).to.not.equal(r2);
      expect(r1.length).to.equal(r2.length);
    });

    it("changing pallet+call indices changes only those two bytes", async () => {
      const user = "0x" + "01".repeat(32);
      const r1 = await h.encodeIdentityQueryXcm(
        user, 1_000_000_000n, 5_000_000_000n, 100_000n, 50, 0
      );
      const r2 = await h.encodeIdentityQueryXcm(
        user, 1_000_000_000n, 5_000_000_000n, 100_000n, 51, 7
      );
      // Same length, differ only at the (pallet, call) byte positions
      expect(r1.length).to.equal(r2.length);
      // pallet+call bytes are right before the trailing user bytes (32 bytes = 64 hex)
      // ...followed immediately by the 32-byte user.
      const diffStart = r1.length - 64 - 4;  // 2 hex chars for pallet + 2 for call
      expect(r1.slice(0, diffStart)).to.equal(r2.slice(0, diffStart));
      expect(r1.slice(diffStart, diffStart + 4)).to.equal("3200");
      expect(r2.slice(diffStart, diffStart + 4)).to.equal("3307");
      expect(r1.slice(-64)).to.equal(r2.slice(-64));
    });
  });
});
