import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumCampaigns, DatumPublishers } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";

// Campaign lifecycle tests: L1-L8
// Plus: take rate snapshot test, pending expiry test

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
  const PENDING_TIMEOUT = 100n;         // 100 blocks
  const TAKE_RATE_DELAY = 50n;          // 50 blocks
  const TAKE_RATE_BPS = 5000;           // 50%
  const BUDGET = parseDOT("1");         // 1 DOT
  const DAILY_CAP = parseDOT("0.1");    // 0.1 DOT
  const BID_CPM = parseDOT("0.01");     // 0.01 DOT per 1000 impressions

  beforeEach(async function () {
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

  // L1: Campaign creation stores correct fields
  it("L1: createCampaign stores correct initial state", async function () {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    const receipt = await tx.wait();

    const c = await campaigns.getCampaign(1n);
    expect(c.id).to.equal(1n);
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
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    await expect(
      campaigns.connect(other).activateCampaign(1n)
    ).to.be.revertedWith("Governance only");

    await campaigns.connect(governance).activateCampaign(1n);
    expect((await campaigns.getCampaign(1n)).status).to.equal(1); // Active
  });

  // L3: Active → Paused → Active cycle (advertiser only)
  it("L3: pause/resume cycle works for advertiser", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    await campaigns.connect(governance).activateCampaign(1n);

    await campaigns.connect(advertiser).pauseCampaign(1n);
    expect((await campaigns.getCampaign(1n)).status).to.equal(2); // Paused

    await expect(
      campaigns.connect(other).resumeCampaign(1n)
    ).to.be.revertedWith("Advertiser only");

    await campaigns.connect(advertiser).resumeCampaign(1n);
    expect((await campaigns.getCampaign(1n)).status).to.equal(1); // Active
  });

  // L4: Invalid state transitions revert
  it("L4: invalid transitions revert", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );

    // Cannot pause a Pending campaign
    await expect(
      campaigns.connect(advertiser).pauseCampaign(1n)
    ).to.be.revertedWith("Not Active");

    // Cannot activate twice
    await campaigns.connect(governance).activateCampaign(1n);
    await expect(
      campaigns.connect(governance).activateCampaign(1n)
    ).to.be.revertedWith("Not Pending");

    // Cannot pause twice
    await campaigns.connect(advertiser).pauseCampaign(1n);
    await expect(
      campaigns.connect(advertiser).pauseCampaign(1n)
    ).to.be.revertedWith("Not Active");
  });

  // L5: terminateCampaign records terminationBlock and transfers escrow to governance
  it("L5: terminateCampaign records terminationBlock and slashes escrow", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    await campaigns.connect(governance).activateCampaign(1n);

    const balBefore = await ethers.provider.getBalance(governance.address);
    const tx = await campaigns.connect(governance).terminateCampaign(1n);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(governance.address);

    const c = await campaigns.getCampaign(1n);
    expect(c.status).to.equal(4); // Terminated
    expect(c.terminationBlock).to.equal(BigInt(receipt!.blockNumber));
    expect(c.remainingBudget).to.equal(0n);

    // Governance received the budget (net of gas paid by governance)
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
    expect(balAfter - balBefore + gasUsed).to.equal(BUDGET);
  });

  // L6: expirePendingCampaign works after timeout; returns budget to advertiser
  it("L6: expirePendingCampaign works after pendingExpiryBlock", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );

    // Too early
    await expect(
      campaigns.connect(other).expirePendingCampaign(1n)
    ).to.be.revertedWith("Expiry block not reached");

    // Mine past the timeout
    await ethers.provider.send("hardhat_mine", [`0x${(PENDING_TIMEOUT + 1n).toString(16)}`]);

    const balBefore = await ethers.provider.getBalance(advertiser.address);
    await campaigns.connect(other).expirePendingCampaign(1n);
    const balAfter = await ethers.provider.getBalance(advertiser.address);

    expect((await campaigns.getCampaign(1n)).status).to.equal(5); // Expired
    expect(balAfter - balBefore).to.equal(BUDGET);
  });

  // L7: deductBudget enforces daily cap and only callable by settlement
  it("L7: deductBudget enforces daily cap and resets on new day", async function () {
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    await campaigns.connect(governance).activateCampaign(1n);

    // Only settlement can call
    await expect(
      campaigns.connect(other).deductBudget(1n, parseDOT("0.01"))
    ).to.be.revertedWith("Settlement only");

    // Deduct up to daily cap
    await campaigns.connect(settlement).deductBudget(1n, DAILY_CAP);

    // Exceeds daily cap
    await expect(
      campaigns.connect(settlement).deductBudget(1n, 1n)
    ).to.be.revertedWith("Daily cap exceeded");

    // Advance time by 1 day
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);

    // Daily cap resets
    await campaigns.connect(settlement).deductBudget(1n, DAILY_CAP);
    const c = await campaigns.getCampaign(1n);
    expect(c.dailySpent).to.equal(DAILY_CAP);
  });

  // L8: Budget exhaustion auto-completes the campaign
  it("L8: exhausting budget auto-completes campaign", async function () {
    const smallBudget = parseDOT("0.05"); // 0.05 DOT
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, smallBudget, BID_CPM, { value: smallBudget }
    );
    await campaigns.connect(governance).activateCampaign(1n);

    await campaigns.connect(settlement).deductBudget(1n, smallBudget);
    const c = await campaigns.getCampaign(1n);
    expect(c.status).to.equal(3); // Completed
    expect(c.remainingBudget).to.equal(0n);
  });

  // Take rate snapshot: publisher updates rate after campaign creation; settlement uses snapshot
  it("Snapshot: settlement uses snapshotTakeRateBps, not updated rate", async function () {
    // Campaign created at 50%
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    const c1 = await campaigns.getCampaign(1n);
    expect(c1.snapshotTakeRateBps).to.equal(5000);

    // Publisher queues update to 80%
    await publishers.connect(publisher).updateTakeRate(8000);

    // Mine past delay
    await ethers.provider.send("hardhat_mine", [`0x${(TAKE_RATE_DELAY + 1n).toString(16)}`]);
    await publishers.connect(publisher).applyTakeRateUpdate();

    // New campaign created after update uses 80%
    await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    const c2 = await campaigns.getCampaign(2n);
    expect(c2.snapshotTakeRateBps).to.equal(8000);

    // First campaign still has 50% snapshot
    const c1after = await campaigns.getCampaign(1n);
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
    await publishers.connect(other).registerPublisher(5000);
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
    ).to.be.revertedWith("Bid below minimum CPM floor");
  });
});
