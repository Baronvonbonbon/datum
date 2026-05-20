import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumRelayGovernance,
  DatumRelayStake,
  DatumPauseRegistry,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// G-10 first close: ParameterRetuneGuard integration on DatumRelayGovernance.
// Defense-in-depth on top of the upgrade-ladder Timelock — high-impact
// economic setters (slash bps, conviction curve, treasury split) cannot
// be snap-retuned faster than retuneCooldownBlocks. Quorum / grace /
// propose-bond are ungated (rate-limiter parameters, lower damage profile).
//
// G10-1..3:  setRetuneCooldownBlocks — bounds, owner-only, event
// G10-4..7:  cooldown enforcement per guarded setter (slashAmountBps,
//                                                     challengerBonusBps,
//                                                     treasuryBps,
//                                                     convictionCurve)
// G10-8..10: cooldown isolation (different keys don't block each other);
//            cooldown elapse → setter works; ungated setters unaffected
// G10-11..13: retuneReadyAt view, RetuneGuarded event, lastRetuneBlock

describe("DatumRelayGovernance G-10 first close (ParameterRetuneGuard)", function () {
  let gov: DatumRelayGovernance;
  let stake: DatumRelayStake;
  let pauseReg: DatumPauseRegistry;

  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;

  const COOLDOWN = 100n;

  beforeEach(async function () {
    await fundSigners();
    [owner, other, treasury] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, other.address, treasury.address);

    const StakeFactory = await ethers.getContractFactory("DatumRelayStake");
    stake = await StakeFactory.deploy(0, 20n);

    const GovFactory = await ethers.getContractFactory("DatumRelayGovernance");
    gov = await GovFactory.deploy(
      10_000_000_000n,   // quorum
      5n,                // grace
      2_000_000_000n,    // proposeBond
      5000,              // slashAmountBps
      2000,              // challengerBonusBps
      1000               // treasuryBps
    );

    await gov.connect(owner).setRelayStake(stake.target);
    await gov.connect(owner).setPauseRegistry(await pauseReg.getAddress());
    await gov.connect(owner).setTreasury(treasury.address);
  });

  // ── setRetuneCooldownBlocks ──────────────────────────────────────────

  it("G10-1: default retuneCooldownBlocks is 0 (disabled)", async function () {
    expect(await gov.retuneCooldownBlocks()).to.equal(0n);
  });

  it("G10-2: setRetuneCooldownBlocks from non-owner reverts", async function () {
    await expect(gov.connect(other).setRetuneCooldownBlocks(COOLDOWN))
      .to.be.revertedWith("E18");
  });

  it("G10-3: setRetuneCooldownBlocks emits RetuneCooldownBlocksSet", async function () {
    await expect(gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN))
      .to.emit(gov, "RetuneCooldownBlocksSet")
      .withArgs(COOLDOWN);
    expect(await gov.retuneCooldownBlocks()).to.equal(COOLDOWN);
  });

  it("G10-3b: setRetuneCooldownBlocks above ceiling reverts", async function () {
    const tooHigh = 500_000n; // > MAX_RETUNE_COOLDOWN_BLOCKS (432_000)
    await expect(gov.connect(owner).setRetuneCooldownBlocks(tooHigh))
      .to.be.revertedWithCustomError(gov, "RetuneCooldown");
  });

  // ── cooldown enforcement per guarded setter ──────────────────────────

  it("G10-4: setSlashAmountBps within cooldown reverts RetuneCooldown", async function () {
    await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    await gov.connect(owner).setSlashAmountBps(4000); // first call passes
    await expect(gov.connect(owner).setSlashAmountBps(4500))
      .to.be.revertedWithCustomError(gov, "RetuneCooldown");
  });

  it("G10-5: setChallengerBonusBps within cooldown reverts RetuneCooldown", async function () {
    await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    await gov.connect(owner).setChallengerBonusBps(1500);
    await expect(gov.connect(owner).setChallengerBonusBps(2500))
      .to.be.revertedWithCustomError(gov, "RetuneCooldown");
  });

  it("G10-6: setTreasuryBps within cooldown reverts RetuneCooldown", async function () {
    await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    await gov.connect(owner).setTreasuryBps(800);
    await expect(gov.connect(owner).setTreasuryBps(900))
      .to.be.revertedWithCustomError(gov, "RetuneCooldown");
  });

  it("G10-7: setConvictionCurve within cooldown reverts RetuneCooldown", async function () {
    await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    await gov.connect(owner).setConvictionCurve(30, 60);
    await expect(gov.connect(owner).setConvictionCurve(40, 70))
      .to.be.revertedWithCustomError(gov, "RetuneCooldown");
  });

  // ── cooldown isolation and elapse ───────────────────────────────────

  it("G10-8: different keys don't block each other", async function () {
    await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    await gov.connect(owner).setSlashAmountBps(4000);
    // Same block — different key, should pass
    await gov.connect(owner).setTreasuryBps(900);
    await gov.connect(owner).setConvictionCurve(30, 60);
  });

  it("G10-9: cooldown elapse → guarded setter works again", async function () {
    await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    await gov.connect(owner).setSlashAmountBps(4000);
    await mineBlocks(Number(COOLDOWN) + 1);
    await gov.connect(owner).setSlashAmountBps(4500); // passes after cooldown
    expect(await gov.slashAmountBps()).to.equal(4500);
  });

  it("G10-10: ungated setters (quorum, grace, proposeBond) unaffected", async function () {
    await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    await gov.connect(owner).setQuorum(20_000_000_000n);
    await gov.connect(owner).setQuorum(30_000_000_000n); // back-to-back, no revert
    await gov.connect(owner).setMinGraceBlocks(10);
    await gov.connect(owner).setMinGraceBlocks(20);
    await gov.connect(owner).setProposeBond(3_000_000_000n);
    await gov.connect(owner).setProposeBond(4_000_000_000n);
  });

  // ── views + events ──────────────────────────────────────────────────

  it("G10-11: retuneReadyAt returns 0 when cooldown disabled", async function () {
    const key = ethers.encodeBytes32String("slashAmountBps");
    expect(await gov.retuneReadyAt(key)).to.equal(0n);
  });

  it("G10-12: retuneReadyAt returns lastBlock + cooldown when armed", async function () {
    await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    const tx = await gov.connect(owner).setSlashAmountBps(4000);
    const receipt = await tx.wait();
    const lastBlock = BigInt(receipt!.blockNumber);
    const key = ethers.encodeBytes32String("slashAmountBps");
    expect(await gov.retuneReadyAt(key)).to.equal(lastBlock + COOLDOWN);
  });

  it("G10-13: RetuneGuarded event emitted per guarded setter", async function () {
    await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    await expect(gov.connect(owner).setSlashAmountBps(4000))
      .to.emit(gov, "RetuneGuarded");
  });

  it("G10-14: lastRetuneBlock updates on guarded setter call", async function () {
    await gov.connect(owner).setRetuneCooldownBlocks(COOLDOWN);
    const key = ethers.encodeBytes32String("slashAmountBps");
    expect(await gov.lastRetuneBlock(key)).to.equal(0n);
    const tx = await gov.connect(owner).setSlashAmountBps(4000);
    const receipt = await tx.wait();
    expect(await gov.lastRetuneBlock(key)).to.equal(BigInt(receipt!.blockNumber));
  });

  it("G10-15: cooldown=0 disables the guard entirely (back-to-back works)", async function () {
    // Default state: cooldown is 0
    await gov.connect(owner).setSlashAmountBps(4000);
    await gov.connect(owner).setSlashAmountBps(4500); // immediate; no revert
    expect(await gov.slashAmountBps()).to.equal(4500);
  });
});
