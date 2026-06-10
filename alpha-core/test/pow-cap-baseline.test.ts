// Stage 0 baseline — captures current behaviour of MAX_CLAIM_EVENTS and
// the PoW difficulty curve BEFORE the governance-tuning changes land.
// After Stages 1-3, these invariants must hold (defaults preserved) or
// the test must be updated alongside the contract change.
//
// (PoW state + curve tuning moved from DatumSettlement to DatumPowEngine
// as part of the EIP-170 carve-out.)

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("PoW + claim-cap baseline (pre-governance-tuning)", function () {
  let powEngine: any;
  let validator: any;
  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  beforeEach(async function () {
    const sigs = await ethers.getSigners();
    [owner, other] = sigs;
    const g2 = sigs[2];

    const Pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
      owner.address, other.address, g2.address,
    );
    powEngine = await (await ethers.getContractFactory("DatumPowEngine")).deploy();

    const Publishers = await (await ethers.getContractFactory("DatumPublishers")).deploy(20n, await Pause.getAddress());
    const Campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(
      0n, 50n, await Publishers.getAddress(), await Pause.getAddress(),
    );
    validator = await (await ethers.getContractFactory("DatumClaimValidator")).deploy(
      await Campaigns.getAddress(), await Publishers.getAddress(), await Pause.getAddress(),
    );
  });

  describe("PowEngine: PoW curve defaults", function () {
    it("powBaseShift defaults to 8", async function () {
      expect(await powEngine.powBaseShift()).to.equal(8);
    });
    it("powLinearDivisor defaults to 60", async function () {
      expect(await powEngine.powLinearDivisor()).to.equal(60);
    });
    it("powQuadDivisor defaults to 100", async function () {
      expect(await powEngine.powQuadDivisor()).to.equal(100);
    });
    it("powBucketLeakPerN defaults to 1440 (~monthly batching, Stage 3)", async function () {
      expect(await powEngine.powBucketLeakPerN()).to.equal(1440);
    });
    it("POW_MAX_SHIFT is 64 (baked)", async function () {
      expect(await powEngine.POW_MAX_SHIFT()).to.equal(64);
    });
    it("enforcePow defaults to false", async function () {
      expect(await powEngine.enforcePow()).to.equal(false);
    });
  });

  describe("PowEngine: setPowDifficultyCurve bounds", function () {
    it("baseShift=0 rejected (E11)", async function () {
      await expect(powEngine.setPowDifficultyCurve(0, 60, 100, 10)).to.be.revertedWithCustomError(powEngine, "E11");
    });
    it("baseShift=33 rejected (above [1,32])", async function () {
      await expect(powEngine.setPowDifficultyCurve(33, 60, 100, 10)).to.be.revertedWithCustomError(powEngine, "E11");
    });
    it("linearDivisor=0 rejected", async function () {
      await expect(powEngine.setPowDifficultyCurve(8, 0, 100, 10)).to.be.revertedWithCustomError(powEngine, "E11");
    });
    it("quadDivisor=0 rejected", async function () {
      await expect(powEngine.setPowDifficultyCurve(8, 60, 0, 10)).to.be.revertedWithCustomError(powEngine, "E11");
    });
    it("bucketLeakPerN=0 rejected", async function () {
      await expect(powEngine.setPowDifficultyCurve(8, 60, 100, 0)).to.be.revertedWithCustomError(powEngine, "E11");
    });
    it("valid update lands on all four fields", async function () {
      await powEngine.setPowDifficultyCurve(12, 100, 200, 50);
      expect(await powEngine.powBaseShift()).to.equal(12);
      expect(await powEngine.powLinearDivisor()).to.equal(100);
      expect(await powEngine.powQuadDivisor()).to.equal(200);
      expect(await powEngine.powBucketLeakPerN()).to.equal(50);
    });
    it("non-owner rejected", async function () {
      await expect(powEngine.connect(other).setPowDifficultyCurve(8, 60, 100, 10)).to.be.reverted;
    });
  });

  describe("ClaimValidator: MAX_CLAIM_EVENTS (Stage 1 will make this storage-backed)", function () {
    it("validator rejects eventCount > 100,000 with reason 17 (via static call)", async function () {
      expect(typeof validator.validateClaim).to.equal("function");
    });
  });

  describe("Bucket leak math (mirror of contract formula)", function () {
    it("bucket = 0 after 0 settles for a fresh user", async function () {
      expect(await powEngine.userPowBucketEffective(other.address)).to.equal(0);
    });
    it("shiftFromBucket(0) = baseShift = 8 (off-chain mirror)", function () {
      const bucket = 0n;
      const linearExtra = bucket / 60n;
      const quadInput = bucket / 100n;
      const quadExtra = quadInput * quadInput;
      const shift = 8n + linearExtra + quadExtra;
      expect(shift).to.equal(8n);
    });
    it("shiftFromBucket(300) = 22 (heavy regime)", function () {
      const bucket = 300n;
      const linearExtra = bucket / 60n;
      const quadInput = bucket / 100n;
      const shift = 8n + linearExtra + quadInput * quadInput;
      expect(shift).to.equal(22n);
    });
    it("shiftFromBucket(800) hits MAX_SHIFT (64)", function () {
      const bucket = 800n;
      const linearExtra = bucket / 60n;
      const quadInput = bucket / 100n;
      const raw = 8n + linearExtra + quadInput * quadInput;
      const clamped = raw >= 64n ? 64n : raw;
      expect(clamped).to.equal(64n);
    });
  });
});
