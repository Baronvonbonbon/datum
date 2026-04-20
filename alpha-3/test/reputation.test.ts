import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumPublisherReputation } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// DatumPublisherReputation tests (BM-8/BM-9/FP-16)
// REP1–REP3:  setSettlement access control
// REP4–REP7:  recordSettlement access control + counter accumulation
// REP8–REP10: getScore() bps calculation
// REP11–REP17: isAnomaly() logic (MIN_SAMPLE, ANOMALY_FACTOR, zero global rate)
// REP18–REP21: getPublisherStats / getCampaignStats views
// REP22–REP25: no-op, event emission, transferOwnership, multi-publisher isolation

describe("DatumPublisherReputation", function () {
  let reputation: DatumPublisherReputation;

  let owner: HardhatEthersSigner;
  let settlement: HardhatEthersSigner;
  let settlement2: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let publisher2: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  before(async function () {
    await fundSigners();
    [owner, settlement, settlement2, publisher, publisher2, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    reputation = await Factory.deploy();
    await reputation.setSettlement(settlement.address);
  });

  // ── setSettlement access control ─────────────────────────────────────────────

  // REP1: setSettlement works for owner
  it("REP1: setSettlement registers settlement address", async function () {
    expect(await reputation.settlement()).to.equal(settlement.address);
  });

  // REP2: setSettlement from non-owner reverts E18
  it("REP2: setSettlement from non-owner reverts E18", async function () {
    await expect(
      reputation.connect(other).setSettlement(settlement2.address)
    ).to.be.revertedWith("E18");
  });

  // REP3: setSettlement with zero address reverts E00
  it("REP3: setSettlement with zero address reverts E00", async function () {
    await expect(
      reputation.connect(owner).setSettlement(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");
  });

  // ── recordSettlement access control ──────────────────────────────────────────

  // REP4: recordSettlement from non-settlement reverts E18
  it("REP4: recordSettlement from non-settlement reverts E18", async function () {
    await expect(
      reputation.connect(other).recordSettlement(publisher.address, 1n, 100n, 0n)
    ).to.be.revertedWith("E18");
  });

  // REP5: recordSettlement with zero address publisher reverts E00
  it("REP5: recordSettlement with publisher=address(0) reverts E00", async function () {
    await expect(
      reputation.connect(settlement).recordSettlement(ethers.ZeroAddress, 1n, 100n, 0n)
    ).to.be.revertedWith("E00");
  });

  // REP6: recordSettlement accumulates global counters
  it("REP6: recordSettlement accumulates totalSettled and totalRejected", async function () {
    await reputation.connect(settlement).recordSettlement(publisher.address, 1n, 800n, 200n);
    expect(await reputation.totalSettled(publisher.address)).to.equal(800n);
    expect(await reputation.totalRejected(publisher.address)).to.equal(200n);

    // Second call accumulates
    await reputation.connect(settlement).recordSettlement(publisher.address, 2n, 100n, 50n);
    expect(await reputation.totalSettled(publisher.address)).to.equal(900n);
    expect(await reputation.totalRejected(publisher.address)).to.equal(250n);
  });

  // REP7: recordSettlement accumulates per-campaign counters independently
  it("REP7: recordSettlement accumulates per-campaign counters independently", async function () {
    const s1 = await reputation.campaignSettled(publisher.address, 1n);
    const r1 = await reputation.campaignRejected(publisher.address, 1n);
    expect(s1).to.equal(800n);
    expect(r1).to.equal(200n);

    const s2 = await reputation.campaignSettled(publisher.address, 2n);
    const r2 = await reputation.campaignRejected(publisher.address, 2n);
    expect(s2).to.equal(100n);
    expect(r2).to.equal(50n);
  });

  // ── getScore ─────────────────────────────────────────────────────────────────

  // REP8: getScore returns 10000 for publisher with no data
  it("REP8: getScore returns 10000 (perfect) when no data recorded", async function () {
    expect(await reputation.getScore(publisher2.address)).to.equal(10000);
  });

  // REP9: getScore returns correct bps
  it("REP9: getScore returns settled/(settled+rejected)*10000 bps", async function () {
    // publisher has 900 settled, 250 rejected (from REP6)
    // score = 900 / 1150 * 10000 = 7826 (integer division)
    const score = await reputation.getScore(publisher.address);
    const expected = (900n * 10000n) / (900n + 250n);
    expect(score).to.equal(expected);
  });

  // REP10: getScore reflects updated totals
  it("REP10: getScore updates correctly after additional recordSettlement calls", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep2 = await Factory.deploy();
    await rep2.setSettlement(settlement.address);

    await rep2.connect(settlement).recordSettlement(publisher2.address, 1n, 600n, 400n);
    const score = await rep2.getScore(publisher2.address);
    // 600 / 1000 * 10000 = 6000
    expect(score).to.equal(6000n);
  });

  // ── isAnomaly ─────────────────────────────────────────────────────────────────

  // REP11: isAnomaly returns false when campaign has fewer than MIN_SAMPLE total
  it("REP11: isAnomaly returns false when campaign total < MIN_SAMPLE (10)", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.setSettlement(settlement.address);

    // Record 9 total (5 settled, 4 rejected) — below MIN_SAMPLE
    await rep.connect(settlement).recordSettlement(publisher.address, 10n, 5n, 4n);
    expect(await rep.isAnomaly(publisher.address, 10n)).to.equal(false);
  });

  // REP12: isAnomaly returns false when campaign rate is within ANOMALY_FACTOR of global
  it("REP12: isAnomaly returns false when campaign rejection rate <= 2x global", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.setSettlement(settlement.address);

    // Global: 800 settled, 200 rejected → 20% rejection rate
    await rep.connect(settlement).recordSettlement(publisher.address, 1n, 800n, 200n);
    // Campaign 2: 8 settled, 2 rejected → 20% rejection rate (same as global — not anomalous)
    await rep.connect(settlement).recordSettlement(publisher.address, 2n, 8n, 2n);
    expect(await rep.isAnomaly(publisher.address, 2n)).to.equal(false);
  });

  // REP13: isAnomaly returns true when campaign rejection rate > 2x global
  it("REP13: isAnomaly returns true when campaign rejection rate > 2x global", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.setSettlement(settlement.address);

    // Global: 900 settled, 100 rejected → ~10% rejection rate
    await rep.connect(settlement).recordSettlement(publisher.address, 1n, 900n, 100n);
    // Campaign 2: 4 settled, 6 rejected → 60% rejection rate (> 2× 10%)
    await rep.connect(settlement).recordSettlement(publisher.address, 2n, 4n, 6n);
    expect(await rep.isAnomaly(publisher.address, 2n)).to.equal(true);
  });

  // REP14: isAnomaly returns true when global rejection rate is 0 but campaign has rejections
  it("REP14: isAnomaly returns true when global rejection=0 but campaign has rejections", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.setSettlement(settlement.address);

    // Global: 1000 settled, 0 rejected — perfect record
    await rep.connect(settlement).recordSettlement(publisher.address, 1n, 1000n, 0n);
    // Campaign 2: 8 settled, 2 rejected — any rejection is anomalous when global=0
    await rep.connect(settlement).recordSettlement(publisher.address, 2n, 8n, 2n);
    expect(await rep.isAnomaly(publisher.address, 2n)).to.equal(true);
  });

  // REP15: isAnomaly returns false when global rejection=0 and campaign also has 0 rejections
  it("REP15: isAnomaly returns false when global=0 rejections and campaign also 0 rejections", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.setSettlement(settlement.address);

    // Global + campaign: only settled, no rejections
    await rep.connect(settlement).recordSettlement(publisher.address, 1n, 1000n, 0n);
    await rep.connect(settlement).recordSettlement(publisher.address, 2n, 10n, 0n);
    expect(await rep.isAnomaly(publisher.address, 2n)).to.equal(false);
  });

  // REP16: isAnomaly returns false for publisher with no data at all
  it("REP16: isAnomaly returns false for publisher with no data (cTotal=0 < MIN_SAMPLE)", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    expect(await rep.isAnomaly(publisher.address, 1n)).to.equal(false);
  });

  // REP17: Boundary — exactly MIN_SAMPLE claims triggers anomaly check
  it("REP17: isAnomaly fires at exactly MIN_SAMPLE threshold", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.setSettlement(settlement.address);

    // Global: 900 settled, 100 rejected → 10% rejection rate
    await rep.connect(settlement).recordSettlement(publisher.address, 1n, 900n, 100n);
    // Campaign 2: exactly 10 total with 7 rejected (70% > 2×10%) — should trigger
    await rep.connect(settlement).recordSettlement(publisher.address, 2n, 3n, 7n);
    expect(await rep.isAnomaly(publisher.address, 2n)).to.equal(true);
  });

  // ── Stats views ───────────────────────────────────────────────────────────────

  // REP18: getPublisherStats returns correct triple
  it("REP18: getPublisherStats returns (settled, rejected, score)", async function () {
    // publisher has 900 settled, 250 rejected from REP6
    const [s, r, score] = await reputation.getPublisherStats(publisher.address);
    expect(s).to.equal(900n);
    expect(r).to.equal(250n);
    const expected = (900n * 10000n) / (900n + 250n);
    expect(score).to.equal(expected);
  });

  // REP19: getPublisherStats for unknown publisher returns (0, 0, 10000)
  it("REP19: getPublisherStats for unknown publisher returns (0, 0, 10000)", async function () {
    const [s, r, score] = await reputation.getPublisherStats(other.address);
    expect(s).to.equal(0n);
    expect(r).to.equal(0n);
    expect(score).to.equal(10000n);
  });

  // REP20: getCampaignStats returns correct per-campaign values
  it("REP20: getCampaignStats returns campaign-level settled and rejected", async function () {
    const [s, r] = await reputation.getCampaignStats(publisher.address, 1n);
    expect(s).to.equal(800n);
    expect(r).to.equal(200n);
  });

  // REP21: getCampaignStats for unknown campaign returns (0, 0)
  it("REP21: getCampaignStats for unknown campaign returns (0, 0)", async function () {
    const [s, r] = await reputation.getCampaignStats(publisher.address, 999n);
    expect(s).to.equal(0n);
    expect(r).to.equal(0n);
  });

  // ── Misc ──────────────────────────────────────────────────────────────────────

  // REP22: recordSettlement with settled=0 and rejected=0 is a no-op (no event)
  it("REP22: recordSettlement(0, 0) is a no-op and emits no event", async function () {
    const sBefore = await reputation.totalSettled(publisher.address);
    const rBefore = await reputation.totalRejected(publisher.address);

    const tx = await reputation.connect(settlement).recordSettlement(publisher.address, 5n, 0n, 0n);
    const receipt = await tx.wait();
    // No SettlementRecorded event should be emitted
    const events = receipt!.logs.filter(
      (log) => log.topics[0] === reputation.interface.getEvent("SettlementRecorded").topicHash
    );
    expect(events.length).to.equal(0);

    // Counters unchanged
    expect(await reputation.totalSettled(publisher.address)).to.equal(sBefore);
    expect(await reputation.totalRejected(publisher.address)).to.equal(rBefore);
  });

  // REP23: recordSettlement emits SettlementRecorded event
  it("REP23: recordSettlement emits SettlementRecorded with correct args", async function () {
    await expect(
      reputation.connect(settlement).recordSettlement(publisher2.address, 7n, 300n, 50n)
    )
      .to.emit(reputation, "SettlementRecorded")
      .withArgs(publisher2.address, 7n, 300n, 50n);
  });

  // REP24: transferOwnership works correctly (2-step)
  it("REP24: transferOwnership transfers owner and reverts on zero address", async function () {
    await expect(
      reputation.connect(owner).transferOwnership(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");

    await expect(
      reputation.connect(other).transferOwnership(other.address)
    ).to.be.revertedWith("E18");

    // Transfer to other (2-step), then restore
    await reputation.connect(owner).transferOwnership(other.address);
    expect(await reputation.pendingOwner()).to.equal(other.address);
    expect(await reputation.owner()).to.equal(owner.address); // not transferred yet
    await reputation.connect(other).acceptOwnership();
    expect(await reputation.owner()).to.equal(other.address);
    // Restore
    await reputation.connect(other).transferOwnership(owner.address);
    await reputation.connect(owner).acceptOwnership();
    expect(await reputation.owner()).to.equal(owner.address);
  });

  // REP25: multiple publishers tracked independently
  it("REP25: multiple publishers tracked independently", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.setSettlement(settlement.address);

    await rep.connect(settlement).recordSettlement(publisher.address, 1n, 500n, 100n);
    await rep.connect(settlement).recordSettlement(publisher2.address, 1n, 200n, 300n);

    expect(await rep.totalSettled(publisher.address)).to.equal(500n);
    expect(await rep.totalSettled(publisher2.address)).to.equal(200n);
    expect(await rep.getScore(publisher.address)).to.equal((500n * 10000n) / 600n);
    expect(await rep.getScore(publisher2.address)).to.equal((200n * 10000n) / 500n);
  });
});
