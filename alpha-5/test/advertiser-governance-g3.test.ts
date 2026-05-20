import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumAdvertiserGovernance,
  DatumAdvertiserStake,
  DatumPauseRegistry,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// G-3 first close: Council-arbitrated publisher → advertiser fraud claims.
// Mirror of DatumPublisherGovernance.fileAdvertiserFraudClaim.
//
// PG3-1..5:   setCouncilArbiter — lock-once, address(0) rejection, owner-only
// PG3-6..7:   setPublisherClaimBond — open setter, 0 disables track
// PG3-8..14:  filePublisherFraudClaim — validation, bond, anti-self, disabled track
// PG3-15..20: councilResolvePublisherClaim — upheld slash + bond refund,
//                                            dismissed bond → advertiser
// PG3-21..23: claim payout queue + treasury

describe("DatumAdvertiserGovernance G-3 first close", function () {
  let gov: DatumAdvertiserGovernance;
  let stake: DatumAdvertiserStake;
  let pauseReg: DatumPauseRegistry;

  let owner: HardhatEthersSigner;
  let council: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let g1: HardhatEthersSigner;
  let g2: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const SLASH_BPS  = 5000n;            // 50%
  const QUORUM     = 10_000_000_000n;  // 1 DOT (irrelevant for G-3 track)
  const PROPOSE_BOND = 2_000_000_000n;
  const CLAIM_BOND = 5_000_000_000n;   // 0.5 DOT to file
  const ADV_STAKE  = 100_000_000_000n; // 10 DOT
  const EVIDENCE   = ethers.keccak256(ethers.toUtf8Bytes("advertiser_fraud_evidence"));

  beforeEach(async function () {
    await fundSigners();
    [owner, council, publisher, advertiser, g1, g2, other] = await ethers.getSigners();

    // Pause registry: owner + 2 guardians
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, g1.address, g2.address);

    // AdvertiserStake (base, perDOTSpent, unstakeDelayBlocks)
    const StakeFactory = await ethers.getContractFactory("DatumAdvertiserStake");
    stake = await StakeFactory.deploy(0, 0, 10n);

    // AdvertiserGovernance
    const GovFactory = await ethers.getContractFactory("DatumAdvertiserGovernance");
    gov = await GovFactory.deploy(QUORUM, SLASH_BPS, 5n, PROPOSE_BOND, await pauseReg.getAddress());

    await gov.connect(owner).setAdvertiserStake(stake.target);
    await stake.connect(owner).setSlashContract(gov.target);

    // Advertiser stakes
    await stake.connect(advertiser).stake({ value: ADV_STAKE });
  });

  // ── setCouncilArbiter ────────────────────────────────────────────────

  it("PG3-1: setCouncilArbiter from non-owner reverts", async function () {
    await expect(gov.connect(other).setCouncilArbiter(council.address))
      .to.be.revertedWith("E18");
  });

  it("PG3-2: setCouncilArbiter rejects address(0)", async function () {
    await expect(gov.connect(owner).setCouncilArbiter(ethers.ZeroAddress))
      .to.be.revertedWith("E00");
  });

  it("PG3-3: setCouncilArbiter emits CouncilArbiterSet", async function () {
    await expect(gov.connect(owner).setCouncilArbiter(council.address))
      .to.emit(gov, "CouncilArbiterSet")
      .withArgs(council.address);
    expect(await gov.councilArbiter()).to.equal(council.address);
  });

  it("PG3-4: setCouncilArbiter is lock-once", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await expect(gov.connect(owner).setCouncilArbiter(other.address))
      .to.be.revertedWith("already set");
  });

  // ── setPublisherClaimBond ────────────────────────────────────────────

  it("PG3-5: setPublisherClaimBond from non-owner reverts", async function () {
    await expect(gov.connect(other).setPublisherClaimBond(CLAIM_BOND))
      .to.be.revertedWith("E18");
  });

  it("PG3-6: setPublisherClaimBond emits PublisherClaimBondSet", async function () {
    await expect(gov.connect(owner).setPublisherClaimBond(CLAIM_BOND))
      .to.emit(gov, "PublisherClaimBondSet")
      .withArgs(CLAIM_BOND);
    expect(await gov.publisherClaimBond()).to.equal(CLAIM_BOND);
  });

  it("PG3-7: setPublisherClaimBond(0) disables the track", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(0);
    await expect(gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: 0 }))
      .to.be.revertedWith("E01");
  });

  // ── filePublisherFraudClaim ──────────────────────────────────────────

  it("PG3-8: file with council unwired reverts E01", async function () {
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await expect(gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND }))
      .to.be.revertedWith("E01");
  });

  it("PG3-9: file with zero advertiser reverts E00", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await expect(gov.connect(publisher).filePublisherFraudClaim(ethers.ZeroAddress, 0, EVIDENCE, { value: CLAIM_BOND }))
      .to.be.revertedWith("E00");
  });

  it("PG3-10: file with zero evidence reverts E00", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await expect(gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, ethers.ZeroHash, { value: CLAIM_BOND }))
      .to.be.revertedWith("E00");
  });

  it("PG3-11: file with wrong bond reverts E11", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await expect(gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND - 1n }))
      .to.be.revertedWith("E11");
  });

  it("PG3-12: advertiser cannot file against self (anti-laundering)", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await expect(gov.connect(advertiser).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND }))
      .to.be.revertedWith("E18");
  });

  it("PG3-13: valid file creates claim + emits event", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await expect(gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 42, EVIDENCE, { value: CLAIM_BOND }))
      .to.emit(gov, "PublisherFraudClaimFiled")
      .withArgs(1n, publisher.address, advertiser.address, 42n, EVIDENCE, CLAIM_BOND);
    const c = await gov.publisherClaims(1n);
    expect(c.publisher).to.equal(publisher.address);
    expect(c.advertiser).to.equal(advertiser.address);
    expect(c.campaignId).to.equal(42n);
    expect(c.bond).to.equal(CLAIM_BOND);
    expect(c.resolved).to.equal(false);
  });

  it("PG3-14: nextPublisherClaimId increments", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND });
    await gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 1, EVIDENCE, { value: CLAIM_BOND });
    expect(await gov.nextPublisherClaimId()).to.equal(3n);
  });

  // ── councilResolvePublisherClaim ────────────────────────────────────

  it("PG3-15: resolve from non-arbiter reverts E18", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND });
    await expect(gov.connect(other).councilResolvePublisherClaim(1n, true))
      .to.be.revertedWith("E18");
  });

  it("PG3-16: resolve unknown claim reverts E01", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await expect(gov.connect(council).councilResolvePublisherClaim(999n, true))
      .to.be.revertedWith("E01");
  });

  it("PG3-17: upheld → advertiser slashed + bond queued to publisher", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND });

    const stakeBefore = await stake.staked(advertiser.address);
    const expectedSlash = (stakeBefore * SLASH_BPS) / 10000n;
    await expect(gov.connect(council).councilResolvePublisherClaim(1n, true))
      .to.emit(gov, "PublisherFraudClaimResolved")
      .withArgs(1n, advertiser.address, true, expectedSlash, CLAIM_BOND);

    const stakeAfter = await stake.staked(advertiser.address);
    expect(stakeAfter).to.equal(stakeBefore - expectedSlash);
    expect(await gov.pendingGovPayout(publisher.address)).to.equal(CLAIM_BOND);
    expect(await gov.treasuryBalance()).to.equal(expectedSlash);
  });

  it("PG3-18: dismissed → bond queued to advertiser", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND });

    const stakeBefore = await stake.staked(advertiser.address);
    await expect(gov.connect(council).councilResolvePublisherClaim(1n, false))
      .to.emit(gov, "PublisherFraudClaimResolved")
      .withArgs(1n, advertiser.address, false, 0n, CLAIM_BOND);

    const stakeAfter = await stake.staked(advertiser.address);
    expect(stakeAfter).to.equal(stakeBefore);
    expect(await gov.pendingGovPayout(advertiser.address)).to.equal(CLAIM_BOND);
    expect(await gov.pendingGovPayout(publisher.address)).to.equal(0n);
  });

  it("PG3-19: double resolve reverts E41", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND });
    await gov.connect(council).councilResolvePublisherClaim(1n, true);
    await expect(gov.connect(council).councilResolvePublisherClaim(1n, true))
      .to.be.revertedWith("E41");
  });

  it("PG3-20: claim marked resolved + upheld after upheld resolution", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND });
    await gov.connect(council).councilResolvePublisherClaim(1n, true);
    const c = await gov.publisherClaims(1n);
    expect(c.resolved).to.equal(true);
    expect(c.upheld).to.equal(true);
    expect(c.bond).to.equal(0n);
  });

  // ── claim payout queue ───────────────────────────────────────────────

  it("PG3-21: filer can claim bond refund post-upheld", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND });
    await gov.connect(council).councilResolvePublisherClaim(1n, true);

    const balBefore = await ethers.provider.getBalance(publisher.address);
    const tx = await gov.connect(publisher).claimGovPayout();
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(publisher.address);
    expect(balAfter - balBefore + gasCost).to.equal(CLAIM_BOND);
  });

  it("PG3-22: advertiser can claim bond compensation post-dismissed", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND });
    await gov.connect(council).councilResolvePublisherClaim(1n, false);

    const balBefore = await ethers.provider.getBalance(advertiser.address);
    const tx = await gov.connect(advertiser).claimGovPayout();
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(advertiser.address);
    expect(balAfter - balBefore + gasCost).to.equal(CLAIM_BOND);
  });

  it("PG3-23: owner can sweep slashed treasury post-upheld", async function () {
    await gov.connect(owner).setCouncilArbiter(council.address);
    await gov.connect(owner).setPublisherClaimBond(CLAIM_BOND);
    await gov.connect(publisher).filePublisherFraudClaim(advertiser.address, 0, EVIDENCE, { value: CLAIM_BOND });
    await gov.connect(council).councilResolvePublisherClaim(1n, true);

    const treasuryBefore = await gov.treasuryBalance();
    expect(treasuryBefore).to.be.gt(0n);
    await gov.connect(owner).sweepTreasury();
    expect(await gov.treasuryBalance()).to.equal(0n);
    expect(await gov.pendingGovPayout(owner.address)).to.equal(treasuryBefore);
  });
});
