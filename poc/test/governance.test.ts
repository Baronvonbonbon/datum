import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumGovernanceVoting, DatumGovernanceRewards, MockCampaigns } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { mineBlocks, isSubstrate, fundSigners } from "./helpers/mine";

// Governance tests: G1-G8
// Plus: absolute lockup cap, minReviewerStake tests
//
// On substrate, contract deployments are very slow (>5 min for large PVM bytecodes).
// Contracts are deployed once in `before`. Each test creates a fresh campaign in the
// mock to get clean voting state (votes are permanent per campaign).

describe("DatumGovernance (Voting + Rewards)", function () {
  let voting: DatumGovernanceVoting;
  let rewards: DatumGovernanceRewards;
  let mock: MockCampaigns;
  let owner: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;
  let voter3: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;

  // Config — all amounts in planck (1 DOT = 10^10 planck)
  const ACTIVATION_THRESHOLD = parseDOT("1");    // 1 DOT weighted aye
  const TERMINATION_THRESHOLD = parseDOT("2");   // 2 DOT weighted nay
  const MIN_REVIEWER_STAKE = parseDOT("0.1");    // 0.1 DOT min reviewer
  const BASE_LOCKUP = 10n;                        // 10 blocks base
  const MAX_LOCKUP = 100n;                        // 100 blocks cap (small for testing)

  const BUDGET = parseDOT("5");                  // 5 DOT
  const DAILY_CAP = parseDOT("1");               // 1 DOT
  const BID_CPM = parseDOT("0.01");              // 0.01 DOT per 1000 impressions
  const TAKE_RATE_BPS = 5000;

  // nextCampaignId is read from mock.nextCampaignId() in createTestCampaign()

  // Create a fresh Pending campaign in the mock and fund it for slash tests.
  // Returns the campaign ID from the CampaignCreated event (most reliable on substrate).
  async function createTestCampaign(): Promise<bigint> {
    const tx = await mock.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    const receipt = await tx.wait();
    // Parse CampaignCreated event to get the actual assigned ID
    const event = receipt!.logs.find(
      (log) => {
        try { return mock.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "CampaignCreated"; }
        catch { return false; }
      }
    );
    const parsed = mock.interface.parseLog({ topics: event!.topics as string[], data: event!.data });
    const id = parsed!.args[0] as bigint;
    return id;
  }

  before(async function () {
    await fundSigners();
    [owner, voter1, voter2, voter3, advertiser, publisher] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const VotingFactory = await ethers.getContractFactory("DatumGovernanceVoting");
    voting = await VotingFactory.deploy(
      await mock.getAddress(),
      ACTIVATION_THRESHOLD,
      TERMINATION_THRESHOLD,
      MIN_REVIEWER_STAKE,
      BASE_LOCKUP,
      MAX_LOCKUP
    );

    const RewardsFactory = await ethers.getContractFactory("DatumGovernanceRewards");
    rewards = await RewardsFactory.deploy(
      await voting.getAddress(),
      await mock.getAddress()
    );

    // Wire: voting knows rewards, mock knows voting as governance
    await voting.setRewardsContract(await rewards.getAddress());
    await mock.setGovernanceContract(await voting.getAddress());

    // Register publisher
    await mock.connect(publisher).registerPublisher(TAKE_RATE_BPS);

    // Pre-fund mock with enough DOT for all campaign slash transfers
    // (avoids separate funding tx per campaign which can revert on substrate)
    const prefund = BUDGET * 20n;
    await owner.sendTransaction({ to: await mock.getAddress(), value: prefund });
  });

  // G1: voteAye with sufficient stake activates campaign
  it("G1: voteAye crossing threshold activates campaign", async function () {
    const cid = await createTestCampaign();
    await voting.connect(voter1).voteAye(cid, 0, { value: ACTIVATION_THRESHOLD });

    const cv = await voting.getCampaignVote(cid);
    expect(cv.activated).to.be.true;
    expect(cv.ayeTotal).to.equal(ACTIVATION_THRESHOLD);

    const c = await mock.getCampaign(cid);
    expect(c.status).to.equal(1); // Active
  });

  // G2: conviction multiplier doubles at each level
  it("G2: conviction multiplier is 2^conviction", async function () {
    const cid = await createTestCampaign();
    const stake = parseDOT("0.01");

    // conviction=3 → weight = 0.01 DOT * 8 = 0.08 DOT
    await voting.connect(voter1).voteAye(cid, 3, { value: stake });
    const cv = await voting.getCampaignVote(cid);
    expect(cv.ayeTotal).to.equal(stake * 8n); // 2^3 = 8
  });

  // G3: voteAye with small stake does not increment uniqueReviewers (Issue 11)
  it("G3: only votes >= minReviewerStake count as reviewers", async function () {
    const cid = await createTestCampaign();
    // Use value below threshold but divisible by 10^6 (substrate denomination boundary:
    // values where `value % 10^6 >= 500_000` fail due to eth-rpc rounding)
    const smallStake = MIN_REVIEWER_STAKE - 1_000_000n;
    const largeStake = MIN_REVIEWER_STAKE;

    await voting.connect(voter1).voteAye(cid, 0, { value: smallStake });
    let cv = await voting.getCampaignVote(cid);
    expect(cv.uniqueReviewers).to.equal(0n);

    await voting.connect(voter2).voteAye(cid, 0, { value: largeStake });
    cv = await voting.getCampaignVote(cid);
    expect(cv.uniqueReviewers).to.equal(1n);
  });

  // G4: voteNay crossing threshold terminates campaign (with aye activation first)
  it("G4: voteNay crossing threshold terminates campaign", async function () {
    const cid = await createTestCampaign();
    // Activate first
    await voting.connect(voter1).voteAye(cid, 0, { value: ACTIVATION_THRESHOLD });

    // Nay: 2 DOT at conviction 0 = 2 DOT weighted
    await voting.connect(voter2).voteNay(cid, 0, { value: TERMINATION_THRESHOLD });

    const cv = await voting.getCampaignVote(cid);
    expect(cv.terminated).to.be.true;
    expect(cv.terminationBlock).to.be.gt(0n);

    const c = await mock.getCampaign(cid);
    expect(c.status).to.equal(4); // Terminated
  });

  // G5: Graduated nay lockup formula
  it("G5: nay lockup = base * 2^conviction + base * 2^min(failed,4)", async function () {
    const cid = await createTestCampaign();
    // Activate first
    await voting.connect(voter1).voteAye(cid, 0, { value: ACTIVATION_THRESHOLD });

    // First nay voter, conviction=1, no failed nays
    // lockup = 10 * 2^1 + 10 * 2^0 = 20 + 10 = 30 blocks (< MAX 100)
    const conviction = 1;
    const tx = await voting.connect(voter2).voteNay(cid, conviction, { value: parseDOT("0.01") });
    const receipt = await tx.wait();

    const vr = await voting.getVoteRecord(cid, voter2.address);
    const expectedLockup = BASE_LOCKUP * 2n + BASE_LOCKUP * 1n; // = 30
    expect(vr.lockedUntilBlock).to.equal(BigInt(receipt!.blockNumber) + expectedLockup);
  });

  // G6: Absolute lockup cap (Issue 10)
  it("G6: lockup is capped at maxLockupDuration regardless of conviction/history", async function () {
    const cid = await createTestCampaign();
    // Activate first
    await voting.connect(voter1).voteAye(cid, 0, { value: ACTIVATION_THRESHOLD });

    // conviction=6, failedNays=0 → base * 64 + base * 1 = 10*64 + 10 = 650 > MAX(100)
    const tx = await voting.connect(voter2).voteNay(cid, 6, { value: parseDOT("0.01") });
    const receipt = await tx.wait();

    const vr = await voting.getVoteRecord(cid, voter2.address);
    // Should be capped at MAX_LOCKUP (100 blocks)
    expect(vr.lockedUntilBlock).to.equal(BigInt(receipt!.blockNumber) + MAX_LOCKUP);
  });

  // G7: Slash reward distribution — nay voters receive proportional slash after termination
  it("G7: nay voters can claim proportional slash reward after lockup", async function () {
    const cid = await createTestCampaign();
    // Activate first
    await voting.connect(voter1).voteAye(cid, 0, { value: ACTIVATION_THRESHOLD });

    // Single nay voter triggers termination
    await voting.connect(voter2).voteNay(cid, 0, { value: TERMINATION_THRESHOLD });

    // Distribute slash rewards (separate step in split architecture)
    await rewards.distributeSlashRewards(cid);

    // Slash amount = BUDGET (full remaining budget)
    expect(await voting.nayClaimable(cid, voter2.address)).to.equal(BUDGET);

    // Cannot claim before lockup
    await expect(
      rewards.connect(voter2).claimSlashReward(cid)
    ).to.be.revertedWith("E07");

    // Mine past lockup
    const vr = await voting.getVoteRecord(cid, voter2.address);
    const currentBlock = await ethers.provider.getBlockNumber();
    const blocksNeeded = Number(vr.lockedUntilBlock) - currentBlock + 1;
    if (blocksNeeded > 0) {
      await mineBlocks(blocksNeeded);
    }

    const balBefore = await ethers.provider.getBalance(voter2.address);
    const tx = await rewards.connect(voter2).claimSlashReward(cid);
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(voter2.address);

    // On substrate, receipt.gasUsed returns weight (~10^15), not EVM gas.
    // gasUsed * gasPrice dwarfs actual cost. Check contract state instead.
    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(BUDGET);
    }
    // On all networks, verify contract state zeroed (transfer succeeded)
    expect(await voting.nayClaimable(cid, voter2.address)).to.equal(0n);
  });

  // G8: withdrawStake works after lockup expiry
  it("G8: aye voter can withdraw stake after lockup period", async function () {
    const cid = await createTestCampaign();
    const stake = ACTIVATION_THRESHOLD;
    const tx = await voting.connect(voter1).voteAye(cid, 0, { value: stake });
    const receipt = await tx.wait();

    const vr = await voting.getVoteRecord(cid, voter1.address);
    expect(vr.lockAmount).to.equal(stake);

    // Cannot withdraw before lockup
    await expect(
      rewards.connect(voter1).withdrawStake(cid)
    ).to.be.revertedWith("E07");

    // Mine past lockup: conviction 0 → baseLockup * 1 = 10 blocks
    const currentBlock = await ethers.provider.getBlockNumber();
    const blocksNeeded = Number(vr.lockedUntilBlock) - currentBlock + 1;
    await mineBlocks(blocksNeeded);

    const balBefore = await ethers.provider.getBalance(voter1.address);
    const withdrawTx = await rewards.connect(voter1).withdrawStake(cid);
    const withdrawReceipt = await withdrawTx.wait();
    const balAfter = await ethers.provider.getBalance(voter1.address);

    if (!(await isSubstrate())) {
      const gasUsed = withdrawReceipt!.gasUsed * withdrawReceipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(stake);
    }

    // Cannot withdraw twice — verify contract state zeroed
    const vrAfter = await voting.getVoteRecord(cid, voter1.address);
    expect(vrAfter.lockAmount).to.equal(0n);
  });

  // Aye reward — Issue 9: only pre-terminationBlock voters get rewards
  it("Issue9: aye voters after terminationBlock excluded from rewards", async function () {
    const cid = await createTestCampaign();
    // Voter1 aye → activates
    await voting.connect(voter1).voteAye(cid, 0, { value: ACTIVATION_THRESHOLD });

    // Voter2 nay → triggers termination
    await voting.connect(voter2).voteNay(cid, 0, { value: TERMINATION_THRESHOLD });

    // voter3 votes aye AFTER termination — should be excluded from rewards
    // (campaign is now terminated, so voteAye should fail on status check)
    await expect(
      voting.connect(voter3).voteAye(cid, 0, { value: parseDOT("0.1") })
    ).to.be.revertedWith("Campaign not Pending");

    // creditAyeReward: voter1 (pre-termination) should get full pool
    // Campaign must be Completed or Terminated
    const rewardAmount = parseDOT("0.5");
    await rewards.connect(owner).creditAyeReward(cid, voter1.address, { value: rewardAmount });

    const voter1Claimable = await rewards.ayeClaimable(cid, voter1.address);
    expect(voter1Claimable).to.equal(rewardAmount);
  });

  // Cannot vote twice on same campaign
  it("Double vote: reverts if voter votes twice on same campaign", async function () {
    const cid = await createTestCampaign();
    await voting.connect(voter1).voteAye(cid, 0, { value: parseDOT("0.01") });
    await expect(
      voting.connect(voter1).voteAye(cid, 0, { value: parseDOT("0.01") })
    ).to.be.revertedWith("Already voted");
  });

  // A1 fix: resolveFailedNay increments _voterFailedNays
  it("A1: resolveFailedNay increments failed nay count when campaign completes", async function () {
    const cid = await createTestCampaign();
    // Activate campaign
    await voting.connect(voter1).voteAye(cid, 0, { value: ACTIVATION_THRESHOLD });

    // voter2 votes nay but doesn't reach termination threshold
    await voting.connect(voter2).voteNay(cid, 0, { value: parseDOT("0.01") });

    // Campaign completes normally (advertiser completes it)
    await mock.completeCampaign(cid);

    // Resolve failed nay — emits event with totalFailedNays
    const tx = await rewards.connect(voter2).resolveFailedNay(cid);
    await expect(tx)
      .to.emit(rewards, "FailedNayResolved")
      .withArgs(cid, voter2.address, 1n);

    // Cannot resolve twice
    await expect(
      rewards.connect(voter2).resolveFailedNay(cid)
    ).to.be.revertedWith("Already resolved");
  });

  it("A1: resolveFailedNay reverts for non-nay voter", async function () {
    const cid = await createTestCampaign();
    await voting.connect(voter1).voteAye(cid, 0, { value: ACTIVATION_THRESHOLD });
    await mock.completeCampaign(cid);

    await expect(
      rewards.connect(voter1).resolveFailedNay(cid)
    ).to.be.revertedWith("E06");
  });

  it("A1: resolveFailedNay reverts if campaign not completed", async function () {
    const cid = await createTestCampaign();
    await voting.connect(voter1).voteAye(cid, 0, { value: ACTIVATION_THRESHOLD });
    await voting.connect(voter2).voteNay(cid, 0, { value: parseDOT("0.01") });

    // Campaign is Active, not Completed
    await expect(
      rewards.connect(voter2).resolveFailedNay(cid)
    ).to.be.revertedWith("E10");
  });

  // Min reviewer stake — constructor-set, test with fresh deploy
  // Skipped on substrate: deploys 3 fresh contracts in the test body (too slow, >5 min)
  it("minReviewerStake: threshold controls uniqueReviewers count", async function () {
    if (await isSubstrate()) this.skip();
    // Deploy with higher min reviewer stake
    const highMinStake = parseDOT("0.5");
    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    const freshMock = await MockFactory.deploy();

    const VotingFactory = await ethers.getContractFactory("DatumGovernanceVoting");
    const freshVoting = await VotingFactory.deploy(
      await freshMock.getAddress(),
      ACTIVATION_THRESHOLD,
      TERMINATION_THRESHOLD,
      highMinStake,
      BASE_LOCKUP,
      MAX_LOCKUP
    );

    const RewardsFactory = await ethers.getContractFactory("DatumGovernanceRewards");
    const freshRewards = await RewardsFactory.deploy(
      await freshVoting.getAddress(),
      await freshMock.getAddress()
    );
    await freshVoting.setRewardsContract(await freshRewards.getAddress());
    await freshMock.setGovernanceContract(await freshVoting.getAddress());

    await freshMock.connect(publisher).registerPublisher(TAKE_RATE_BPS);
    await freshMock.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );

    const cid = 1n;

    // Below threshold
    await freshVoting.connect(voter1).voteAye(cid, 0, { value: parseDOT("0.1") });
    let cv = await freshVoting.getCampaignVote(cid);
    expect(cv.uniqueReviewers).to.equal(0n);

    // At threshold
    await freshVoting.connect(voter2).voteAye(cid, 0, { value: parseDOT("0.5") });
    cv = await freshVoting.getCampaignVote(cid);
    expect(cv.uniqueReviewers).to.equal(1n);
  });
});
