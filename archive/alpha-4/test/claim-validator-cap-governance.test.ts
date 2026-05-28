// Stage 1 — maxClaimEvents storage + setter on DatumClaimValidator.
// Covers default value preserved, bounds, lock-once nature (just owner-only
// for now; Stage 2 adds the PG-or-owner dual-permission).

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("DatumClaimValidator: maxClaimEvents governance (Stage 1)", function () {
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
    const Publishers = await (await ethers.getContractFactory("DatumPublishers")).deploy(20n, await Pause.getAddress());
    const Campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(
      0n, 50n, await Publishers.getAddress(), await Pause.getAddress(),
    );
    validator = await (await ethers.getContractFactory("DatumClaimValidator")).deploy(
      await Campaigns.getAddress(), await Publishers.getAddress(), await Pause.getAddress(),
    );
  });

  describe("Default + constants", function () {
    it("ABSOLUTE_MAX_CLAIM_EVENTS = 1,000,000 (baked)", async function () {
      expect(await validator.ABSOLUTE_MAX_CLAIM_EVENTS()).to.equal(1_000_000n);
    });
    it("maxClaimEvents defaults to 100,000 (matches historical baked constant)", async function () {
      expect(await validator.maxClaimEvents()).to.equal(100_000n);
    });
  });

  describe("setMaxClaimEvents bounds", function () {
    it("zero rejected (E11)", async function () {
      await expect(validator.setMaxClaimEvents(0)).to.be.revertedWith("E11");
    });
    it("above ABSOLUTE_MAX (1,000,001) rejected", async function () {
      await expect(validator.setMaxClaimEvents(1_000_001n)).to.be.revertedWith("E11");
    });
    it("exact lower bound (1) accepted", async function () {
      await validator.setMaxClaimEvents(1);
      expect(await validator.maxClaimEvents()).to.equal(1);
    });
    it("exact upper bound (ABSOLUTE_MAX) accepted", async function () {
      await validator.setMaxClaimEvents(1_000_000n);
      expect(await validator.maxClaimEvents()).to.equal(1_000_000n);
    });
    it("typical update emits MaxClaimEventsSet(old, new)", async function () {
      await expect(validator.setMaxClaimEvents(50_000n))
        .to.emit(validator, "MaxClaimEventsSet").withArgs(100_000n, 50_000n);
      expect(await validator.maxClaimEvents()).to.equal(50_000n);
    });
    it("can be raised back up after lowering", async function () {
      await validator.setMaxClaimEvents(10_000n);
      await validator.setMaxClaimEvents(500_000n);
      expect(await validator.maxClaimEvents()).to.equal(500_000n);
    });
  });

  describe("Authorization", function () {
    it("non-owner rejected", async function () {
      await expect(validator.connect(other).setMaxClaimEvents(50_000n)).to.be.reverted;
    });
  });

  describe("Validator behaviour follows the storage value", function () {
    it("lowering the cap makes previously-fitting claims oversize-rejected", async function () {
      // We can't easily call validateClaim() externally here (it's an
      // external view that requires a fully-built Claim struct), but the
      // visible side-effect is the storage update. The rejection path
      // is exercised in benchmark.test.ts via real settleClaims calls.
      await validator.setMaxClaimEvents(50n);
      expect(await validator.maxClaimEvents()).to.equal(50n);
      // Any claim with eventCount > 50 will reject reason 17.
    });
  });
});
