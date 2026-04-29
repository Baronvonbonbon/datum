import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumCampaignLifecycle,
  DatumCampaigns,
  DatumPublishers,
  DatumPauseRegistry,
  DatumBudgetLedger,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, mineBlocks } from "./helpers/mine";

// Lifecycle tests for alpha-2 satellite:
// LC1-LC3: complete, terminate, expire
// LC4-LC6: access control
// LC7-LC8: edge cases

describe("DatumCampaignLifecycle", function () {
  let lifecycle: DatumCampaignLifecycle;
  let campaigns: DatumCampaigns;
  let publishers: DatumPublishers;
  let pauseReg: DatumPauseRegistry;
  let ledger: DatumBudgetLedger;

  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let governance: HardhatEthersSigner;
  let settlementMock: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const PENDING_TIMEOUT = 20n;
  const BUDGET = parseDOT("2");
  const DAILY_CAP = parseDOT("1");
  const BID_CPM = parseDOT("0.01");
  const TAKE_RATE_BPS = 5000;

  before(async function () {
    await fundSigners();
    [owner, advertiser, publisher, governance, settlementMock, other] = await ethers.getSigners();

    // Deploy infrastructure
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, advertiser.address, publisher.address);

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n, await pauseReg.getAddress());

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    const CampValFactory = await ethers.getContractFactory("DatumCampaignValidator");
    const campaignValidator = await CampValFactory.deploy(await publishers.getAddress(), ethers.ZeroAddress);

    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(
      0n, PENDING_TIMEOUT, await campaignValidator.getAddress(), await pauseReg.getAddress()
    );

    // Deploy Lifecycle
    const LifecycleFactory = await ethers.getContractFactory("DatumCampaignLifecycle");
    lifecycle = await LifecycleFactory.deploy(await pauseReg.getAddress(), 100n);

    // Wire everything
    await ledger.setCampaigns(await campaigns.getAddress());
    await ledger.setLifecycle(await lifecycle.getAddress());
    await ledger.setSettlement(settlementMock.address); // placeholder

    await campaigns.setBudgetLedger(await ledger.getAddress());
    await campaigns.setLifecycleContract(await lifecycle.getAddress());
    await campaigns.setGovernanceContract(governance.address);

    await lifecycle.setCampaigns(await campaigns.getAddress());
    await lifecycle.setBudgetLedger(await ledger.getAddress());
    await lifecycle.setGovernanceContract(governance.address);
    await lifecycle.setSettlementContract(settlementMock.address);

    // Register publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  async function createAndActivate(): Promise<bigint> {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    const id = await campaigns.nextCampaignId() - 1n;
    // Activate via governance
    await campaigns.connect(governance).activateCampaign(id);
    return id;
  }

  async function createPending(): Promise<bigint> {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    return (await campaigns.nextCampaignId()) - 1n;
  }

  // LC1: completeCampaign by advertiser
  it("LC1: advertiser can complete Active campaign; budget refunded", async function () {
    const cid = await createAndActivate();

    const advBalBefore = await ethers.provider.getBalance(advertiser.address);
    const tx = await lifecycle.connect(advertiser).completeCampaign(cid);
    const receipt = await tx.wait();
    const advBalAfter = await ethers.provider.getBalance(advertiser.address);
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    expect(await campaigns.getCampaignStatus(cid)).to.equal(3); // Completed
    // Advertiser should receive budget minus gas
    expect(advBalAfter - advBalBefore + gasUsed).to.equal(BUDGET);
    expect(await ledger.getRemainingBudget(cid, 0)).to.equal(0n);
  });

  // LC2: terminateCampaign by governance (10% slash, 90% refund)
  it("LC2: governance can terminate Active campaign; 10% slash, 90% refund", async function () {
    const cid = await createAndActivate();

    const advBalBefore = await ethers.provider.getBalance(advertiser.address);
    const govBalBefore = await ethers.provider.getBalance(governance.address);

    const tx = await lifecycle.connect(governance).terminateCampaign(cid);
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    expect(await campaigns.getCampaignStatus(cid)).to.equal(4); // Terminated

    const advBalAfter = await ethers.provider.getBalance(advertiser.address);
    const govBalAfter = await ethers.provider.getBalance(governance.address);

    // 10% to governance, 90% to advertiser
    const slashAmount = BUDGET * 1000n / 10000n; // 10%
    const refundAmount = BUDGET - slashAmount;

    expect(advBalAfter - advBalBefore).to.equal(refundAmount);
    // Governance receives slash minus gas for calling
    expect(govBalAfter - govBalBefore + gasUsed).to.equal(slashAmount);

    expect(await ledger.getRemainingBudget(cid, 0)).to.equal(0n);
  });

  // LC3: expirePendingCampaign after timeout
  it("LC3: anyone can expire Pending campaign after timeout; full refund", async function () {
    const cid = await createPending();

    await mineBlocks(PENDING_TIMEOUT + 2n);

    const advBalBefore = await ethers.provider.getBalance(advertiser.address);
    await lifecycle.connect(other).expirePendingCampaign(cid);
    const advBalAfter = await ethers.provider.getBalance(advertiser.address);

    expect(await campaigns.getCampaignStatus(cid)).to.equal(5); // Expired
    expect(advBalAfter - advBalBefore).to.equal(BUDGET);
  });

  // LC4: only advertiser/settlement can complete
  it("LC4: only advertiser or settlement can complete", async function () {
    const cid = await createAndActivate();

    await expect(
      lifecycle.connect(other).completeCampaign(cid)
    ).to.be.revertedWith("E13");

    // Settlement mock can complete (auto-complete on budget exhaustion)
    await lifecycle.connect(settlementMock).completeCampaign(cid);
    expect(await campaigns.getCampaignStatus(cid)).to.equal(3);
  });

  // LC5: only governance can terminate
  it("LC5: only governance can terminate", async function () {
    const cid = await createAndActivate();

    await expect(
      lifecycle.connect(other).terminateCampaign(cid)
    ).to.be.revertedWith("E19");

    await expect(
      lifecycle.connect(advertiser).terminateCampaign(cid)
    ).to.be.revertedWith("E19");
  });

  // LC6: expire before timeout reverts
  it("LC6: expire before timeout reverts E24", async function () {
    const cid = await createPending();

    await expect(
      lifecycle.connect(other).expirePendingCampaign(cid)
    ).to.be.revertedWith("E24");
  });

  // LC7: cannot complete non-Active campaign
  it("LC7: cannot complete Pending campaign (E14)", async function () {
    const cid = await createPending();

    await expect(
      lifecycle.connect(advertiser).completeCampaign(cid)
    ).to.be.revertedWith("E14");
  });

  // LC8: terminate reverts when paused
  it("LC8: terminate reverts when paused", async function () {
    const cid = await createAndActivate();
    await pauseReg.pause();

    await expect(
      lifecycle.connect(governance).terminateCampaign(cid)
    ).to.be.revertedWith("P");

    // C-4: unpause via guardian 2-of-3
    const pid = await pauseReg.connect(advertiser).propose.staticCall(2);
    await pauseReg.connect(advertiser).propose(2);
    await pauseReg.connect(publisher).approve(pid);
  });

  // LC9: expire non-Pending reverts
  it("LC9: expire Active campaign reverts E20", async function () {
    const cid = await createAndActivate();

    await expect(
      lifecycle.connect(other).expirePendingCampaign(cid)
    ).to.be.revertedWith("E20");
  });

  // =========================================================================
  // P20: Campaign inactivity timeout
  // =========================================================================

  // LC10: expireInactiveCampaign succeeds after timeout
  it("LC10: anyone can expire inactive Active campaign after timeout", async function () {
    const cid = await createAndActivate();

    // Mine past inactivity timeout (100 blocks in test)
    await mineBlocks(102n);

    const advBalBefore = await ethers.provider.getBalance(advertiser.address);
    await lifecycle.connect(other).expireInactiveCampaign(cid);
    const advBalAfter = await ethers.provider.getBalance(advertiser.address);

    expect(await campaigns.getCampaignStatus(cid)).to.equal(3); // Completed
    expect(advBalAfter - advBalBefore).to.equal(BUDGET);
    expect(await ledger.getRemainingBudget(cid, 0)).to.equal(0n);
  });

  // LC11: expireInactiveCampaign reverts before timeout
  it("LC11: expire inactive reverts before timeout (E64)", async function () {
    const cid = await createAndActivate();

    await expect(
      lifecycle.connect(other).expireInactiveCampaign(cid)
    ).to.be.revertedWith("E64");
  });

  // LC12: expireInactiveCampaign reverts on non-Active
  it("LC12: expire inactive reverts on Pending campaign (E14)", async function () {
    const cid = await createPending();

    await mineBlocks(102n);

    await expect(
      lifecycle.connect(other).expireInactiveCampaign(cid)
    ).to.be.revertedWith("E14");
  });

  // LC13: expireInactiveCampaign works on Paused campaign
  it("LC13: expire inactive works on Paused campaign", async function () {
    const cid = await createAndActivate();

    // Pause the campaign
    await campaigns.connect(advertiser).togglePause(cid, true);
    expect(await campaigns.getCampaignStatus(cid)).to.equal(2); // Paused

    await mineBlocks(102n);

    await lifecycle.connect(other).expireInactiveCampaign(cid);
    expect(await campaigns.getCampaignStatus(cid)).to.equal(3); // Completed
  });

  // LC14: lastSettlementBlock is set on creation
  it("LC14: lastSettlementBlock set on budget initialization", async function () {
    const cid = await createAndActivate();
    const lastBlock = await ledger.lastSettlementBlock(cid);
    expect(lastBlock).to.be.gt(0n);
  });
});
