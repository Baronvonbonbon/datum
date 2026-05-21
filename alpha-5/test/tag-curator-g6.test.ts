import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumTagCurator } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// G-6 mirror: bonded appeal mechanism on DatumTagCurator.
//
// Structural mirror of blocklist-curator-g6.test.ts. Asymmetry vs blocklist:
// fileTagAppeal requires the tag is NOT currently approved (E22 if it
// already is — no appeal needed).

describe("DatumTagCurator G-6 mirror (bonded appeal)", function () {
  let curator: DatumTagCurator;

  let owner: HardhatEthersSigner;
  let council: HardhatEthersSigner;
  let appellant: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const APPEAL_BOND = 5_000_000_000n;  // 0.5 DOT
  const TAG         = ethers.keccak256(ethers.toUtf8Bytes("sports.basketball"));
  const EVIDENCE    = ethers.keccak256(ethers.toUtf8Bytes("appeal_evidence_cid"));

  beforeEach(async function () {
    await fundSigners();
    [owner, council, appellant, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DatumTagCurator");
    curator = await Factory.deploy();

    await curator.connect(owner).setCouncil(council.address);
  });

  // ── setAppealBond ────────────────────────────────────────────────────

  it("TG6-1: setAppealBond from non-owner reverts", async function () {
    await expect(curator.connect(other).setAppealBond(APPEAL_BOND))
      .to.be.revertedWith("E18");
  });

  it("TG6-2: setAppealBond emits AppealBondSet", async function () {
    await expect(curator.connect(owner).setAppealBond(APPEAL_BOND))
      .to.emit(curator, "AppealBondSet")
      .withArgs(APPEAL_BOND);
    expect(await curator.appealBond()).to.equal(APPEAL_BOND);
  });

  it("TG6-3: setAppealBond(0) disables the track", async function () {
    await curator.connect(owner).setAppealBond(0);
    await expect(curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: 0 }))
      .to.be.revertedWith("E01");
  });

  // ── fileTagAppeal ────────────────────────────────────────────────────

  it("TG6-4: file with bond=0 (track disabled) reverts E01", async function () {
    await expect(curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: 0 }))
      .to.be.revertedWith("E01");
  });

  it("TG6-5: file with zero tag reverts E00", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await expect(curator.connect(appellant).fileTagAppeal(ethers.ZeroHash, EVIDENCE, { value: APPEAL_BOND }))
      .to.be.revertedWith("E00");
  });

  it("TG6-6: file with zero evidence reverts E00", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await expect(curator.connect(appellant).fileTagAppeal(TAG, ethers.ZeroHash, { value: APPEAL_BOND }))
      .to.be.revertedWith("E00");
  });

  it("TG6-7: file with wrong bond reverts E11", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await expect(curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND - 1n }))
      .to.be.revertedWith("E11");
  });

  it("TG6-8: file against already-approved tag reverts E22", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(council).approveTag(TAG);
    await expect(curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND }))
      .to.be.revertedWith("E22");
  });

  it("TG6-9: valid file creates appeal + emits event", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await expect(curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND }))
      .to.emit(curator, "TagAppealFiled")
      .withArgs(1n, appellant.address, TAG, EVIDENCE, APPEAL_BOND);
    const a = await curator.appeals(1n);
    expect(a.appellant).to.equal(appellant.address);
    expect(a.tag).to.equal(TAG);
    expect(a.bond).to.equal(APPEAL_BOND);
    expect(a.resolved).to.equal(false);
  });

  // ── councilResolveAppeal ────────────────────────────────────────────

  it("TG6-10: resolve from non-council reverts E18", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND });
    await expect(curator.connect(other).councilResolveAppeal(1n, true))
      .to.be.revertedWith("E18");
  });

  it("TG6-11: resolve unknown appeal reverts E01", async function () {
    await expect(curator.connect(council).councilResolveAppeal(999n, true))
      .to.be.revertedWith("E01");
  });

  it("TG6-12: upheld → tag approved + refund queued", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND });

    await expect(curator.connect(council).councilResolveAppeal(1n, true))
      .to.emit(curator, "TagApproved")
      .and.to.emit(curator, "TagAppealResolved")
      .withArgs(1n, TAG, true, APPEAL_BOND);

    expect(await curator.isTagApproved(TAG)).to.equal(true);
    expect(await curator.pendingPayout(appellant.address)).to.equal(APPEAL_BOND);
  });

  it("TG6-13: dismissed → bond forfeit to treasury, tag stays unapproved", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND });

    await expect(curator.connect(council).councilResolveAppeal(1n, false))
      .to.emit(curator, "TagAppealResolved")
      .withArgs(1n, TAG, false, APPEAL_BOND);

    expect(await curator.isTagApproved(TAG)).to.equal(false);
    expect(await curator.treasuryBalance()).to.equal(APPEAL_BOND);
    expect(await curator.pendingPayout(appellant.address)).to.equal(0n);
  });

  it("TG6-14: double resolve reverts E41", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND });
    await curator.connect(council).councilResolveAppeal(1n, true);
    await expect(curator.connect(council).councilResolveAppeal(1n, true))
      .to.be.revertedWith("E41");
  });

  it("TG6-15: upheld on already-approved tag is graceful (no double event)", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND });
    // Council approves via direct path first
    await curator.connect(council).approveTag(TAG);
    expect(await curator.isTagApproved(TAG)).to.equal(true);
    // Now resolve appeal as upheld — should not double-approve or revert
    await curator.connect(council).councilResolveAppeal(1n, true);
    expect(await curator.isTagApproved(TAG)).to.equal(true);
    // Bond still refunded
    expect(await curator.pendingPayout(appellant.address)).to.equal(APPEAL_BOND);
  });

  // ── claim payout queue ──────────────────────────────────────────────

  it("TG6-16: claimPayout pulls queued amount", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND });
    await curator.connect(council).councilResolveAppeal(1n, true);
    const balBefore = await ethers.provider.getBalance(appellant.address);
    const tx = await curator.connect(appellant).claimPayout();
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(appellant.address);
    expect(balAfter - balBefore + gasCost).to.equal(APPEAL_BOND);
  });

  it("TG6-17: claimPayout with no pending reverts E03", async function () {
    await expect(curator.connect(other).claimPayout())
      .to.be.revertedWith("E03");
  });

  it("TG6-18: claimPayoutTo routes to a different recipient", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND });
    await curator.connect(council).councilResolveAppeal(1n, true);
    const balBefore = await ethers.provider.getBalance(other.address);
    await curator.connect(appellant).claimPayoutTo(other.address);
    const balAfter = await ethers.provider.getBalance(other.address);
    expect(balAfter - balBefore).to.equal(APPEAL_BOND);
  });

  // ── treasury sweep ──────────────────────────────────────────────────

  it("TG6-19: sweepTreasury moves forfeit residue to owner", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileTagAppeal(TAG, EVIDENCE, { value: APPEAL_BOND });
    await curator.connect(council).councilResolveAppeal(1n, false);

    expect(await curator.treasuryBalance()).to.equal(APPEAL_BOND);
    await expect(curator.connect(other).sweepTreasury())
      .to.emit(curator, "TreasurySwept");
    expect(await curator.treasuryBalance()).to.equal(0n);
    expect(await curator.pendingPayout(owner.address)).to.equal(APPEAL_BOND);
  });

  it("TG6-20: sweepTreasury with no residue reverts E03", async function () {
    await expect(curator.connect(other).sweepTreasury())
      .to.be.revertedWith("E03");
  });
});
