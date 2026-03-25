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
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, mineBlocks } from "./helpers/mine";

// Global pause tests: P1-P8
// Verifies DatumPauseRegistry circuit breaker across Campaigns, Settlement, and Relay.
// Governance contracts no longer check pause (defense-in-depth: paused at Campaigns level).

describe("Global Pause (DatumPauseRegistry)", function () {
  let pauseReg: DatumPauseRegistry;
  let publishers: DatumPublishers;
  let campaigns: DatumCampaigns;
  let settlement: DatumSettlement;
  let relay: DatumRelay;
  let v2: DatumGovernanceV2;
  let slash: DatumGovernanceSlash;

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
  const BASE_LOCKUP = 10n;
  const MAX_LOCKUP = 100n;

  before(async function () {
    await fundSigners();
    [owner, advertiser, publisher, user, voter, other] = await ethers.getSigners();

    // Deploy pause registry
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy();

    // Deploy publishers (has its own OZ Pausable — unrelated to global pause)
    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n);

    // Deploy campaigns
    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(0n, 100n, await publishers.getAddress(), await pauseReg.getAddress());

    // Deploy GovernanceV2 (no pauseRegistry)
    const V2Factory = await ethers.getContractFactory("DatumGovernanceV2");
    v2 = await V2Factory.deploy(
      await campaigns.getAddress(),
      QUORUM_WEIGHTED,
      SLASH_BPS,
      BASE_LOCKUP,
      MAX_LOCKUP,
      QUORUM_WEIGHTED,  // terminationQuorum = same as activation quorum
      20n               // terminationGraceBlocks = 20 blocks
    );

    // Deploy GovernanceSlash
    const SlashFactory = await ethers.getContractFactory("DatumGovernanceSlash");
    slash = await SlashFactory.deploy(
      await v2.getAddress(),
      await campaigns.getAddress()
    );

    // Wire: v2 <-> slash
    await v2.setSlashContract(await slash.getAddress());

    // Deploy settlement
    const SettleFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettleFactory.deploy(await campaigns.getAddress(), await pauseReg.getAddress());

    // Deploy relay
    const RelayFactory = await ethers.getContractFactory("DatumRelay");
    relay = await RelayFactory.deploy(
      await settlement.getAddress(),
      await campaigns.getAddress(),
      await pauseReg.getAddress()
    );

    // Wire directly (no timelock in test)
    await campaigns.setGovernanceContract(await v2.getAddress());
    await campaigns.setSettlementContract(await settlement.getAddress());
    await settlement.setRelayContract(await relay.getAddress());

    // Register publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  afterEach(async function () {
    // Ensure unpaused after each test
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
        publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
      )
    ).to.be.revertedWith("P");
  });

  // P3: createCampaign works when unpaused
  it("P3: createCampaign works when unpaused", async function () {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.be.gt(0n);
  });

  // P4: activateCampaign reverts when paused (pause check is on campaigns.activateCampaign)
  it("P4: activateCampaign reverts when paused", async function () {
    // Create while unpaused
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    const cid = await campaigns.nextCampaignId() - 1n;

    // Vote aye while unpaused
    await v2.connect(voter).vote(cid, true, 0, { value: QUORUM_WEIGHTED });

    // Pause, then try to evaluate — evaluateCampaign calls campaigns.activateCampaign which checks pause
    await pauseReg.pause();

    await expect(
      v2.evaluateCampaign(cid)
    ).to.be.revertedWith("P");
  });

  // P5: terminateCampaign reverts when paused (pause check is on campaigns.terminateCampaign)
  it("P5: terminateCampaign reverts when paused via evaluateCampaign", async function () {
    // Create and activate
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    const cid = await campaigns.nextCampaignId() - 1n;
    await v2.connect(voter).vote(cid, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(cid);

    // Vote nay with majority while unpaused
    await v2.connect(other).vote(cid, false, 0, { value: QUORUM_WEIGHTED * 2n });

    // Mine past termination grace period so E52/E53 pass and the revert hits pause check
    await mineBlocks(20);

    // Pause
    await pauseReg.pause();

    // evaluateCampaign calls campaigns.terminateCampaign which checks pause
    await expect(
      v2.evaluateCampaign(cid)
    ).to.be.revertedWith("P");
  });

  // P6: settleClaims reverts when paused
  it("P6: settleClaims reverts when paused", async function () {
    await pauseReg.pause();

    // Even with an empty batch array, the pause check fires first
    await expect(
      settlement.connect(user).settleClaims([])
    ).to.be.revertedWith("P");
  });

  // P7: Withdrawals still work when paused (critical: user funds must remain accessible)
  it("P7: withdrawals work when paused", async function () {
    // First create a campaign and settle a claim while unpaused
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    const cid = await campaigns.nextCampaignId() - 1n;
    await v2.connect(voter).vote(cid, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(cid);

    // Build and settle one claim
    const impressions = 1000n;
    const nonce = 1n;
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [cid, publisher.address, user.address, impressions, BID_CPM, nonce, ethers.ZeroHash]
    );
    const claims = [{
      campaignId: cid,
      publisher: publisher.address,
      impressionCount: impressions,
      clearingCpmPlanck: BID_CPM,
      nonce,
      previousClaimHash: ethers.ZeroHash,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch = { user: user.address, campaignId: cid, claims };
    await settlement.connect(user).settleClaims([batch]);

    // Now pause
    await pauseReg.pause();

    // Withdrawals should still work
    const pubBal = await settlement.publisherBalance(publisher.address);
    if (pubBal > 0n) {
      await settlement.connect(publisher).withdrawPublisher();
      expect(await settlement.publisherBalance(publisher.address)).to.equal(0n);
    }

    const userBal = await settlement.userBalance(user.address);
    if (userBal > 0n) {
      await settlement.connect(user).withdrawUser();
      expect(await settlement.userBalance(user.address)).to.equal(0n);
    }
  });

  // P8: View functions work when paused
  it("P8: view functions work when paused", async function () {
    await pauseReg.pause();

    // These should not revert
    await campaigns.getCampaignStatus(1n);
    await campaigns.getCampaignForSettlement(1n);
    expect(await pauseReg.paused()).to.be.true;
  });

  // T-5 PauseRegistry idempotency
  it("T5-1: pause() when already paused is idempotent", async function () {
    await pauseReg.pause();
    expect(await pauseReg.paused()).to.be.true;

    // Calling pause again should not revert
    await pauseReg.pause();
    expect(await pauseReg.paused()).to.be.true;
  });

  it("T5-2: unpause() when already unpaused is idempotent", async function () {
    // afterEach ensures unpaused, so it should be unpaused here
    expect(await pauseReg.paused()).to.be.false;

    // Calling unpause again should not revert
    await pauseReg.unpause();
    expect(await pauseReg.paused()).to.be.false;
  });
});
