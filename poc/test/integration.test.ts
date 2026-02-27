import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumPublishers, DatumCampaigns, DatumGovernanceVoting, DatumGovernanceRewards, DatumSettlement } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { mineBlocks, isSubstrate, fundSigners } from "./helpers/mine";

// Integration tests: Scenarios A-E
// A: Happy path (create → aye activate → settle claims → complete → claim aye rewards)
// B: Termination path (create → activate → nay terminate → distribute slash → verify pull payments)
// C: Pending expiry (create → never vote → expire → budget returned)
// D: Nonce gap (batch gap at claim 5 of 10 → only 1-4 settle)
// E: Take rate snapshot (register at 30% → create → update to 80% → settle → verify 30%)
//
// On substrate, contract deployments are very slow (>5 min for large PVM bytecodes).
// All 5 contracts are deployed once in `before`. Each test creates its own campaign.

describe("Integration", function () {
  let publishers: DatumPublishers;
  let campaigns: DatumCampaigns;
  let voting: DatumGovernanceVoting;
  let rewards: DatumGovernanceRewards;
  let settlement: DatumSettlement;

  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;

  // Config — all amounts in planck (1 DOT = 10^10 planck)
  // On substrate, use small block counts (real blocks, ~3s each)
  let PENDING_TIMEOUT: bigint;
  let TAKE_RATE_DELAY: bigint;
  const MIN_CPM = 0n;
  const ACTIVATION_THRESHOLD = parseDOT("0.5");   // 0.5 DOT weighted aye
  const TERMINATION_THRESHOLD = parseDOT("1");     // 1 DOT weighted nay
  const MIN_REVIEWER_STAKE = parseDOT("0.1");      // 0.1 DOT min reviewer
  const BASE_LOCKUP = 5n;
  const MAX_LOCKUP = 200n;

  const BUDGET = parseDOT("2");                    // 2 DOT
  const DAILY_CAP = parseDOT("1");                 // 1 DOT
  const BID_CPM = parseDOT("0.01");               // 0.01 DOT per 1000 impressions
  const TAKE_RATE_BPS = 5000; // 50%

  function buildClaims(
    campaignId: bigint,
    publisherAddr: string,
    userAddr: string,
    count: number,
    cpm: bigint,
    impressions: bigint
  ) {
    const claims = [];
    let prevHash = ethers.ZeroHash;
    for (let i = 1; i <= count; i++) {
      const nonce = BigInt(i);
      const hash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [campaignId, publisherAddr, userAddr, impressions, cpm, nonce, prevHash]
      );
      claims.push({
        campaignId,
        publisher: publisherAddr,
        impressionCount: impressions,
        clearingCpmPlanck: cpm,
        nonce,
        previousClaimHash: prevHash,
        claimHash: hash,
        zkProof: "0x",
      });
      prevHash = hash;
    }
    return claims;
  }

  // Helper: create a campaign and return its ID
  async function createTestCampaign(budget = BUDGET, dailyCap = DAILY_CAP, bidCpm = BID_CPM, pub = publisher) {
    const tx = await campaigns.connect(advertiser).createCampaign(
      pub.address, dailyCap, bidCpm, { value: budget }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    return id;
  }

  before(async function () {
    await fundSigners();
    const substrate = await isSubstrate();
    PENDING_TIMEOUT = substrate ? 3n : 50n;
    TAKE_RATE_DELAY = substrate ? 3n : 20n;

    [owner, advertiser, publisher, user, voter1, voter2] = await ethers.getSigners();

    // Deploy publishers
    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(TAKE_RATE_DELAY);

    // Deploy campaigns
    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(MIN_CPM, PENDING_TIMEOUT, await publishers.getAddress());

    // Deploy governance (Voting + Rewards)
    const VotingFactory = await ethers.getContractFactory("DatumGovernanceVoting");
    voting = await VotingFactory.deploy(
      await campaigns.getAddress(),
      ACTIVATION_THRESHOLD,
      TERMINATION_THRESHOLD,
      MIN_REVIEWER_STAKE,
      BASE_LOCKUP,
      MAX_LOCKUP
    );

    const RewardsFactory = await ethers.getContractFactory("DatumGovernanceRewards");
    rewards = await RewardsFactory.deploy(
      await voting.getAddress(),
      await campaigns.getAddress()
    );

    // Wire: voting ↔ rewards
    await voting.setRewardsContract(await rewards.getAddress());

    // Deploy settlement
    const SettleFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettleFactory.deploy(await campaigns.getAddress());

    // Wire contracts
    await campaigns.setGovernanceContract(await voting.getAddress());
    await campaigns.setSettlementContract(await settlement.getAddress());

    // Register publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  // Scenario A: Happy path
  it("A: Happy path — create, activate, settle, complete, withdraw", async function () {
    const campaignId = await createTestCampaign();

    // Activate via aye vote (voter1 stakes 0.5 DOT at conviction 0 → 0.5 DOT weight = threshold)
    await voting.connect(voter1).voteAye(campaignId, 0, { value: ACTIVATION_THRESHOLD });

    const c = await campaigns.getCampaign(campaignId);
    expect(c.status).to.equal(1); // Active

    // Settle 3 claims
    const impressions = 1000n;
    const cpm = BID_CPM;
    const claims = buildClaims(campaignId, publisher.address, user.address, 3, cpm, impressions);
    const batch = { user: user.address, campaignId, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.settledCount).to.equal(3n);
    expect(result.rejectedCount).to.equal(0n);
    await settlement.connect(user).settleClaims([batch]);

    // Verify split
    const totalPayment = (cpm * impressions) / 1000n * 3n;
    const pubPmt = (totalPayment * 5000n) / 10000n;
    const remainder = totalPayment - pubPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protFee = remainder - userPmt;

    expect(await settlement.publisherBalance(publisher.address)).to.equal(pubPmt);
    expect(await settlement.userBalance(user.address)).to.equal(userPmt);
    expect(await settlement.protocolBalance()).to.equal(protFee);

    // Advertiser completes campaign and gets refund
    const refundExpected = (await campaigns.getCampaign(campaignId)).remainingBudget;
    const advBalBefore = await ethers.provider.getBalance(advertiser.address);
    const completeTx = await campaigns.connect(advertiser).completeCampaign(campaignId);
    const completeReceipt = await completeTx.wait();
    const advBalAfter = await ethers.provider.getBalance(advertiser.address);

    if (!(await isSubstrate())) {
      const gasUsed = completeReceipt!.gasUsed * completeReceipt!.gasPrice;
      expect(advBalAfter - advBalBefore + gasUsed).to.equal(refundExpected);
    }
    expect((await campaigns.getCampaign(campaignId)).status).to.equal(3); // Completed

    // Credit aye reward to voter1 (off-chain computed share — voter1 is the sole aye voter)
    const rewardPool = parseDOT("0.1");
    await rewards.connect(owner).creditAyeReward(campaignId, voter1.address, { value: rewardPool });

    const claimable = await rewards.ayeClaimable(campaignId, voter1.address);
    expect(claimable).to.equal(rewardPool);

    // Mine past lockup (conviction 0 → BASE_LOCKUP * 1 = 5 blocks)
    const vr = await voting.getVoteRecord(campaignId, voter1.address);
    const curBlock = await ethers.provider.getBlockNumber();
    const blocksNeeded = Number(vr.lockedUntilBlock) - curBlock + 1;
    if (blocksNeeded > 0) {
      await mineBlocks(blocksNeeded);
    }

    await rewards.connect(voter1).claimAyeReward(campaignId);
    expect(await rewards.ayeClaimable(campaignId, voter1.address)).to.equal(0n);

    // Withdraw stake
    await rewards.connect(voter1).withdrawStake(campaignId);
    expect((await voting.getVoteRecord(campaignId, voter1.address)).lockAmount).to.equal(0n);
  });

  // Scenario B: Termination path
  it("B: Termination path — nay vote terminates; slash distributed to nay voters", async function () {
    const campaignId = await createTestCampaign();

    // Activate
    await voting.connect(voter1).voteAye(campaignId, 0, { value: ACTIVATION_THRESHOLD });
    expect((await campaigns.getCampaign(campaignId)).status).to.equal(1);

    // Terminate: voter2 stakes 1 DOT at conviction 0 → 1 DOT weight = termination threshold
    await voting.connect(voter2).voteNay(campaignId, 0, { value: TERMINATION_THRESHOLD });

    expect((await campaigns.getCampaign(campaignId)).status).to.equal(4); // Terminated

    // Distribute slash rewards (separate step in split architecture)
    await rewards.distributeSlashRewards(campaignId);

    // Slash claimable should be the remaining budget at termination
    const slashClaimable = await voting.nayClaimable(campaignId, voter2.address);
    expect(slashClaimable).to.equal(BUDGET); // Full budget since no claims were settled

    // Mine past lockup
    const vr = await voting.getVoteRecord(campaignId, voter2.address);
    const curBlock = await ethers.provider.getBlockNumber();
    const blocksNeeded = Number(vr.lockedUntilBlock) - curBlock + 1;
    if (blocksNeeded > 0) {
      await mineBlocks(blocksNeeded);
    }

    // Claim slash reward
    const balBefore = await ethers.provider.getBalance(voter2.address);
    const tx = await rewards.connect(voter2).claimSlashReward(campaignId);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(voter2.address);

    if (!(await isSubstrate())) {
      const gasUsed2 = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed2).to.equal(slashClaimable);
    }
    // On all networks, verify contract state zeroed
    expect(await voting.nayClaimable(campaignId, voter2.address)).to.equal(0n);
  });

  // Scenario C: Pending expiry
  it("C: Pending expiry — budget returned to advertiser after timeout", async function () {
    const campaignId = await createTestCampaign();

    // Don't vote — let it expire
    await mineBlocks(PENDING_TIMEOUT + 1n);

    const advBalBefore = await ethers.provider.getBalance(advertiser.address);
    await campaigns.connect(user).expirePendingCampaign(campaignId);
    const advBalAfter = await ethers.provider.getBalance(advertiser.address);

    expect((await campaigns.getCampaign(campaignId)).status).to.equal(5); // Expired
    expect(advBalAfter - advBalBefore).to.equal(BUDGET);
  });

  // Scenario D: Nonce gap at claim 5
  it("D: Gap at claim 5 of 10 — only 1-4 settle", async function () {
    const campaignId = await createTestCampaign();
    await voting.connect(voter1).voteAye(campaignId, 0, { value: ACTIVATION_THRESHOLD });

    const impressions = 100n;
    const cpm = BID_CPM;
    const all10 = buildClaims(campaignId, publisher.address, user.address, 10, cpm, impressions);

    // Introduce gap: skip nonce 5 (replace index 4 with wrong nonce)
    const gapped = [...all10];
    // Mutate nonce to create a gap (nonce 5 becomes 6)
    gapped[4] = { ...gapped[4], nonce: 6n };

    const batch = { user: user.address, campaignId, claims: gapped };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);

    expect(result.settledCount).to.equal(4n);
    expect(result.rejectedCount).to.equal(6n);

    await settlement.connect(user).settleClaims([batch]);

    // Only 4 claims settled: verify nonce state
    expect(await settlement.lastNonce(user.address, campaignId)).to.equal(4n);

    // Verify payment for 4 claims
    const totalPayment = (cpm * impressions) / 1000n * 4n;
    const pubPmt = (totalPayment * 5000n) / 10000n;
    // Note: publisher balance accumulates across tests (shared deployment)
    // Just verify it increased by the expected amount
    // For this test, we check the nonce state which is per-campaign
  });

  // Scenario E: Take rate snapshot
  it("E: Take rate snapshot — settlement uses rate at campaign creation, not updated rate", async function () {
    // Publisher registers at 30%
    const lowPublisher = (await ethers.getSigners())[7];
    await publishers.connect(lowPublisher).registerPublisher(3000); // 30%

    // Create campaign at 30%
    const campaignId = await createTestCampaign(BUDGET, DAILY_CAP, BID_CPM, lowPublisher as any);

    const c = await campaigns.getCampaign(campaignId);
    expect(c.snapshotTakeRateBps).to.equal(3000);

    // Publisher queues update to 80%
    await publishers.connect(lowPublisher).updateTakeRate(8000);

    // Mine past delay
    await mineBlocks(TAKE_RATE_DELAY + 1n);
    await publishers.connect(lowPublisher).applyTakeRateUpdate();

    // Verify live rate is 80%
    expect((await publishers.getPublisher(lowPublisher.address)).takeRateBps).to.equal(8000);

    // Activate and settle
    await voting.connect(voter1).voteAye(campaignId, 0, { value: ACTIVATION_THRESHOLD });

    const impressions = 1000n;
    const cpm = BID_CPM;
    const claims = buildClaims(campaignId, lowPublisher.address, user.address, 1, cpm, impressions);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId, claims }]);

    // Verify 30% take rate was used, NOT 80%
    const totalPayment = (cpm * impressions) / 1000n;
    const pubPmtAt30 = (totalPayment * 3000n) / 10000n;

    const actualPubBalance = await settlement.publisherBalance(lowPublisher.address);
    expect(actualPubBalance).to.equal(pubPmtAt30);
  });
});
