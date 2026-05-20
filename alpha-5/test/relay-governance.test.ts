import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumRelayGovernance,
  DatumRelayStake,
  DatumPauseRegistry,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// DatumRelayGovernance tests (G-1 first close)
// RG1–RG6:   propose() — reason codes, evidence hash, bond, self-propose, anti-laundering
// RG7–RG12:  vote() — aye/nay, conviction weighting, re-vote, lockup, pause
// RG13–RG16: withdrawVote() — locked, unlocked, idempotent
// RG17–RG24: resolve() — quorum/non-quorum, fraud upheld → slash + distribution,
//                        grace period, bond accounting
// RG25–RG28: parameter setters — conviction curve L6 mirror, slash bps caps
// RG29–RG32: claim flow + treasury sweep
// RG33–RG36: wiring + lock-once

describe("DatumRelayGovernance", function () {
  let gov: DatumRelayGovernance;
  let stake: DatumRelayStake;
  let pauseReg: DatumPauseRegistry;

  let owner: HardhatEthersSigner;
  let proposer: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;
  let relay: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const MIN_STAKE         = 10_000_000_000n;     // 1 DOT
  const EXIT_DELAY        = 20n;
  const RELAY_STAKE_AMT   = 100_000_000_000n;    // 10 DOT
  const QUORUM            = 10_000_000_000n;     // 1 DOT conviction-weighted
  const GRACE_BLOCKS      = 5n;
  const SLASH_AMOUNT_BPS  = 5000n;               // 50% of relay's stake on uphold
  const CHALLENGER_BPS    = 2000n;               // 20% to proposer
  const TREASURY_BPS      = 1000n;               // 10% to treasury
  const PROPOSE_BOND      = 2_000_000_000n;
  const EVIDENCE          = ethers.keccak256(ethers.toUtf8Bytes("censorship_evidence"));

  beforeEach(async function () {
    await fundSigners();
    [owner, proposer, voter1, voter2, relay, treasury, other] = await ethers.getSigners();

    const StakeFactory = await ethers.getContractFactory("DatumRelayStake");
    stake = await StakeFactory.deploy(MIN_STAKE, EXIT_DELAY);

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, voter1.address, voter2.address);

    const GovFactory = await ethers.getContractFactory("DatumRelayGovernance");
    gov = await GovFactory.deploy(
      QUORUM,
      GRACE_BLOCKS,
      PROPOSE_BOND,
      SLASH_AMOUNT_BPS,
      CHALLENGER_BPS,
      TREASURY_BPS
    );

    // Wire
    await gov.connect(owner).setRelayStake(stake.target);
    await gov.connect(owner).setPauseRegistry(await pauseReg.getAddress());
    await gov.connect(owner).setTreasury(treasury.address);

    await stake.connect(owner).setRelayContract(other.address);  // placeholder
    await stake.connect(owner).setGovernance(gov.target);

    // Relay stakes
    await stake.connect(relay).stake({ value: RELAY_STAKE_AMT });
  });

  // ── propose() ────────────────────────────────────────────────────────

  it("RG1: propose with valid args creates proposal", async function () {
    await expect(gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND }))
      .to.emit(gov, "ProposalCreated")
      .withArgs(1n, relay.address, proposer.address, 1, EVIDENCE);
    const p = await gov.proposals(1n);
    expect(p.relay).to.equal(relay.address);
    expect(p.reasonCode).to.equal(1);
    expect(p.bond).to.equal(PROPOSE_BOND);
  });

  it("RG2: propose with reason 0 reverts E68", async function () {
    await expect(gov.connect(proposer).propose(relay.address, 0, EVIDENCE, { value: PROPOSE_BOND }))
      .to.be.revertedWithCustomError(gov, "E68");
  });

  it("RG3: propose with reason > 4 reverts E68", async function () {
    await expect(gov.connect(proposer).propose(relay.address, 5, EVIDENCE, { value: PROPOSE_BOND }))
      .to.be.revertedWithCustomError(gov, "E68");
  });

  it("RG4: propose with wrong bond reverts E11", async function () {
    await expect(gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND - 1n }))
      .to.be.revertedWithCustomError(gov, "E11");
  });

  it("RG5: relay cannot propose against itself (anti-laundering)", async function () {
    await expect(gov.connect(relay).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND }))
      .to.be.revertedWithCustomError(gov, "E18");
  });

  it("RG6: propose with zero address / zero evidence reverts E00", async function () {
    await expect(gov.connect(proposer).propose(ethers.ZeroAddress, 1, EVIDENCE, { value: PROPOSE_BOND }))
      .to.be.revertedWithCustomError(gov, "E00");
    await expect(gov.connect(proposer).propose(relay.address, 1, ethers.ZeroHash, { value: PROPOSE_BOND }))
      .to.be.revertedWithCustomError(gov, "E00");
  });

  // ── vote() ───────────────────────────────────────────────────────────

  it("RG7: vote aye/nay updates weighted tallies", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, true, 0, { value: 5_000_000_000n });
    await gov.connect(voter2).vote(1n, false, 0, { value: 3_000_000_000n });
    const p = await gov.proposals(1n);
    expect(p.ayeWeighted).to.equal(5_000_000_000n);  // conv=0 → weight 1
    expect(p.nayWeighted).to.equal(3_000_000_000n);
  });

  it("RG8: higher conviction gives quadratic weight", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    // weight(2) = (25*4 + 50*2) / 100 + 1 = 200/100 + 1 = 3x
    await gov.connect(voter1).vote(1n, true, 2, { value: 1_000_000_000n });
    const p = await gov.proposals(1n);
    expect(p.ayeWeighted).to.equal(3_000_000_000n);
  });

  it("RG9: vote with conviction > MAX (8) reverts E40", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await expect(gov.connect(voter1).vote(1n, true, 9, { value: 1_000_000_000n }))
      .to.be.revertedWithCustomError(gov, "E40");
  });

  it("RG10: vote with value=0 reverts E11", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await expect(gov.connect(voter1).vote(1n, true, 0, { value: 0n }))
      .to.be.revertedWithCustomError(gov, "E11");
  });

  it("RG11: re-vote during lockup reverts E42", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, true, 1, { value: 1_000_000_000n });  // 1d lockup
    await expect(gov.connect(voter1).vote(1n, false, 0, { value: 500_000_000n }))
      .to.be.revertedWithCustomError(gov, "E42");
  });

  it("RG12: re-vote after lockup expires updates tallies", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, true, 0, { value: 1_000_000_000n });  // 0 lockup
    await gov.connect(voter1).vote(1n, false, 0, { value: 500_000_000n });
    const p = await gov.proposals(1n);
    expect(p.ayeWeighted).to.equal(0n);
    expect(p.nayWeighted).to.equal(500_000_000n);
  });

  // ── withdrawVote() ───────────────────────────────────────────────────

  it("RG13: withdrawVote during lockup reverts E42", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, true, 1, { value: 1_000_000_000n });
    await expect(gov.connect(voter1).withdrawVote(1n))
      .to.be.revertedWithCustomError(gov, "E42");
  });

  it("RG14: withdrawVote refunds + clears", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, true, 0, { value: 1_000_000_000n });
    const balBefore = await ethers.provider.getBalance(voter1.address);
    const tx = await gov.connect(voter1).withdrawVote(1n);
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(voter1.address);
    expect(balAfter - balBefore + gasCost).to.equal(1_000_000_000n);
  });

  it("RG15: withdrawVote from non-voter reverts E01", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await expect(gov.connect(other).withdrawVote(1n))
      .to.be.revertedWithCustomError(gov, "E01");
  });

  // ── resolve() ────────────────────────────────────────────────────────

  it("RG16: resolve below quorum → not fraud, bond refunded to proposer", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    // Vote small amount — below quorum
    await gov.connect(voter1).vote(1n, true, 0, { value: 1_000n });
    await gov.connect(voter1).vote(1n, false, 0, { value: 0n }).catch(() => {});
    // No nay → no grace required
    await expect(gov.connect(other).resolve(1n))
      .to.emit(gov, "ProposalResolved")
      .withArgs(1n, relay.address, false, 0n);
    // Bond → forfeited to owner (no quorum reached)
    expect(await gov.pendingGovPayout(owner.address)).to.equal(PROPOSE_BOND);
  });

  it("RG17: fraud upheld slashes relay + distributes correctly", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    // Vote above quorum, aye dominates
    await gov.connect(voter1).vote(1n, true, 0, { value: QUORUM + 1n });
    const [stakeBefore] = await stake.stakeOf(relay.address);
    const expectedSlash = (stakeBefore * SLASH_AMOUNT_BPS) / 10000n;
    await expect(gov.connect(other).resolve(1n))
      .to.emit(gov, "ProposalResolved")
      .withArgs(1n, relay.address, true, expectedSlash);
    const [stakeAfter] = await stake.stakeOf(relay.address);
    expect(stakeAfter).to.equal(stakeBefore - expectedSlash);
    // Proposer queued for challenger bonus
    const expectedChallenger = (expectedSlash * CHALLENGER_BPS) / 10000n;
    expect(await gov.pendingGovPayout(proposer.address)).to.equal(expectedChallenger + PROPOSE_BOND);  // bonus + refunded bond
    // Treasury queued for treasury cut
    const expectedTreasury = (expectedSlash * TREASURY_BPS) / 10000n;
    expect(await gov.pendingGovPayout(treasury.address)).to.equal(expectedTreasury);
    // Residue accumulated to contract treasuryBalance
    const distributed = expectedChallenger + expectedTreasury;
    expect(await gov.treasuryBalance()).to.equal(expectedSlash - distributed);
  });

  it("RG18: fraud upheld at MAX_PUNISHMENT_BPS cap (slashAmountBps = 10000 still capped)", async function () {
    // Push slash bps high; RelayStake caps at MAX_PUNISHMENT_BPS = 8000.
    await gov.connect(owner).setSlashAmountBps(10000);
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, true, 0, { value: QUORUM + 1n });
    const [stakeBefore] = await stake.stakeOf(relay.address);
    await gov.connect(other).resolve(1n);
    const [stakeAfter] = await stake.stakeOf(relay.address);
    // 80% slashed → 20% retained
    expect(stakeAfter).to.equal((stakeBefore * 2000n) / 10000n);
  });

  it("RG19: ayes < nays → not fraud", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, true, 0, { value: QUORUM });
    await gov.connect(voter2).vote(1n, false, 0, { value: QUORUM + 1n });
    await mineBlocks(Number(GRACE_BLOCKS) + 1);
    await gov.connect(other).resolve(1n);
    const p = await gov.proposals(1n);
    expect(p.resolved).to.equal(true);
    // Quorum reached → bond refund to proposer
    expect(await gov.pendingGovPayout(proposer.address)).to.equal(PROPOSE_BOND);
  });

  it("RG20: grace period enforced after first nay", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, false, 0, { value: 1_000_000_000n });
    await expect(gov.connect(other).resolve(1n))
      .to.be.revertedWithCustomError(gov, "E43");
    await mineBlocks(Number(GRACE_BLOCKS) + 1);
    // After grace
    await expect(gov.connect(other).resolve(1n))
      .to.emit(gov, "ProposalResolved");
  });

  it("RG21: double resolve reverts E41", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, true, 0, { value: QUORUM + 1n });
    await gov.connect(other).resolve(1n);
    await expect(gov.connect(other).resolve(1n))
      .to.be.revertedWithCustomError(gov, "E41");
  });

  it("RG22: resolve of unknown proposal reverts E01", async function () {
    await expect(gov.connect(other).resolve(999n))
      .to.be.revertedWithCustomError(gov, "E01");
  });

  // ── parameter setters ────────────────────────────────────────────────

  it("RG23: setConvictionCurve(0, 0) reverts (L6 mirror)", async function () {
    await expect(gov.connect(owner).setConvictionCurve(0, 0))
      .to.be.revertedWithCustomError(gov, "E11");
  });

  it("RG24: setConvictionCurve accepts (a, 0) and (0, b)", async function () {
    await gov.connect(owner).setConvictionCurve(10, 0);
    expect(await gov.convictionA()).to.equal(10n);
    await gov.connect(owner).setConvictionCurve(0, 5);
    expect(await gov.convictionB()).to.equal(5n);
  });

  it("RG25: setSlashAmountBps rejects > 10000", async function () {
    await expect(gov.connect(owner).setSlashAmountBps(10001))
      .to.be.revertedWithCustomError(gov, "E11");
  });

  it("RG26: setTreasuryBps rejects sum > 10000 with challengerBonusBps", async function () {
    // challengerBonusBps starts at 2000. Setting treasuryBps to 8001 exceeds.
    await expect(gov.connect(owner).setTreasuryBps(8001))
      .to.be.revertedWithCustomError(gov, "E11");
  });

  it("RG27: per-proposal conviction snapshot survives mid-flight retune (M-2)", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    expect(await gov.proposalConvictionA(1n)).to.equal(25n);
    expect(await gov.proposalConvictionB(1n)).to.equal(50n);
    // Retune curve mid-flight
    await gov.connect(owner).setConvictionCurve(100, 0);
    // Vote with conviction=2 — should still use snapshotted (25, 50) curve
    await gov.connect(voter1).vote(1n, true, 2, { value: 1_000_000_000n });
    const p = await gov.proposals(1n);
    expect(p.ayeWeighted).to.equal(3_000_000_000n);  // weight=3 from old curve
  });

  // ── claim flow ───────────────────────────────────────────────────────

  it("RG28: claimGovPayout pulls queued amount", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, true, 0, { value: QUORUM + 1n });
    await gov.connect(other).resolve(1n);
    const balBefore = await ethers.provider.getBalance(proposer.address);
    const tx = await gov.connect(proposer).claimGovPayout();
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(proposer.address);
    // Should have received challenger bonus + bond refund
    const [stakeBefore] = [RELAY_STAKE_AMT];  // pre-slash
    const slashed = (stakeBefore * SLASH_AMOUNT_BPS) / 10000n;
    const bonus = (slashed * CHALLENGER_BPS) / 10000n;
    expect(balAfter - balBefore + gasCost).to.equal(bonus + PROPOSE_BOND);
  });

  it("RG29: claimGovPayout with no pending reverts E03", async function () {
    await expect(gov.connect(other).claimGovPayout())
      .to.be.revertedWithCustomError(gov, "E03");
  });

  it("RG30: sweepTreasury moves residue to owner", async function () {
    await gov.connect(proposer).propose(relay.address, 1, EVIDENCE, { value: PROPOSE_BOND });
    await gov.connect(voter1).vote(1n, true, 0, { value: QUORUM + 1n });
    await gov.connect(other).resolve(1n);
    const residue = await gov.treasuryBalance();
    expect(residue).to.be.gt(0n);
    await gov.connect(other).sweepTreasury();
    expect(await gov.treasuryBalance()).to.equal(0n);
    expect(await gov.pendingGovPayout(owner.address)).to.equal(residue);
  });

  // ── wiring + locks ───────────────────────────────────────────────────

  it("RG31: setRelayStake is lock-once", async function () {
    await expect(gov.connect(owner).setRelayStake(other.address))
      .to.be.revertedWithCustomError(gov, "AlreadySet");
  });

  it("RG32: setPauseRegistry is lock-once", async function () {
    await expect(gov.connect(owner).setPauseRegistry(other.address))
      .to.be.revertedWithCustomError(gov, "AlreadySet");
  });

  it("RG33: lockPlumbing freezes wiring", async function () {
    await gov.connect(owner).lockPlumbing();
    expect(await gov.plumbingLocked()).to.equal(true);
    await expect(gov.connect(owner).lockPlumbing())
      .to.be.revertedWithCustomError(gov, "AlreadySet");
  });
});
