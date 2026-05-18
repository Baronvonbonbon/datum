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
import { fundSigners, mineBlocks } from "./helpers/mine";

// TX-1/TX-2: Tag-based targeting tests
// TG1-TG6: Targeting (setPublisherTags, getPublisherTags2, hasAllTags) — merged into Campaigns
// TG7-TG11: Campaign creation with requiredTags

describe("Tag-Based Targeting (TX-1/TX-2)", function () {
  let campaigns: DatumCampaigns;
  let allowlist: any;
  let tagSystem: any;
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

    allowlist = await (await ethers.getContractFactory("DatumCampaignAllowlist")).deploy();
    await allowlist.setCampaigns(await campaigns.getAddress());
    await allowlist.setPublishers(await publishers.getAddress());
    await campaigns.setAllowlist(await allowlist.getAddress());

    tagSystem = await (await ethers.getContractFactory("DatumTagSystem")).deploy();
    await tagSystem.setCampaigns(await campaigns.getAddress());
    await tagSystem.setPublishers(await publishers.getAddress());
    await tagSystem.setPauseRegistry(await pauseReg.getAddress());
    await campaigns.setTagSystem(await tagSystem.getAddress());
    await allowlist.setTagSystem(await tagSystem.getAddress());

    // Register publishers
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
    await publishers.connect(publisher2).registerPublisher(TAKE_RATE_BPS);
  });

  // =========================================================================
  // TG: TargetingRegistry
  // =========================================================================

  it("TG1: publisher can set tags", async function () {
    const tags = [TAG_DEFI, TAG_EN_US, TAG_MOBILE];
    await tagSystem.connect(publisher).setPublisherTags(tags);

    const stored = await tagSystem.getPublisherTags2(publisher.address);
    expect(stored.length).to.equal(3);
    expect(stored[0]).to.equal(TAG_DEFI);
    expect(stored[1]).to.equal(TAG_EN_US);
    expect(stored[2]).to.equal(TAG_MOBILE);
  });

  it("TG1b: setPublisherTags emits TagsUpdated event", async function () {
    const tags = [TAG_GAMING, TAG_DE];
    await expect(tagSystem.connect(publisher2).setPublisherTags(tags))
      .to.emit(tagSystem, "TagsUpdated")
      .withArgs(publisher2.address, tags);
  });

  it("TG2: setTags replaces previous tags (with A8 removal grace)", async function () {
    // publisher2 already has [GAMING, DE] from TG1b
    const newTags = [TAG_DEFI, TAG_EN_US];
    await tagSystem.connect(publisher2).setPublisherTags(newTags);

    const stored = await tagSystem.getPublisherTags2(publisher2.address);
    expect(stored.length).to.equal(2);
    expect(stored[0]).to.equal(TAG_DEFI);
    expect(stored[1]).to.equal(TAG_EN_US);

    // A8: dropped tag still effective during the grace window.
    expect(await tagSystem.hasAllTags(publisher2.address, [TAG_GAMING])).to.be.true;
    const grace = Number(await tagSystem.TAG_REMOVAL_GRACE_BLOCKS());
    await mineBlocks(grace + 1);
    // After grace elapses, dropped tag is truly gone.
    expect(await tagSystem.hasAllTags(publisher2.address, [TAG_GAMING])).to.be.false;
  });

  it("TG3: hasAllTags returns true when publisher has all required tags", async function () {
    // publisher has [DEFI, EN_US, MOBILE]
    expect(await tagSystem.hasAllTags(publisher.address, [TAG_DEFI])).to.be.true;
    expect(await tagSystem.hasAllTags(publisher.address, [TAG_DEFI, TAG_EN_US])).to.be.true;
    expect(await tagSystem.hasAllTags(publisher.address, [TAG_DEFI, TAG_EN_US, TAG_MOBILE])).to.be.true;
  });

  it("TG3b: hasAllTags returns false when publisher is missing a tag", async function () {
    // publisher has [DEFI, EN_US, MOBILE] but not GAMING
    expect(await tagSystem.hasAllTags(publisher.address, [TAG_GAMING])).to.be.false;
    expect(await tagSystem.hasAllTags(publisher.address, [TAG_DEFI, TAG_GAMING])).to.be.false;
  });

  it("TG3c: hasAllTags returns true for empty requiredTags", async function () {
    expect(await tagSystem.hasAllTags(publisher.address, [])).to.be.true;
    expect(await tagSystem.hasAllTags(other.address, [])).to.be.true;
  });

  it("TG4: only registered publisher can set tags", async function () {
    await expect(
      tagSystem.connect(other).setPublisherTags([TAG_DEFI])
    ).to.be.revertedWithCustomError(tagSystem, "NotRegistered");
  });

  it("TG5: setTags rejects more than maxPublisherTags (E65)", async function () {
    // Default is 64 (governance-settable). Shrink to 4 to keep the test cheap.
    await tagSystem.setMaxPublisherTags(4);
    const tooMany = Array.from({ length: 5 }, (_, i) =>
      ethers.keccak256(ethers.toUtf8Bytes(`tag:${i}`))
    );
    await expect(
      tagSystem.connect(publisher).setPublisherTags(tooMany)
    ).to.be.revertedWithCustomError(tagSystem, "E65");
    await tagSystem.setMaxPublisherTags(64); // restore default
  });

  it("TG5b: setTags rejects zero hash (E00)", async function () {
    await expect(
      tagSystem.connect(publisher).setPublisherTags([ethers.ZeroHash])
    ).to.be.revertedWithCustomError(tagSystem, "E00");
  });

  it("TG6: setTags reverts when paused", async function () {
    await pauseReg.pause();

    await expect(
      tagSystem.connect(publisher).setPublisherTags([TAG_DEFI])
    ).to.be.revertedWithCustomError(tagSystem, "Paused");

    // C-4: unpause via guardian 2-of-3
    const pid = await pauseReg.connect(advertiser).propose.staticCall(2);
    await pauseReg.connect(advertiser).propose(2);
    await pauseReg.connect(publisher).approve(pid);
  });

  it("TG6b: hasAllTags rejects more than maxCampaignTags (E66)", async function () {
    await tagSystem.setMaxCampaignTags(2);
    const tooMany = Array.from({ length: 3 }, (_, i) =>
      ethers.keccak256(ethers.toUtf8Bytes(`tag:${i}`))
    );
    await expect(
      tagSystem.hasAllTags(publisher.address, tooMany)
    ).to.be.revertedWithCustomError(tagSystem, "E66");
    await tagSystem.setMaxCampaignTags(16); // restore default
  });

  it("TG6c: setTags to empty clears all tags (A8 grace honored)", async function () {
    await tagSystem.connect(publisher2).setPublisherTags([]);
    const stored = await tagSystem.getPublisherTags2(publisher2.address);
    expect(stored.length).to.equal(0);
    // A8: dropped tags still effective until the grace elapses.
    expect(await tagSystem.hasAllTags(publisher2.address, [TAG_DEFI])).to.be.true;
    const grace = Number(await tagSystem.TAG_REMOVAL_GRACE_BLOCKS());
    await mineBlocks(grace + 1);
    expect(await tagSystem.hasAllTags(publisher2.address, [TAG_DEFI])).to.be.false;
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
    ).to.be.revertedWithCustomError(allowlist, "E62");
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
    ).to.be.revertedWithCustomError(allowlist, "E62");
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

  it("TG-gov-1: setMaxPublisherTags bounded by ceiling (E11)", async function () {
    const ceiling = await tagSystem.MAX_PUBLISHER_TAGS_CEILING();
    await expect(tagSystem.setMaxPublisherTags(0)).to.be.revertedWithCustomError(allowlist, "E11");
    await expect(tagSystem.setMaxPublisherTags(ceiling + 1n)).to.be.revertedWithCustomError(allowlist, "E11");
    await tagSystem.setMaxPublisherTags(128);
    expect(await tagSystem.maxPublisherTags()).to.equal(128);
    await tagSystem.setMaxPublisherTags(64); // restore
  });

  it("TG-gov-2: setMaxCampaignTags bounded by ceiling (E11)", async function () {
    const ceiling = await tagSystem.MAX_CAMPAIGN_TAGS_CEILING();
    await expect(tagSystem.setMaxCampaignTags(0)).to.be.revertedWithCustomError(allowlist, "E11");
    await expect(tagSystem.setMaxCampaignTags(ceiling + 1n)).to.be.revertedWithCustomError(allowlist, "E11");
  });

  it("TG-gov-3: setMaxAllowedPublishers bounded by ceiling (E11)", async function () {
    const ceiling = await allowlist.MAX_ALLOWED_PUBLISHERS_CEILING();
    await expect(allowlist.setMaxAllowedPublishers(0)).to.be.revertedWithCustomError(allowlist, "E11");
    await expect(allowlist.setMaxAllowedPublishers(ceiling + 1n)).to.be.revertedWithCustomError(allowlist, "E11");
  });

  it("TG-gov-4: only owner can set caps (E18)", async function () {
    await expect(tagSystem.connect(advertiser).setMaxPublisherTags(50)).to.be.revertedWith("E18");
    await expect(tagSystem.connect(advertiser).setMaxCampaignTags(10)).to.be.revertedWith("E18");
    await expect(allowlist.connect(advertiser).setMaxAllowedPublishers(50)).to.be.revertedWith("E18");
  });

  it("TG11: createCampaign rejects more than maxCampaignTags (E66)", async function () {
    await tagSystem.setMaxCampaignTags(2);
    const tooMany = Array.from({ length: 3 }, (_, i) =>
      ethers.keccak256(ethers.toUtf8Bytes(`tag:${i}`))
    );
    await expect(
      campaigns.connect(advertiser).createCampaign(
        publisher.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        tooMany, false, ethers.ZeroAddress, 0n, 0n,
        { value: BUDGET }
      )
    ).to.be.revertedWithCustomError(tagSystem, "E66");
    await tagSystem.setMaxCampaignTags(16); // restore default
  });

});
