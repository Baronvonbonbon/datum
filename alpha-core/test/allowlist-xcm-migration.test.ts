import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

describe("CampaignAllowlist + XcmBridge — upgrade migration", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, campaignsS: HardhatEthersSigner, pubA: HardhatEthersSigner, pubB: HardhatEthersSigner;
  let router: any;

  beforeEach(async function () {
    await fundSigners();
    [owner, gov, campaignsS, pubA, pubB] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
  });

  it("DatumCampaignAllowlist copies the per-(campaign,publisher) allow set", async function () {
    const v1 = await (await ethers.getContractFactory("DatumCampaignAllowlist")).deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setCampaigns(campaignsS.address); // EOA stand-in to drive initializeFor
    await v1.connect(campaignsS).initializeFor(1, pubA.address, 5000);
    await v1.connect(campaignsS).initializeFor(2, pubB.address, 6000);

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockCampaignAllowlistV2")).deploy();
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());

    expect(await v2.isAllowedPublisher(1, pubA.address)).to.equal(true);
    expect(await v2.getCampaignPublisherTakeRate(1, pubA.address)).to.equal(5000);
    expect(await v2.campaignAllowedPublisherCount(1)).to.equal(1);
    expect(await v2.isAllowedPublisher(2, pubB.address)).to.equal(true);
    expect(await v2.getCampaignPublisherTakeRate(2, pubB.address)).to.equal(6000);
    // a never-allowed pair stays false
    expect(await v2.isAllowedPublisher(1, pubB.address)).to.equal(false);
    expect(await v2.allowlistCampaignCount()).to.equal(2n);
  });

  it("DatumPeopleChainXcmBridge migrates per-campaign escrow + config + sweeps DOT", async function () {
    const xcm = pubA.address, cache = pubB.address; // arbitrary non-zero (not called here)
    const v1 = await (await ethers.getContractFactory("DatumPeopleChainXcmBridge")).deploy(xcm, cache);
    await v1.setRouter(await router.getAddress());
    await v1.setRefreshCooldownBlocks(1234);
    await v1.fundXcmRefreshEscrow(1, { value: parseDOT("5") });
    await v1.fundXcmRefreshEscrow(2, { value: parseDOT("3") });

    const total = parseDOT("8");
    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(total);

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockPeopleChainXcmBridgeV2")).deploy(xcm, cache);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.campaignXcmRefreshEscrow(1)).to.equal(parseDOT("5"));
    expect(await v2.campaignXcmRefreshEscrow(2)).to.equal(parseDOT("3"));
    expect(await v2.refreshCooldownBlocks()).to.equal(1234n);
    expect(await v2.escrowCampaignCount()).to.equal(2n);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(total);
    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(0n);
  });
});
