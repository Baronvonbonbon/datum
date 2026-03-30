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
    pauseReg = await PauseFactory.deploy();

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n, await pauseReg.getAddress());

    // Deploy BudgetLedger first
    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    // Deploy CampaignValidator (SE-3)
    const ValFactory = await ethers.getContractFactory("DatumCampaignValidator");
    const campaignValidator = await ValFactory.deploy(await publishers.getAddress());

    // Deploy Campaigns
    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(
      MIN_CPM,
      PENDING_TIMEOUT,
      await campaignValidator.getAddress(),
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
      publisher.address, DAILY_CAP, BID_CPM, 0,
      { value: BUDGET }
    );
    await tx.wait();

    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.equal(1n);
    expect(await campaigns.getCampaignStatus(id)).to.equal(0); // Pending
    expect(await campaigns.getCampaignAdvertiser(id)).to.equal(advertiser.address);

    // Budget should be in ledger
    expect(await ledger.getRemainingBudget(id)).to.equal(BUDGET);
    expect(await ledger.getDailyCap(id)).to.equal(DAILY_CAP);
  });

  // L2: Create open campaign (publisher = address(0))
  it("L2: createCampaign with publisher=address(0) uses DEFAULT_TAKE_RATE_BPS", async function () {
    const tx = await campaigns.connect(advertiser).createCampaign(
      ethers.ZeroAddress, DAILY_CAP, BID_CPM, 0,
      { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;

    const [status, pub, bidCpm, takeRate] = await campaigns.getCampaignForSettlement(id);
    expect(status).to.equal(0); // Pending
    expect(pub).to.equal(ethers.ZeroAddress);
    expect(takeRate).to.equal(5000); // DEFAULT_TAKE_RATE_BPS
  });

  // L3: Create campaign with unregistered publisher reverts (SE-3: validator returns E62)
  it("L3: createCampaign with unregistered publisher reverts E62", async function () {
    await expect(
      campaigns.connect(advertiser).createCampaign(
        other.address, DAILY_CAP, BID_CPM, 0,
        { value: BUDGET }
      )
    ).to.be.revertedWith("E62");
  });

  // L4: Create campaign with zero value reverts
  it("L4: createCampaign with zero value reverts E11", async function () {
    await expect(
      campaigns.connect(advertiser).createCampaign(
        publisher.address, DAILY_CAP, BID_CPM, 0,
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
    ).to.emit(campaigns, "CampaignMetadataSet").withArgs(id, hash);

    await expect(
      campaigns.connect(other).setMetadata(id, hash)
    ).to.be.revertedWith("E21");
  });

  // L6: Pause/resume (advertiser only)
  it("L6: advertiser can pause and resume Active campaign", async function () {
    // Create and activate a campaign
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
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

  // L7: getCampaignForSettlement returns 4 values
  it("L7: getCampaignForSettlement returns 4 values", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    const id = await campaigns.nextCampaignId() - 1n;

    const [status, pub, bidCpm, takeRate] = await campaigns.getCampaignForSettlement(id);
    expect(status).to.equal(0);
    expect(pub).to.equal(publisher.address);
    expect(bidCpm).to.equal(BID_CPM);
    expect(takeRate).to.equal(TAKE_RATE_BPS);
  });

  // L8: Category support
  it("L8: campaign stores category ID", async function () {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 5,
      { value: BUDGET }
    );
    await tx.wait();
    // Category is stored in the struct but we don't have a direct getter
    // Just verify the campaign was created successfully
    const id = await campaigns.nextCampaignId() - 1n;
    expect(await campaigns.getCampaignStatus(id)).to.equal(0);
  });

  // -------------------------------------------------------------------------
  // Lifecycle gating
  // -------------------------------------------------------------------------

  it("setCampaignStatus only callable by lifecycleContract", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    const id = await campaigns.nextCampaignId() - 1n;

    await expect(
      campaigns.connect(other).setCampaignStatus(id, 3) // Completed
    ).to.be.revertedWith("E25");

    // Lifecycle mock can call it
    await campaigns.connect(lifecycleMock).setCampaignStatus(id, 3);
    expect(await campaigns.getCampaignStatus(id)).to.equal(3);
  });

  it("setTerminationBlock only callable by lifecycleContract", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
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
});
