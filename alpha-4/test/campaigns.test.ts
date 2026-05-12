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

// Campaign tests for alpha-2:
// L1-L8: campaign creation, metadata, pause/resume, views
//
// Alpha-2 changes:
// - Budget held by BudgetLedger (createCampaign forwards value)
// - getCampaignForSettlement returns 4 values (no remainingBudget)
// - setCampaignStatus/setTerminationBlock gated to lifecycleContract
// - completeCampaign/terminateCampaign/expirePendingCampaign moved to Lifecycle
// - Open campaigns (publisher=address(0)) + category support

describe("DatumCampaigns", function () {
  let campaigns: DatumCampaigns;
  let publishers: DatumPublishers;
  let pauseReg: DatumPauseRegistry;
  let ledger: DatumBudgetLedger;

  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let lifecycleMock: HardhatEthersSigner;

  const PENDING_TIMEOUT = 50n;
  const MIN_CPM = 0n;
  const BUDGET = parseDOT("2");
  const DAILY_CAP = parseDOT("1");
  const BID_CPM = parseDOT("0.01");
  const TAKE_RATE_BPS = 5000;

  before(async function () {
    await fundSigners();
    [owner, advertiser, publisher, other, lifecycleMock] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, advertiser.address, publisher.address);

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n, await pauseReg.getAddress());

    // Deploy BudgetLedger first
    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    // Deploy Campaigns
    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(
      MIN_CPM,
      PENDING_TIMEOUT,
      await publishers.getAddress(),
      await pauseReg.getAddress()
    );

    // Wire BudgetLedger
    await ledger.setCampaigns(await campaigns.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());

    // Wire lifecycle (use a signer as mock)
    await campaigns.setLifecycleContract(lifecycleMock.address);

    // Register publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  // L1: Create campaign with registered publisher
  it("L1: createCampaign with registered publisher succeeds", async function () {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n,
      { value: BUDGET }
    );
    await tx.wait();

    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.equal(1n);
    expect(await campaigns.getCampaignStatus(id)).to.equal(0); // Pending
    expect(await campaigns.getCampaignAdvertiser(id)).to.equal(advertiser.address);

    // Budget should be in ledger
    expect(await ledger.getRemainingBudget(id, 0)).to.equal(BUDGET);
    expect(await ledger.getDailyCap(id, 0)).to.equal(DAILY_CAP);
  });

  // L2: Create open campaign (publisher = address(0))
  it("L2: createCampaign with publisher=address(0) uses DEFAULT_TAKE_RATE_BPS", async function () {
    const tx = await campaigns.connect(advertiser).createCampaign(
      ethers.ZeroAddress,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n,
      { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;

    const [status, pub, takeRate] = await campaigns.getCampaignForSettlement(id);
    expect(status).to.equal(0); // Pending
    expect(pub).to.equal(ethers.ZeroAddress);
    expect(takeRate).to.equal(5000); // DEFAULT_TAKE_RATE_BPS
  });

  // L3: Create campaign with unregistered publisher reverts (SE-3: validator returns E62)
  it("L3: createCampaign with unregistered publisher reverts E62", async function () {
    await expect(
      campaigns.connect(advertiser).createCampaign(
        other.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        [], false, ethers.ZeroAddress, 0n, 0n,
        { value: BUDGET }
      )
    ).to.be.revertedWith("E62");
  });

  // L4: Create campaign with zero value reverts
  it("L4: createCampaign with zero value reverts E11", async function () {
    await expect(
      campaigns.connect(advertiser).createCampaign(
        publisher.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        [], false, ethers.ZeroAddress, 0n, 0n,
        { value: 0 }
      )
    ).to.be.revertedWith("E11");
  });

  // L5: Metadata
  it("L5: setMetadata emits event and only advertiser can call", async function () {
    const id = (await campaigns.nextCampaignId()) - 1n;
    const hash = ethers.keccak256(ethers.toUtf8Bytes("test-metadata"));

    await expect(
      campaigns.connect(advertiser).setMetadata(id, hash)
    ).to.emit(campaigns, "CampaignMetadataSet").withArgs(id, hash, 1n);

    await expect(
      campaigns.connect(other).setMetadata(id, hash)
    ).to.be.revertedWith("E21");
  });

  // L6: Pause/resume (advertiser only)
  it("L6: advertiser can pause and resume Active campaign", async function () {
    // Create and activate a campaign
    await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    const id = await campaigns.nextCampaignId() - 1n;

    // Wire governance to owner for activation
    await campaigns.setGovernanceContract(owner.address);

    // Activate via governance
    await campaigns.connect(owner).activateCampaign(id);
    expect(await campaigns.getCampaignStatus(id)).to.equal(1); // Active

    // Pause
    await campaigns.connect(advertiser).togglePause(id, true);
    expect(await campaigns.getCampaignStatus(id)).to.equal(2); // Paused

    // Resume
    await campaigns.connect(advertiser).togglePause(id, false);
    expect(await campaigns.getCampaignStatus(id)).to.equal(1); // Active
  });

  // L7: getCampaignForSettlement returns 3 values
  it("L7: getCampaignForSettlement returns 3 values", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    const id = await campaigns.nextCampaignId() - 1n;

    const [status, pub, takeRate] = await campaigns.getCampaignForSettlement(id);
    expect(status).to.equal(0);
    expect(pub).to.equal(publisher.address);
    expect(takeRate).to.equal(TAKE_RATE_BPS);
  });

  // L8: ZK proof requirement stored per-campaign
  it("L8: createCampaign with requireZkProof=true stores flag", async function () {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], true, ethers.ZeroAddress, 0n, 0n,
      { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(await campaigns.getCampaignStatus(id)).to.equal(0);
    expect(await campaigns.getCampaignRequiresZkProof(id)).to.equal(true);
  });

  // -------------------------------------------------------------------------
  // Lifecycle gating
  // -------------------------------------------------------------------------

  it("setCampaignStatus only callable by lifecycleContract", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    const id = await campaigns.nextCampaignId() - 1n;

    await expect(
      campaigns.connect(other).setCampaignStatus(id, 3) // Completed
    ).to.be.revertedWith("E25");

    // Activate first (governance), then complete via lifecycle (SM-7 valid transition)
    await campaigns.setGovernanceContract(owner.address);
    await campaigns.connect(owner).activateCampaign(id);
    await campaigns.connect(lifecycleMock).setCampaignStatus(id, 3); // Active→Completed
    expect(await campaigns.getCampaignStatus(id)).to.equal(3);
  });

  it("SM-7: setCampaignStatus rejects invalid transition (E67)", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    const id = await campaigns.nextCampaignId() - 1n;

    // Pending → Completed is invalid
    await expect(
      campaigns.connect(lifecycleMock).setCampaignStatus(id, 3)
    ).to.be.revertedWith("E67");

    // Pending → Expired is valid
    await campaigns.connect(lifecycleMock).setCampaignStatus(id, 5);
    expect(await campaigns.getCampaignStatus(id)).to.equal(5);
  });

  it("setTerminationBlock only callable by lifecycleContract", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    const id = await campaigns.nextCampaignId() - 1n;

    await expect(
      campaigns.connect(other).setTerminationBlock(id, 12345)
    ).to.be.revertedWith("E25");

    await campaigns.connect(lifecycleMock).setTerminationBlock(id, 12345);
  });

  // -------------------------------------------------------------------------
  // Admin setters
  // -------------------------------------------------------------------------

  it("admin setters require owner and non-zero address", async function () {
    await expect(
      campaigns.connect(other).setSettlementContract(owner.address)
    ).to.be.revertedWith("E18");

    await expect(
      campaigns.setSettlementContract(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");

    await campaigns.setSettlementContract(owner.address);
    expect(await campaigns.settlementContract()).to.equal(owner.address);
  });

  it("ContractReferenceChanged event emitted on setter", async function () {
    await expect(
      campaigns.setGovernanceContract(other.address)
    ).to.emit(campaigns, "ContractReferenceChanged");
  });

  it("transferOwnership requires non-zero and owner", async function () {
    await expect(
      campaigns.connect(other).transferOwnership(other.address)
    ).to.be.revertedWith("E18");

    await expect(
      campaigns.transferOwnership(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");
  });

  describe("defaultTakeRateBps governance", function () {
    it("default is 5000 bps (50%)", async function () {
      expect(await campaigns.defaultTakeRateBps()).to.equal(5000n);
    });

    it("setDefaultTakeRateBps — owner updates within bounds", async function () {
      await expect(campaigns.setDefaultTakeRateBps(6500))
        .to.emit(campaigns, "DefaultTakeRateUpdated").withArgs(5000, 6500);
      expect(await campaigns.defaultTakeRateBps()).to.equal(6500n);
    });

    it("setDefaultTakeRateBps — at min (3000) and max (8000) bounds", async function () {
      await campaigns.setDefaultTakeRateBps(3000);
      expect(await campaigns.defaultTakeRateBps()).to.equal(3000n);
      await campaigns.setDefaultTakeRateBps(8000);
      expect(await campaigns.defaultTakeRateBps()).to.equal(8000n);
    });

    it("setDefaultTakeRateBps — below min reverts E11", async function () {
      await expect(campaigns.setDefaultTakeRateBps(2999)).to.be.revertedWith("E11");
    });

    it("setDefaultTakeRateBps — above max reverts E11", async function () {
      await expect(campaigns.setDefaultTakeRateBps(8001)).to.be.revertedWith("E11");
    });

    it("setDefaultTakeRateBps — non-owner reverts E18", async function () {
      await expect(
        campaigns.connect(other).setDefaultTakeRateBps(5000)
      ).to.be.revertedWith("E18");
    });

    it("MIN/MAX constants match the publisher take rate range", async function () {
      expect(await campaigns.MIN_DEFAULT_TAKE_RATE_BPS()).to.equal(3000n);
      expect(await campaigns.MAX_DEFAULT_TAKE_RATE_BPS()).to.equal(8000n);
    });
  });
});
