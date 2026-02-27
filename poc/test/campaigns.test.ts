import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumCampaigns, DatumPublishers } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { mineBlocks, advanceTime, isSubstrate, fundSigners } from "./helpers/mine";

// Campaign lifecycle tests: L1-L8
// Plus: take rate snapshot test, pending expiry test
//
// On substrate, contract deployments are very slow (>5 min for large PVM bytecodes).
// Contracts are deployed once in `before` and shared across tests.
// Each test creates its own campaign(s) via createCampaign to avoid state conflicts.

describe("DatumCampaigns", function () {
  let campaigns: DatumCampaigns;
  let publishers: DatumPublishers;
  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let governance: HardhatEthersSigner;
  let settlement: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  // Config values — all amounts in planck (1 DOT = 10^10 planck)
  const MIN_CPM = parseDOT("0.001");   // 0.001 DOT per 1000 impressions
  // On substrate, use small block counts (real blocks, ~3s each)
  let PENDING_TIMEOUT: bigint;
  let TAKE_RATE_DELAY: bigint;
  const TAKE_RATE_BPS = 5000;           // 50%
  const BUDGET = parseDOT("1");         // 1 DOT
  const DAILY_CAP = parseDOT("0.1");    // 0.1 DOT
  const BID_CPM = parseDOT("0.01");     // 0.01 DOT per 1000 impressions

  before(async function () {
    await fundSigners();
    const substrate = await isSubstrate();
    PENDING_TIMEOUT = substrate ? 3n : 100n;
    TAKE_RATE_DELAY = substrate ? 3n : 50n;

    [owner, advertiser, publisher, governance, settlement, other] = await ethers.getSigners();

    // Deploy publishers
    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(TAKE_RATE_DELAY);

    // Deploy campaigns with publishers reference
    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(MIN_CPM, PENDING_TIMEOUT, await publishers.getAddress());

    await campaigns.setGovernanceContract(governance.address);
    await campaigns.setSettlementContract(settlement.address);

    // Register publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  // Helper: create a campaign and return its ID
  async function createTestCampaign(budget = BUDGET, dailyCap = DAILY_CAP, bidCpm = BID_CPM) {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address, dailyCap, bidCpm, { value: budget }
    );
    const receipt = await tx.wait();
    // nextCampaignId was incremented, so the new ID is current - 1
    const id = await campaigns.nextCampaignId() - 1n;
    return { id, receipt };
  }

  // L1: Campaign creation stores correct fields
  it("L1: createCampaign stores correct initial state", async function () {
    const { id, receipt } = await createTestCampaign();

    const c = await campaigns.getCampaign(id);
    expect(c.id).to.equal(id);
    expect(c.advertiser).to.equal(advertiser.address);
    expect(c.publisher).to.equal(publisher.address);
    expect(c.budgetPlanck).to.equal(BUDGET);
    expect(c.remainingBudget).to.equal(BUDGET);
    expect(c.dailyCapPlanck).to.equal(DAILY_CAP);
    expect(c.bidCpmPlanck).to.equal(BID_CPM);
    expect(c.snapshotTakeRateBps).to.equal(TAKE_RATE_BPS);
    expect(c.status).to.equal(0); // Pending
    expect(c.version).to.equal(1);
    expect(c.terminationBlock).to.equal(0n);
    expect(c.pendingExpiryBlock).to.equal(BigInt(receipt!.blockNumber) + PENDING_TIMEOUT);
  });

  // L2: Pending → Active requires governance
  it("L2: activateCampaign only callable by governance", async function () {
    const { id } = await createTestCampaign();

    await expect(
      campaigns.connect(other).activateCampaign(id)
    ).to.be.revertedWith("E19");

    await campaigns.connect(governance).activateCampaign(id);
    expect((await campaigns.getCampaign(id)).status).to.equal(1); // Active
  });

  // L3: Active → Paused → Active cycle (advertiser only)
  it("L3: pause/resume cycle works for advertiser", async function () {
    const { id } = await createTestCampaign();
    await campaigns.connect(governance).activateCampaign(id);

    await campaigns.connect(advertiser).pauseCampaign(id);
    expect((await campaigns.getCampaign(id)).status).to.equal(2); // Paused

    await expect(
      campaigns.connect(other).resumeCampaign(id)
    ).to.be.revertedWith("E21");

    await campaigns.connect(advertiser).resumeCampaign(id);
    expect((await campaigns.getCampaign(id)).status).to.equal(1); // Active
  });

  // L4: Invalid state transitions revert
  it("L4: invalid transitions revert", async function () {
    const { id } = await createTestCampaign();

    // Cannot pause a Pending campaign
    await expect(
      campaigns.connect(advertiser).pauseCampaign(id)
    ).to.be.revertedWith("E22");

    // Cannot activate twice
    await campaigns.connect(governance).activateCampaign(id);
    await expect(
      campaigns.connect(governance).activateCampaign(id)
    ).to.be.revertedWith("E20");

    // Cannot pause twice
    await campaigns.connect(advertiser).pauseCampaign(id);
    await expect(
      campaigns.connect(advertiser).pauseCampaign(id)
    ).to.be.revertedWith("E22");
  });

  // L5: terminateCampaign records terminationBlock and transfers escrow to governance
  it("L5: terminateCampaign records terminationBlock and slashes escrow", async function () {
    const { id } = await createTestCampaign();
    await campaigns.connect(governance).activateCampaign(id);

    const balBefore = await ethers.provider.getBalance(governance.address);
    const tx = await campaigns.connect(governance).terminateCampaign(id);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(governance.address);

    const c = await campaigns.getCampaign(id);
    expect(c.status).to.equal(4); // Terminated
    expect(c.terminationBlock).to.equal(BigInt(receipt!.blockNumber));
    expect(c.remainingBudget).to.equal(0n);

    // On substrate, receipt.gasUsed returns weight (not EVM gas), so
    // gasUsed * gasPrice ≈ 10^18 planck — dwarfing the actual cost. Skip native balance check.
    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(BUDGET);
    }
  });

  // L6: expirePendingCampaign works after timeout; returns budget to advertiser
  it("L6: expirePendingCampaign works after pendingExpiryBlock", async function () {
    const { id } = await createTestCampaign();

    // Too early
    await expect(
      campaigns.connect(other).expirePendingCampaign(id)
    ).to.be.revertedWith("E24");

    // Mine past the timeout
    await mineBlocks(PENDING_TIMEOUT + 1n);

    const balBefore = await ethers.provider.getBalance(advertiser.address);
    await campaigns.connect(other).expirePendingCampaign(id);
    const balAfter = await ethers.provider.getBalance(advertiser.address);

    expect((await campaigns.getCampaign(id)).status).to.equal(5); // Expired
    expect(balAfter - balBefore).to.equal(BUDGET);
  });

  // L7: deductBudget enforces daily cap and only callable by settlement
  it("L7: deductBudget enforces daily cap and resets on new day", async function () {
    // On substrate, advanceTime(86400) only mines 1 real block — block.timestamp / 86400
    // doesn't change, so daily cap never resets. Skip this test on substrate.
    if (await isSubstrate()) this.skip();

    const { id } = await createTestCampaign();
    await campaigns.connect(governance).activateCampaign(id);

    // Only settlement can call
    await expect(
      campaigns.connect(other).deductBudget(id, parseDOT("0.01"))
    ).to.be.revertedWith("E25");

    // Deduct up to daily cap
    await campaigns.connect(settlement).deductBudget(id, DAILY_CAP);

    // Exceeds daily cap
    await expect(
      campaigns.connect(settlement).deductBudget(id, 1n)
    ).to.be.revertedWith("E26");

    // Advance time by 1 day
    await advanceTime(86400);

    // Daily cap resets
    await campaigns.connect(settlement).deductBudget(id, DAILY_CAP);
    const c = await campaigns.getCampaign(id);
    expect(c.dailySpent).to.equal(DAILY_CAP);
  });

  // L8: Budget exhaustion auto-completes the campaign
  it("L8: exhausting budget auto-completes campaign", async function () {
    const smallBudget = parseDOT("0.05"); // 0.05 DOT
    const { id } = await createTestCampaign(smallBudget, smallBudget);
    await campaigns.connect(governance).activateCampaign(id);

    await campaigns.connect(settlement).deductBudget(id, smallBudget);
    const c = await campaigns.getCampaign(id);
    expect(c.status).to.equal(3); // Completed
    expect(c.remainingBudget).to.equal(0n);
  });

  // Take rate snapshot: publisher updates rate after campaign creation; settlement uses snapshot
  it("Snapshot: settlement uses snapshotTakeRateBps, not updated rate", async function () {
    // Campaign created at 50%
    const { id: id1 } = await createTestCampaign();
    const c1 = await campaigns.getCampaign(id1);
    expect(c1.snapshotTakeRateBps).to.equal(5000);

    // Publisher queues update to 80%
    await publishers.connect(publisher).updateTakeRate(8000);

    // Mine past delay
    await mineBlocks(TAKE_RATE_DELAY + 1n);
    await publishers.connect(publisher).applyTakeRateUpdate();

    // New campaign created after update uses 80%
    const { id: id2 } = await createTestCampaign();
    const c2 = await campaigns.getCampaign(id2);
    expect(c2.snapshotTakeRateBps).to.equal(8000);

    // First campaign still has 50% snapshot
    const c1after = await campaigns.getCampaign(id1);
    expect(c1after.snapshotTakeRateBps).to.equal(5000);
  });

  // Publisher registration and rate range validation
  it("Publisher: rejects take rates out of range", async function () {
    await expect(
      publishers.connect(other).registerPublisher(2999)
    ).to.be.revertedWith("Take rate out of range");

    await expect(
      publishers.connect(other).registerPublisher(8001)
    ).to.be.revertedWith("Take rate out of range");

    await publishers.connect(other).registerPublisher(3000);
    expect((await publishers.getPublisher(other.address)).registered).to.be.true;
  });

  // C3: Publishers pause circuit breaker (DatumCampaigns has no Pausable; publishers does)
  it("C3: publishers pause blocks registerPublisher; unpause restores", async function () {
    await publishers.connect(owner).pause();
    await expect(
      publishers.connect(other).registerPublisher(5000)
    ).to.be.revertedWithCustomError(publishers, "EnforcedPause");

    await publishers.connect(owner).unpause();
    // Note: 'other' may already be registered from the previous test (shared state)
    // Use a fresh address check instead
    const otherPub = await publishers.getPublisher(other.address);
    if (!otherPub.registered) {
      await publishers.connect(other).registerPublisher(5000);
    }
    expect((await publishers.getPublisher(other.address)).registered).to.be.true;
  });

  it("C3: only owner can pause/unpause publishers", async function () {
    await expect(
      publishers.connect(other).pause()
    ).to.be.revertedWithCustomError(publishers, "OwnableUnauthorizedAccount");
  });

  // createCampaign with bid below floor reverts
  it("createCampaign: reverts if bid below minimumCpmFloor", async function () {
    await campaigns.setMinimumCpmFloor(parseDOT("0.1"));
    await expect(
      campaigns.connect(advertiser).createCampaign(
        publisher.address, DAILY_CAP, parseDOT("0.01"), { value: BUDGET }
      )
    ).to.be.revertedWith("E27");
    // Reset floor for subsequent tests
    await campaigns.setMinimumCpmFloor(MIN_CPM);
  });
});
