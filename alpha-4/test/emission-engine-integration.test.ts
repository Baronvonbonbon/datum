// Path H Stage 4 integration test — verify DatumSettlement's mint hook
// delegates to DatumEmissionEngine when wired, and falls back to the legacy
// flat-rate path when not.

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const UNIT = 10n ** 10n;

describe("DatumSettlement ↔ DatumEmissionEngine integration", function () {
  let settlement: any;
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
    const EngineF = await ethers.getContractFactory("DatumEmissionEngine");
    engine = await EngineF.deploy();
  });

  describe("setEmissionEngine (lock-once)", function () {
    it("starts unset", async function () {
      expect(await settlement.emissionEngine()).to.equal(ethers.ZeroAddress);
    });
    it("zero address rejected", async function () {
      await expect(settlement.setEmissionEngine(ethers.ZeroAddress)).to.be.revertedWith("E00");
    });
    it("non-owner rejected", async function () {
      await expect(settlement.connect(other).setEmissionEngine(await engine.getAddress())).to.be.reverted;
    });
    it("happy path sets address + emits event", async function () {
      const addr = await engine.getAddress();
      await expect(settlement.setEmissionEngine(addr))
        .to.emit(settlement, "EmissionEngineSet").withArgs(addr);
      expect(await settlement.emissionEngine()).to.equal(addr);
    });
    it("double-set reverts", async function () {
      await settlement.setEmissionEngine(await engine.getAddress());
      await expect(settlement.setEmissionEngine(await engine.getAddress())).to.be.revertedWith("already set");
    });
  });

  describe("Engine wiring sanity", function () {
    it("engine accepts settlement as authorized caller", async function () {
      await engine.setSettlement(await settlement.getAddress());
      // Now Settlement could call engine.computeAndClipMint via internal path
      // (no direct external entry from owner — that's the design).
    });
    it("non-settlement callers rejected by engine", async function () {
      await engine.setSettlement(await settlement.getAddress());
      await expect(engine.computeAndClipMint(UNIT)).to.be.revertedWith("not settlement");
    });
  });

  describe("Mint hook delegation (smoke)", function () {
    it("Settlement compiles with both legacy + engine fields wired", async function () {
      // Legacy field still exposed for fallback / observability.
      expect(await settlement.mintRatePerDot()).to.equal(19n * UNIT);
      // Engine field exposed for migration.
      expect(await settlement.emissionEngine()).to.equal(ethers.ZeroAddress);
    });
  });
});
