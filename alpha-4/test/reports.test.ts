import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumCampaigns, DatumPublishers, DatumPauseRegistry, DatumBudgetLedger } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// Community reporting — merged into DatumCampaigns (alpha-4)
// RP1–RP3:  reportPage basic path, counters, invalid reason
// RP4–RP6:  reportAd basic path, counters, invalid reason
// RP7–RP9:  non-existent campaign rejects, open campaigns, events
// RP10–RP11: multi-reporter accumulation, reason boundary

describe("DatumCampaigns — Reports", function () {
  let campaigns: DatumCampaigns;
  let publishers: DatumPublishers;
  let pauseReg: DatumPauseRegistry;
  let ledger: DatumBudgetLedger;

  let owner: HardhatEthersSigner;
  let reporter1: HardhatEthersSigner;
  let reporter2: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let lifecycleMock: HardhatEthersSigner;

  const BUDGET = parseDOT("0.1");
  const DAILY_CAP = parseDOT("0.05");
  const BID_CPM = parseDOT("0.01");
  const TAKE_RATE_BPS = 5000;

  before(async function () {
    await fundSigners();
    [owner, reporter1, reporter2, advertiser, publisher, lifecycleMock] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, advertiser.address, publisher.address);

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n, await pauseReg.getAddress());

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(0n, 100n, await publishers.getAddress(), await pauseReg.getAddress());

    await ledger.setCampaigns(await campaigns.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());
    await campaigns.setLifecycleContract(lifecycleMock.address);

    // Register publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);

    // Create 15 campaigns for tests (IDs 1-15)
    for (let i = 0; i < 15; i++) {
      const pub = i === 1 ? ethers.ZeroAddress : publisher.address; // campaign 2 is open
      await campaigns.connect(advertiser).createCampaign(
        pub,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        [], false, ethers.ZeroAddress, 0n, 0n,
        { value: BUDGET }
      );
    }

    // Activate campaign 1 and 2 (reports require Active status)
    await campaigns.setGovernanceContract(owner.address);
    for (let i = 1; i <= 15; i++) {
      await campaigns.activateCampaign(i);
    }
  });

  // RP1: reportPage increments pageReports for campaign
  it("RP1: reportPage increments pageReports[campaignId]", async function () {
    await campaigns.connect(reporter1).reportPage(1, 1);
    expect(await campaigns.pageReports(1)).to.equal(1n);
  });

  // RP2: reportPage with fixed publisher increments publisherReports
  it("RP2: reportPage increments publisherReports for the campaign publisher", async function () {
    const before = await campaigns.publisherReports(publisher.address);
    await campaigns.connect(reporter2).reportPage(1, 2);
    expect(await campaigns.publisherReports(publisher.address)).to.equal(before + 1n);
  });

  // RP3: reportPage with invalid reason reverts E68
  it("RP3: reportPage with reason=0 reverts E68", async function () {
    await expect(campaigns.connect(reporter1).reportPage(1, 0)).to.be.revertedWith("E68");
  });

  it("RP3b: reportPage with reason=6 reverts E68", async function () {
    await expect(campaigns.connect(reporter1).reportPage(1, 6)).to.be.revertedWith("E68");
  });

  // RP4: reportAd increments adReports for campaign
  it("RP4: reportAd increments adReports[campaignId]", async function () {
    await campaigns.connect(reporter1).reportAd(1, 3);
    expect(await campaigns.adReports(1)).to.equal(1n);
  });

  // RP5: reportAd increments advertiserReports
  it("RP5: reportAd increments advertiserReports for the campaign advertiser", async function () {
    const before = await campaigns.advertiserReports(advertiser.address);
    await campaigns.connect(reporter2).reportAd(1, 4);
    expect(await campaigns.advertiserReports(advertiser.address)).to.equal(before + 1n);
  });

  // RP6: reportAd with invalid reason reverts E68
  it("RP6: reportAd with reason=6 reverts E68", async function () {
    await expect(campaigns.connect(reporter1).reportAd(1, 6)).to.be.revertedWith("E68");
  });

  it("RP6b: reportAd with reason=0 reverts E68", async function () {
    await expect(campaigns.connect(reporter1).reportAd(1, 0)).to.be.revertedWith("E68");
  });

  // RP7: non-existent campaign reverts E01
  it("RP7: reportPage on non-existent campaign reverts E01", async function () {
    await expect(campaigns.connect(reporter1).reportPage(999, 1)).to.be.revertedWith("E01");
  });

  it("RP7b: reportAd on non-existent campaign reverts E01", async function () {
    await expect(campaigns.connect(reporter1).reportAd(999, 1)).to.be.revertedWith("E01");
  });

  // RP8: open campaign (publisher=0) — reportPage does NOT increment publisherReports
  it("RP8: reportPage on open campaign does not increment publisherReports for zero address", async function () {
    const before = await campaigns.publisherReports(ethers.ZeroAddress);
    await campaigns.connect(reporter1).reportPage(2, 1);
    expect(await campaigns.publisherReports(ethers.ZeroAddress)).to.equal(before);
    // pageReports is still incremented
    expect(await campaigns.pageReports(2)).to.be.gt(0n);
  });

  // RP9: PageReported event emitted correctly
  it("RP9: reportPage emits PageReported event", async function () {
    await expect(campaigns.connect(reporter1).reportPage(3, 5))
      .to.emit(campaigns, "PageReported")
      .withArgs(3n, publisher.address, reporter1.address, 5n);
  });

  it("RP9b: reportAd emits AdReported event", async function () {
    await expect(campaigns.connect(reporter1).reportAd(4, 2))
      .to.emit(campaigns, "AdReported")
      .withArgs(4n, advertiser.address, reporter1.address, 2n);
  });

  // RP10: Multiple reporters accumulate independently
  it("RP10: multiple reporters accumulate pageReports correctly", async function () {
    const before = await campaigns.pageReports(5);
    await campaigns.connect(reporter1).reportPage(5, 1);
    await campaigns.connect(reporter2).reportPage(5, 2);
    await campaigns.connect(owner).reportPage(5, 3);
    expect(await campaigns.pageReports(5)).to.equal(before + 3n);
  });

  // RP11: All valid reason codes (1-5) are accepted
  it("RP11: all valid reason codes 1-5 accepted for reportPage", async function () {
    for (let r = 1; r <= 5; r++) {
      await expect(campaigns.connect(reporter1).reportPage(5 + r, r)).not.to.be.reverted;
    }
  });

  it("RP11b: all valid reason codes 1-5 accepted for reportAd", async function () {
    for (let r = 1; r <= 5; r++) {
      await expect(campaigns.connect(reporter1).reportAd(10 + r, r)).not.to.be.reverted;
    }
  });
});
