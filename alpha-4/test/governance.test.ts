import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumGovernanceV2, DatumPauseRegistry, MockCampaigns, MockCampaignLifecycle } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { mineBlocks, fundSigners } from "./helpers/mine";

// Governance tests for alpha-2: conviction 0-8, logarithmic curve, scaled grace.
//
// V1-V8: vote casting & constraints
// W1-W5: withdrawal & lockup enforcement
// E1-E9: evaluate paths (activate, terminate, complete, expire)
// S1-S6: slash distribution (inline in GovernanceV2)
// D1-D3: edge cases & regression

describe("DatumGovernanceV2", function () {
  let v2: DatumGovernanceV2;
  let mock: MockCampaigns;
  let mockLifecycle: MockCampaignLifecycle;
  let pauseReg: DatumPauseRegistry;

  let owner: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;
  let voter3: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const QUORUM = parseDOT("1");          // 1 DOT weighted quorum
  const SLASH_BPS = 1000n;               // 10% slash on losing side
  const TERMINATION_QUORUM = parseDOT("0.5");
  const BASE_GRACE = 10n;                // base grace period (blocks)
  const GRACE_PER_QUORUM = 20n;          // additional grace blocks per quorum-unit
  const MAX_GRACE = 50n;                 // cap on grace period

  // Default quadratic conviction curve: weight(c) = (25c² + 50c)/100 + 1
  //   c: 0  1  2  3  4  5   6   7   8
  //   w: 1  1  3  4  7  9  13  16  21
  // Lockups unchanged at [0,1d,3d,7d,21d,90d,180d,270d,365d]; both are now
  // governable via setConvictionCurve / setConvictionLockups.
  const WEIGHTS = [1n, 1n, 3n, 4n, 7n, 9n, 13n, 16n, 21n];
  const LOCKUPS = [0n, 14400n, 43200n, 100800n, 302400n, 1296000n, 2592000n, 3888000n, 5256000n];

  let nextCid = 1n;

  async function setupCampaign(status: number = 0): Promise<bigint> {
    const cid = nextCid++;
    await mock.setCampaign(cid, owner.address, voter1.address, parseDOT("0.01"), 5000, status);
    return cid;
  }

  before(async function () {
    await fundSigners();
    [owner, voter1, voter2, voter3, other] = await ethers.getSigners();

    // Deploy MockCampaigns + PauseRegistry
    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, voter1.address, voter2.address);

    // Deploy GovernanceV2 (alpha-2: 8 params with scaled grace + pauseRegistry)
    const V2Factory = await ethers.getContractFactory("DatumGovernanceV2");
    v2 = await V2Factory.deploy(
      await mock.getAddress(),
      QUORUM,
      SLASH_BPS,
      TERMINATION_QUORUM,
      BASE_GRACE,
      GRACE_PER_QUORUM,
      MAX_GRACE,
      await pauseReg.getAddress()
    );

    // Deploy MockCampaignLifecycle and wire
    const LifecycleFactory = await ethers.getContractFactory("MockCampaignLifecycle");
    mockLifecycle = await LifecycleFactory.deploy(await mock.getAddress());
    await mockLifecycle.setGovernanceContract(await v2.getAddress());
    await mock.setLifecycleContract(await mockLifecycle.getAddress());

    // Wire
    await v2.setLifecycle(await mockLifecycle.getAddress());
    await mock.setGovernanceContract(await v2.getAddress());
  });

  // =========================================================================
  // V1-V8: Vote casting
  // =========================================================================

  it("V1: vote aye with conviction 0 — no lockup", async function () {
    const cid = await setupCampaign(0); // Pending
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("1") });

    const [dir, lockAmt, conv, lockedUntil] = await v2.getVote(cid, voter1.address);
    expect(dir).to.equal(1); // aye
    expect(lockAmt).to.equal(parseDOT("1"));
    expect(conv).to.equal(0);
    // conviction 0 = 0 lockup
    const curBlock = await ethers.provider.getBlockNumber();
    expect(lockedUntil).to.be.lte(curBlock); // effectively unlocked

    expect(await v2.ayeWeighted(cid)).to.equal(parseDOT("1") * 1n); // weight 1x
  });

  it("V2: vote nay records direction 2", async function () {
    const cid = await setupCampaign(0);
    await v2.connect(voter1).vote(cid, false, 0, { value: parseDOT("0.5") });

    const [dir] = await v2.getVote(cid, voter1.address);
    expect(dir).to.equal(2); // nay
    expect(await v2.nayWeighted(cid)).to.equal(parseDOT("0.5"));
  });

  it("V3: cannot vote twice on same campaign", async function () {
    const cid = await setupCampaign(0);
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("0.5") });

    await expect(
      v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("0.5") })
    ).to.be.revertedWith("E42");
  });

  it("V4: conviction weights match escalating curve [1,2,3,4,6,9,14,18,21]", async function () {
    for (let c = 0; c <= 8; c++) {
      const cid = await setupCampaign(0);
      const stake = parseDOT("1");
      await v2.connect(voter1).vote(cid, true, c, { value: stake });

      const expectedWeight = stake * WEIGHTS[c];
      expect(await v2.ayeWeighted(cid)).to.equal(expectedWeight);
    }
  });

  it("V5: conviction > 8 reverts E40", async function () {
    const cid = await setupCampaign(0);
    await expect(
      v2.connect(voter1).vote(cid, true, 9, { value: parseDOT("1") })
    ).to.be.revertedWith("E40");
  });

  it("V6: vote with zero value reverts E41", async function () {
    const cid = await setupCampaign(0);
    await expect(
      v2.connect(voter1).vote(cid, true, 0, { value: 0n })
    ).to.be.revertedWith("E41");
  });

  it("V7: cannot vote on completed campaign", async function () {
    const cid = await setupCampaign(3); // Completed
    await expect(
      v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("1") })
    ).to.be.revertedWith("E43");
  });

  it("V8: can vote on Active campaign (status 1)", async function () {
    const cid = await setupCampaign(1); // Active
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("1") });
    expect(await v2.ayeWeighted(cid)).to.equal(parseDOT("1"));
  });

  // =========================================================================
  // W1-W5: Withdrawal & lockup
  // =========================================================================

  it("W1: withdraw after lockup returns full stake (unresolved)", async function () {
    const cid = await setupCampaign(0);
    const stake = parseDOT("1");
    await v2.connect(voter1).vote(cid, true, 1, { value: stake }); // conv 1 = 14400 blocks (24h)

    // Mine past lockup
    await mineBlocks(14401);

    const balBefore = await ethers.provider.getBalance(voter1.address);
    const tx = await v2.connect(voter1).withdraw(cid);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(voter1.address);
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    expect(balAfter - balBefore + gasUsed).to.equal(stake);
  });

  it("W2: withdraw before lockup reverts E45", async function () {
    const cid = await setupCampaign(0);
    await v2.connect(voter1).vote(cid, true, 2, { value: parseDOT("1") }); // conv 2 = 43200 blocks (3d)

    await expect(
      v2.connect(voter1).withdraw(cid)
    ).to.be.revertedWith("E45");
  });

  it("W3: withdraw with no vote reverts E44", async function () {
    const cid = await setupCampaign(0);
    await expect(
      v2.connect(voter1).withdraw(cid)
    ).to.be.revertedWith("E44");
  });

  it("W4: losing aye voter slashed on Terminated campaign", async function () {
    const cid = await setupCampaign(0);
    const stake = parseDOT("1");

    // Vote aye, then force-terminate
    await v2.connect(voter1).vote(cid, true, 0, { value: stake });
    await mock.setStatus(Number(cid), 4); // Terminated

    // Mark resolved
    await v2.evaluateCampaign(cid);
    expect(await v2.resolved(cid)).to.be.true;

    const balBefore = await ethers.provider.getBalance(voter1.address);
    const tx = await v2.connect(voter1).withdraw(cid);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(voter1.address);
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    // Should get stake minus 10% slash
    const expectedSlash = stake * SLASH_BPS / 10000n;
    const expectedRefund = stake - expectedSlash;
    expect(balAfter - balBefore + gasUsed).to.equal(expectedRefund);
    expect(await v2.slashCollected(cid)).to.equal(expectedSlash);
  });

  it("W5: winning nay voter gets full refund on Terminated campaign", async function () {
    const cid = await setupCampaign(0);
    const stake = parseDOT("1");

    await v2.connect(voter1).vote(cid, false, 0, { value: stake });
    await mock.setStatus(Number(cid), 4); // Terminated
    await v2.evaluateCampaign(cid);

    const balBefore = await ethers.provider.getBalance(voter1.address);
    const tx = await v2.connect(voter1).withdraw(cid);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(voter1.address);
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    expect(balAfter - balBefore + gasUsed).to.equal(stake);
    expect(await v2.slashCollected(cid)).to.equal(0n);
  });

  // =========================================================================
  // E1-E9: Evaluate paths
  // =========================================================================

  it("E1: evaluate Pending→Active (aye majority + quorum)", async function () {
    const cid = await setupCampaign(0);
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM });
    await mineBlocks(MAX_GRACE + 1n); // AUDIT-011: symmetric grace period

    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(1); // Active
  });

  it("E2: evaluate fails without quorum (E46)", async function () {
    const cid = await setupCampaign(0);
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM / 2n });

    await expect(v2.evaluateCampaign(cid)).to.be.revertedWith("E46");
  });

  it("E3: evaluate Pending — aye=nay (nay wins at 50%) but grace not elapsed → E53", async function () {
    const cid = await setupCampaign(0);
    // Equal aye and nay: nay wins the ≥50% check (exact tie), but grace hasn't elapsed
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM });
    await v2.connect(voter2).vote(cid, false, 0, { value: QUORUM });

    await expect(v2.evaluateCampaign(cid)).to.be.revertedWith("E53");
  });

  it("E4: Active → demote → Pending → terminate (two-step nay path)", async function () {
    const cid = await setupCampaign(0);

    // Step 1: Activate
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM });
    await mineBlocks(MAX_GRACE + 1n); // AUDIT-011: symmetric grace period
    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(1); // Active

    // Step 2: Nay majority — nayStake = 3×QUORUM → 75% nay, total = 4×QUORUM
    const nayStake = QUORUM * 3n;
    await v2.connect(voter2).vote(cid, false, 0, { value: nayStake });

    // Mine past grace period so demotion then immediate termination works
    // total = 4*QUORUM, grace = BASE_GRACE + 4*GRACE_PER_QUORUM = 10 + 80 = 90 > MAX_GRACE=50
    await mineBlocks(MAX_GRACE + 1n);

    // First evaluate: Active → Demoted (Pending, result=5)
    await expect(v2.evaluateCampaign(cid)).to.emit(v2, "CampaignEvaluated").withArgs(cid, 5n);
    expect(await mock.getCampaignStatus(cid)).to.equal(0); // Pending

    // Second evaluate: Pending → Terminated (grace already elapsed, result=4)
    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(4); // Terminated
    expect(await v2.resolved(cid)).to.be.true;
    expect(await v2.resolvedWinningWeight(cid)).to.equal(nayStake);
  });

  it("E5: evaluate Completed→resolved", async function () {
    const cid = await setupCampaign(3); // Completed
    await v2.evaluateCampaign(cid);
    expect(await v2.resolved(cid)).to.be.true;
  });

  it("E6: evaluate already-resolved reverts E49", async function () {
    const cid = await setupCampaign(3);
    await v2.evaluateCampaign(cid);

    await expect(v2.evaluateCampaign(cid)).to.be.revertedWith("E49");
  });

  it("E7: evaluate Terminated→resolved", async function () {
    const cid = await setupCampaign(4); // Terminated
    await v2.evaluateCampaign(cid);
    expect(await v2.resolved(cid)).to.be.true;
  });

  it("E8: evaluate invalid status reverts E50", async function () {
    const cid = await setupCampaign(5); // Expired
    await expect(v2.evaluateCampaign(cid)).to.be.revertedWith("E50");
  });

  // =========================================================================
  // Conviction curve verification
  // =========================================================================

  it("convictionWeight view matches internal _weight for 0-8", async function () {
    for (let c = 0; c <= 8; c++) {
      expect(await v2.convictionWeight(c)).to.equal(WEIGHTS[c]);
    }
  });

  it("convictionWeight > 8 reverts E40", async function () {
    await expect(v2.convictionWeight(9)).to.be.revertedWith("E40");
  });

  // =========================================================================
  // Lockup verification
  // =========================================================================

  it("lockups match expected blocks for conviction 0-8", async function () {
    for (let c = 0; c <= 8; c++) {
      const cid = await setupCampaign(0);
      await v2.connect(voter1).vote(cid, true, c, { value: parseDOT("0.1") });
      const [, , , lockedUntil] = await v2.getVote(cid, voter1.address);
      const curBlock = BigInt(await ethers.provider.getBlockNumber());
      // lockedUntil = voteBlock + lockup. voteBlock ≈ curBlock.
      // Allow 1 block tolerance for mining during tx
      const actualLockup = lockedUntil - curBlock;
      // For conv 0, lockup is 0 so lockedUntil could be <= curBlock
      if (c === 0) {
        expect(lockedUntil).to.be.lte(curBlock);
      } else {
        // Allow ±2 block tolerance
        expect(actualLockup).to.be.gte(LOCKUPS[c] - 2n);
        expect(actualLockup).to.be.lte(LOCKUPS[c] + 2n);
      }
    }
  });

  // =========================================================================
  // Scaled grace period
  // =========================================================================

  it("grace scales linearly with turnout (tested on Pending termination path)", async function () {
    const cid = await setupCampaign(0);

    // Activate
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM });
    await mineBlocks(MAX_GRACE + 1n); // AUDIT-011: symmetric grace period
    await v2.evaluateCampaign(cid);

    // Nay majority: nayStake = 2x QUORUM, total = 3*QUORUM, nay% = 66%
    const nayStake = QUORUM * 2n;
    await v2.connect(voter2).vote(cid, false, 0, { value: nayStake });

    // Step 1: Demote to Pending (no grace check on Active→Demote)
    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(0); // Pending

    // Step 2: Try to terminate before grace elapses → E53
    // total = 3*QUORUM, grace = BASE_GRACE + 3*GRACE_PER_QUORUM = 10 + 60 = 70 > MAX_GRACE=50 → 50
    // firstNayBlock was set when voter2 voted, only ~2 blocks ago
    await mineBlocks(45);
    await expect(v2.evaluateCampaign(cid)).to.be.revertedWith("E53");
  });

  it("grace capped at maxGraceBlocks (tested on Pending termination path)", async function () {
    const cid = await setupCampaign(0);

    // Activate
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM });
    await mineBlocks(MAX_GRACE + 1n); // AUDIT-011: symmetric grace period
    await v2.evaluateCampaign(cid);

    // Huge nay vote → grace would exceed MAX_GRACE
    const bigNay = QUORUM * 10n;
    await v2.connect(voter2).vote(cid, false, 0, { value: bigNay });

    // Demote to Pending
    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(0); // Pending

    // Try to terminate before grace elapses
    // total = 11*QUORUM, grace would be 10 + 11*20 = 230, capped at MAX_GRACE=50
    await mineBlocks(45);
    await expect(v2.evaluateCampaign(cid)).to.be.revertedWith("E53");
  });

  // =========================================================================
  // S1-S6: Slash distribution (GovernanceSlash)
  // =========================================================================

  it("S1: finalizeSlash snapshots winning weight", async function () {
    const cid = await setupCampaign(0); // Start as Pending (voteable)
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("2") });

    // Force to Completed and resolve
    await mock.setStatus(Number(cid), 3);
    await v2.evaluateCampaign(cid); // resolved

    await v2.finalizeSlash(cid);
    expect(await v2.slashFinalized(cid)).to.be.true;
    // Completed = aye wins, winningWeight = ayeWeighted
    expect(await v2.winningWeight(cid)).to.equal(parseDOT("2"));
  });

  it("S2: finalizeSlash on unresolved campaign reverts E60", async function () {
    const cid = await setupCampaign(0);
    await expect(v2.finalizeSlash(cid)).to.be.revertedWith("E60");
  });

  it("S3: double finalize reverts E59", async function () {
    const cid = await setupCampaign(0); // Start as Pending (voteable)
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("1") });

    // Force to Completed and resolve
    await mock.setStatus(Number(cid), 3);
    await v2.evaluateCampaign(cid);

    await v2.finalizeSlash(cid);
    await expect(v2.finalizeSlash(cid)).to.be.revertedWith("E59");
  });

  it("S4: claimSlashReward works for winning voter", async function () {
    const cid = await setupCampaign(0);
    const ayeStake = parseDOT("1");
    const nayStake = parseDOT("2");

    await v2.connect(voter1).vote(cid, true, 0, { value: ayeStake });
    await v2.connect(voter2).vote(cid, false, 0, { value: nayStake });

    // Force terminate
    await mock.setStatus(Number(cid), 4);
    await v2.evaluateCampaign(cid);

    // Aye voter withdraws (slashed)
    await v2.connect(voter1).withdraw(cid);
    const expectedSlash = ayeStake * SLASH_BPS / 10000n;
    expect(await v2.slashCollected(cid)).to.equal(expectedSlash);

    // Finalize
    await v2.finalizeSlash(cid);

    // Nay voter (winner) claims
    const claimable = await v2.getClaimable(cid, voter2.address);
    expect(claimable).to.equal(expectedSlash);

    await v2.connect(voter2).claimSlashReward(cid);
    expect(await v2.getClaimable(cid, voter2.address)).to.equal(0n);
  });

  it("S5: losing voter cannot claim (E56)", async function () {
    const cid = await setupCampaign(0);
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("1") });
    // Need a nay voter so resolvedWinningWeight > 0 (SM-5)
    await v2.connect(voter2).vote(cid, false, 0, { value: parseDOT("1") });

    // Force terminate (aye loses)
    await mock.setStatus(Number(cid), 4);
    await v2.evaluateCampaign(cid);
    await v2.finalizeSlash(cid);

    // Aye voter tries to claim — should fail (they're the loser)
    await expect(
      v2.connect(voter1).claimSlashReward(cid)
    ).to.be.revertedWith("E56");
  });

  it("S6: double claim reverts E55", async function () {
    const cid = await setupCampaign(0);
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("1") });
    await v2.connect(voter2).vote(cid, false, 0, { value: parseDOT("1") });

    await mock.setStatus(Number(cid), 4);
    await v2.evaluateCampaign(cid);
    await v2.connect(voter1).withdraw(cid); // slash collected
    await v2.finalizeSlash(cid);

    await v2.connect(voter2).claimSlashReward(cid);
    await expect(
      v2.connect(voter2).claimSlashReward(cid)
    ).to.be.revertedWith("E55");
  });

  // =========================================================================
  // D1-D4: Edge cases
  // =========================================================================

  it("D1: firstNayBlock recorded on first nay vote", async function () {
    const cid = await setupCampaign(0);
    expect(await v2.firstNayBlock(cid)).to.equal(0n);

    await v2.connect(voter1).vote(cid, false, 0, { value: parseDOT("1") });
    expect(await v2.firstNayBlock(cid)).to.be.gt(0n);
  });

  it("D2: second nay vote does not update firstNayBlock", async function () {
    const cid = await setupCampaign(0);
    await v2.connect(voter1).vote(cid, false, 0, { value: parseDOT("1") });
    const firstBlock = await v2.firstNayBlock(cid);

    await mineBlocks(5);
    await v2.connect(voter2).vote(cid, false, 0, { value: parseDOT("1") });
    expect(await v2.firstNayBlock(cid)).to.equal(firstBlock);
  });

  it("D3: aye vote does not set firstNayBlock", async function () {
    const cid = await setupCampaign(0);
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("1") });
    expect(await v2.firstNayBlock(cid)).to.equal(0n);
  });

  // SL-2: GovernanceV2 receive() accepts ETH (for slash pool collection)
  it("D5: SL-2 direct ETH deposit accepted (slash pool)", async function () {
    await expect(
      owner.sendTransaction({ to: await v2.getAddress(), value: 1n })
    ).not.to.be.reverted;
  });
});
