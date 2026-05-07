import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumCampaigns,
  DatumPublishers,
  DatumPauseRegistry,
  DatumBudgetLedger,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// TX-1/TX-2: Tag-based targeting tests
// TG1-TG6: Targeting (setPublisherTags, getPublisherTags2, hasAllTags) — merged into Campaigns
// TG7-TG11: Campaign creation with requiredTags

describe("Tag-Based Targeting (TX-1/TX-2)", function () {
  let campaigns: DatumCampaigns;
  let publishers: DatumPublishers;
  let pauseReg: DatumPauseRegistry;
  let ledger: DatumBudgetLedger;

  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let publisher2: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let lifecycleMock: HardhatEthersSigner;

  const BUDGET = parseDOT("2");
  const DAILY_CAP = parseDOT("1");
  const BID_CPM = parseDOT("0.01");
  const TAKE_RATE_BPS = 5000;

  // Standard tag hashes
  const TAG_DEFI = ethers.keccak256(ethers.toUtf8Bytes("topic:defi"));
  const TAG_GAMING = ethers.keccak256(ethers.toUtf8Bytes("topic:gaming"));
  const TAG_EN_US = ethers.keccak256(ethers.toUtf8Bytes("locale:en-US"));
  const TAG_DE = ethers.keccak256(ethers.toUtf8Bytes("locale:de"));
  const TAG_MOBILE = ethers.keccak256(ethers.toUtf8Bytes("platform:mobile"));

  before(async function () {
    await fundSigners();
    [owner, advertiser, publisher, publisher2, other, lifecycleMock] =
      await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, advertiser.address, publisher.address);

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n, await pauseReg.getAddress());

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(
      0n,
      100n,
      await publishers.getAddress(),
      await pauseReg.getAddress()
    );

    await ledger.setCampaigns(await campaigns.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());
    await campaigns.setLifecycleContract(lifecycleMock.address);

    // Register publishers
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
    await publishers.connect(publisher2).registerPublisher(TAKE_RATE_BPS);
  });

  // =========================================================================
  // TG: TargetingRegistry
  // =========================================================================

  it("TG1: publisher can set tags", async function () {
    const tags = [TAG_DEFI, TAG_EN_US, TAG_MOBILE];
    await campaigns.connect(publisher).setPublisherTags(tags);

    const stored = await campaigns.getPublisherTags2(publisher.address);
    expect(stored.length).to.equal(3);
    expect(stored[0]).to.equal(TAG_DEFI);
    expect(stored[1]).to.equal(TAG_EN_US);
    expect(stored[2]).to.equal(TAG_MOBILE);
  });

  it("TG1b: setPublisherTags emits TagsUpdated event", async function () {
    const tags = [TAG_GAMING, TAG_DE];
    await expect(campaigns.connect(publisher2).setPublisherTags(tags))
      .to.emit(campaigns, "TagsUpdated")
      .withArgs(publisher2.address, tags);
  });

  it("TG2: setTags replaces previous tags", async function () {
    // publisher2 already has [GAMING, DE] from TG1b
    const newTags = [TAG_DEFI, TAG_EN_US];
    await campaigns.connect(publisher2).setPublisherTags(newTags);

    const stored = await campaigns.getPublisherTags2(publisher2.address);
    expect(stored.length).to.equal(2);
    expect(stored[0]).to.equal(TAG_DEFI);
    expect(stored[1]).to.equal(TAG_EN_US);

    // Old tags should be removed from set
    expect(await campaigns.hasAllTags(publisher2.address, [TAG_GAMING])).to.be.false;
  });

  it("TG3: hasAllTags returns true when publisher has all required tags", async function () {
    // publisher has [DEFI, EN_US, MOBILE]
    expect(await campaigns.hasAllTags(publisher.address, [TAG_DEFI])).to.be.true;
    expect(await campaigns.hasAllTags(publisher.address, [TAG_DEFI, TAG_EN_US])).to.be.true;
    expect(await campaigns.hasAllTags(publisher.address, [TAG_DEFI, TAG_EN_US, TAG_MOBILE])).to.be.true;
  });

  it("TG3b: hasAllTags returns false when publisher is missing a tag", async function () {
    // publisher has [DEFI, EN_US, MOBILE] but not GAMING
    expect(await campaigns.hasAllTags(publisher.address, [TAG_GAMING])).to.be.false;
    expect(await campaigns.hasAllTags(publisher.address, [TAG_DEFI, TAG_GAMING])).to.be.false;
  });

  it("TG3c: hasAllTags returns true for empty requiredTags", async function () {
    expect(await campaigns.hasAllTags(publisher.address, [])).to.be.true;
    expect(await campaigns.hasAllTags(other.address, [])).to.be.true;
  });

  it("TG4: only registered publisher can set tags", async function () {
    await expect(
      campaigns.connect(other).setPublisherTags([TAG_DEFI])
    ).to.be.revertedWith("Not registered");
  });

  it("TG5: setTags rejects more than 32 tags (E65)", async function () {
    const tooMany = Array.from({ length: 33 }, (_, i) =>
      ethers.keccak256(ethers.toUtf8Bytes(`tag:${i}`))
    );
    await expect(
      campaigns.connect(publisher).setPublisherTags(tooMany)
    ).to.be.revertedWith("E65");
  });

  it("TG5b: setTags rejects zero hash (E00)", async function () {
    await expect(
      campaigns.connect(publisher).setPublisherTags([ethers.ZeroHash])
    ).to.be.revertedWith("E00");
  });

  it("TG6: setTags reverts when paused", async function () {
    await pauseReg.pause();

    await expect(
      campaigns.connect(publisher).setPublisherTags([TAG_DEFI])
    ).to.be.revertedWith("P");

    // C-4: unpause via guardian 2-of-3
    const pid = await pauseReg.connect(advertiser).propose.staticCall(2);
    await pauseReg.connect(advertiser).propose(2);
    await pauseReg.connect(publisher).approve(pid);
  });

  it("TG6b: hasAllTags rejects more than 8 required tags (E66)", async function () {
    const tooMany = Array.from({ length: 9 }, (_, i) =>
      ethers.keccak256(ethers.toUtf8Bytes(`tag:${i}`))
    );
    await expect(
      campaigns.hasAllTags(publisher.address, tooMany)
    ).to.be.revertedWith("E66");
  });

  it("TG6c: setTags to empty clears all tags", async function () {
    await campaigns.connect(publisher2).setPublisherTags([]);
    const stored = await campaigns.getPublisherTags2(publisher2.address);
    expect(stored.length).to.equal(0);
    expect(await campaigns.hasAllTags(publisher2.address, [TAG_DEFI])).to.be.false;
  });

  // =========================================================================
  // Campaign creation with requiredTags
  // =========================================================================

  it("TG7: createCampaign with empty requiredTags succeeds (backward compat)", async function () {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(await campaigns.getCampaignStatus(id)).to.equal(0);

    // No tags stored
    const tags = await campaigns.getCampaignTags(id);
    expect(tags.length).to.equal(0);
  });

  it("TG8: createCampaign with matching requiredTags succeeds", async function () {
    // publisher has [DEFI, EN_US, MOBILE]
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [TAG_DEFI, TAG_EN_US], false, ethers.ZeroAddress, 0n, 0n,
      { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(await campaigns.getCampaignStatus(id)).to.equal(0);

    // Tags stored
    const tags = await campaigns.getCampaignTags(id);
    expect(tags.length).to.equal(2);
    expect(tags[0]).to.equal(TAG_DEFI);
    expect(tags[1]).to.equal(TAG_EN_US);
  });

  it("TG9: createCampaign with non-matching requiredTags reverts E62", async function () {
    // publisher has [DEFI, EN_US, MOBILE] but not GAMING
    await expect(
      campaigns.connect(advertiser).createCampaign(
        publisher.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        [TAG_GAMING], false, ethers.ZeroAddress, 0n, 0n,
        { value: BUDGET }
      )
    ).to.be.revertedWith("E62");
  });

  it("TG9b: createCampaign with partial match reverts E62", async function () {
    // publisher has DEFI but not DE
    await expect(
      campaigns.connect(advertiser).createCampaign(
        publisher.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        [TAG_DEFI, TAG_DE], false, ethers.ZeroAddress, 0n, 0n,
        { value: BUDGET }
      )
    ).to.be.revertedWith("E62");
  });

  it("TG10: open campaign (publisher=0) skips tag check", async function () {
    // Open campaigns don't check tags at creation — tags matched at auction time
    const tx = await campaigns.connect(advertiser).createCampaign(
      ethers.ZeroAddress,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [TAG_DEFI, TAG_EN_US], false, ethers.ZeroAddress, 0n, 0n,
      { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(await campaigns.getCampaignStatus(id)).to.equal(0);

    // Tags still stored for auction-time matching
    const tags = await campaigns.getCampaignTags(id);
    expect(tags.length).to.equal(2);
  });

  it("TG11: createCampaign rejects more than 8 requiredTags (E66)", async function () {
    const tooMany = Array.from({ length: 9 }, (_, i) =>
      ethers.keccak256(ethers.toUtf8Bytes(`tag:${i}`))
    );
    await expect(
      campaigns.connect(advertiser).createCampaign(
        publisher.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        tooMany, false, ethers.ZeroAddress, 0n, 0n,
        { value: BUDGET }
      )
    ).to.be.revertedWith("E66");
  });

});
