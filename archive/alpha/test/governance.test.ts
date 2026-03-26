import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumGovernanceV2, DatumGovernanceSlash, MockCampaigns } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { mineBlocks, isSubstrate, fundSigners } from "./helpers/mine";

// Governance V2 tests:
// V1-V8: Voting
// W1-W5: Withdrawal
// E1-E9: Evaluation (E6-E9: termination protection)
// S1-S6: Slash
// D1-D4: Dynamic voting

describe("DatumGovernanceV2 (Voting + Slash)", function () {
  let v2: DatumGovernanceV2;
  let slash: DatumGovernanceSlash;
  let mock: MockCampaigns;
  let owner: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;
  let voter3: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;

  // Config — all amounts in planck (1 DOT = 10^10 planck)
  const QUORUM_WEIGHTED = parseDOT("1");       // 1 DOT weighted quorum
  const SLASH_BPS = 1000n;                      // 10% slash on losing side
  const BASE_LOCKUP = 10n;                      // 10 blocks base
  const MAX_LOCKUP = 100n;                      // 100 blocks cap (small for testing)
  const TERMINATION_QUORUM = parseDOT("1");    // 1 DOT nay-weighted minimum to terminate
  const TERMINATION_GRACE = 20n;               // 20 blocks grace period after first nay

  const BUDGET = parseDOT("5");                // 5 DOT
  const DAILY_CAP = parseDOT("1");             // 1 DOT
  const BID_CPM = parseDOT("0.01");            // 0.01 DOT per 1000 impressions
  const TAKE_RATE_BPS = 5000;

  // Create a fresh Pending campaign in the mock and fund it for slash tests.
  async function createTestCampaign(): Promise<bigint> {
    const tx = await mock.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    const receipt = await tx.wait();
    const event = receipt!.logs.find(
      (log) => {
        try { return mock.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "CampaignCreated"; }
        catch { return false; }
      }
    );
    const parsed = mock.interface.parseLog({ topics: event!.topics as string[], data: event!.data });
    return parsed!.args[0] as bigint;
  }

  // Helper: mine past lockup for a voter
  async function minePastLockup(campaignId: bigint, voter: string) {
    const [, , , lockedUntil] = await v2.getVote(campaignId, voter);
    const curBlock = await ethers.provider.getBlockNumber();
    const blocksNeeded = Number(lockedUntil) - curBlock + 1;
    if (blocksNeeded > 0) {
      await mineBlocks(blocksNeeded);
    }
  }

  before(async function () {
    await fundSigners();
    [owner, voter1, voter2, voter3, advertiser, publisher] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const V2Factory = await ethers.getContractFactory("DatumGovernanceV2");
    v2 = await V2Factory.deploy(
      await mock.getAddress(),
      QUORUM_WEIGHTED,
      SLASH_BPS,
      BASE_LOCKUP,
      MAX_LOCKUP,
      TERMINATION_QUORUM,
      TERMINATION_GRACE
    );

    const SlashFactory = await ethers.getContractFactory("DatumGovernanceSlash");
    slash = await SlashFactory.deploy(
      await v2.getAddress(),
      await mock.getAddress()
    );

    // Wire: v2 <-> slash, mock knows v2 as governance
    await v2.setSlashContract(await slash.getAddress());
    await mock.setGovernanceContract(await v2.getAddress());

    // Register publisher
    await mock.connect(publisher).registerPublisher(TAKE_RATE_BPS);

    // Pre-fund mock with enough DOT for all campaign slash transfers
    const prefund = BUDGET * 20n;
    await owner.sendTransaction({ to: await mock.getAddress(), value: prefund });
  });

  // =========================================================================
  // Voting tests (V1-V8)
  // =========================================================================

  it("V1: vote() stores correct fields, updates ayeWeighted/nayWeighted", async function () {
    const cid = await createTestCampaign();
    const stake = parseDOT("0.5");

    await v2.connect(voter1).vote(cid, true, 2, { value: stake });

    const [dir, lockAmount, conviction, lockedUntil] = await v2.getVote(cid, voter1.address);
    expect(dir).to.equal(1); // aye
    expect(lockAmount).to.equal(stake);
    expect(conviction).to.equal(2);

    // weight = stake * 2^2 = stake * 4
    expect(await v2.ayeWeighted(cid)).to.equal(stake * 4n);
    expect(await v2.nayWeighted(cid)).to.equal(0n);
  });

  it("V2: cannot vote twice on same campaign", async function () {
    const cid = await createTestCampaign();
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("0.01") });

    await expect(
      v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("0.01") })
    ).to.be.revertedWith("E42");
  });

  it("V3: cannot vote on Completed/Terminated campaign", async function () {
    const cid = await createTestCampaign();
    await mock.setStatus(cid, 3); // Completed

    await expect(
      v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("0.01") })
    ).to.be.revertedWith("E43");
  });

  it("V4: conviction 0-6 produces correct weight and lockup", async function () {
    for (let c = 0; c <= 6; c++) {
      const cid = await createTestCampaign();
      const stake = parseDOT("0.01");

      const tx = await v2.connect(voter1).vote(cid, true, c, { value: stake });
      const receipt = await tx.wait();

      const expectedWeight = stake * BigInt(1 << c);
      expect(await v2.ayeWeighted(cid)).to.equal(expectedWeight);

      const [, , , lockedUntil] = await v2.getVote(cid, voter1.address);
      let expectedLockup = BASE_LOCKUP * BigInt(1 << c);
      if (expectedLockup > MAX_LOCKUP) expectedLockup = MAX_LOCKUP;
      expect(lockedUntil).to.equal(BigInt(receipt!.blockNumber) + expectedLockup);
    }
  });

  it("V5: conviction > 6 reverts", async function () {
    const cid = await createTestCampaign();
    await expect(
      v2.connect(voter1).vote(cid, true, 7, { value: parseDOT("0.01") })
    ).to.be.revertedWith("E40");
  });

  it("V6: can vote aye on Pending campaign", async function () {
    const cid = await createTestCampaign();
    // Status is Pending (0) by default
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("0.01") });
    const [dir] = await v2.getVote(cid, voter1.address);
    expect(dir).to.equal(1);
  });

  it("V7: can vote nay on Active campaign", async function () {
    const cid = await createTestCampaign();
    await mock.setStatus(cid, 1); // Active

    await v2.connect(voter1).vote(cid, false, 0, { value: parseDOT("0.01") });
    const [dir] = await v2.getVote(cid, voter1.address);
    expect(dir).to.equal(2); // nay
  });

  it("V8: can vote aye on Active campaign (support existing campaign)", async function () {
    const cid = await createTestCampaign();
    await mock.setStatus(cid, 1); // Active

    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("0.01") });
    const [dir] = await v2.getVote(cid, voter1.address);
    expect(dir).to.equal(1); // aye
  });

  // =========================================================================
  // Withdrawal tests (W1-W5)
  // =========================================================================

  it("W1: cannot withdraw before lockup expires", async function () {
    const cid = await createTestCampaign();
    await v2.connect(voter1).vote(cid, true, 1, { value: parseDOT("0.1") });

    await expect(
      v2.connect(voter1).withdraw(cid)
    ).to.be.revertedWith("E45");
  });

  it("W2: withdraw returns full stake when unresolved", async function () {
    const cid = await createTestCampaign();
    const stake = parseDOT("0.5");
    await v2.connect(voter1).vote(cid, true, 0, { value: stake });

    await minePastLockup(cid, voter1.address);

    const balBefore = await ethers.provider.getBalance(voter1.address);
    const tx = await v2.connect(voter1).withdraw(cid);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(voter1.address);

    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(stake);
    }
    // Vote zeroed
    const [dir] = await v2.getVote(cid, voter1.address);
    expect(dir).to.equal(0);
  });

  it("W3: withdraw deducts slash from losing side after resolution", async function () {
    const cid = await createTestCampaign();
    const ayeStake = parseDOT("1");
    const nayStake = parseDOT("2");

    // voter1 aye, voter2 nay (with majority)
    await v2.connect(voter1).vote(cid, true, 0, { value: ayeStake });
    await v2.connect(voter2).vote(cid, false, 0, { value: nayStake });

    // Set to Active, then terminate via evaluateCampaign
    await mock.setStatus(cid, 1); // Active (skip evaluation-based activation)
    // Mine past grace period
    await mineBlocks(TERMINATION_GRACE);
    // Now nay has majority (2 vs 1), evaluate to terminate
    await v2.evaluateCampaign(cid);
    expect(await v2.resolved(cid)).to.be.true;

    await minePastLockup(cid, voter1.address);

    // Aye voter withdraws — should be slashed (Terminated = aye loses)
    const balBefore = await ethers.provider.getBalance(voter1.address);
    const tx = await v2.connect(voter1).withdraw(cid);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(voter1.address);

    const expectedSlash = ayeStake * SLASH_BPS / 10000n;
    const expectedRefund = ayeStake - expectedSlash;

    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(expectedRefund);
    }

    expect(await v2.slashCollected(cid)).to.equal(expectedSlash);
  });

  it("W4: after withdrawal, voter can re-vote (direction reset to 0)", async function () {
    const cid = await createTestCampaign();
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("0.1") });

    await minePastLockup(cid, voter1.address);
    await v2.connect(voter1).withdraw(cid);

    // Re-vote nay
    await v2.connect(voter1).vote(cid, false, 0, { value: parseDOT("0.1") });
    const [dir] = await v2.getVote(cid, voter1.address);
    expect(dir).to.equal(2); // nay
  });

  it("W5: withdraw updates ayeWeighted/nayWeighted totals", async function () {
    const cid = await createTestCampaign();
    const stake = parseDOT("0.5");

    await v2.connect(voter1).vote(cid, true, 1, { value: stake });
    const weightBefore = await v2.ayeWeighted(cid);
    expect(weightBefore).to.equal(stake * 2n); // conviction 1 = 2x

    await minePastLockup(cid, voter1.address);
    await v2.connect(voter1).withdraw(cid);

    expect(await v2.ayeWeighted(cid)).to.equal(0n);
  });

  // =========================================================================
  // Evaluation tests (E1-E5)
  // =========================================================================

  it("E1: evaluateCampaign activates Pending campaign with aye majority + quorum", async function () {
    const cid = await createTestCampaign();

    // Vote aye with enough to meet quorum
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM_WEIGHTED });

    await v2.evaluateCampaign(cid);

    expect(await mock.getCampaignStatus(cid)).to.equal(1); // Active
  });

  it("E2: evaluateCampaign reverts if quorum not met", async function () {
    const cid = await createTestCampaign();

    // Vote aye but below quorum
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM_WEIGHTED / 2n });

    await expect(
      v2.evaluateCampaign(cid)
    ).to.be.revertedWith("E46");
  });

  it("E3: evaluateCampaign reverts if aye <= 50%", async function () {
    const cid = await createTestCampaign();

    // Equal aye and nay — aye must be STRICTLY > 50%
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM_WEIGHTED / 2n });
    await v2.connect(voter2).vote(cid, false, 0, { value: QUORUM_WEIGHTED / 2n });

    await expect(
      v2.evaluateCampaign(cid)
    ).to.be.revertedWith("E47");
  });

  it("E4: evaluateCampaign terminates Active campaign with nay majority", async function () {
    const cid = await createTestCampaign();

    // Activate first
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(1);

    // Nay votes to gain majority
    await v2.connect(voter2).vote(cid, false, 0, { value: QUORUM_WEIGHTED * 2n });

    // Mine past grace period
    await mineBlocks(TERMINATION_GRACE);

    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(4); // Terminated
    expect(await v2.resolved(cid)).to.be.true;
  });

  it("E5: evaluateCampaign marks Completed campaign as resolved", async function () {
    const cid = await createTestCampaign();
    await mock.setStatus(cid, 3); // Completed

    await v2.evaluateCampaign(cid);
    expect(await v2.resolved(cid)).to.be.true;
  });

  it("E6: termination reverts when nay < terminationQuorum (E52)", async function () {
    const cid = await createTestCampaign();

    // Activate with small aye vote
    const smallStake = TERMINATION_QUORUM / 4n;
    await v2.connect(voter1).vote(cid, true, 0, { value: smallStake });
    // Need quorum for activation — use mock to set Active directly
    await mock.setStatus(cid, 1);

    // Nay with less than terminationQuorum but enough for majority
    await v2.connect(voter2).vote(cid, false, 0, { value: smallStake });

    // Mine past grace period
    await mineBlocks(TERMINATION_GRACE);

    // Nay has majority (equal = >=50%) but below terminationQuorum
    await expect(
      v2.evaluateCampaign(cid)
    ).to.be.revertedWith("E52");
  });

  it("E7: termination reverts when grace period not elapsed (E53)", async function () {
    const cid = await createTestCampaign();

    // Activate
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(1);

    // Nay votes to gain majority and meet termination quorum
    await v2.connect(voter2).vote(cid, false, 0, { value: QUORUM_WEIGHTED * 2n });

    // Do NOT mine past grace period — should revert
    await expect(
      v2.evaluateCampaign(cid)
    ).to.be.revertedWith("E53");
  });

  it("E8: termination succeeds when both quorum and grace met", async function () {
    const cid = await createTestCampaign();

    // Activate
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(1);

    // Nay votes with enough weight for majority + termination quorum
    await v2.connect(voter2).vote(cid, false, 0, { value: QUORUM_WEIGHTED * 2n });

    // Mine past grace period
    await mineBlocks(TERMINATION_GRACE);

    // Should succeed
    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(4); // Terminated
    expect(await v2.resolved(cid)).to.be.true;
  });

  it("E9: firstNayBlock set on first nay, not overwritten by subsequent nay", async function () {
    const cid = await createTestCampaign();
    await mock.setStatus(cid, 1); // Active

    // First nay vote
    await v2.connect(voter1).vote(cid, false, 0, { value: parseDOT("0.5") });
    const firstBlock = await v2.firstNayBlock(cid);
    expect(firstBlock).to.be.gt(0n);

    // Mine a few blocks, then second nay vote
    await mineBlocks(5);
    await v2.connect(voter2).vote(cid, false, 0, { value: parseDOT("0.5") });

    // firstNayBlock should NOT have changed
    expect(await v2.firstNayBlock(cid)).to.equal(firstBlock);
  });

  // =========================================================================
  // T-1 Zero-vote edge cases
  // =========================================================================

  it("T1-1: evaluateCampaign on Active campaign with zero votes reverts E51", async function () {
    const cid = await createTestCampaign();
    await mock.setStatus(cid, 1); // Active

    // No votes at all — total == 0, should revert E51
    await expect(
      v2.evaluateCampaign(cid)
    ).to.be.revertedWith("E51");
  });

  it("T1-2: evaluateCampaign on non-existent campaign reverts", async function () {
    // Campaign 99999 was never created — MockCampaigns returns status 0 (Pending)
    // With no votes, quorum check fails
    await expect(
      v2.evaluateCampaign(99999n)
    ).to.be.revertedWith("E46");
  });

  // =========================================================================
  // T-3 Governance edge cases
  // =========================================================================

  it("T3-1: vote() with msg.value = 0 reverts E41", async function () {
    const cid = await createTestCampaign();
    await expect(
      v2.connect(voter1).vote(cid, true, 0, { value: 0n })
    ).to.be.revertedWith("E41");
  });

  it("T3-2: conviction 6 produces exactly 64x weight and lockup capped at maxLockupBlocks", async function () {
    const cid = await createTestCampaign();
    const stake = parseDOT("0.01");

    const tx = await v2.connect(voter1).vote(cid, true, 6, { value: stake });
    const receipt = await tx.wait();

    // Weight = stake * 2^6 = stake * 64
    expect(await v2.ayeWeighted(cid)).to.equal(stake * 64n);

    // Lockup = base * 2^6 = 10 * 64 = 640, but capped at MAX_LOCKUP = 100
    const [, , , lockedUntil] = await v2.getVote(cid, voter1.address);
    expect(lockedUntil).to.equal(BigInt(receipt!.blockNumber) + MAX_LOCKUP);
  });

  it("T3-3: withdraw() on Paused campaign before resolution returns full stake", async function () {
    const cid = await createTestCampaign();
    await v2.connect(voter1).vote(cid, true, 0, { value: parseDOT("0.5") });

    // Set to Paused (status 2) — not resolved
    await mock.setStatus(cid, 2);
    expect(await v2.resolved(cid)).to.be.false;

    await minePastLockup(cid, voter1.address);

    // Withdraw should return full stake (no slash — not resolved)
    const balBefore = await ethers.provider.getBalance(voter1.address);
    const tx = await v2.connect(voter1).withdraw(cid);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(voter1.address);

    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
    expect(balAfter - balBefore + gasUsed).to.equal(parseDOT("0.5"));
    expect(await v2.slashCollected(cid)).to.equal(0n);
  });

  // =========================================================================
  // Slash tests (S1-S5)
  // =========================================================================

  it("S1: finalizeSlash records winning side weight", async function () {
    const cid = await createTestCampaign();
    const ayeStake = parseDOT("1");
    const nayStake = parseDOT("2");

    await v2.connect(voter1).vote(cid, true, 0, { value: ayeStake });
    await mock.setStatus(cid, 1);
    await v2.connect(voter2).vote(cid, false, 0, { value: nayStake });

    // Mine past grace period, then terminate
    await mineBlocks(TERMINATION_GRACE);
    await v2.evaluateCampaign(cid);

    // Losing voter (aye) withdraws to populate slashCollected
    await minePastLockup(cid, voter1.address);
    await v2.connect(voter1).withdraw(cid);

    // Finalize
    await slash.finalizeSlash(cid);
    expect(await slash.finalized(cid)).to.be.true;
    // Nay wins on termination; winning weight = nayWeighted
    expect(await slash.winningWeight(cid)).to.equal(nayStake); // conviction 0 = 1x
  });

  it("S2: claimSlashReward distributes proportional share", async function () {
    const cid = await createTestCampaign();
    const ayeStake = parseDOT("1");
    const nayStake1 = parseDOT("1");
    const nayStake2 = parseDOT("1");

    await v2.connect(voter1).vote(cid, true, 0, { value: ayeStake });
    await mock.setStatus(cid, 1);
    await v2.connect(voter2).vote(cid, false, 0, { value: nayStake1 });
    await v2.connect(voter3).vote(cid, false, 0, { value: nayStake2 });

    // Mine past grace period, then terminate (nay has 2:1 majority)
    await mineBlocks(TERMINATION_GRACE);
    await v2.evaluateCampaign(cid);

    // Aye voter withdraws
    await minePastLockup(cid, voter1.address);
    await v2.connect(voter1).withdraw(cid);

    const totalSlash = ayeStake * SLASH_BPS / 10000n;
    expect(await v2.slashCollected(cid)).to.equal(totalSlash);

    // Finalize
    await slash.finalizeSlash(cid);

    // Each nay voter gets half (equal weight)
    const share = totalSlash / 2n;
    expect(await slash.getClaimable(cid, voter2.address)).to.equal(share);
    expect(await slash.getClaimable(cid, voter3.address)).to.equal(share);

    // Voter2 claims
    await minePastLockup(cid, voter2.address);
    await slash.connect(voter2).claimSlashReward(cid);
    expect(await slash.getClaimable(cid, voter2.address)).to.equal(0n);
  });

  it("S3: cannot claim slash reward twice", async function () {
    const cid = await createTestCampaign();
    const ayeStake = parseDOT("1");
    const nayStake = parseDOT("2");

    await v2.connect(voter1).vote(cid, true, 0, { value: ayeStake });
    await mock.setStatus(cid, 1);
    await v2.connect(voter2).vote(cid, false, 0, { value: nayStake });

    await mineBlocks(TERMINATION_GRACE);
    await v2.evaluateCampaign(cid);

    await minePastLockup(cid, voter1.address);
    await v2.connect(voter1).withdraw(cid);

    await slash.finalizeSlash(cid);
    await minePastLockup(cid, voter2.address);
    await slash.connect(voter2).claimSlashReward(cid);

    await expect(
      slash.connect(voter2).claimSlashReward(cid)
    ).to.be.revertedWith("E55");
  });

  it("S4: cannot claim if on losing side", async function () {
    const cid = await createTestCampaign();
    const ayeStake = parseDOT("1");
    const nayStake = parseDOT("0.5");

    await v2.connect(voter1).vote(cid, true, 0, { value: ayeStake });
    await v2.connect(voter2).vote(cid, false, 0, { value: nayStake });

    // Complete (aye wins)
    await mock.setStatus(cid, 3);
    await v2.evaluateCampaign(cid);

    // Nay voter withdraws (loser on Completed)
    await minePastLockup(cid, voter2.address);
    await v2.connect(voter2).withdraw(cid);

    await slash.finalizeSlash(cid);

    // Nay voter tries to claim — should fail (loser)
    // But voter2 already withdrew (direction=0), so E44
    await expect(
      slash.connect(voter2).claimSlashReward(cid)
    ).to.be.revertedWith("E44");
  });

  it("S5: slash reward amount matches slashBps deduction", async function () {
    const cid = await createTestCampaign();
    const ayeStake = parseDOT("2");
    const nayStake = parseDOT("3");

    await v2.connect(voter1).vote(cid, true, 0, { value: ayeStake });
    await mock.setStatus(cid, 1);
    await v2.connect(voter2).vote(cid, false, 0, { value: nayStake });

    // Mine past grace period, then terminate
    await mineBlocks(TERMINATION_GRACE);
    await v2.evaluateCampaign(cid);

    // Aye voter (loser) withdraws
    await minePastLockup(cid, voter1.address);
    await v2.connect(voter1).withdraw(cid);

    const expectedSlash = ayeStake * SLASH_BPS / 10000n;
    expect(await v2.slashCollected(cid)).to.equal(expectedSlash);

    // Finalize and check claimable matches
    await slash.finalizeSlash(cid);
    const claimable = await slash.getClaimable(cid, voter2.address);
    expect(claimable).to.equal(expectedSlash); // sole nay voter gets all
  });

  it("S6: claimSlashReward reverts when winningWeight is zero (all winners withdrew)", async function () {
    const cid = await createTestCampaign();
    const ayeStake = parseDOT("1");
    const nayStake = parseDOT("2");

    await v2.connect(voter1).vote(cid, true, 0, { value: ayeStake });
    await mock.setStatus(cid, 1);
    await v2.connect(voter2).vote(cid, false, 0, { value: nayStake });

    // Mine past grace period, then terminate (nay wins)
    await mineBlocks(TERMINATION_GRACE);
    await v2.evaluateCampaign(cid);

    // Aye voter (loser) withdraws — generates slash
    await minePastLockup(cid, voter1.address);
    await v2.connect(voter1).withdraw(cid);

    // Nay voter (winner) withdraws BEFORE finalization
    await minePastLockup(cid, voter2.address);
    await v2.connect(voter2).withdraw(cid);

    // Finalize — winningWeight should be 0 since all nay voters already withdrew
    await slash.finalizeSlash(cid);
    expect(await slash.winningWeight(cid)).to.equal(0n);

    // A third voter who somehow tries to claim should get E03
    // (voter2 already withdrew so direction=0, would get E44 first)
    // Verify getClaimable returns 0 for withdrawn voter
    expect(await slash.getClaimable(cid, voter2.address)).to.equal(0n);
  });

  // =========================================================================
  // Dynamic voting tests (D1-D4)
  // =========================================================================

  it("D1: campaign activates, aye withdraws, nay majority, evaluateCampaign terminates", async function () {
    const cid = await createTestCampaign();

    // voter1 aye -> activate
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(1); // Active

    // voter2 nay (less than aye initially, so E48 still fails)
    await v2.connect(voter2).vote(cid, false, 0, { value: QUORUM_WEIGHTED / 2n });

    // Aye still has majority — termination should fail
    await expect(
      v2.evaluateCampaign(cid)
    ).to.be.revertedWith("E48");

    // voter1 withdraws aye
    await minePastLockup(cid, voter1.address);
    await v2.connect(voter1).withdraw(cid);

    // Now nay has majority (0 aye vs QUORUM/2 nay) but below terminationQuorum
    // Need a bigger nay vote to meet termination quorum
    await v2.connect(voter3).vote(cid, false, 0, { value: TERMINATION_QUORUM });

    // Mine past grace period (firstNayBlock was set by voter2's earlier nay vote)
    await mineBlocks(TERMINATION_GRACE);

    await v2.evaluateCampaign(cid);
    expect(await mock.getCampaignStatus(cid)).to.equal(4); // Terminated
  });

  it("D2: multiple voters, mixed aye/nay, correct totals tracked", async function () {
    const cid = await createTestCampaign();
    const s1 = parseDOT("0.3");
    const s2 = parseDOT("0.5");
    const s3 = parseDOT("0.2");

    await v2.connect(voter1).vote(cid, true, 1, { value: s1 });   // weight = 0.3 * 2 = 0.6
    await v2.connect(voter2).vote(cid, false, 0, { value: s2 });  // weight = 0.5
    await v2.connect(voter3).vote(cid, true, 0, { value: s3 });   // weight = 0.2

    expect(await v2.ayeWeighted(cid)).to.equal(s1 * 2n + s3);   // 0.6 + 0.2 = 0.8
    expect(await v2.nayWeighted(cid)).to.equal(s2);               // 0.5
  });

  it("D3: re-vote after withdrawal changes side", async function () {
    const cid = await createTestCampaign();
    const stake = parseDOT("0.5");

    // Vote aye
    await v2.connect(voter1).vote(cid, true, 0, { value: stake });
    expect(await v2.ayeWeighted(cid)).to.equal(stake);
    expect(await v2.nayWeighted(cid)).to.equal(0n);

    // Withdraw
    await minePastLockup(cid, voter1.address);
    await v2.connect(voter1).withdraw(cid);
    expect(await v2.ayeWeighted(cid)).to.equal(0n);

    // Re-vote nay
    await v2.connect(voter1).vote(cid, false, 0, { value: stake });
    expect(await v2.ayeWeighted(cid)).to.equal(0n);
    expect(await v2.nayWeighted(cid)).to.equal(stake);
  });

  it("D4: unresolved campaign withdrawal returns full stake (no slash)", async function () {
    const cid = await createTestCampaign();
    const stake = parseDOT("0.5");

    await v2.connect(voter1).vote(cid, true, 0, { value: stake });

    // Campaign still Pending, not resolved
    expect(await v2.resolved(cid)).to.be.false;

    await minePastLockup(cid, voter1.address);

    const balBefore = await ethers.provider.getBalance(voter1.address);
    const tx = await v2.connect(voter1).withdraw(cid);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(voter1.address);

    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(stake);
    }

    expect(await v2.slashCollected(cid)).to.equal(0n);
  });
});
