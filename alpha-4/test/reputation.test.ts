import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumSettlement, DatumPauseRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// Settlement inline reputation tests (BM-8/BM-9, alpha-4 consolidation)
// REP1–REP3:  setReporterAuthorized access control
// REP4–REP7:  recordSettlement access control + counter accumulation
// REP8–REP10: getReputationScore bps calculation
// REP11–REP17: isAnomaly logic (MIN_SAMPLE, ANOMALY_FACTOR, zero global rate)
// REP18–REP21: getPublisherStats / getCampaignRepStats views
// REP22–REP24: no-op, event emission, multi-publisher isolation

describe("Settlement Reputation (inline)", function () {
  let settlement: DatumSettlement;
  let pauseReg: DatumPauseRegistry;

  let owner: HardhatEthersSigner;
  let reporter: HardhatEthersSigner;
  let reporter2: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let publisher2: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  before(async function () {
    await fundSigners();
    [owner, reporter, reporter2, publisher, publisher2, other] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, reporter.address, publisher.address);

    const SettleFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettleFactory.deploy(await pauseReg.getAddress());

    // Authorize reporter
    await settlement.setReporterAuthorized(reporter.address, true);
  });

  // ── setReporterAuthorized access control ────────────────────────────────────

  it("REP1: setReporterAuthorized registers reporter", async function () {
    expect(await settlement.authorizedReporters(reporter.address)).to.equal(true);
  });

  it("REP2: setReporterAuthorized from non-owner reverts E18", async function () {
    await expect(
      settlement.connect(other).setReporterAuthorized(reporter2.address, true)
    ).to.be.revertedWith("E18");
  });

  it("REP3: setReporterAuthorized with zero address reverts E00", async function () {
    await expect(
      settlement.setReporterAuthorized(ethers.ZeroAddress, true)
    ).to.be.revertedWith("E00");
  });

  // ── recordSettlement access control ─────────────────────────────────────────

  it("REP4: recordSettlement from non-reporter reverts E18", async function () {
    await expect(
      settlement.connect(other).recordSettlement(publisher.address, 1n, 100n, 0n)
    ).to.be.revertedWith("E18");
  });

  it("REP5: recordSettlement with publisher=address(0) reverts E00", async function () {
    await expect(
      settlement.connect(reporter).recordSettlement(ethers.ZeroAddress, 1n, 100n, 0n)
    ).to.be.revertedWith("E00");
  });

  it("REP6: recordSettlement accumulates global counters", async function () {
    await settlement.connect(reporter).recordSettlement(publisher.address, 1n, 800n, 200n);
    expect(await settlement.repTotalSettled(publisher.address)).to.equal(800n);
    expect(await settlement.repTotalRejected(publisher.address)).to.equal(200n);

    // Second call accumulates
    await settlement.connect(reporter).recordSettlement(publisher.address, 2n, 100n, 50n);
    expect(await settlement.repTotalSettled(publisher.address)).to.equal(900n);
    expect(await settlement.repTotalRejected(publisher.address)).to.equal(250n);
  });

  it("REP7: recordSettlement accumulates per-campaign counters independently", async function () {
    expect(await settlement.repCampaignSettled(publisher.address, 1n)).to.equal(800n);
    expect(await settlement.repCampaignRejected(publisher.address, 1n)).to.equal(200n);
    expect(await settlement.repCampaignSettled(publisher.address, 2n)).to.equal(100n);
    expect(await settlement.repCampaignRejected(publisher.address, 2n)).to.equal(50n);
  });

  // ── getReputationScore ──────────────────────────────────────────────────────

  it("REP8: getReputationScore returns 10000 (perfect) when no data", async function () {
    expect(await settlement.getReputationScore(publisher2.address)).to.equal(10000);
  });

  it("REP9: getReputationScore returns settled/(settled+rejected)*10000 bps", async function () {
    // publisher has 900 settled, 250 rejected
    const score = await settlement.getReputationScore(publisher.address);
    const expected = (900n * 10000n) / (900n + 250n);
    expect(score).to.equal(expected);
  });

  it("REP10: getReputationScore updates after additional records", async function () {
    // Use a fresh Settlement for clean state
    const s2 = await (await ethers.getContractFactory("DatumSettlement")).deploy(
      await pauseReg.getAddress()
    ) as DatumSettlement;
    await s2.setReporterAuthorized(reporter.address, true);
    await s2.connect(reporter).recordSettlement(publisher2.address, 1n, 600n, 400n);
    expect(await s2.getReputationScore(publisher2.address)).to.equal(6000n);
  });

  // ── isAnomaly ───────────────────────────────────────────────────────────────

  it("REP11: isAnomaly returns false when campaign total < MIN_SAMPLE (10)", async function () {
    const s = await (await ethers.getContractFactory("DatumSettlement")).deploy(
      await pauseReg.getAddress()
    ) as DatumSettlement;
    await s.setReporterAuthorized(reporter.address, true);
    await s.connect(reporter).recordSettlement(publisher.address, 10n, 5n, 4n);
    expect(await s.isAnomaly(publisher.address, 10n)).to.equal(false);
  });

  it("REP12: isAnomaly returns false when campaign rejection rate <= 2x global", async function () {
    const s = await (await ethers.getContractFactory("DatumSettlement")).deploy(
      await pauseReg.getAddress()
    ) as DatumSettlement;
    await s.setReporterAuthorized(reporter.address, true);
    // Global: 800 settled, 200 rejected → 20% rejection rate
    await s.connect(reporter).recordSettlement(publisher.address, 1n, 800n, 200n);
    // Campaign 2: 8 settled, 2 rejected → 20% (same as global)
    await s.connect(reporter).recordSettlement(publisher.address, 2n, 8n, 2n);
    expect(await s.isAnomaly(publisher.address, 2n)).to.equal(false);
  });

  it("REP13: isAnomaly returns true when campaign rejection rate > 2x global", async function () {
    const s = await (await ethers.getContractFactory("DatumSettlement")).deploy(
      await pauseReg.getAddress()
    ) as DatumSettlement;
    await s.setReporterAuthorized(reporter.address, true);
    // Global: 900 settled, 100 rejected → ~10% rejection
    await s.connect(reporter).recordSettlement(publisher.address, 1n, 900n, 100n);
    // Campaign 2: 4 settled, 6 rejected → 60% (> 2×10%)
    await s.connect(reporter).recordSettlement(publisher.address, 2n, 4n, 6n);
    expect(await s.isAnomaly(publisher.address, 2n)).to.equal(true);
  });

  it("REP14: isAnomaly returns true when global rejection=0 but campaign has rejections", async function () {
    const s = await (await ethers.getContractFactory("DatumSettlement")).deploy(
      await pauseReg.getAddress()
    ) as DatumSettlement;
    await s.setReporterAuthorized(reporter.address, true);
    await s.connect(reporter).recordSettlement(publisher.address, 1n, 1000n, 0n);
    await s.connect(reporter).recordSettlement(publisher.address, 2n, 8n, 2n);
    expect(await s.isAnomaly(publisher.address, 2n)).to.equal(true);
  });

  it("REP15: isAnomaly returns false when global=0 and campaign also 0 rejections", async function () {
    const s = await (await ethers.getContractFactory("DatumSettlement")).deploy(
      await pauseReg.getAddress()
    ) as DatumSettlement;
    await s.setReporterAuthorized(reporter.address, true);
    await s.connect(reporter).recordSettlement(publisher.address, 1n, 1000n, 0n);
    await s.connect(reporter).recordSettlement(publisher.address, 2n, 10n, 0n);
    expect(await s.isAnomaly(publisher.address, 2n)).to.equal(false);
  });

  it("REP16: isAnomaly returns false for publisher with no data", async function () {
    expect(await settlement.isAnomaly(other.address, 1n)).to.equal(false);
  });

  it("REP17: isAnomaly fires at exactly MIN_SAMPLE threshold", async function () {
    const s = await (await ethers.getContractFactory("DatumSettlement")).deploy(
      await pauseReg.getAddress()
    ) as DatumSettlement;
    await s.setReporterAuthorized(reporter.address, true);
    // Global: 900 settled, 100 rejected → 10% rejection
    await s.connect(reporter).recordSettlement(publisher.address, 1n, 900n, 100n);
    // Campaign 2: exactly 10 total with 7 rejected (70% > 2×10%)
    await s.connect(reporter).recordSettlement(publisher.address, 2n, 3n, 7n);
    expect(await s.isAnomaly(publisher.address, 2n)).to.equal(true);
  });

  // ── Stats views ─────────────────────────────────────────────────────────────

  it("REP18: getPublisherStats returns (settled, rejected, score)", async function () {
    const [s, r, score] = await settlement.getPublisherStats(publisher.address);
    expect(s).to.equal(900n);
    expect(r).to.equal(250n);
    const expected = (900n * 10000n) / (900n + 250n);
    expect(score).to.equal(expected);
  });

  it("REP19: getPublisherStats for unknown publisher returns (0, 0, 10000)", async function () {
    const [s, r, score] = await settlement.getPublisherStats(other.address);
    expect(s).to.equal(0n);
    expect(r).to.equal(0n);
    expect(score).to.equal(10000n);
  });

  it("REP20: getCampaignRepStats returns campaign-level settled and rejected", async function () {
    const [s, r] = await settlement.getCampaignRepStats(publisher.address, 1n);
    expect(s).to.equal(800n);
    expect(r).to.equal(200n);
  });

  it("REP21: getCampaignRepStats for unknown campaign returns (0, 0)", async function () {
    const [s, r] = await settlement.getCampaignRepStats(publisher.address, 999n);
    expect(s).to.equal(0n);
    expect(r).to.equal(0n);
  });

  // ── Misc ────────────────────────────────────────────────────────────────────

  it("REP22: recordSettlement(0, 0) is a no-op and emits no event", async function () {
    const sBefore = await settlement.repTotalSettled(publisher.address);
    const rBefore = await settlement.repTotalRejected(publisher.address);

    const tx = await settlement.connect(reporter).recordSettlement(publisher.address, 5n, 0n, 0n);
    const receipt = await tx.wait();
    const events = receipt!.logs.filter(
      (log) => log.topics[0] === settlement.interface.getEvent("SettlementRecorded").topicHash
    );
    expect(events.length).to.equal(0);

    expect(await settlement.repTotalSettled(publisher.address)).to.equal(sBefore);
    expect(await settlement.repTotalRejected(publisher.address)).to.equal(rBefore);
  });

  it("REP23: recordSettlement emits SettlementRecorded with correct args", async function () {
    await expect(
      settlement.connect(reporter).recordSettlement(publisher2.address, 7n, 300n, 50n)
    )
      .to.emit(settlement, "SettlementRecorded")
      .withArgs(publisher2.address, 7n, 300n, 50n);
  });

  it("REP24: multiple publishers tracked independently", async function () {
    const s = await (await ethers.getContractFactory("DatumSettlement")).deploy(
      await pauseReg.getAddress()
    ) as DatumSettlement;
    await s.setReporterAuthorized(reporter.address, true);

    await s.connect(reporter).recordSettlement(publisher.address, 1n, 500n, 100n);
    await s.connect(reporter).recordSettlement(publisher2.address, 1n, 200n, 300n);

    expect(await s.repTotalSettled(publisher.address)).to.equal(500n);
    expect(await s.repTotalSettled(publisher2.address)).to.equal(200n);
    expect(await s.getReputationScore(publisher.address)).to.equal((500n * 10000n) / 600n);
    expect(await s.getReputationScore(publisher2.address)).to.equal((200n * 10000n) / 500n);
  });
});
