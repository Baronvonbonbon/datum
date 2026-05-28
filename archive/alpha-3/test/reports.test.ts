import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumReports } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// DatumReports — community reporting satellite (alpha-3)
// RP1–RP3:  reportPage basic path, counters, invalid reason
// RP4–RP6:  reportAd basic path, counters, invalid reason
// RP7–RP9:  non-existent campaign rejects, open campaigns, events
// RP10–RP11: multi-reporter accumulation, reason boundary

describe("DatumReports", function () {
  let reports: DatumReports;
  let mock: any;  // MockCampaigns used as campaign data source

  let owner: HardhatEthersSigner;
  let reporter1: HardhatEthersSigner;
  let reporter2: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;

  before(async function () {
    await fundSigners();
    [owner, reporter1, reporter2, advertiser, publisher] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    // Seed two campaigns in mock:
    // campaignId=1: fixed publisher
    await mock.setCampaign(1, advertiser.address, publisher.address, 100n, 5000, 1);
    // campaignId=2: open campaign (publisher=address(0))
    await mock.setCampaign(2, advertiser.address, ethers.ZeroAddress, 100n, 3000, 1);
    // campaignId=3-15: fresh campaigns for dedup-sensitive tests (AUDIT-023)
    for (let i = 3; i <= 15; i++) {
      await mock.setCampaign(i, advertiser.address, publisher.address, 100n, 5000, 1);
    }

    const ReportsFactory = await ethers.getContractFactory("DatumReports");
    reports = await ReportsFactory.deploy(await mock.getAddress());
  });

  // RP1: reportPage increments pageReports for campaign
  it("RP1: reportPage increments pageReports[campaignId]", async function () {
    await reports.connect(reporter1).reportPage(1, 1);
    expect(await reports.pageReports(1)).to.equal(1n);
  });

  // RP2: reportPage with fixed publisher increments publisherReports
  it("RP2: reportPage increments publisherReports for the campaign publisher", async function () {
    const before = await reports.publisherReports(publisher.address);
    await reports.connect(reporter2).reportPage(1, 2);
    expect(await reports.publisherReports(publisher.address)).to.equal(before + 1n);
  });

  // RP3: reportPage with invalid reason reverts E68
  it("RP3: reportPage with reason=0 reverts E68", async function () {
    await expect(reports.connect(reporter1).reportPage(1, 0)).to.be.revertedWith("E68");
  });

  it("RP3b: reportPage with reason=6 reverts E68", async function () {
    await expect(reports.connect(reporter1).reportPage(1, 6)).to.be.revertedWith("E68");
  });

  // RP4: reportAd increments adReports for campaign
  it("RP4: reportAd increments adReports[campaignId]", async function () {
    await reports.connect(reporter1).reportAd(1, 3);
    expect(await reports.adReports(1)).to.equal(1n);
  });

  // RP5: reportAd increments advertiserReports
  it("RP5: reportAd increments advertiserReports for the campaign advertiser", async function () {
    const before = await reports.advertiserReports(advertiser.address);
    await reports.connect(reporter2).reportAd(1, 4);
    expect(await reports.advertiserReports(advertiser.address)).to.equal(before + 1n);
  });

  // RP6: reportAd with invalid reason reverts E68
  it("RP6: reportAd with reason=6 reverts E68", async function () {
    await expect(reports.connect(reporter1).reportAd(1, 6)).to.be.revertedWith("E68");
  });

  it("RP6b: reportAd with reason=0 reverts E68", async function () {
    await expect(reports.connect(reporter1).reportAd(1, 0)).to.be.revertedWith("E68");
  });

  // RP7: non-existent campaign reverts E01
  it("RP7: reportPage on non-existent campaign reverts E01", async function () {
    await expect(reports.connect(reporter1).reportPage(999, 1)).to.be.revertedWith("E01");
  });

  it("RP7b: reportAd on non-existent campaign reverts E01", async function () {
    await expect(reports.connect(reporter1).reportAd(999, 1)).to.be.revertedWith("E01");
  });

  // RP8: open campaign (publisher=0) — reportPage does NOT increment publisherReports
  it("RP8: reportPage on open campaign does not increment publisherReports for zero address", async function () {
    const before = await reports.publisherReports(ethers.ZeroAddress);
    await reports.connect(reporter1).reportPage(2, 1);
    expect(await reports.publisherReports(ethers.ZeroAddress)).to.equal(before);
    // pageReports is still incremented
    expect(await reports.pageReports(2)).to.be.gt(0n);
  });

  // RP9: PageReported event emitted correctly
  // Uses campaign 3 — reporter1 is fresh on this campaignId (AUDIT-023 dedup)
  it("RP9: reportPage emits PageReported event", async function () {
    await expect(reports.connect(reporter1).reportPage(3, 5))
      .to.emit(reports, "PageReported")
      .withArgs(3n, publisher.address, reporter1.address, 5n);
  });

  it("RP9b: reportAd emits AdReported event", async function () {
    // Uses campaign 4 — reporter1 is fresh on this campaignId (AUDIT-023 dedup)
    await expect(reports.connect(reporter1).reportAd(4, 2))
      .to.emit(reports, "AdReported")
      .withArgs(4n, advertiser.address, reporter1.address, 2n);
  });

  // RP10: Multiple reporters accumulate independently
  // Uses campaign 5 — reporter1, reporter2, owner all fresh on this campaignId (AUDIT-023 dedup)
  it("RP10: multiple reporters accumulate pageReports correctly", async function () {
    const before = await reports.pageReports(5);
    await reports.connect(reporter1).reportPage(5, 1);
    await reports.connect(reporter2).reportPage(5, 2);
    await reports.connect(owner).reportPage(5, 3);
    expect(await reports.pageReports(5)).to.equal(before + 3n);
  });

  // RP11: All valid reason codes (1-5) are accepted
  // Uses campaigns 6-10 — one per reason code, reporter1 fresh on each (AUDIT-023 dedup)
  it("RP11: all valid reason codes 1-5 accepted for reportPage", async function () {
    for (let r = 1; r <= 5; r++) {
      await expect(reports.connect(reporter1).reportPage(5 + r, r)).not.to.be.reverted;
    }
  });

  // Uses campaigns 11-15 — one per reason code, reporter1 fresh on each (AUDIT-023 dedup)
  it("RP11b: all valid reason codes 1-5 accepted for reportAd", async function () {
    for (let r = 1; r <= 5; r++) {
      await expect(reports.connect(reporter1).reportAd(10 + r, r)).not.to.be.reverted;
    }
  });
});
