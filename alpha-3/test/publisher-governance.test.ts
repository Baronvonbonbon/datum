import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumPublisherGovernance,
  DatumPublisherStake,
  DatumChallengeBonds,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// DatumPublisherGovernance tests (FP-3)
// PG1–PG4:   propose() — happy path, zero address/hash, event
// PG5–PG10:  vote() — aye/nay, conviction weighting, re-vote, locked vote, access
// PG11–PG13: withdrawVote() — locked, unlocked, non-voter
// PG14–PG19: resolve() — not-fraud (no quorum), fraud-upheld, grace period, slash→pool flow
// PG20–PG21: admin setters, ownership

describe("DatumPublisherGovernance", function () {
  let gov: DatumPublisherGovernance;
  let stakeContract: DatumPublisherStake;
  let bondsContract: DatumChallengeBonds;

  let owner: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  // Settings
  const QUORUM          = 10_000_000_000n;  // 1 DOT conviction-weighted
  const SLASH_BPS       = 5000n;            // 50%
  const BOND_BONUS_BPS  = 2000n;            // 20% of slash goes to pool
  const GRACE_BLOCKS    = 5n;
  const DELAY_BLOCKS    = 10n;
  const PUBLISHER_STAKE = 100_000_000_000n; // 10 DOT

  const EVIDENCE = ethers.keccak256(ethers.toUtf8Bytes("fraud_evidence"));
  const BOND     = 2_000_000_000n;

  before(async function () {
    await fundSigners();
    [owner, publisher, voter1, voter2, advertiser, other] = await ethers.getSigners();

    // Deploy DatumPublisherStake
    const StakeFactory = await ethers.getContractFactory("DatumPublisherStake");
    stakeContract = await StakeFactory.deploy(1_000_000_000n, 1_000n, DELAY_BLOCKS);

    // Deploy DatumChallengeBonds
    const BondsFactory = await ethers.getContractFactory("DatumChallengeBonds");
    bondsContract = await BondsFactory.deploy();

    // Deploy DatumPublisherGovernance
    const GovFactory = await ethers.getContractFactory("DatumPublisherGovernance");
    gov = await GovFactory.deploy(
      stakeContract.target,
      bondsContract.target,
      QUORUM,
      SLASH_BPS,
      BOND_BONUS_BPS,
      GRACE_BLOCKS
    );

    // Wire: stake slash contract = gov
    await stakeContract.connect(owner).setSlashContract(gov.target);
    // Wire: bonds governance contract = gov
    await bondsContract.connect(owner).setGovernanceContract(gov.target);
    // Wire: bonds campaigns contract = owner (to lock bonds in tests)
    await bondsContract.connect(owner).setCampaignsContract(owner.address);

    // Publisher stakes
    await stakeContract.connect(publisher).stake({ value: PUBLISHER_STAKE });
  });

  // ── propose() ─────────────────────────────────────────────────────────────────

  // PG1: anyone can propose
  it("PG1: propose creates proposal and emits ProposalCreated", async function () {
    await expect(gov.connect(voter1).propose(publisher.address, EVIDENCE))
      .to.emit(gov, "ProposalCreated")
      .withArgs(1n, publisher.address, EVIDENCE);

    const p = await gov.proposals(1n);
    expect(p.publisher).to.equal(publisher.address);
    expect(p.evidenceHash).to.equal(EVIDENCE);
    expect(p.resolved).to.equal(false);
  });

  // PG2: propose with zero publisher reverts E00
  it("PG2: propose with zero publisher reverts E00", async function () {
    await expect(
      gov.connect(voter1).propose(ethers.ZeroAddress, EVIDENCE)
    ).to.be.revertedWith("E00");
  });

  // PG3: propose with zero evidenceHash reverts E00
  it("PG3: propose with zero evidenceHash reverts E00", async function () {
    await expect(
      gov.connect(voter1).propose(publisher.address, ethers.ZeroHash)
    ).to.be.revertedWith("E00");
  });

  // PG4: nextProposalId increments
  it("PG4: nextProposalId increments per proposal", async function () {
    expect(await gov.nextProposalId()).to.equal(2n);
  });

  // ── vote() ────────────────────────────────────────────────────────────────────

  // PG5: aye vote records weight and emits VoteCast
  it("PG5: aye vote (conviction=0) records 1x weight", async function () {
    const amount = 5_000_000_000n; // 0.5 DOT
    await expect(gov.connect(voter1).vote(1n, true, 0, { value: amount }))
      .to.emit(gov, "VoteCast")
      .withArgs(1n, voter1.address, true, amount, 0);

    const p = await gov.proposals(1n);
    expect(p.ayeWeighted).to.equal(amount * 1n); // conviction 0 = 1x
  });

  // PG6: nay vote sets firstNayBlock
  it("PG6: nay vote sets firstNayBlock", async function () {
    const amount = 2_000_000_000n;
    await gov.connect(voter2).vote(1n, false, 0, { value: amount });
    const p = await gov.proposals(1n);
    expect(p.nayWeighted).to.equal(amount);
    expect(p.firstNayBlock).to.be.gt(0n);
  });

  // PG7: conviction weight multipliers are applied correctly
  it("PG7: conviction=2 applies 3x weight", async function () {
    // Create a fresh proposal for this test
    await gov.connect(voter1).propose(publisher.address, EVIDENCE);
    const proposalId = 2n;

    const amount = 1_000_000_000n;
    await gov.connect(voter1).vote(proposalId, true, 2, { value: amount });
    const p = await gov.proposals(proposalId);
    expect(p.ayeWeighted).to.equal(amount * 3n); // conviction 2 = 3x
  });

  // PG8: conviction out-of-range reverts E40
  it("PG8: conviction > MAX_CONVICTION reverts E40", async function () {
    await gov.connect(voter1).propose(publisher.address, EVIDENCE);
    const proposalId = 3n;
    await expect(
      gov.connect(voter1).vote(proposalId, true, 9, { value: 1_000_000_000n })
    ).to.be.revertedWith("E40");
  });

  // PG9: vote on non-existent proposal reverts E01
  it("PG9: vote on non-existent proposal reverts E01", async function () {
    await expect(
      gov.connect(voter1).vote(9999n, true, 0, { value: 1_000_000_000n })
    ).to.be.revertedWith("E01");
  });

  // PG10: zero-value vote reverts E11
  it("PG10: zero-value vote reverts E11", async function () {
    await gov.connect(voter1).propose(publisher.address, EVIDENCE);
    const proposalId = 4n;
    await expect(
      gov.connect(voter1).vote(proposalId, true, 0, { value: 0n })
    ).to.be.revertedWith("E11");
  });

  // ── withdrawVote() ────────────────────────────────────────────────────────────

  // PG11: withdrawVote on locked conviction reverts E42
  it("PG11: withdrawVote before lockup reverts E42", async function () {
    // voter1 voted with conviction=2 on proposal 2 (lockup = 43200 blocks)
    await expect(gov.connect(voter1).withdrawVote(2n)).to.be.revertedWith("E42");
  });

  // PG12: withdrawVote on conviction=0 (no lockup) succeeds
  it("PG12: withdrawVote with no lockup returns funds", async function () {
    // voter1 voted conviction=0 on proposal 1 (lockup=0)
    const v = await gov.getVote(1n, voter1.address);
    const balBefore = await ethers.provider.getBalance(voter1.address);
    const tx = await gov.connect(voter1).withdrawVote(1n);
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(voter1.address);
    expect(balAfter + gasUsed).to.be.closeTo(balBefore + v.lockAmount, 1_000_000n);
  });

  // PG13: withdrawVote with no vote reverts E01
  it("PG13: withdrawVote with no vote reverts E01", async function () {
    await expect(gov.connect(other).withdrawVote(1n)).to.be.revertedWith("E01");
  });

  // ── resolve() ─────────────────────────────────────────────────────────────────

  // PG14: resolve without meeting quorum results in not-fraud
  it("PG14: resolve with aye < quorum → not fraud", async function () {
    // Proposal 3 — no votes yet, will resolve as not-fraud
    // (needs no grace period since no nay votes)
    await gov.connect(voter1).propose(publisher.address, EVIDENCE);
    const pid = await gov.nextProposalId() - 1n;
    // Tiny aye vote below quorum
    await gov.connect(voter1).vote(pid, true, 0, { value: 1000n });
    // resolve immediately (no nay vote → no grace period)
    await expect(gov.connect(other).resolve(pid))
      .to.emit(gov, "ProposalResolved")
      .withArgs(pid, publisher.address, false, 0n);
    const p = await gov.proposals(pid);
    expect(p.resolved).to.equal(true);
  });

  // PG15: resolve before grace period elapses reverts E43
  it("PG15: resolve before grace period reverts E43", async function () {
    // Create a fresh proposal and vote nay, then immediately try to resolve
    await gov.connect(voter1).propose(publisher.address, EVIDENCE);
    const pid = await gov.nextProposalId() - 1n;
    // Large aye vote to meet quorum
    await gov.connect(voter1).vote(pid, true, 0, { value: 20_000_000_000n });
    // Nay vote — sets firstNayBlock; grace period hasn't elapsed yet
    await gov.connect(voter2).vote(pid, false, 0, { value: 1_000_000_000n });
    // Immediately resolve — grace blocks (5) haven't passed since nay
    await expect(gov.connect(other).resolve(pid)).to.be.revertedWith("E43");
  });

  // PG16: resolve after grace period with fraud upheld slashes publisher
  it("PG16: resolve after grace — fraud upheld, publisher slashed", async function () {
    // Create fresh proposal with large aye > quorum and nay, then wait grace
    await gov.connect(voter1).propose(publisher.address, EVIDENCE);
    const pid = await gov.nextProposalId() - 1n;

    // Aye vote: 5 DOT × 6x (conviction 4) = 30 DOT weighted
    const AYE_AMOUNT = 5_000_000_000n;
    await gov.connect(voter1).vote(pid, true, 4, { value: AYE_AMOUNT });
    // Nay vote: small
    await gov.connect(voter2).vote(pid, false, 0, { value: 100_000_000n });

    await mineBlocks(GRACE_BLOCKS + 1n);

    const stakedBefore = await stakeContract.staked(publisher.address);
    const expectedSlash = (stakedBefore * SLASH_BPS) / 10000n;

    await expect(gov.connect(other).resolve(pid))
      .to.emit(gov, "ProposalResolved")
      .withArgs(pid, publisher.address, true, expectedSlash);

    const stakedAfter = await stakeContract.staked(publisher.address);
    expect(stakedAfter).to.equal(stakedBefore - expectedSlash);
  });

  // PG17: slash proceeds partially go to bonus pool via ChallengeBonds
  it("PG17: bondBonusBps% of slash is forwarded to ChallengeBonds pool", async function () {
    // publisher has been slashed; check bonusPool was updated
    // Gov contract should have forwarded bondBonusBps% to bondsContract
    const pool = await bondsContract.bonusPool(publisher.address);
    // The pool should be > 0 (funded by the slash in PG16)
    expect(pool).to.be.gt(0n);
  });

  // PG18: resolve on already-resolved proposal reverts E41
  it("PG18: double resolve reverts E41", async function () {
    // Find last resolved proposal (from PG16)
    const pid = await gov.nextProposalId() - 1n;
    await expect(gov.connect(other).resolve(pid)).to.be.revertedWith("E41");
  });

  // PG19: resolve on non-existent proposal reverts E01
  it("PG19: resolve on non-existent proposal reverts E01", async function () {
    await expect(gov.connect(other).resolve(9999n)).to.be.revertedWith("E01");
  });

  // ── Admin ─────────────────────────────────────────────────────────────────────

  // PG20: setParams from non-owner reverts E18
  it("PG20: setParams from non-owner reverts E18", async function () {
    await expect(
      gov.connect(other).setParams(QUORUM, SLASH_BPS, BOND_BONUS_BPS, GRACE_BLOCKS)
    ).to.be.revertedWith("E18");
  });

  // PG21: slashBps > 10000 reverts E00
  it("PG21: setParams with slashBps > 10000 reverts E00", async function () {
    await expect(
      gov.connect(owner).setParams(QUORUM, 10001n, BOND_BONUS_BPS, GRACE_BLOCKS)
    ).to.be.revertedWith("E00");
  });

  // PG22: two-step ownership transfer
  it("PG22: two-step ownership transfer works", async function () {
    await gov.connect(owner).transferOwnership(other.address);
    expect(await gov.pendingOwner()).to.equal(other.address);
    await gov.connect(other).acceptOwnership();
    expect(await gov.owner()).to.equal(other.address);
    await gov.connect(other).transferOwnership(owner.address);
    await gov.connect(owner).acceptOwnership();
    expect(await gov.owner()).to.equal(owner.address);
  });
});
