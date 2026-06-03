import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Campaigns is EIP-170-bound, so its migration uses governance-gated write hooks
// (migrateImportCampaign / migrateBumpNextId) that an OFF-CHAIN migrator
// (scripts/migrate-campaigns.ts) drives — reading each campaign's struct + gates
// from the frozen predecessor and replaying them here. This test exercises the
// hooks directly: import a campaign record into v2 and read it back.
describe("DatumCampaigns — migration write hooks", function () {
  let v2: any, router: any, pause: any;
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, adv: HardhatEthersSigner, pubr: HardhatEthersSigner, signer: HardhatEthersSigner;

  const REWARD = "0x000000000000000000000000000000000000bEEF";

  function campaign(): any {
    return {
      advertiser: adv.address,
      publisher: pubr.address,
      pendingExpiryBlock: 0n,
      terminationBlock: 0n,
      snapshotTakeRateBps: 5000,
      status: 1, // Active
      relaySigner: signer.address,
      requiresZkProof: true,
      rewardToken: REWARD,
      rewardPerImpression: 123n,
      viewBid: 4_000_000_000n,
    };
  }

  beforeEach(async function () {
    [owner, gov, adv, pubr, signer] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
    pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(owner.address, adv.address, pubr.address);
    const pubs = await (await ethers.getContractFactory("DatumPublishers")).deploy(100, await pause.getAddress());
    v2 = await (await ethers.getContractFactory("MockCampaignsV2"))
      .deploy(1, 100, await pubs.getAddress(), await pause.getAddress());
    await v2.setRouter(await router.getAddress());
  });

  it("governance replays a campaign struct + scalar gates + nextId", async function () {
    await v2.connect(gov).migrateImportCampaign(42, campaign(), 2, 10n ** 12n, 1);
    await v2.connect(gov).migrateBumpNextId(43);

    const c = await v2.getCampaignStruct(42);
    expect(c.advertiser).to.equal(adv.address);
    expect(c.publisher).to.equal(pubr.address);
    expect(c.snapshotTakeRateBps).to.equal(5000);
    expect(c.status).to.equal(1n);
    expect(c.relaySigner).to.equal(signer.address);
    expect(c.requiresZkProof).to.equal(true);
    expect(c.rewardToken).to.equal(REWARD);
    expect(c.rewardPerImpression).to.equal(123n);
    expect(c.viewBid).to.equal(4_000_000_000n);

    expect(await v2.campaignAssuranceLevel(42)).to.equal(2);
    expect(await v2.campaignMinStake(42)).to.equal(10n ** 12n);
    expect(await v2.campaignMinIdentityLevel(42)).to.equal(1);
    expect(await v2.nextCampaignId()).to.equal(43n);
    // settlement-facing read resolves the migrated campaign
    expect(await v2.getCampaignAdvertiser(42)).to.equal(adv.address);
  });

  it("import hooks are governance-only", async function () {
    await expect(v2.connect(owner).migrateImportCampaign(1, campaign(), 0, 0, 0)).to.be.revertedWith("E19");
    await expect(v2.connect(owner).migrateBumpNextId(99)).to.be.revertedWith("E19");
  });
});
