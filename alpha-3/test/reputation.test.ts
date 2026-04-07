import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumPublisherReputation } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// DatumPublisherReputation tests (BM-8/BM-9)
// REP1–REP4:  addReporter/removeReporter access control
// REP5–REP8:  recordSettlement counter accumulation
// REP9–REP11: getScore() bps calculation
// REP12–REP17: isAnomaly() logic (MIN_SAMPLE, ANOMALY_FACTOR, zero global rate)
// REP18–REP21: getPublisherStats / getCampaignStats views
// REP22–REP24: no-op on zero input, transferOwnership, event emission

describe("DatumPublisherReputation", function () {
  let reputation: DatumPublisherReputation;

  let owner: HardhatEthersSigner;
  let reporter: HardhatEthersSigner;
  let reporter2: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let publisher2: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  before(async function () {
    await fundSigners();
    [owner, reporter, reporter2, publisher, publisher2, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    reputation = await Factory.deploy();
  });

  // REP1: addReporter works for owner
  it("REP1: addReporter registers reporter and emits ReporterAdded", async function () {
    await expect(reputation.connect(owner).addReporter(reporter.address))
      .to.emit(reputation, "ReporterAdded")
      .withArgs(reporter.address);
    expect(await reputation.reporters(reporter.address)).to.equal(true);
  });

  // REP2: addReporter from non-owner reverts E18
  it("REP2: addReporter from non-owner reverts E18", async function () {
    await expect(
      reputation.connect(other).addReporter(reporter2.address)
    ).to.be.revertedWith("E18");
  });

  // REP3: addReporter with zero address reverts E00
  it("REP3: addReporter with zero address reverts E00", async function () {
    await expect(
      reputation.connect(owner).addReporter(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");
  });

  // REP4: removeReporter works for owner, emits ReporterRemoved
  it("REP4: removeReporter deregisters reporter and emits ReporterRemoved", async function () {
    await reputation.connect(owner).addReporter(reporter2.address);
    await expect(reputation.connect(owner).removeReporter(reporter2.address))
      .to.emit(reputation, "ReporterRemoved")
      .withArgs(reporter2.address);
    expect(await reputation.reporters(reporter2.address)).to.equal(false);

    // removeReporter from non-owner reverts E18
    await expect(
      reputation.connect(other).removeReporter(reporter.address)
    ).to.be.revertedWith("E18");
  });

  // REP5: recordSettlement from non-reporter reverts E25
  it("REP5: recordSettlement from non-reporter reverts E25", async function () {
    await expect(
      reputation.connect(other).recordSettlement(publisher.address, 1n, 100n, 0n)
    ).to.be.revertedWith("E25");
  });

  // REP6: recordSettlement with zero address publisher reverts E00
  it("REP6: recordSettlement with publisher=address(0) reverts E00", async function () {
    await expect(
      reputation.connect(reporter).recordSettlement(ethers.ZeroAddress, 1n, 100n, 0n)
    ).to.be.revertedWith("E00");
  });

  // REP7: recordSettlement accumulates global counters
  it("REP7: recordSettlement accumulates totalSettled and totalRejected", async function () {
    await reputation.connect(reporter).recordSettlement(publisher.address, 1n, 800n, 200n);
    expect(await reputation.totalSettled(publisher.address)).to.equal(800n);
    expect(await reputation.totalRejected(publisher.address)).to.equal(200n);

    // Second call accumulates
    await reputation.connect(reporter).recordSettlement(publisher.address, 2n, 100n, 50n);
    expect(await reputation.totalSettled(publisher.address)).to.equal(900n);
    expect(await reputation.totalRejected(publisher.address)).to.equal(250n);
  });

  // REP8: recordSettlement accumulates per-campaign counters
  it("REP8: recordSettlement accumulates per-campaign counters independently", async function () {
    const s1 = await reputation.campaignSettled(publisher.address, 1n);
    const r1 = await reputation.campaignRejected(publisher.address, 1n);
    expect(s1).to.equal(800n);
    expect(r1).to.equal(200n);

    const s2 = await reputation.campaignSettled(publisher.address, 2n);
    const r2 = await reputation.campaignRejected(publisher.address, 2n);
    expect(s2).to.equal(100n);
    expect(r2).to.equal(50n);
  });

  // REP9: getScore returns 10000 for publisher with no data
  it("REP9: getScore returns 10000 (perfect) when no data recorded", async function () {
    expect(await reputation.getScore(publisher2.address)).to.equal(10000);
  });

  // REP10: getScore returns correct bps
  it("REP10: getScore returns settled/(settled+rejected)*10000 bps", async function () {
    // publisher has 900 settled, 250 rejected (from REP7)
    // score = 900 / 1150 * 10000 = 7826 (integer division)
    const score = await reputation.getScore(publisher.address);
    const expected = (900n * 10000n) / (900n + 250n);
    expect(score).to.equal(expected);
  });

  // REP11: getScore reflects updated totals
  it("REP11: getScore updates correctly after additional recordSettlement calls", async function () {
    // Add a fresh publisher with known values for clean test
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep2 = await Factory.deploy();
    await rep2.addReporter(reporter.address);

    await rep2.connect(reporter).recordSettlement(publisher2.address, 1n, 600n, 400n);
    const score = await rep2.getScore(publisher2.address);
    // 600 / 1000 * 10000 = 6000
    expect(score).to.equal(6000n);
  });

  // REP12: isAnomaly returns false when campaign has fewer than MIN_SAMPLE total
  it("REP12: isAnomaly returns false when campaign total < MIN_SAMPLE (10)", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.addReporter(reporter.address);

    // Record 9 total (5 settled, 4 rejected) — below MIN_SAMPLE
    await rep.connect(reporter).recordSettlement(publisher.address, 10n, 5n, 4n);
    expect(await rep.isAnomaly(publisher.address, 10n)).to.equal(false);
  });

  // REP13: isAnomaly returns false when campaign rate is within ANOMALY_FACTOR of global
  it("REP13: isAnomaly returns false when campaign rejection rate <= 2x global", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.addReporter(reporter.address);

    // Global: 800 settled, 200 rejected → 20% rejection rate
    await rep.connect(reporter).recordSettlement(publisher.address, 1n, 800n, 200n);
    // Campaign 2: 8 settled, 2 rejected → 20% rejection rate (same as global — not anomalous)
    await rep.connect(reporter).recordSettlement(publisher.address, 2n, 8n, 2n);
    expect(await rep.isAnomaly(publisher.address, 2n)).to.equal(false);
  });

  // REP14: isAnomaly returns true when campaign rejection rate > 2x global
  it("REP14: isAnomaly returns true when campaign rejection rate > 2x global", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.addReporter(reporter.address);

    // Global: 900 settled, 100 rejected → ~10% rejection rate
    await rep.connect(reporter).recordSettlement(publisher.address, 1n, 900n, 100n);
    // Campaign 2: 4 settled, 6 rejected → 60% rejection rate (> 2× 10%)
    await rep.connect(reporter).recordSettlement(publisher.address, 2n, 4n, 6n);
    expect(await rep.isAnomaly(publisher.address, 2n)).to.equal(true);
  });

  // REP15: isAnomaly returns true when global rejection rate is 0 but campaign has rejections
  it("REP15: isAnomaly returns true when global rejection=0 but campaign has rejections", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.addReporter(reporter.address);

    // Global: 1000 settled, 0 rejected — perfect record
    await rep.connect(reporter).recordSettlement(publisher.address, 1n, 1000n, 0n);
    // Campaign 2: 8 settled, 2 rejected — any rejection is anomalous when global=0
    await rep.connect(reporter).recordSettlement(publisher.address, 2n, 8n, 2n);
    expect(await rep.isAnomaly(publisher.address, 2n)).to.equal(true);
  });

  // REP16: isAnomaly returns false when global rejection=0 and campaign also has 0 rejections
  it("REP16: isAnomaly returns false when global=0 rejections and campaign also 0 rejections", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    await rep.addReporter(reporter.address);

    // Global + campaign: only settled, no rejections
    await rep.connect(reporter).recordSettlement(publisher.address, 1n, 1000n, 0n);
    await rep.connect(reporter).recordSettlement(publisher.address, 2n, 10n, 0n);
    expect(await rep.isAnomaly(publisher.address, 2n)).to.equal(false);
  });

  // REP17: isAnomaly returns false for publisher with no data at all
  it("REP17: isAnomaly returns false for publisher with no data (cTotal=0 < MIN_SAMPLE)", async function () {
    const Factory = await ethers.getContractFactory("DatumPublisherReputation");
    const rep = await Factory.deploy();
    expect(await rep.isAnomaly(publisher.address, 1n)).to.equal(false);
  });

  // REP18: getPublisherStats returns correct triple
  it("REP18: getPublisherStats returns (settled, rejected, score)", async function () {
    // publisher has 900 settled, 250 rejected from REP7
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

  // REP22: recordSettlement with settled=0 and rejected=0 is a no-op (no event)
  it("REP22: recordSettlement(0, 0) is a no-op and emits no event", async function () {
    const sBefore = await reputation.totalSettled(publisher.address);
    const rBefore = await reputation.totalRejected(publisher.address);

    const tx = await reputation.connect(reporter).recordSettlement(publisher.address, 5n, 0n, 0n);
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
      reputation.connect(reporter).recordSettlement(publisher2.address, 7n, 300n, 50n)
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
    await rep.addReporter(reporter.address);

    await rep.connect(reporter).recordSettlement(publisher.address, 1n, 500n, 100n);
    await rep.connect(reporter).recordSettlement(publisher2.address, 1n, 200n, 300n);

    expect(await rep.totalSettled(publisher.address)).to.equal(500n);
    expect(await rep.totalSettled(publisher2.address)).to.equal(200n);
    expect(await rep.getScore(publisher.address)).to.equal((500n * 10000n) / 600n);
    expect(await rep.getScore(publisher2.address)).to.equal((200n * 10000n) / 500n);
  });
});
