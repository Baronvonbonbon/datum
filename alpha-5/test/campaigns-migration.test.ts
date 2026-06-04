import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Campaigns is EIP-170-bound, so the heavy full-import loop lives in
// DatumCampaignsMigrationLogic, reached via DatumCampaigns.migrateDelegate()
// (a governance-gated DELEGATECALL passthrough). An OFF-CHAIN migrator
// (scripts/migrate-campaigns.ts) reads each campaign's FULL state from the
// frozen predecessor — core struct + pots + every scalar gate — ABI-encodes an
// importCampaignFull() call, and replays it here. This test drives that path
// directly: import a full campaign record into v2 and read every field back.
describe("DatumCampaigns — full migration via delegatecall logic", function () {
  let v2: any, logic: any, router: any, pause: any;
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

  function pot(): any {
    return {
      actionType: 0,
      budgetPlanck: 1_000_000n,
      dailyCapPlanck: 100_000n,
      ratePlanck: 4_000_000_000n,
      actionVerifier: ethers.ZeroAddress,
    };
  }

  function fullImport(): any {
    return {
      core: campaign(),
      pots: [pot()],
      allowlistEnabled: true,
      assuranceLevel: 2,
      minStake: 10n ** 12n,
      requiredCategory: ethers.encodeBytes32String("news"),
      userEventCap: 5,
      userCapWindow: 100,
      minHistory: 3,
      minIdentityLevel: 1,
    };
  }

  function encodeImport(id: number, fi: any): string {
    return logic.interface.encodeFunctionData("importCampaignFull", [id, fi]);
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
    logic = await (await ethers.getContractFactory("DatumCampaignsMigrationLogic")).deploy();
  });

  it("governance replays FULL campaign state (struct + pots + every gate) via migrateDelegate", async function () {
    await v2.connect(gov).setMigrationLogic(await logic.getAddress());
    await v2.connect(gov).migrateDelegate(encodeImport(42, fullImport()));
    await v2.connect(gov).migrateBumpNextId(43);

    // core struct
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

    // pots (the side-state the old partial hook could NOT migrate)
    const pots = await v2.getCampaignPots(42);
    expect(pots.length).to.equal(1);
    expect(pots[0].actionType).to.equal(0);
    expect(pots[0].budgetPlanck).to.equal(1_000_000n);
    expect(pots[0].dailyCapPlanck).to.equal(100_000n);
    expect(pots[0].ratePlanck).to.equal(4_000_000_000n);

    // every scalar gate
    expect(await v2.campaignAllowlistEnabled(42)).to.equal(true);
    expect(await v2.campaignAssuranceLevel(42)).to.equal(2);
    expect(await v2.campaignMinStake(42)).to.equal(10n ** 12n);
    expect(await v2.campaignRequiredCategory(42)).to.equal(ethers.encodeBytes32String("news"));
    expect(await v2.userEventCapPerWindow(42)).to.equal(5);
    expect(await v2.userCapWindowBlocks(42)).to.equal(100);
    expect(await v2.minUserSettledHistory(42)).to.equal(3);
    expect(await v2.campaignMinIdentityLevel(42)).to.equal(1);

    expect(await v2.nextCampaignId()).to.equal(43n);
    // settlement-facing read resolves the migrated campaign
    expect(await v2.getCampaignAdvertiser(42)).to.equal(adv.address);
  });

  it("re-importing overwrites pots cleanly (no stale entries)", async function () {
    await v2.connect(gov).setMigrationLogic(await logic.getAddress());
    const three = fullImport();
    three.pots = [pot(), { ...pot(), actionType: 1 }, { ...pot(), actionType: 2, actionVerifier: signer.address }];
    await v2.connect(gov).migrateDelegate(encodeImport(7, three));
    expect((await v2.getCampaignPots(7)).length).to.equal(3);

    // a second import with a single pot must replace, not append
    await v2.connect(gov).migrateDelegate(encodeImport(7, fullImport()));
    expect((await v2.getCampaignPots(7)).length).to.equal(1);
  });

  it("setMigrationLogic is governance-only and lock-once", async function () {
    await expect(v2.connect(owner).setMigrationLogic(await logic.getAddress())).to.be.revertedWith("E19");
    await v2.connect(gov).setMigrationLogic(await logic.getAddress());
    await expect(v2.connect(gov).setMigrationLogic(await logic.getAddress())).to.be.revertedWithCustomError(v2, "AlreadySet");
  });

  it("migrateDelegate is governance-only and reverts when logic unset", async function () {
    // unset
    await expect(v2.connect(gov).migrateDelegate(encodeImport(1, fullImport())))
      .to.be.revertedWithCustomError(v2, "RegistryUnset");
    // non-governance
    await v2.connect(gov).setMigrationLogic(await logic.getAddress());
    await expect(v2.connect(owner).migrateDelegate(encodeImport(1, fullImport())))
      .to.be.revertedWith("E19");
  });

  it("migrateBumpNextId is governance-only", async function () {
    await expect(v2.connect(owner).migrateBumpNextId(99)).to.be.revertedWith("E19");
  });

  it("migrateDelegate rejects any selector other than importCampaignFull", async function () {
    await v2.connect(gov).setMigrationLogic(await logic.getAddress());
    // the logic INHERITS DatumUpgradable.transferOwnership — a generic passthrough
    // would let governance delegatecall it and overwrite THIS contract's owner.
    const evil = logic.interface.encodeFunctionData("transferOwnership", [owner.address]);
    await expect(v2.connect(gov).migrateDelegate(evil)).to.be.revertedWithCustomError(v2, "E00");
    // sanity: the allowed selector still goes through
    await expect(v2.connect(gov).migrateDelegate(encodeImport(9, fullImport()))).to.not.be.reverted;
  });
});
