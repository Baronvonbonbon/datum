import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumCouncilBlocklistCurator } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// G-6 first close: bonded appeal mechanism on DatumCouncilBlocklistCurator.
//
// G6-1..3:  setAppealBond — owner-only, 0 disables, event
// G6-4..10: fileBlocklistAppeal — validation, bond, must-be-blocked
// G6-11..16: councilResolveAppeal — upheld unblocks + refunds, dismissed
//            forfeits to treasury
// G6-17..19: claim payout queue
// G6-20..21: treasury sweep

describe("DatumCouncilBlocklistCurator G-6 first close (bonded appeal)", function () {
  let curator: DatumCouncilBlocklistCurator;

  let owner: HardhatEthersSigner;
  let council: HardhatEthersSigner;
  let appellant: HardhatEthersSigner;
  let blockedAddr: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const APPEAL_BOND = 5_000_000_000n;  // 0.5 DOT
  const REASON      = ethers.keccak256(ethers.toUtf8Bytes("blocked_for_fraud"));
  const EVIDENCE    = ethers.keccak256(ethers.toUtf8Bytes("appeal_evidence_cid"));

  beforeEach(async function () {
    await fundSigners();
    [owner, council, appellant, blockedAddr, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DatumCouncilBlocklistCurator");
    curator = await Factory.deploy();

    await curator.connect(owner).setCouncil(council.address);

    // Block the address via Council
    await curator.connect(council).blockAddr(blockedAddr.address, REASON);
  });

  // ── setAppealBond ────────────────────────────────────────────────────

  it("G6-1: setAppealBond from non-owner reverts", async function () {
    await expect(curator.connect(other).setAppealBond(APPEAL_BOND))
      .to.be.revertedWith("E18");
  });

  it("G6-2: setAppealBond emits AppealBondSet", async function () {
    await expect(curator.connect(owner).setAppealBond(APPEAL_BOND))
      .to.emit(curator, "AppealBondSet")
      .withArgs(APPEAL_BOND);
    expect(await curator.appealBond()).to.equal(APPEAL_BOND);
  });

  it("G6-3: setAppealBond(0) disables the track", async function () {
    await curator.connect(owner).setAppealBond(0);
    await expect(curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: 0 }))
      .to.be.revertedWith("E01");
  });

  // ── fileBlocklistAppeal ──────────────────────────────────────────────

  it("G6-4: file with bond=0 (track disabled) reverts E01", async function () {
    await expect(curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: 0 }))
      .to.be.revertedWith("E01");
  });

  it("G6-5: file with zero blockedAddr reverts E00", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await expect(curator.connect(appellant).fileBlocklistAppeal(ethers.ZeroAddress, EVIDENCE, { value: APPEAL_BOND }))
      .to.be.revertedWith("E00");
  });

  it("G6-6: file with zero evidence reverts E00", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await expect(curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, ethers.ZeroHash, { value: APPEAL_BOND }))
      .to.be.revertedWith("E00");
  });

  it("G6-7: file with wrong bond reverts E11", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await expect(curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND - 1n }))
      .to.be.revertedWith("E11");
  });

  it("G6-8: file against not-blocked address reverts E22", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await expect(curator.connect(appellant).fileBlocklistAppeal(other.address, EVIDENCE, { value: APPEAL_BOND }))
      .to.be.revertedWith("E22");
  });

  it("G6-9: valid file creates appeal + emits event", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await expect(curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND }))
      .to.emit(curator, "BlocklistAppealFiled")
      .withArgs(1n, appellant.address, blockedAddr.address, EVIDENCE, APPEAL_BOND);
    const a = await curator.appeals(1n);
    expect(a.appellant).to.equal(appellant.address);
    expect(a.blockedAddr).to.equal(blockedAddr.address);
    expect(a.bond).to.equal(APPEAL_BOND);
    expect(a.resolved).to.equal(false);
  });

  it("G6-10: blocked address can self-appeal", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(blockedAddr).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND });
    const a = await curator.appeals(1n);
    expect(a.appellant).to.equal(blockedAddr.address);
  });

  // ── councilResolveAppeal ────────────────────────────────────────────

  it("G6-11: resolve from non-council reverts E18", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND });
    await expect(curator.connect(other).councilResolveAppeal(1n, true))
      .to.be.revertedWith("E18");
  });

  it("G6-12: resolve unknown appeal reverts E01", async function () {
    await expect(curator.connect(council).councilResolveAppeal(999n, true))
      .to.be.revertedWith("E01");
  });

  it("G6-13: upheld → unblock + refund queued", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND });

    await expect(curator.connect(council).councilResolveAppeal(1n, true))
      .to.emit(curator, "AddrUnblocked")
      .and.to.emit(curator, "BlocklistAppealResolved")
      .withArgs(1n, blockedAddr.address, true, APPEAL_BOND);

    expect(await curator.isBlocked(blockedAddr.address)).to.equal(false);
    expect(await curator.blockReason(blockedAddr.address)).to.equal(ethers.ZeroHash);
    expect(await curator.pendingPayout(appellant.address)).to.equal(APPEAL_BOND);
  });

  it("G6-14: dismissed → bond forfeit to treasury, address stays blocked", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND });

    await expect(curator.connect(council).councilResolveAppeal(1n, false))
      .to.emit(curator, "BlocklistAppealResolved")
      .withArgs(1n, blockedAddr.address, false, APPEAL_BOND);

    expect(await curator.isBlocked(blockedAddr.address)).to.equal(true);
    expect(await curator.treasuryBalance()).to.equal(APPEAL_BOND);
    expect(await curator.pendingPayout(appellant.address)).to.equal(0n);
  });

  it("G6-15: double resolve reverts E41", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND });
    await curator.connect(council).councilResolveAppeal(1n, true);
    await expect(curator.connect(council).councilResolveAppeal(1n, true))
      .to.be.revertedWith("E41");
  });

  it("G6-16: upheld on already-unblocked addr is graceful (no double event)", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND });
    // Council unblocks via direct path first
    await curator.connect(council).unblockAddr(blockedAddr.address);
    expect(await curator.isBlocked(blockedAddr.address)).to.equal(false);
    // Now resolve appeal as upheld — should not double-unblock or revert
    await curator.connect(council).councilResolveAppeal(1n, true);
    expect(await curator.isBlocked(blockedAddr.address)).to.equal(false);
    // Bond still refunded
    expect(await curator.pendingPayout(appellant.address)).to.equal(APPEAL_BOND);
  });

  // ── claim payout queue ──────────────────────────────────────────────

  it("G6-17: claimPayout pulls queued amount", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND });
    await curator.connect(council).councilResolveAppeal(1n, true);
    const balBefore = await ethers.provider.getBalance(appellant.address);
    const tx = await curator.connect(appellant).claimPayout();
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(appellant.address);
    expect(balAfter - balBefore + gasCost).to.equal(APPEAL_BOND);
  });

  it("G6-18: claimPayout with no pending reverts E03", async function () {
    await expect(curator.connect(other).claimPayout())
      .to.be.revertedWith("E03");
  });

  it("G6-19: claimPayoutTo routes to a different recipient", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND });
    await curator.connect(council).councilResolveAppeal(1n, true);
    const balBefore = await ethers.provider.getBalance(other.address);
    await curator.connect(appellant).claimPayoutTo(other.address);
    const balAfter = await ethers.provider.getBalance(other.address);
    expect(balAfter - balBefore).to.equal(APPEAL_BOND);
  });

  // ── treasury sweep ──────────────────────────────────────────────────

  it("G6-20: sweepTreasury moves forfeit residue to owner", async function () {
    await curator.connect(owner).setAppealBond(APPEAL_BOND);
    await curator.connect(appellant).fileBlocklistAppeal(blockedAddr.address, EVIDENCE, { value: APPEAL_BOND });
    await curator.connect(council).councilResolveAppeal(1n, false);

    expect(await curator.treasuryBalance()).to.equal(APPEAL_BOND);
    await expect(curator.connect(other).sweepTreasury())
      .to.emit(curator, "TreasurySwept");
    expect(await curator.treasuryBalance()).to.equal(0n);
    expect(await curator.pendingPayout(owner.address)).to.equal(APPEAL_BOND);
  });

  it("G6-21: sweepTreasury with no residue reverts E03", async function () {
    await expect(curator.connect(other).sweepTreasury())
      .to.be.revertedWith("E03");
  });
});
