import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Predecessor-chain migration for cumulative reputation counters: the successor
// adds the frozen predecessor's totals on read (no copy), so a publisher's
// acceptance score carries across an upgrade and keeps accruing.
describe("DatumPublisherReputation — predecessor-chain migration", function () {
  let v1: any, v2: any, router: any;
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, settle: HardhatEthersSigner, pub: HardhatEthersSigner;
  const CID = 3n;

  beforeEach(async function () {
    [owner, gov, settle, pub] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);

    v1 = await (await ethers.getContractFactory("DatumPublisherReputation")).deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setSettlement(settle.address);
    await v1.setMinReputationScore(6000);
    await v1.connect(settle).recordSettlement(pub.address, CID, 80, 20); // 80 settled / 20 rejected

    v2 = await (await ethers.getContractFactory("MockPublisherReputationV2")).deploy();
    await v2.setRouter(await router.getAddress());
    await v2.setSettlement(settle.address);
  });

  it("counters + score carry across the upgrade and keep accruing", async function () {
    await v1.connect(gov).freeze();
    await v2.connect(gov).migrate(await v1.getAddress());

    // config copied
    expect(await v2.minReputationScore()).to.equal(6000);
    // pre-upgrade counters visible via the predecessor (not copied)
    expect(await v2.repTotalSettled(pub.address)).to.equal(80n);
    expect(await v2.repTotalRejected(pub.address)).to.equal(20n);
    expect(await v2.repCampaignSettled(pub.address, CID)).to.equal(80n);
    expect(await v2.getReputationScore(pub.address)).to.equal(8000); // 80/100

    // new settlements on v2 accrue ON TOP of the predecessor totals
    await v2.connect(settle).recordSettlement(pub.address, CID, 20, 80); // +20/+80
    expect(await v2.repTotalSettled(pub.address)).to.equal(100n);
    expect(await v2.repTotalRejected(pub.address)).to.equal(100n);
    expect(await v2.getReputationScore(pub.address)).to.equal(5000); // 100/200
  });
});
