import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// Upgrade migration for the creative/bulletin module: per-campaign metadata +
// approved-renewer set + bulletin-renewal escrow (native DOT). Escrow is swept
// to the successor; v2 honours it.
describe("DatumCampaignCreative — upgrade migration", function () {
  let v1: any, v2: any, router: any, mock: any, pause: any;
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, adv: HardhatEthersSigner, pub: HardhatEthersSigner, renewer: HardhatEthersSigner;
  const HASH = "0x" + "ab".repeat(32);
  const CID = 1n;

  beforeEach(async function () {
    await fundSigners();
    [owner, gov, adv, pub, renewer] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
    pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(owner.address, adv.address, pub.address);
    mock = await (await ethers.getContractFactory("MockCampaigns")).deploy();
    await mock.setCampaign(CID, adv.address, pub.address, 1000n, 5000, 0); // Pending

    v1 = await (await ethers.getContractFactory("DatumCampaignCreative")).deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setCampaigns(await mock.getAddress());
    await v1.setPauseRegistry(await pause.getAddress());

    await v1.connect(adv).setMetadata(CID, HASH);
    await v1.connect(adv).setApprovedBulletinRenewer(CID, renewer.address, true);
    await v1.fundBulletinRenewalEscrow(CID, { value: parseDOT("5") });

    v2 = await (await ethers.getContractFactory("MockCampaignCreativeV2")).deploy();
    await v2.setRouter(await router.getAddress());
  });

  it("copies metadata + renewer set + escrow and sweeps the DOT", async function () {
    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(parseDOT("5"));

    await v1.connect(gov).freeze();
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.campaignMetadata(CID)).to.equal(HASH);
    expect(await v2.campaignMetadataVersion(CID)).to.equal(1n);
    expect(await v2.approvedBulletinRenewer(CID, renewer.address)).to.equal(true);
    expect(await v2.bulletinRenewalEscrow(CID)).to.equal(parseDOT("5"));
    expect(await v2.creativeCampaignCount()).to.equal(1n);
    expect(await v2.renewerCount(CID)).to.equal(1n);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("5"));
    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(0n);
  });
});
