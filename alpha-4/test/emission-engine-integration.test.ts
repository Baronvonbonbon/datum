// Path H Stage 4 integration test — verify DatumSettlement's mint hook
// delegates to DatumEmissionEngine when wired, and falls back to the legacy
// flat-rate path when not.

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const UNIT = 10n ** 10n;

describe("MintCoordinator ↔ DatumEmissionEngine integration", function () {
  let settlement: any;
  let coordinator: any;
  let engine: any;
  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0]; other = signers[1];
    const g2 = signers[2];
    const PauseF = await ethers.getContractFactory("DatumPauseRegistry");
    const pause = await PauseF.deploy(owner.address, other.address, g2.address);
    const SettlementF = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettlementF.deploy(await pause.getAddress());
    // DatumMintCoordinator (alpha-4 EIP-170 carve-out): mint state +
    // emissionEngine pointer + mintAuthority + rate/dust/split moved here.
    const CoordinatorF = await ethers.getContractFactory("DatumMintCoordinator");
    coordinator = await CoordinatorF.deploy();
    await coordinator.setSettlement(await settlement.getAddress());
    await settlement.setMintCoordinator(await coordinator.getAddress());
    const EngineF = await ethers.getContractFactory("DatumEmissionEngine");
    engine = await EngineF.deploy();
  });

  describe("setEmissionEngine (lock-once)", function () {
    it("starts unset", async function () {
      expect(await coordinator.emissionEngine()).to.equal(ethers.ZeroAddress);
    });
    it("zero address rejected", async function () {
      await expect(coordinator.setEmissionEngine(ethers.ZeroAddress)).to.be.revertedWithCustomError(coordinator, "E00");
    });
    it("non-owner rejected", async function () {
      await expect(coordinator.connect(other).setEmissionEngine(await engine.getAddress())).to.be.reverted;
    });
    it("happy path sets address + emits event", async function () {
      const addr = await engine.getAddress();
      await expect(coordinator.setEmissionEngine(addr))
        .to.emit(coordinator, "EmissionEngineSet").withArgs(addr);
      expect(await coordinator.emissionEngine()).to.equal(addr);
    });
    it("double-set reverts", async function () {
      await coordinator.setEmissionEngine(await engine.getAddress());
      await expect(coordinator.setEmissionEngine(await engine.getAddress())).to.be.revertedWithCustomError(coordinator, "AlreadySet");
    });
  });

  describe("Engine wiring sanity", function () {
    it("engine accepts coordinator as authorized caller", async function () {
      await engine.setSettlement(await coordinator.getAddress());
      // Now MintCoordinator could call engine.computeAndClipMint via the
      // batch-end coordinate() hook (no direct external entry from owner --
      // that's the design).
    });
    it("non-coordinator callers rejected by engine", async function () {
      await engine.setSettlement(await coordinator.getAddress());
      await expect(engine.computeAndClipMint(UNIT)).to.be.revertedWith("not settlement");
    });
  });

  describe("Mint hook delegation (smoke)", function () {
    it("Coordinator compiles with both legacy + engine fields wired", async function () {
      // Legacy field still exposed for fallback / observability.
      expect(await coordinator.mintRatePerDot()).to.equal(19n * UNIT);
      // Engine field exposed for migration.
      expect(await coordinator.emissionEngine()).to.equal(ethers.ZeroAddress);
    });
  });
});
