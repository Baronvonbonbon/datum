import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumPauseRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// G-2 first close: pause damage-bound tightening.
// PG2-1..6: solo-pause window enforcement (auto-expire after soloMaxPauseBlocks)
// PG2-7..12: per-category extended cap via 2-of-3 extend proposal (action 5)
// PG2-13..17: per-guardian per-category re-engagement cooldown
// PG2-18..21: consensus unpause clears cooldown + extension
// PG2-22..27: parameter setters + bounds + lockPauseParams

describe("DatumPauseRegistry G-2 first close", function () {
  let pauseReg: DatumPauseRegistry;

  let owner: HardhatEthersSigner;
  let g0: HardhatEthersSigner;
  let g1: HardhatEthersSigner;
  let g2: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  // Match contract defaults for clarity.
  const SOLO = 14400n;       // ~24h
  const CAT_SETTLEMENT = 1;
  const CAT_CAMPAIGN_CREATION = 2;
  const CAT_GOVERNANCE = 4;
  const CAT_TOKEN_MINT = 8;
  const CAT_ALL = 15;

  beforeEach(async function () {
    await fundSigners();
    [owner, g0, g1, g2, other] = await ethers.getSigners();
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(g0.address, g1.address, g2.address);
  });

  // ── solo-pause window ────────────────────────────────────────────────

  it("PG2-1: solo pause auto-expires after soloMaxPauseBlocks", async function () {
    await pauseReg.connect(g0).pauseFast();
    expect(await pauseReg.paused()).to.equal(true);
    await mineBlocks(Number(SOLO));
    expect(await pauseReg.paused()).to.equal(true); // exactly at end-block still paused
    await mineBlocks(1);
    expect(await pauseReg.paused()).to.equal(false); // past end-block
  });

  it("PG2-2: per-category pause auto-expires per the solo cap", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    expect(await pauseReg.pausedSettlement()).to.equal(true);
    expect(await pauseReg.pausedGovernance()).to.equal(false);
    await mineBlocks(Number(SOLO) + 1);
    expect(await pauseReg.pausedSettlement()).to.equal(false);
  });

  it("PG2-3: soloMaxPauseBlocks default is 14400 (~24h)", async function () {
    expect(await pauseReg.soloMaxPauseBlocks()).to.equal(SOLO);
  });

  it("PG2-4: solo pause cannot bypass MAX_PAUSE_PARAM_CEILING via setSoloMaxPauseBlocks", async function () {
    const tooLong = 300_000n; // > MAX_PAUSE_PARAM_CEILING (201600)
    await expect(pauseReg.connect(owner).setSoloMaxPauseBlocks(tooLong))
      .to.be.revertedWith("E11");
  });

  it("PG2-5: setSoloMaxPauseBlocks(0) reverts (must be > 0)", async function () {
    await expect(pauseReg.connect(owner).setSoloMaxPauseBlocks(0))
      .to.be.revertedWith("E11");
  });

  it("PG2-6: setSoloMaxPauseBlocks updates the cap and emits event", async function () {
    const newSolo = 7200n; // ~12h
    await expect(pauseReg.connect(owner).setSoloMaxPauseBlocks(newSolo))
      .to.emit(pauseReg, "SoloMaxPauseBlocksSet")
      .withArgs(newSolo);
    expect(await pauseReg.soloMaxPauseBlocks()).to.equal(newSolo);
  });

  // ── extend proposal (2-of-3) ─────────────────────────────────────────

  it("PG2-7: proposeExtendPause from non-guardian reverts E18", async function () {
    await pauseReg.connect(g0).pauseFast();
    await expect(pauseReg.connect(other).proposeExtendPause(CAT_ALL))
      .to.be.revertedWith("E18");
  });

  it("PG2-8: proposeExtendPause when category not active reverts E11", async function () {
    // Pause only SETTLEMENT, attempt to extend TOKEN_MINT.
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    await expect(pauseReg.connect(g0).proposeExtendPause(CAT_TOKEN_MINT))
      .to.be.revertedWith("E11");
  });

  it("PG2-9: 2-of-3 extend bumps end-block past solo cap", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    const tx = await pauseReg.connect(g0).proposeExtendPause(CAT_SETTLEMENT);
    const receipt = await tx.wait();
    // Find proposalId from event
    const proposedEvent = receipt!.logs.find((l: any) => l.fragment?.name === "PauseProposed") as any;
    const proposalId = proposedEvent.args[0];

    await pauseReg.connect(g1).approve(proposalId);
    // After 2-of-3, extendedUntilBlock[CAT_SETTLEMENT] = pausedAtBlockFor + categoryMaxPauseBlocks
    expect(await pauseReg.extendedUntilBlock(CAT_SETTLEMENT)).to.be.gt(0n);
    // Mine well past solo cap — still paused via extension
    await mineBlocks(Number(SOLO) + 100);
    expect(await pauseReg.pausedSettlement()).to.equal(true);
  });

  it("PG2-10: extended pause auto-expires at categoryMaxPauseBlocks", async function () {
    // Settlement default extended cap = 43200 (~3d)
    const SETTLEMENT_CAP = 43200n;
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    const tx = await pauseReg.connect(g0).proposeExtendPause(CAT_SETTLEMENT);
    const receipt = await tx.wait();
    const proposalId = (receipt!.logs.find((l: any) => l.fragment?.name === "PauseProposed") as any).args[0];
    await pauseReg.connect(g1).approve(proposalId);

    await mineBlocks(Number(SETTLEMENT_CAP) - 5);
    expect(await pauseReg.pausedSettlement()).to.equal(true);
    await mineBlocks(10);
    expect(await pauseReg.pausedSettlement()).to.equal(false);
  });

  it("PG2-11: PauseExtended event emitted on execute", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    const tx = await pauseReg.connect(g0).proposeExtendPause(CAT_SETTLEMENT);
    const r = await tx.wait();
    const proposalId = (r!.logs.find((l: any) => l.fragment?.name === "PauseProposed") as any).args[0];
    await expect(pauseReg.connect(g1).approve(proposalId))
      .to.emit(pauseReg, "PauseExtended");
  });

  it("PG2-12: single guardian alone cannot extend (need 2-of-3)", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    const tx = await pauseReg.connect(g0).proposeExtendPause(CAT_SETTLEMENT);
    const r = await tx.wait();
    // Only 1 approval (proposer's own); not yet executed.
    await mineBlocks(Number(SOLO) + 1);
    // Solo window past, extension never executed.
    expect(await pauseReg.pausedSettlement()).to.equal(false);
  });

  // ── cooldown ─────────────────────────────────────────────────────────

  it("PG2-13: same guardian cannot re-engage same category within cooldown", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    await mineBlocks(Number(SOLO) + 1); // solo cap expired
    // Cooldown not yet elapsed — re-engage by same guardian reverts.
    await expect(pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT))
      .to.be.revertedWith("cooldown");
  });

  it("PG2-14: different guardian can engage same category during another's cooldown", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    await mineBlocks(Number(SOLO) + 1);
    // g1 has never engaged this category — passes.
    await pauseReg.connect(g1).pauseFastCategories(CAT_SETTLEMENT);
    expect(await pauseReg.pausedSettlement()).to.equal(true);
  });

  it("PG2-15: cooldown elapses → same guardian can re-engage", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    // Wait soloMaxPauseBlocks + reengagementCooldownBlocks + 1
    const cooldown = await pauseReg.reengagementCooldownBlocks();
    await mineBlocks(Number(SOLO) + Number(cooldown) + 1);
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    expect(await pauseReg.pausedSettlement()).to.equal(true);
  });

  it("PG2-16: cooldown is per-category — engaging A doesn't block B", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    // g0 can still engage CAT_GOVERNANCE immediately.
    await pauseReg.connect(g0).pauseFastCategories(CAT_GOVERNANCE);
    expect(await pauseReg.pausedSettlement()).to.equal(true);
    expect(await pauseReg.pausedGovernance()).to.equal(true);
  });

  it("PG2-17: lastEngagedBlock is recorded on engagement", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    const last = await pauseReg.lastEngagedBlock(CAT_SETTLEMENT, g0.address);
    expect(last).to.be.gt(0n);
  });

  // ── consensus unpause clears cooldown + extension ───────────────────

  it("PG2-18: 2-of-3 unpause clears extendedUntilBlock", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    const tx = await pauseReg.connect(g0).proposeExtendPause(CAT_SETTLEMENT);
    const r = await tx.wait();
    const propId = (r!.logs.find((l: any) => l.fragment?.name === "PauseProposed") as any).args[0];
    await pauseReg.connect(g1).approve(propId);
    expect(await pauseReg.extendedUntilBlock(CAT_SETTLEMENT)).to.be.gt(0n);

    // 2-of-3 unpause SETTLEMENT.
    const tx2 = await pauseReg.connect(g0).proposeCategoryUnpause(CAT_SETTLEMENT);
    const r2 = await tx2.wait();
    const propId2 = (r2!.logs.find((l: any) => l.fragment?.name === "PauseProposed") as any).args[0];
    await pauseReg.connect(g1).approve(propId2);
    expect(await pauseReg.extendedUntilBlock(CAT_SETTLEMENT)).to.equal(0n);
  });

  it("PG2-19: 2-of-3 unpause clears the cooldown for all guardians", async function () {
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    expect(await pauseReg.lastEngagedBlock(CAT_SETTLEMENT, g0.address)).to.be.gt(0n);

    // 2-of-3 unpause.
    const tx = await pauseReg.connect(g0).proposeCategoryUnpause(CAT_SETTLEMENT);
    const r = await tx.wait();
    const propId = (r!.logs.find((l: any) => l.fragment?.name === "PauseProposed") as any).args[0];
    await pauseReg.connect(g1).approve(propId);

    expect(await pauseReg.lastEngagedBlock(CAT_SETTLEMENT, g0.address)).to.equal(0n);
    // g0 can immediately re-engage without waiting for cooldown.
    await pauseReg.connect(g0).pauseFastCategories(CAT_SETTLEMENT);
    expect(await pauseReg.pausedSettlement()).to.equal(true);
  });

  it("PG2-20: full unpause (action 2) clears cooldown + extension across all categories", async function () {
    await pauseReg.connect(g0).pauseFast(); // CAT_ALL
    const tx = await pauseReg.connect(g0).propose(2);
    const r = await tx.wait();
    const propId = (r!.logs.find((l: any) => l.fragment?.name === "PauseProposed") as any).args[0];
    await pauseReg.connect(g1).approve(propId);

    expect(await pauseReg.lastEngagedBlock(CAT_SETTLEMENT, g0.address)).to.equal(0n);
    expect(await pauseReg.lastEngagedBlock(CAT_GOVERNANCE, g0.address)).to.equal(0n);
  });

  it("PG2-21: owner pause() bypasses cooldown (bootstrap-emergency role)", async function () {
    // owner is NOT a guardian — verify by attempting cooldown check is N/A.
    // owner.pause() twice in a row should not revert with "cooldown".
    await pauseReg.connect(owner).pause();
    await pauseReg.connect(owner).pause(); // idempotent
    expect(await pauseReg.paused()).to.equal(true);
  });

  // ── parameter setters + lock ─────────────────────────────────────────

  it("PG2-22: setCategoryMaxPauseBlocks requires a single bit", async function () {
    await expect(pauseReg.connect(owner).setCategoryMaxPauseBlocks(CAT_SETTLEMENT | CAT_GOVERNANCE, 50000))
      .to.be.revertedWith("E11");
  });

  it("PG2-23: setCategoryMaxPauseBlocks below soloMaxPauseBlocks reverts", async function () {
    // soloMaxPauseBlocks default = 14400; set category below that
    await expect(pauseReg.connect(owner).setCategoryMaxPauseBlocks(CAT_SETTLEMENT, 7200))
      .to.be.revertedWith("E11");
  });

  it("PG2-24: setCategoryMaxPauseBlocks above ceiling reverts", async function () {
    await expect(pauseReg.connect(owner).setCategoryMaxPauseBlocks(CAT_SETTLEMENT, 300_000))
      .to.be.revertedWith("E11");
  });

  it("PG2-25: setReengagementCooldownBlocks accepts 0 (testnet posture)", async function () {
    await pauseReg.connect(owner).setReengagementCooldownBlocks(0);
    expect(await pauseReg.reengagementCooldownBlocks()).to.equal(0n);
  });

  it("PG2-26: lockPauseParams freezes setters", async function () {
    // F-004 fix: lockPauseParams is whenOpenGovPhase-guarded.
    const { wireOpenGovRouter } = await import("./helpers/openGovRouter");
    await wireOpenGovRouter(pauseReg);
    await pauseReg.connect(owner).lockPauseParams();
    expect(await pauseReg.pauseParamsLocked()).to.equal(true);
    await expect(pauseReg.connect(owner).setSoloMaxPauseBlocks(7200))
      .to.be.revertedWith("locked");
    await expect(pauseReg.connect(owner).setCategoryMaxPauseBlocks(CAT_SETTLEMENT, 50000))
      .to.be.revertedWith("locked");
    await expect(pauseReg.connect(owner).setReengagementCooldownBlocks(50000))
      .to.be.revertedWith("locked");
  });

  it("PG2-27: double lockPauseParams reverts", async function () {
    const { wireOpenGovRouter } = await import("./helpers/openGovRouter");
    await wireOpenGovRouter(pauseReg);
    await pauseReg.connect(owner).lockPauseParams();
    await expect(pauseReg.connect(owner).lockPauseParams())
      .to.be.revertedWith("already locked");
  });
});
