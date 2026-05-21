import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumPublisherGovernance,
  DatumAdvertiserGovernance,
  DatumGovernanceV2,
  DatumMintCoordinator,
  DatumPauseRegistry,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// G-10 mirror: ParameterRetuneGuard on the remaining four governance
// contracts (PublisherGov, AdvertiserGov, GovernanceV2, MintCoordinator).
//
// Sanity-suite — one happy-path + one within-cooldown revert per newly
// guarded setter. Full per-contract semantics covered by the existing
// relay-governance-g10.test.ts; this file confirms the integration is
// wired through to the same RetuneCooldown custom error on each contract.

describe("G-10 mirror: ParameterRetuneGuard across governance contracts", function () {
  const COOLDOWN = 100n;

  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let g3: HardhatEthersSigner;
  let pauseReg: DatumPauseRegistry;

  beforeEach(async function () {
    await fundSigners();
    [owner, other, g3] = await ethers.getSigners();
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, other.address, g3.address);
  });

  // ── DatumPublisherGovernance ───────────────────────────────────────────

  describe("DatumPublisherGovernance", function () {
    let gov: DatumPublisherGovernance;

    beforeEach(async function () {
      // PublisherStake at owner for the test — only the address-non-zero
      // check matters at construction.
      const stub = owner.address;
      const Factory = await ethers.getContractFactory("DatumPublisherGovernance");
      gov = await Factory.deploy(stub, ethers.ZeroAddress, await pauseReg.getAddress(),
        10_000_000_000n, 5000, 1000, 5n, 2_000_000_000n);
      await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    });

    it("PG-G10-1: setSlashBps cooldown trips", async function () {
      await gov.connect(owner).setSlashBps(4000);
      await expect(gov.connect(owner).setSlashBps(4500))
        .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    });

    it("PG-G10-2: setBondBonusBps cooldown trips", async function () {
      await gov.connect(owner).setBondBonusBps(2000);
      await expect(gov.connect(owner).setBondBonusBps(2500))
        .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    });

    it("PG-G10-3: setConvictionCurve cooldown trips", async function () {
      await gov.connect(owner).setConvictionCurve(20, 40);
      await expect(gov.connect(owner).setConvictionCurve(30, 50))
        .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    });

    it("PG-G10-4: cooldown elapse → setter works again", async function () {
      await gov.connect(owner).setSlashBps(4000);
      await mineBlocks(COOLDOWN);
      await gov.connect(owner).setSlashBps(4500);
    });
  });

  // ── DatumAdvertiserGovernance ──────────────────────────────────────────

  describe("DatumAdvertiserGovernance", function () {
    let gov: DatumAdvertiserGovernance;

    beforeEach(async function () {
      const Factory = await ethers.getContractFactory("DatumAdvertiserGovernance");
      gov = await Factory.deploy(10_000_000_000n, 5000, 5n, 2_000_000_000n,
        await pauseReg.getAddress());
      await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    });

    it("AG-G10-1: setConvictionCurve cooldown trips", async function () {
      await gov.connect(owner).setConvictionCurve(20, 40);
      await expect(gov.connect(owner).setConvictionCurve(30, 50))
        .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    });

    it("AG-G10-2: setPublisherClaimBond cooldown trips", async function () {
      await gov.connect(owner).setPublisherClaimBond(1_000_000_000n);
      await expect(gov.connect(owner).setPublisherClaimBond(2_000_000_000n))
        .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    });

    it("AG-G10-3: setParams (slashBps key) cooldown trips", async function () {
      await gov.connect(owner).setParams(10_000_000_000n, 4000, 5n, 2_000_000_000n);
      await expect(gov.connect(owner).setParams(10_000_000_000n, 4500, 5n, 2_000_000_000n))
        .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    });

    it("AG-G10-4: cooldown elapse → setter works again", async function () {
      await gov.connect(owner).setConvictionCurve(20, 40);
      await mineBlocks(COOLDOWN);
      await gov.connect(owner).setConvictionCurve(30, 50);
    });
  });

  // ── DatumGovernanceV2 ──────────────────────────────────────────────────

  describe("DatumGovernanceV2", function () {
    let gov: DatumGovernanceV2;

    beforeEach(async function () {
      const Factory = await ethers.getContractFactory("DatumGovernanceV2");
      // _campaigns just needs to be non-zero for the constructor.
      gov = await Factory.deploy(
        owner.address,
        10_000_000_000n, 5000, 20_000_000_000n,
        5n, 5n, 100n,
        await pauseReg.getAddress()
      );
      await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    });

    it("GV2-G10-1: setQuorumWeighted cooldown trips", async function () {
      await gov.connect(owner).setQuorumWeighted(11_000_000_000n);
      await expect(gov.connect(owner).setQuorumWeighted(12_000_000_000n))
        .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    });

    it("GV2-G10-2: setSlashBps cooldown trips", async function () {
      await gov.connect(owner).setSlashBps(4500);
      await expect(gov.connect(owner).setSlashBps(4000))
        .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    });

    it("GV2-G10-3: setConvictionCurve cooldown trips", async function () {
      await gov.connect(owner).setConvictionCurve(30, 60);
      await expect(gov.connect(owner).setConvictionCurve(20, 40))
        .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    });

    it("GV2-G10-4: cooldown elapse → setter works again", async function () {
      await gov.connect(owner).setSlashBps(4500);
      await mineBlocks(COOLDOWN);
      await gov.connect(owner).setSlashBps(4000);
    });
  });

  // ── DatumMintCoordinator ───────────────────────────────────────────────

  describe("DatumMintCoordinator", function () {
    let coord: DatumMintCoordinator;

    beforeEach(async function () {
      const Factory = await ethers.getContractFactory("DatumMintCoordinator");
      coord = await Factory.deploy();
      await coord.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    });

    it("MC-G10-1: setMintRate cooldown trips", async function () {
      await coord.connect(owner).setMintRate(20n * 10n ** 10n);
      await expect(coord.connect(owner).setMintRate(21n * 10n ** 10n))
        .to.be.revertedWithCustomError(coord, "RetuneCooldown");
    });

    it("MC-G10-2: setDustMintThreshold cooldown trips", async function () {
      await coord.connect(owner).setDustMintThreshold(10n ** 7n);
      await expect(coord.connect(owner).setDustMintThreshold(10n ** 8n))
        .to.be.revertedWithCustomError(coord, "RetuneCooldown");
    });

    it("MC-G10-3: setDatumRewardSplit cooldown trips", async function () {
      await coord.connect(owner).setDatumRewardSplit(3000, 4000, 3000);
      await expect(coord.connect(owner).setDatumRewardSplit(4000, 3000, 3000))
        .to.be.revertedWithCustomError(coord, "RetuneCooldown");
    });

    it("MC-G10-4: cooldown elapse → setter works again", async function () {
      await coord.connect(owner).setMintRate(20n * 10n ** 10n);
      await mineBlocks(COOLDOWN);
      await coord.connect(owner).setMintRate(21n * 10n ** 10n);
    });
  });
});
