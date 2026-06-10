import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumStakeRootV2 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// G-4 first close: permissionless inactivity eviction on DatumStakeRootV2.
// Closes the reporter-cabal stonewall vector — malicious reporters can be
// evicted without governance vote after a threshold period of inactivity.
//
// G4-1..4:  lastActiveBlock recording (join, propose, approve)
// G4-5..10: markInactive eviction flow
// G4-11..14: edge cases (already-pending, non-reporter, fresh joiner)
// G4-15..17: inactivityThresholdBlocks setter bounds

describe("DatumStakeRootV2 G-4 first close", function () {
  let stakeRoot: DatumStakeRootV2;

  let owner: HardhatEthersSigner;
  let r1: HardhatEthersSigner;
  let r2: HardhatEthersSigner;
  let r3: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;

  const MIN_STAKE  = 1_000_000_000n;  // 0.1 DOT
  const FUND       = 100_000_000_000n; // 10 DOT
  const EXIT_DELAY = 100n;
  const THRESH_BPS = 5100;
  const CHALLENGE_WINDOW = 50n;
  const PROPOSER_BOND = 1_000_000_000n;
  const CHALLENGER_BOND = 1_000_000_000n;
  // Inactivity threshold default = 100_800. For tests we want a small value.
  // The MIN bound is 14_400 — we can only test with that or higher.
  const INACTIVITY_THRESH = 14_400n;

  beforeEach(async function () {
    await fundSigners();
    [owner, r1, r2, r3, other, treasury] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DatumStakeRootV2");
    stakeRoot = await Factory.deploy(
      treasury.address,
      MIN_STAKE,
      EXIT_DELAY,
      THRESH_BPS,
      CHALLENGE_WINDOW,
      PROPOSER_BOND,
      CHALLENGER_BOND,
      0,                    // slashedToChallengerBps
      0,                    // slashApproverBps
      0,                    // commitmentBond
      ethers.ZeroAddress    // datumToken (not needed)
    );

    // Lower the threshold to MIN so we can mine within reasonable bounds.
    await stakeRoot.connect(owner).setInactivityThresholdBlocks(INACTIVITY_THRESH);

    // Three reporters bond
    await stakeRoot.connect(r1).joinReporters({ value: FUND });
    await stakeRoot.connect(r2).joinReporters({ value: FUND });
    await stakeRoot.connect(r3).joinReporters({ value: FUND });
  });

  // ── lastActiveBlock recording ────────────────────────────────────────

  it("G4-1: joinReporters sets lastActiveBlock", async function () {
    const lab = await stakeRoot.lastActiveBlock(r1.address);
    expect(lab).to.be.gt(0n);
  });

  it("G4-2: proposeRoot refreshes lastActiveBlock for proposer", async function () {
    const before = await stakeRoot.lastActiveBlock(r1.address);
    // Mine enough so block.number > SNAPSHOT_MAX_AGE (100)
    await mineBlocks(120);
    const block = await ethers.provider.getBlockNumber();
    await stakeRoot.connect(r1).proposeRoot(
      1n, BigInt(block - 50), ethers.keccak256(ethers.toUtf8Bytes("root1")),
      { value: PROPOSER_BOND }
    );
    const after = await stakeRoot.lastActiveBlock(r1.address);
    expect(after).to.be.gt(before);
  });

  it("G4-3: approveRoot refreshes lastActiveBlock for approver", async function () {
    await mineBlocks(120);
    const block = await ethers.provider.getBlockNumber();
    await stakeRoot.connect(r1).proposeRoot(
      1n, BigInt(block - 50), ethers.keccak256(ethers.toUtf8Bytes("root1")),
      { value: PROPOSER_BOND }
    );
    const before = await stakeRoot.lastActiveBlock(r2.address);
    await mineBlocks(5);
    await stakeRoot.connect(r2).approveRoot(1n);
    const after = await stakeRoot.lastActiveBlock(r2.address);
    expect(after).to.be.gt(before);
  });

  it("G4-4: inactivityThresholdBlocks default is 100_800 (when not overridden)", async function () {
    // Re-deploy without override to confirm default
    const Factory = await ethers.getContractFactory("DatumStakeRootV2");
    const fresh = await Factory.deploy(
      treasury.address, MIN_STAKE, EXIT_DELAY, THRESH_BPS, CHALLENGE_WINDOW,
      PROPOSER_BOND, CHALLENGER_BOND, 0, 0, 0, ethers.ZeroAddress
    );
    expect(await fresh.inactivityThresholdBlocks()).to.equal(100_800n);
  });

  // ── markInactive eviction flow ───────────────────────────────────────

  it("G4-5: markInactive before threshold reverts E96", async function () {
    await expect(stakeRoot.connect(other).markInactive(r1.address))
      .to.be.revertedWith("E96");
  });

  it("G4-6: markInactive after threshold succeeds and emits events", async function () {
    await mineBlocks(Number(INACTIVITY_THRESH) + 1);
    await expect(stakeRoot.connect(other).markInactive(r1.address))
      .to.emit(stakeRoot, "ReporterMarkedInactive")
      .and.to.emit(stakeRoot, "ReporterExitProposed");
  });

  it("G4-7: markInactive sets exitProposedBlock", async function () {
    await mineBlocks(Number(INACTIVITY_THRESH) + 1);
    await stakeRoot.connect(other).markInactive(r1.address);
    const stake = await stakeRoot.reporterStake(r1.address);
    expect(stake.exitProposedBlock).to.be.gt(0n);
  });

  it("G4-8: markInactive removes voting weight from totalReporterStake", async function () {
    const totalBefore = await stakeRoot.totalReporterStake();
    await mineBlocks(Number(INACTIVITY_THRESH) + 1);
    await stakeRoot.connect(other).markInactive(r1.address);
    const totalAfter = await stakeRoot.totalReporterStake();
    expect(totalBefore - totalAfter).to.equal(FUND);
  });

  it("G4-9: markInactive does not return stake (stays locked through exitDelay)", async function () {
    await mineBlocks(Number(INACTIVITY_THRESH) + 1);
    const balBefore = await ethers.provider.getBalance(r1.address);
    const tx = await stakeRoot.connect(other).markInactive(r1.address);
    await tx.wait();
    const balAfter = await ethers.provider.getBalance(r1.address);
    expect(balAfter).to.equal(balBefore);  // no payout yet
    // Stake amount still recorded
    const stake = await stakeRoot.reporterStake(r1.address);
    expect(stake.amount).to.equal(FUND);
  });

  it("G4-10: after markInactive + exitDelay, reporter can finalizeReporterExit", async function () {
    await mineBlocks(Number(INACTIVITY_THRESH) + 1);
    await stakeRoot.connect(other).markInactive(r1.address);
    await mineBlocks(Number(EXIT_DELAY) + 1);
    await expect(stakeRoot.connect(r1).finalizeReporterExit())
      .to.emit(stakeRoot, "ReporterExited");
  });

  // ── markInactive edge cases ─────────────────────────────────────────

  it("G4-11: markInactive on already-exit-pending reverts E22", async function () {
    await mineBlocks(Number(INACTIVITY_THRESH) + 1);
    await stakeRoot.connect(other).markInactive(r1.address);
    await expect(stakeRoot.connect(other).markInactive(r1.address))
      .to.be.revertedWith("E22");
  });

  it("G4-12: markInactive on non-reporter reverts E01", async function () {
    await mineBlocks(Number(INACTIVITY_THRESH) + 1);
    await expect(stakeRoot.connect(other).markInactive(other.address))
      .to.be.revertedWith("E01");
  });

  it("G4-13: fresh joiner is not immediately markInactive-able", async function () {
    // r1 just joined in beforeEach. Try to markInactive right away.
    await expect(stakeRoot.connect(other).markInactive(r1.address))
      .to.be.revertedWith("E96");
  });

  it("G4-14: reporter who recently proposed is not markInactive-able", async function () {
    await mineBlocks(120);
    const block = await ethers.provider.getBlockNumber();
    await stakeRoot.connect(r1).proposeRoot(
      1n, BigInt(block - 50), ethers.keccak256(ethers.toUtf8Bytes("root1")),
      { value: PROPOSER_BOND }
    );
    // Mine threshold-1 blocks — still within the activity window
    await mineBlocks(Number(INACTIVITY_THRESH) - 2);
    await expect(stakeRoot.connect(other).markInactive(r1.address))
      .to.be.revertedWith("E96");
  });

  // ── inactivityThresholdBlocks setter ────────────────────────────────

  it("G4-15: setInactivityThresholdBlocks below MIN reverts E11", async function () {
    await expect(stakeRoot.connect(owner).setInactivityThresholdBlocks(1000))
      .to.be.revertedWith("E11");
  });

  it("G4-16: setInactivityThresholdBlocks above MAX reverts E11", async function () {
    const tooHigh = 500_000n;  // > MAX_INACTIVITY_THRESHOLD (432_000)
    await expect(stakeRoot.connect(owner).setInactivityThresholdBlocks(tooHigh))
      .to.be.revertedWith("E11");
  });

  it("G4-17: setInactivityThresholdBlocks within bounds emits event", async function () {
    const val = 50_000n;
    await expect(stakeRoot.connect(owner).setInactivityThresholdBlocks(val))
      .to.emit(stakeRoot, "InactivityThresholdSet")
      .withArgs(val);
    expect(await stakeRoot.inactivityThresholdBlocks()).to.equal(val);
  });
});
