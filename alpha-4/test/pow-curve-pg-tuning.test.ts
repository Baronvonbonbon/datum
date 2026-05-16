// Stage 2 — dual-permission PG hook on Settlement + ClaimValidator.
// Owner can still tune directly; ParameterGovernance can tune through
// the standard PG.execute path; everyone else is rejected.

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Stage 2: Settlement + ClaimValidator PG dual-permission", function () {
  let settlement: any;
  let validator: any;
  let owner: HardhatEthersSigner;
  let pgImpersonator: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  beforeEach(async function () {
    const sigs = await ethers.getSigners();
    [owner, pgImpersonator, other] = sigs;
    const g2 = sigs[3];

    const Pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
      owner.address, pgImpersonator.address, g2.address,
    );
    settlement = await (await ethers.getContractFactory("DatumSettlement")).deploy(await Pause.getAddress());

    const Publishers = await (await ethers.getContractFactory("DatumPublishers")).deploy(20n, await Pause.getAddress());
    const Campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(
      0n, 50n, await Publishers.getAddress(), await Pause.getAddress(),
    );
    validator = await (await ethers.getContractFactory("DatumClaimValidator")).deploy(
      await Campaigns.getAddress(), await Publishers.getAddress(), await Pause.getAddress(),
    );

    // Wire the PG impersonator address as parameterGovernance on both contracts
    await settlement.setParameterGovernance(pgImpersonator.address);
    await validator.setParameterGovernance(pgImpersonator.address);
  });

  describe("setParameterGovernance lock-once on both contracts", function () {
    it("Settlement: starts unset (zero address before setup)", async function () {
      const freshPause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
        owner.address, pgImpersonator.address, other.address,
      );
      const freshSettlement = await (await ethers.getContractFactory("DatumSettlement")).deploy(await freshPause.getAddress());
      expect(await freshSettlement.parameterGovernance()).to.equal(ethers.ZeroAddress);
    });
    it("Settlement: double-set rejected", async function () {
      await expect(settlement.setParameterGovernance(other.address)).to.be.revertedWith("already set");
    });
    it("Settlement: zero address rejected", async function () {
      const freshPause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
        owner.address, pgImpersonator.address, other.address,
      );
      const freshSettlement = await (await ethers.getContractFactory("DatumSettlement")).deploy(await freshPause.getAddress());
      await expect(freshSettlement.setParameterGovernance(ethers.ZeroAddress)).to.be.revertedWith("E00");
    });
    it("Settlement: non-owner rejected", async function () {
      const freshPause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
        owner.address, pgImpersonator.address, other.address,
      );
      const freshSettlement = await (await ethers.getContractFactory("DatumSettlement")).deploy(await freshPause.getAddress());
      await expect(freshSettlement.connect(other).setParameterGovernance(pgImpersonator.address)).to.be.reverted;
    });
    it("Settlement: emits ParameterGovernanceSet", async function () {
      const freshPause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
        owner.address, pgImpersonator.address, other.address,
      );
      const freshSettlement = await (await ethers.getContractFactory("DatumSettlement")).deploy(await freshPause.getAddress());
      await expect(freshSettlement.setParameterGovernance(pgImpersonator.address))
        .to.emit(freshSettlement, "ParameterGovernanceSet").withArgs(pgImpersonator.address);
    });

    it("ClaimValidator: double-set rejected", async function () {
      await expect(validator.setParameterGovernance(other.address)).to.be.revertedWith("already set");
    });
  });

  describe("Settlement.setPowDifficultyCurve — owner-or-PG", function () {
    it("owner can call", async function () {
      await expect(settlement.connect(owner).setPowDifficultyCurve(12, 100, 200, 50)).to.not.be.reverted;
      expect(await settlement.powBaseShift()).to.equal(12);
    });
    it("PG impersonator can call (simulates PG.execute → setPowDifficultyCurve)", async function () {
      await expect(settlement.connect(pgImpersonator).setPowDifficultyCurve(10, 80, 150, 30)).to.not.be.reverted;
      expect(await settlement.powBaseShift()).to.equal(10);
      expect(await settlement.powBucketLeakPerN()).to.equal(30);
    });
    it("random caller rejected with E18", async function () {
      await expect(settlement.connect(other).setPowDifficultyCurve(8, 60, 100, 10)).to.be.revertedWith("E18");
    });
    it("bounds still enforced via PG path", async function () {
      await expect(settlement.connect(pgImpersonator).setPowDifficultyCurve(0, 60, 100, 10)).to.be.revertedWith("E11");
      await expect(settlement.connect(pgImpersonator).setPowDifficultyCurve(33, 60, 100, 10)).to.be.revertedWith("E11");
      await expect(settlement.connect(pgImpersonator).setPowDifficultyCurve(8, 0, 100, 10)).to.be.revertedWith("E11");
    });
  });

  describe("ClaimValidator.setMaxClaimEvents — owner-or-PG", function () {
    it("owner can call", async function () {
      await validator.connect(owner).setMaxClaimEvents(50_000n);
      expect(await validator.maxClaimEvents()).to.equal(50_000n);
    });
    it("PG impersonator can call", async function () {
      await validator.connect(pgImpersonator).setMaxClaimEvents(250_000n);
      expect(await validator.maxClaimEvents()).to.equal(250_000n);
    });
    it("random caller rejected with E18", async function () {
      await expect(validator.connect(other).setMaxClaimEvents(50_000n)).to.be.revertedWith("E18");
    });
    it("absolute-max bound still enforced via PG path", async function () {
      await expect(validator.connect(pgImpersonator).setMaxClaimEvents(1_000_001n)).to.be.revertedWith("E11");
    });
  });

  describe("Other onlyOwner setters remain owner-only", function () {
    it("Settlement.setRateLimits still owner-only", async function () {
      await expect(settlement.connect(pgImpersonator).setRateLimits(100, 10000)).to.be.reverted;
      await expect(settlement.connect(owner).setRateLimits(100, 10000)).to.not.be.reverted;
    });
    it("ClaimValidator.setActivationBonds still owner-only", async function () {
      await expect(validator.connect(pgImpersonator).setActivationBonds(other.address)).to.be.reverted;
    });
  });
});
