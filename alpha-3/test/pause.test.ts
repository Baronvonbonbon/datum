import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumPauseRegistry,
  DatumCampaigns,
  DatumPublishers,
  DatumSettlement,
  DatumRelay,
  DatumGovernanceV2,
  DatumGovernanceSlash,
  DatumBudgetLedger,
  DatumPaymentVault,
  DatumClaimValidator,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, mineBlocks } from "./helpers/mine";

// Global pause tests for alpha-2: P1-P8
// Verifies DatumPauseRegistry circuit breaker across Campaigns, Settlement, Relay, and Lifecycle.

describe("Global Pause (DatumPauseRegistry)", function () {
  let pauseReg: DatumPauseRegistry;
  let publishers: DatumPublishers;
  let campaigns: DatumCampaigns;
  let settlement: DatumSettlement;
  let relay: DatumRelay;
  let v2: DatumGovernanceV2;
  let slash: DatumGovernanceSlash;
  let ledger: DatumBudgetLedger;
  let vault: DatumPaymentVault;

  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let voter: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const BUDGET = parseDOT("2");
  const DAILY_CAP = parseDOT("1");
  const BID_CPM = parseDOT("0.01");
  const TAKE_RATE_BPS = 5000;
  const QUORUM_WEIGHTED = parseDOT("1");
  const SLASH_BPS = 1000n;

  before(async function () {
    await fundSigners();
    [owner, advertiser, publisher, user, voter, other] = await ethers.getSigners();

    // Deploy all infrastructure
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy();

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n, await pauseReg.getAddress());

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    const VaultFactory = await ethers.getContractFactory("DatumPaymentVault");
    vault = await VaultFactory.deploy();

    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    const CampValFactory = await ethers.getContractFactory("DatumCampaignValidator");
    const campaignValidator = await CampValFactory.deploy(await publishers.getAddress(), ethers.ZeroAddress);
    campaigns = await CampaignsFactory.deploy(0n, 100n, await campaignValidator.getAddress(), await pauseReg.getAddress());

    const V2Factory = await ethers.getContractFactory("DatumGovernanceV2");
    v2 = await V2Factory.deploy(
      await campaigns.getAddress(),
      QUORUM_WEIGHTED,
      SLASH_BPS,
      QUORUM_WEIGHTED,
      10n, 20n, 50n,
      await pauseReg.getAddress()
    );

    const SlashFactory = await ethers.getContractFactory("DatumGovernanceSlash");
    slash = await SlashFactory.deploy(await v2.getAddress(), await campaigns.getAddress());

    await v2.setSlashContract(await slash.getAddress());

    const ValidatorFactory = await ethers.getContractFactory("DatumClaimValidator");
    const claimValidator = await ValidatorFactory.deploy(
      await campaigns.getAddress(),
      await publishers.getAddress(),
      await pauseReg.getAddress()
    );

    const SettleFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettleFactory.deploy(await pauseReg.getAddress());

    const RelayFactory = await ethers.getContractFactory("DatumRelay");
    relay = await RelayFactory.deploy(
      await settlement.getAddress(),
      await campaigns.getAddress(),
      await pauseReg.getAddress()
    );

    // Wire everything
    await campaigns.setGovernanceContract(await v2.getAddress());
    await campaigns.setSettlementContract(await settlement.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());
    await campaigns.setLifecycleContract(owner.address); // placeholder

    await ledger.setCampaigns(await campaigns.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(owner.address); // placeholder

    await vault.setSettlement(await settlement.getAddress());

    await settlement.setClaimValidator(await claimValidator.getAddress());
    await settlement.configure(
      await ledger.getAddress(),
      await vault.getAddress(),
      owner.address, // lifecycle placeholder
      await relay.getAddress()
    );

    // Register publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  afterEach(async function () {
    if (await pauseReg.paused()) {
      await pauseReg.unpause();
    }
  });

  // P1: Only owner can pause/unpause
  it("P1: only owner can pause/unpause registry", async function () {
    await expect(pauseReg.connect(other).pause()).to.be.revertedWith("E18");
    await expect(pauseReg.connect(other).unpause()).to.be.revertedWith("E18");

    await pauseReg.pause();
    expect(await pauseReg.paused()).to.be.true;

    await pauseReg.unpause();
    expect(await pauseReg.paused()).to.be.false;
  });

  // P2: createCampaign reverts when paused
  it("P2: createCampaign reverts when paused", async function () {
    await pauseReg.pause();

    await expect(
      campaigns.connect(advertiser).createCampaign(
        publisher.address, DAILY_CAP, BID_CPM, 0, [], { value: BUDGET }
      )
    ).to.be.revertedWith("P");
  });

  // P3: createCampaign works when unpaused
  it("P3: createCampaign works when unpaused", async function () {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, [], { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.be.gt(0n);
  });

  // P4: activateCampaign reverts when paused
  it("P4: activateCampaign reverts when paused", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, [], { value: BUDGET }
    );
    const cid = await campaigns.nextCampaignId() - 1n;

    await v2.connect(voter).vote(cid, true, 0, { value: QUORUM_WEIGHTED });

    await pauseReg.pause();

    await expect(v2.evaluateCampaign(cid)).to.be.revertedWith("P");
  });

  // P6: settleClaims reverts when paused
  it("P6: settleClaims reverts when paused", async function () {
    await pauseReg.pause();

    await expect(
      settlement.connect(user).settleClaims([])
    ).to.be.revertedWith("P");
  });

  // P8: View functions work when paused
  it("P8: view functions work when paused", async function () {
    await pauseReg.pause();

    await campaigns.getCampaignStatus(1n);
    await campaigns.getCampaignForSettlement(1n);
    expect(await pauseReg.paused()).to.be.true;
  });

  // P9: Publishers respects global pause (S5 fix)
  it("P9: registerPublisher reverts when globally paused", async function () {
    await pauseReg.pause();

    await expect(
      publishers.connect(other).registerPublisher(5000)
    ).to.be.revertedWith("P");
  });

  it("P10: setCategories reverts when globally paused", async function () {
    // Register first while unpaused
    await publishers.connect(other).registerPublisher(5000);

    await pauseReg.pause();

    await expect(
      publishers.connect(other).setCategories(1n)
    ).to.be.revertedWith("P");
  });

  // T5: PauseRegistry idempotency
  it("T5-1: pause() when already paused is idempotent", async function () {
    await pauseReg.pause();
    expect(await pauseReg.paused()).to.be.true;

    await pauseReg.pause();
    expect(await pauseReg.paused()).to.be.true;
  });

  it("T5-2: unpause() when already unpaused is idempotent", async function () {
    expect(await pauseReg.paused()).to.be.false;

    await pauseReg.unpause();
    expect(await pauseReg.paused()).to.be.false;
  });
});
