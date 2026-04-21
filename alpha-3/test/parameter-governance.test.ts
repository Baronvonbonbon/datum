import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumParameterGovernance,
  DatumPublisherStake,
  MockCallTarget,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// DatumParameterGovernance tests (T1-B)
// PGV1–PGV3:  propose() — happy path, zero target, wrong bond
// PGV4–PGV7:  vote() — aye/nay, conviction weight, locked re-vote, zero value
// PGV8:       withdrawVote() — locked reverts, conviction 0 withdraws
// PGV9–PGV11: resolve() — passes, rejected (bond slashed), cannot re-resolve
// PGV12–PGV13: execute() — calls target, returns bond; too-early reverts
// PGV14–PGV15: cancel() — owner cancels, non-owner reverts
// PGV16:      setParams — updates all params
// PGV17:      ownership transfer

describe("DatumParameterGovernance", function () {
  let gov: DatumParameterGovernance;
  let target: MockCallTarget;
  let stakeContract: DatumPublisherStake;

  let owner: HardhatEthersSigner;
  let proposer: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const VOTING_PERIOD = 20n;
  const TIMELOCK      = 3n;
  const QUORUM        = 10_000_000_000n; // 1 DOT conviction-weighted
  const PROPOSE_BOND  = 2_000_000_000n;  // 0.2 DOT

  before(async function () {
    await fundSigners();
    [owner, proposer, voter1, voter2, other] = await ethers.getSigners();

    const GovFactory = await ethers.getContractFactory("DatumParameterGovernance");
    gov = await GovFactory.deploy(VOTING_PERIOD, TIMELOCK, QUORUM, PROPOSE_BOND);

    const TargetFactory = await ethers.getContractFactory("MockCallTarget");
    target = await TargetFactory.deploy();

    // For ABI encoding tests only (no ownership needed)
    const StakeFactory = await ethers.getContractFactory("DatumPublisherStake");
    stakeContract = await StakeFactory.deploy(1_000_000_000n, 1_000n, 100n);

    // AUDIT-004: whitelist MockCallTarget so PGV11 execute() can proceed
    await gov.connect(owner).setWhitelistedTarget(await target.getAddress(), true);
    await gov.connect(owner).setPermittedSelector(await target.getAddress(), "0xdeadbeef", true);
  });

  // ── PGV1: propose happy path ─────────────────────────────────────────────────

  it("PGV1 propose — creates proposal with correct fields", async function () {
    const payload = "0xdeadbeef";
    const tx = await gov.connect(proposer).propose(
      await target.getAddress(), payload, "Test proposal",
      { value: PROPOSE_BOND }
    );
    const receipt = await tx.wait();
    const event = receipt?.logs.map(l => {
      try { return gov.interface.parseLog(l); } catch { return null; }
    }).find(e => e?.name === "Proposed");
    expect(event).to.not.be.null;
    expect(event?.args.proposalId).to.equal(0n);
    expect(event?.args.proposer).to.equal(proposer.address);

    const p = await gov.proposals(0n);
    expect(p.state).to.equal(0); // Active
    expect(p.bond).to.equal(PROPOSE_BOND);
    expect(p.endBlock - p.startBlock).to.equal(VOTING_PERIOD);
  });

  // ── PGV2: propose — wrong bond ───────────────────────────────────────────────

  it("PGV2 propose — wrong bond reverts E11", async function () {
    await expect(
      gov.connect(proposer).propose(await target.getAddress(), "0x01", "x", { value: 1n })
    ).to.be.revertedWith("E11");
  });

  // ── PGV3: propose — zero target reverts E00 ─────────────────────────────────

  it("PGV3 propose — zero target reverts E00", async function () {
    await expect(
      gov.connect(proposer).propose(ethers.ZeroAddress, "0x01", "x", { value: PROPOSE_BOND })
    ).to.be.revertedWith("E00");
  });

  // ── PGV4: vote aye ───────────────────────────────────────────────────────────

  it("PGV4 vote — aye adds conviction-weighted weight", async function () {
    const amount = 1_000_000_000n;
    await gov.connect(voter1).vote(0n, true, 1, { value: amount }); // ×2

    const p = await gov.proposals(0n);
    expect(p.ayeWeight).to.equal(amount * 2n);
    expect(p.nayWeight).to.equal(0n);

    const v = await gov.getVote(0n, voter1.address);
    expect(v.aye).to.be.true;
    expect(v.conviction).to.equal(1);
    expect(v.lockAmount).to.equal(amount);
  });

  // ── PGV5: vote nay ───────────────────────────────────────────────────────────

  it("PGV5 vote — nay with conviction 0 (×1)", async function () {
    const amount = 500_000_000n;
    await gov.connect(voter2).vote(0n, false, 0, { value: amount });

    const p = await gov.proposals(0n);
    expect(p.nayWeight).to.equal(amount);
  });

  // ── PGV6: vote — zero value reverts E03 ──────────────────────────────────────

  it("PGV6 vote — zero value reverts E03", async function () {
    await expect(gov.connect(other).vote(0n, true, 0, { value: 0n })).to.be.revertedWith("E03");
  });

  // ── PGV7: vote — conviction > 8 reverts E40 ──────────────────────────────────

  it("PGV7 vote — conviction > 8 reverts E40", async function () {
    await expect(
      gov.connect(other).vote(0n, true, 9, { value: 1_000_000_000n })
    ).to.be.revertedWith("E40");
  });

  // ── PGV8: withdrawVote ────────────────────────────────────────────────────────

  it("PGV8 withdrawVote — locked vote reverts E40; conviction 0 withdraws immediately", async function () {
    // voter1 has conviction 1 (14400 block lockup) — locked
    await expect(gov.connect(voter1).withdrawVote(0n)).to.be.revertedWith("E40");

    // voter2 voted with conviction 0 — lockUntil = block.number + 0 = at-or-before now
    const v = await gov.getVote(0n, voter2.address);
    expect(v.lockAmount).to.be.gt(0n);
    const before = await ethers.provider.getBalance(voter2.address);
    const tx = await gov.connect(voter2).withdrawVote(0n);
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * tx.gasPrice!;
    const after = await ethers.provider.getBalance(voter2.address);
    expect(after + gasCost).to.be.closeTo(before + v.lockAmount, 1_000_000n);

    // Re-withdraw reverts E03
    await expect(gov.connect(voter2).withdrawVote(0n)).to.be.revertedWith("E03");
  });

  // ── PGV9: resolve — passes ───────────────────────────────────────────────────

  it("PGV9 resolve — passes when aye >= quorum and aye > nay", async function () {
    // voter1: 1_000_000_000 × 2 = 2_000_000_000; need 10_000_000_000
    const bigVote = 5_000_000_000n; // × 2 = 10_000_000_000 → total aye = 12_000_000_000
    await gov.connect(other).vote(0n, true, 1, { value: bigVote });

    const p = await gov.proposals(0n);
    const currentBlock = await ethers.provider.getBlockNumber();
    const blocksToMine = Number(p.endBlock) - currentBlock + 1;
    if (blocksToMine > 0) await mineBlocks(blocksToMine);

    await gov.connect(other).resolve(0n);

    const resolved = await gov.proposals(0n);
    expect(resolved.state).to.equal(1); // Passed
    expect(resolved.executeAfter).to.be.gt(0n);
  });

  // ── PGV10: resolve — cannot re-resolve ───────────────────────────────────────

  it("PGV10 resolve — already resolved reverts E40", async function () {
    await expect(gov.connect(other).resolve(0n)).to.be.revertedWith("E40");
  });

  // ── PGV11: execute — success ──────────────────────────────────────────────────

  it("PGV11 execute — calls target, returns bond to proposer", async function () {
    const p = await gov.proposals(0n);
    const currentBlock = await ethers.provider.getBlockNumber();
    const blocksToMine = Number(p.executeAfter) - currentBlock + 1;
    if (blocksToMine > 0) await mineBlocks(blocksToMine);

    const before = await ethers.provider.getBalance(proposer.address);
    await gov.connect(other).execute(0n);
    const after = await ethers.provider.getBalance(proposer.address);

    expect(after - before).to.equal(PROPOSE_BOND);

    const callCount = await target.callCount();
    expect(callCount).to.equal(1n); // MockCallTarget's fallback was invoked

    const executed = await gov.proposals(0n);
    expect(executed.state).to.equal(2); // Executed
    expect(executed.bond).to.equal(0n);
  });

  // ── PGV12: execute — too early ────────────────────────────────────────────────

  it("PGV12 execute — before timelock reverts E40", async function () {
    // Create a new proposal and pass it, then try to execute immediately
    await gov.connect(proposer).propose(
      await target.getAddress(), "0xdeadbeef", "Early execute test",
      { value: PROPOSE_BOND }
    );
    const proposalId = await gov.nextProposalId() - 1n;

    // Vote to pass
    await gov.connect(voter1).vote(proposalId, true, 1, { value: 5_000_000_000n });
    await gov.connect(other).vote(proposalId, true, 1, { value: 5_000_000_000n });

    const p = await gov.proposals(proposalId);
    const currentBlock = await ethers.provider.getBlockNumber();
    let blocksToMine = Number(p.endBlock) - currentBlock + 1;
    if (blocksToMine > 0) await mineBlocks(blocksToMine);
    await gov.connect(other).resolve(proposalId);

    // executeAfter = endBlock + timelockBlocks = now + 3 blocks (approx)
    // Immediately try to execute — may or may not be before executeAfter
    const p2 = await gov.proposals(proposalId);
    const current2 = BigInt(await ethers.provider.getBlockNumber());
    if (current2 < p2.executeAfter) {
      await expect(gov.connect(other).execute(proposalId)).to.be.revertedWith("E40");
    } else {
      this.skip(); // Hardhat mines fast; timelock already elapsed
    }
  });

  // ── PGV13: rejected — bond slashed ────────────────────────────────────────────

  it("PGV13 reject — bond slashed to owner when quorum not met", async function () {
    await gov.connect(proposer).propose(
      await target.getAddress(), "0xdeadbeef", "No quorum",
      { value: PROPOSE_BOND }
    );
    const proposalId = await gov.nextProposalId() - 1n;

    // No votes (ayeWeight = 0 < QUORUM)
    const p = await gov.proposals(proposalId);
    const currentBlock = await ethers.provider.getBlockNumber();
    const blocksToMine = Number(p.endBlock) - currentBlock + 1;
    if (blocksToMine > 0) await mineBlocks(blocksToMine);

    const ownerBefore = await ethers.provider.getBalance(owner.address);
    await gov.connect(other).resolve(proposalId);
    const ownerAfter = await ethers.provider.getBalance(owner.address);

    const rejected = await gov.proposals(proposalId);
    expect(rejected.state).to.equal(3); // Rejected
    expect(ownerAfter - ownerBefore).to.equal(PROPOSE_BOND);
  });

  // ── PGV14: cancel — owner cancels Active proposal ─────────────────────────────

  it("PGV14 cancel — owner cancels, bond slashed", async function () {
    await gov.connect(proposer).propose(
      await target.getAddress(), "0xdeadbeef", "Cancel me",
      { value: PROPOSE_BOND }
    );
    const proposalId = await gov.nextProposalId() - 1n;

    const ownerBefore = await ethers.provider.getBalance(owner.address);
    const tx = await gov.connect(owner).cancel(proposalId);
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * tx.gasPrice!;
    const ownerAfter = await ethers.provider.getBalance(owner.address);

    expect(ownerAfter + gasCost - ownerBefore).to.be.closeTo(PROPOSE_BOND, 1_000_000n);
    expect((await gov.proposals(proposalId)).state).to.equal(4); // Cancelled
  });

  // ── PGV15: cancel — non-owner reverts E18 ────────────────────────────────────

  it("PGV15 cancel — non-owner reverts E18", async function () {
    await gov.connect(proposer).propose(
      await target.getAddress(), "0xdeadbeef", "Non-owner cancel",
      { value: PROPOSE_BOND }
    );
    const proposalId = await gov.nextProposalId() - 1n;
    await expect(gov.connect(other).cancel(proposalId)).to.be.revertedWith("E18");
    await gov.connect(owner).cancel(proposalId);
  });

  // ── PGV16: setParams ──────────────────────────────────────────────────────────

  it("PGV16 setParams — owner updates params", async function () {
    await gov.connect(owner).setParams(20n, 10n, 50_000_000_000n, 5_000_000_000n);
    expect(await gov.votingPeriodBlocks()).to.equal(20n);
    expect(await gov.timelockBlocks()).to.equal(10n);
    expect(await gov.quorum()).to.equal(50_000_000_000n);
    expect(await gov.proposeBond()).to.equal(5_000_000_000n);

    await expect(gov.connect(other).setParams(1n, 1n, 1n, 1n)).to.be.revertedWith("E18");

    // Restore
    await gov.connect(owner).setParams(VOTING_PERIOD, TIMELOCK, QUORUM, PROPOSE_BOND);
  });

  // ── PGV17: ownership transfer ─────────────────────────────────────────────────

  it("PGV17 ownership — two-step transfer", async function () {
    await gov.connect(owner).transferOwnership(other.address);
    expect(await gov.pendingOwner()).to.equal(other.address);

    await expect(gov.connect(voter1).acceptOwnership()).to.be.revertedWith("E18");

    await gov.connect(other).acceptOwnership();
    expect(await gov.owner()).to.equal(other.address);

    await gov.connect(other).transferOwnership(owner.address);
    await gov.connect(owner).acceptOwnership();
    expect(await gov.owner()).to.equal(owner.address);
  });

  // ── PGV18: conviction helpers ─────────────────────────────────────────────────

  it("PGV18 convictionWeight and convictionLockup — boundary values", async function () {
    expect(await gov.convictionWeight(0)).to.equal(1n);
    expect(await gov.convictionWeight(8)).to.equal(21n);
    expect(await gov.convictionLockup(0)).to.equal(0n);
    expect(await gov.convictionLockup(1)).to.equal(14_400n);
    expect(await gov.convictionLockup(8)).to.equal(5_256_000n);

    await expect(gov.convictionWeight(9)).to.be.revertedWith("E40");
    await expect(gov.convictionLockup(9)).to.be.revertedWith("E40");
  });
});
