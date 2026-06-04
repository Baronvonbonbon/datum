import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

describe("Tag* — upgrade migration", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, campaignsS: HardhatEthersSigner, pub: HardhatEthersSigner, juror: HardhatEthersSigner;
  let router: any;
  const TAG1 = "0x" + "a1".repeat(32);
  const TAG2 = "0x" + "a2".repeat(32);

  beforeEach(async function () {
    await fundSigners();
    [owner, gov, campaignsS, pub, juror] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
  });

  it("DatumTagSystem migrates the tag dictionary + campaign tag snapshots", async function () {
    const v1 = await (await ethers.getContractFactory("DatumTagSystem")).deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setCampaigns(campaignsS.address); // EOA stand-in to drive initializeCampaignTags
    await v1.approveTag(TAG1);
    await v1.approveTag(TAG2);
    await v1.connect(campaignsS).initializeCampaignTags(9, ethers.ZeroAddress, [TAG1]); // address(0) skips the publisher-holds-tags check

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockTagSystemNext")).deploy();
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());

    expect(await v2.approvedTags(TAG1)).to.equal(true);
    expect(await v2.approvedTags(TAG2)).to.equal(true);
    expect((await v2.listApprovedTags()).length).to.equal(2);
    expect(await v2.getCampaignTags(9)).to.deep.equal([TAG1]);
    expect(await v2.tagCampaignCount()).to.equal(1n);
  });

  it("DatumTagRegistry migrates juror stakes + tags and sweeps DATUM", async function () {
    const datum = await (await ethers.getContractFactory("MockERC20")).deploy("Datum", "DTM");
    await datum.mint(juror.address, ethers.parseEther("1000")); // DATUM is 18 decimals
    const v1 = await (await ethers.getContractFactory("DatumTagRegistry")).deploy(await datum.getAddress());
    await v1.setRouter(await router.getAddress());
    await datum.connect(juror).approve(await v1.getAddress(), ethers.parseEther("1000"));
    await v1.connect(juror).stakeAsJuror(ethers.parseEther("100")); // >= jurorMinStake (5e18)
    await v1.connect(juror).registerTag(TAG1, ethers.parseEther("50")); // >= minTagBond (10e18)

    const total = ethers.parseEther("150");
    expect(await datum.balanceOf(await v1.getAddress())).to.equal(total);

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockTagRegistryNext")).deploy(await datum.getAddress());
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.jurorStake(juror.address)).to.equal(ethers.parseEther("100"));
    expect(await v2.jurorCount()).to.equal(1n);
    expect(await v2.tagCount()).to.equal(1n);
    expect((await v2.getTagInfo(TAG1)).bond).to.equal(ethers.parseEther("50"));
    expect(await datum.balanceOf(await v2.getAddress())).to.equal(total);
    expect(await datum.balanceOf(await v1.getAddress())).to.equal(0n);
  });
});
