// Pause drill (RUNBOOK Phase 6 — operational readiness). Proves the incident
// primitive: settlement can be HALTED fast (1 guardian, one tx) and re-engaged
// only deliberately (2-of-3), with a bounded blast radius (solo pauses auto-expire
// and are category-scoped). `pausedSettlement()` is the exact view
// DatumSettlement reads before every batch (`DatumSettlement.sol:593:
// if (_pauseRegistry.pausedSettlement()) revert Paused()`), so flipping it true
// is what stops settlement under attack.
import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks } from "./helpers/mine";

describe("Pause drill — settlement halt via PauseRegistry", function () {
  let pause: any;
  let owner: HardhatEthersSigner, g0: HardhatEthersSigner, g1: HardhatEthersSigner,
      g2: HardhatEthersSigner, attacker: HardhatEthersSigner;

  const CAT_SETTLEMENT = 1;
  const CAT_CAMPAIGN_CREATION = 2;

  beforeEach(async function () {
    [owner, g0, g1, g2, attacker] = await ethers.getSigners();
    pause = await (await ethers.getContractFactory("DatumPauseRegistry"))
      .deploy(g0.address, g1.address, g2.address);
  });

  it("FAST HALT: a single guardian stops settlement in one tx (1-of-N)", async function () {
    expect(await pause.pausedSettlement()).to.equal(false);
    await pause.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    // This is the exact gate DatumSettlement reads → every settle batch now reverts Paused.
    expect(await pause.pausedSettlement()).to.equal(true);
    expect(await pause.paused()).to.equal(true);
  });

  it("only guardians can pause (attacker rejected E18)", async function () {
    await expect(pause.connect(attacker).pauseFast()).to.be.revertedWith("E18");
    await expect(pause.connect(attacker).pauseFastCategories(CAT_SETTLEMENT)).to.be.revertedWith("E18");
  });

  it("GRANULAR: halting settlement leaves campaign-creation live", async function () {
    await pause.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    expect(await pause.pausedSettlement()).to.equal(true);
    expect(await pause.pausedCampaignCreation()).to.equal(false);
  });

  it("DELIBERATE RE-ENGAGE: unpause needs 2-of-3 guardian approval", async function () {
    await pause.connect(g0).pauseFastCategories(CAT_SETTLEMENT);

    // g0 proposes (auto-approves = 1 of 2). Still paused.
    const id = await pause.connect(g0).proposeCategoryUnpause.staticCall(CAT_SETTLEMENT);
    await pause.connect(g0).proposeCategoryUnpause(CAT_SETTLEMENT);
    expect(await pause.pausedSettlement(), "1 approval is not enough").to.equal(true);

    // a non-guardian can't approve
    await expect(pause.connect(attacker).approve(id)).to.be.revertedWith("E18");

    // g1 is the second approval → threshold reached → executes the unpause.
    await pause.connect(g1).approve(id);
    expect(await pause.pausedSettlement()).to.equal(false);
  });

  it("BOUNDED BLAST RADIUS: a solo pause auto-expires (a lone guardian can't pause forever)", async function () {
    await pause.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    expect(await pause.pausedSettlement()).to.equal(true);

    const solo = await pause.soloMaxPauseBlocks();
    await mineBlocks(solo + 1n);
    expect(await pause.pausedSettlement(), "solo window elapsed → auto-unpaused").to.equal(false);
  });
});
