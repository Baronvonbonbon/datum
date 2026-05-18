// Stage 2 — dual-permission PG hook on PowEngine + ClaimValidator.
// Owner can still tune directly; ParameterGovernance can tune through
// the standard PG.execute path; everyone else is rejected.
//
// (Originally targeted DatumSettlement; PoW state + curve tuning moved
// to DatumPowEngine as part of the EIP-170 carve-out. Settlement no
// longer owns the PG hook because it had no other consumers.)

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Stage 2: PowEngine + ClaimValidator PG dual-permission", function () {
  let powEngine: any;
  let validator: any;
  let owner: HardhatEthersSigner;
  let pgImpersonator: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  async function freshPowEngine() {
    return (await ethers.getContractFactory("DatumPowEngine")).deploy();
  }

  beforeEach(async function () {
    const sigs = await ethers.getSigners();
    [owner, pgImpersonator, other] = sigs;
    const g2 = sigs[3];

    const Pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
      owner.address, pgImpersonator.address, g2.address,
    );
    powEngine = await freshPowEngine();

    const Publishers = await (await ethers.getContractFactory("DatumPublishers")).deploy(20n, await Pause.getAddress());
    const Campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(
      0n, 50n, await Publishers.getAddress(), await Pause.getAddress(),
    );
    validator = await (await ethers.getContractFactory("DatumClaimValidator")).deploy(
      await Campaigns.getAddress(), await Publishers.getAddress(), await Pause.getAddress(),
    );

    await powEngine.setParameterGovernance(pgImpersonator.address);
    await validator.setParameterGovernance(pgImpersonator.address);
  });

  describe("setParameterGovernance lock-once on both contracts", function () {
    it("PowEngine: starts unset (zero address before setup)", async function () {
      const fresh = await freshPowEngine();
      expect(await fresh.parameterGovernance()).to.equal(ethers.ZeroAddress);
    });
    it("PowEngine: double-set rejected", async function () {
      await expect(powEngine.setParameterGovernance(other.address)).to.be.revertedWithCustomError(powEngine, "AlreadySet");
    });
    it("PowEngine: zero address rejected", async function () {
      const fresh = await freshPowEngine();
      await expect(fresh.setParameterGovernance(ethers.ZeroAddress)).to.be.revertedWithCustomError(fresh, "E00");
    });
    it("PowEngine: non-owner rejected", async function () {
      const fresh = await freshPowEngine();
      await expect(fresh.connect(other).setParameterGovernance(pgImpersonator.address)).to.be.reverted;
    });
    it("PowEngine: emits ParameterGovernanceSet", async function () {
      const fresh = await freshPowEngine();
      await expect(fresh.setParameterGovernance(pgImpersonator.address))
        .to.emit(fresh, "ParameterGovernanceSet").withArgs(pgImpersonator.address);
    });

    it("ClaimValidator: double-set rejected", async function () {
      await expect(validator.setParameterGovernance(other.address)).to.be.revertedWith("already set");
    });
  });

  describe("PowEngine.setPowDifficultyCurve — owner-or-PG", function () {
    it("owner can call", async function () {
      await expect(powEngine.connect(owner).setPowDifficultyCurve(12, 100, 200, 50)).to.not.be.reverted;
      expect(await powEngine.powBaseShift()).to.equal(12);
    });
    it("PG impersonator can call (simulates PG.execute → setPowDifficultyCurve)", async function () {
      await expect(powEngine.connect(pgImpersonator).setPowDifficultyCurve(10, 80, 150, 30)).to.not.be.reverted;
      expect(await powEngine.powBaseShift()).to.equal(10);
      expect(await powEngine.powBucketLeakPerN()).to.equal(30);
    });
    it("random caller rejected with E18", async function () {
      await expect(powEngine.connect(other).setPowDifficultyCurve(8, 60, 100, 10)).to.be.revertedWithCustomError(powEngine, "E18");
    });
    it("bounds still enforced via PG path", async function () {
      await expect(powEngine.connect(pgImpersonator).setPowDifficultyCurve(0, 60, 100, 10)).to.be.revertedWithCustomError(powEngine, "E11");
      await expect(powEngine.connect(pgImpersonator).setPowDifficultyCurve(33, 60, 100, 10)).to.be.revertedWithCustomError(powEngine, "E11");
      await expect(powEngine.connect(pgImpersonator).setPowDifficultyCurve(8, 0, 100, 10)).to.be.revertedWithCustomError(powEngine, "E11");
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

  describe("Settlement-side setters unchanged", function () {
    it("RateLimiter.setRateLimits still owner-only (sanity)", async function () {
      const rl = await (await ethers.getContractFactory("DatumSettlementRateLimiter")).deploy();
      await expect(rl.connect(other).setRateLimits(100, 10000)).to.be.reverted;
      await expect(rl.connect(owner).setRateLimits(100, 10000)).to.not.be.reverted;
    });
    it("ClaimValidator.setActivationBonds still owner-only", async function () {
      await expect(validator.connect(pgImpersonator).setActivationBonds(other.address)).to.be.reverted;
    });
  });
});
