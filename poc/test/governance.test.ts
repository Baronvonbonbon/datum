import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumGovernanceVoting, DatumGovernanceRewards, MockCampaigns } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";

// Governance tests: G1-G8
// Plus: absolute lockup cap, minReviewerStake tests

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

  async function deployGovernance() {
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

    return { mock, voting, rewards };
  }

  beforeEach(async function () {
    [owner, voter1, voter2, voter3, advertiser, publisher] = await ethers.getSigners();
    await deployGovernance();

    // Register publisher and create a Pending campaign in mock
    await mock.connect(publisher).registerPublisher(TAKE_RATE_BPS);
    await mock.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    // Fund mock to cover terminateCampaign slash transfer
    await owner.sendTransaction({ to: await mock.getAddress(), value: BUDGET });
  });

  const CAMPAIGN_ID = 1n;

  // G1: voteAye with sufficient stake activates campaign
  it("G1: voteAye crossing threshold activates campaign", async function () {
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: ACTIVATION_THRESHOLD });

    const cv = await voting.getCampaignVote(CAMPAIGN_ID);
    expect(cv.activated).to.be.true;
    expect(cv.ayeTotal).to.equal(ACTIVATION_THRESHOLD);

    const c = await mock.getCampaign(CAMPAIGN_ID);
    expect(c.status).to.equal(1); // Active
  });

  // G2: conviction multiplier doubles at each level
  it("G2: conviction multiplier is 2^conviction", async function () {
    const stake = parseDOT("0.01");

    // conviction=3 → weight = 0.01 DOT * 8 = 0.08 DOT
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 3, { value: stake });
    const cv = await voting.getCampaignVote(CAMPAIGN_ID);
    expect(cv.ayeTotal).to.equal(stake * 8n); // 2^3 = 8
  });

  // G3: voteAye with small stake does not increment uniqueReviewers (Issue 11)
  it("G3: only votes >= minReviewerStake count as reviewers", async function () {
    const smallStake = MIN_REVIEWER_STAKE - 1n;
    const largeStake = MIN_REVIEWER_STAKE;

    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: smallStake });
    let cv = await voting.getCampaignVote(CAMPAIGN_ID);
    expect(cv.uniqueReviewers).to.equal(0n);

    await voting.connect(voter2).voteAye(CAMPAIGN_ID, 0, { value: largeStake });
    cv = await voting.getCampaignVote(CAMPAIGN_ID);
    expect(cv.uniqueReviewers).to.equal(1n);
  });

  // G4: voteNay crossing threshold terminates campaign (with aye activation first)
  it("G4: voteNay crossing threshold terminates campaign", async function () {
    // Activate first
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: ACTIVATION_THRESHOLD });

    // Nay: 2 DOT at conviction 0 = 2 DOT weighted
    await voting.connect(voter2).voteNay(CAMPAIGN_ID, 0, { value: TERMINATION_THRESHOLD });

    const cv = await voting.getCampaignVote(CAMPAIGN_ID);
    expect(cv.terminated).to.be.true;
    expect(cv.terminationBlock).to.be.gt(0n);

    const c = await mock.getCampaign(CAMPAIGN_ID);
    expect(c.status).to.equal(4); // Terminated
  });

  // G5: Graduated nay lockup formula
  it("G5: nay lockup = base * 2^conviction + base * 2^min(failed,4)", async function () {
    // Activate first
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: ACTIVATION_THRESHOLD });

    // First nay voter, conviction=1, no failed nays
    // lockup = 10 * 2^1 + 10 * 2^0 = 20 + 10 = 30 blocks (< MAX 100)
    const conviction = 1;
    const tx = await voting.connect(voter2).voteNay(CAMPAIGN_ID, conviction, { value: parseDOT("0.01") });
    const receipt = await tx.wait();

    const vr = await voting.getVoteRecord(CAMPAIGN_ID, voter2.address);
    const expectedLockup = BASE_LOCKUP * 2n + BASE_LOCKUP * 1n; // = 30
    expect(vr.lockedUntilBlock).to.equal(BigInt(receipt!.blockNumber) + expectedLockup);
  });

  // G6: Absolute lockup cap (Issue 10)
  it("G6: lockup is capped at maxLockupDuration regardless of conviction/history", async function () {
    // Activate first
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: ACTIVATION_THRESHOLD });

    // conviction=6, failedNays=0 → base * 64 + base * 1 = 10*64 + 10 = 650 > MAX(100)
    const tx = await voting.connect(voter2).voteNay(CAMPAIGN_ID, 6, { value: parseDOT("0.01") });
    const receipt = await tx.wait();

    const vr = await voting.getVoteRecord(CAMPAIGN_ID, voter2.address);
    // Should be capped at MAX_LOCKUP (100 blocks)
    expect(vr.lockedUntilBlock).to.equal(BigInt(receipt!.blockNumber) + MAX_LOCKUP);
  });

  // G7: Slash reward distribution — nay voters receive proportional slash after termination
  it("G7: nay voters can claim proportional slash reward after lockup", async function () {
    // Activate first
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: ACTIVATION_THRESHOLD });

    // Single nay voter triggers termination
    await voting.connect(voter2).voteNay(CAMPAIGN_ID, 0, { value: TERMINATION_THRESHOLD });

    // Distribute slash rewards (separate step in split architecture)
    await rewards.distributeSlashRewards(CAMPAIGN_ID);

    // Slash amount = BUDGET (full remaining budget)
    expect(await voting.nayClaimable(CAMPAIGN_ID, voter2.address)).to.equal(BUDGET);

    // Cannot claim before lockup
    await expect(
      rewards.connect(voter2).claimSlashReward(CAMPAIGN_ID)
    ).to.be.revertedWith("E07");

    // Mine past lockup
    const vr = await voting.getVoteRecord(CAMPAIGN_ID, voter2.address);
    const currentBlock = await ethers.provider.getBlockNumber();
    const blocksNeeded = Number(vr.lockedUntilBlock) - currentBlock + 1;
    if (blocksNeeded > 0) {
      await ethers.provider.send("hardhat_mine", [`0x${blocksNeeded.toString(16)}`]);
    }

    const balBefore = await ethers.provider.getBalance(voter2.address);
    const tx = await rewards.connect(voter2).claimSlashReward(CAMPAIGN_ID);
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(voter2.address);

    expect(balAfter - balBefore + gasUsed).to.equal(BUDGET);
    expect(await voting.nayClaimable(CAMPAIGN_ID, voter2.address)).to.equal(0n);
  });

  // G8: withdrawStake works after lockup expiry
  it("G8: aye voter can withdraw stake after lockup period", async function () {
    const stake = ACTIVATION_THRESHOLD;
    const tx = await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: stake });
    const receipt = await tx.wait();

    const vr = await voting.getVoteRecord(CAMPAIGN_ID, voter1.address);
    expect(vr.lockAmount).to.equal(stake);

    // Cannot withdraw before lockup
    await expect(
      rewards.connect(voter1).withdrawStake(CAMPAIGN_ID)
    ).to.be.revertedWith("E07");

    // Mine past lockup: conviction 0 → baseLockup * 1 = 10 blocks
    const currentBlock = await ethers.provider.getBlockNumber();
    const blocksNeeded = Number(vr.lockedUntilBlock) - currentBlock + 1;
    await ethers.provider.send("hardhat_mine", [`0x${blocksNeeded.toString(16)}`]);

    const balBefore = await ethers.provider.getBalance(voter1.address);
    const withdrawTx = await rewards.connect(voter1).withdrawStake(CAMPAIGN_ID);
    const withdrawReceipt = await withdrawTx.wait();
    const gasUsed = withdrawReceipt!.gasUsed * withdrawReceipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(voter1.address);

    expect(balAfter - balBefore + gasUsed).to.equal(stake);

    // Cannot withdraw twice
    const vrAfter = await voting.getVoteRecord(CAMPAIGN_ID, voter1.address);
    expect(vrAfter.lockAmount).to.equal(0n);
  });

  // Aye reward — Issue 9: only pre-terminationBlock voters get rewards
  it("Issue9: aye voters after terminationBlock excluded from rewards", async function () {
    // Voter1 aye → activates
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: ACTIVATION_THRESHOLD });

    // Voter2 nay → triggers termination
    await voting.connect(voter2).voteNay(CAMPAIGN_ID, 0, { value: TERMINATION_THRESHOLD });

    // voter3 votes aye AFTER termination — should be excluded from rewards
    // (campaign is now terminated, so voteAye should fail on status check)
    await expect(
      voting.connect(voter3).voteAye(CAMPAIGN_ID, 0, { value: parseDOT("0.1") })
    ).to.be.revertedWith("Campaign not Pending");

    // creditAyeReward: voter1 (pre-termination) should get full pool
    // Campaign must be Completed or Terminated
    const rewardAmount = parseDOT("0.5");
    await rewards.connect(owner).creditAyeReward(CAMPAIGN_ID, voter1.address, { value: rewardAmount });

    const voter1Claimable = await rewards.ayeClaimable(CAMPAIGN_ID, voter1.address);
    expect(voter1Claimable).to.equal(rewardAmount);
  });

  // Cannot vote twice on same campaign
  it("Double vote: reverts if voter votes twice on same campaign", async function () {
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: parseDOT("0.01") });
    await expect(
      voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: parseDOT("0.01") })
    ).to.be.revertedWith("Already voted");
  });

  // A1 fix: resolveFailedNay increments _voterFailedNays
  it("A1: resolveFailedNay increments failed nay count when campaign completes", async function () {
    // Activate campaign
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: ACTIVATION_THRESHOLD });

    // voter2 votes nay but doesn't reach termination threshold
    await voting.connect(voter2).voteNay(CAMPAIGN_ID, 0, { value: parseDOT("0.01") });

    // Campaign completes normally (advertiser completes it)
    await mock.completeCampaign(CAMPAIGN_ID);

    // Resolve failed nay — emits event with totalFailedNays
    const tx = await rewards.connect(voter2).resolveFailedNay(CAMPAIGN_ID);
    await expect(tx)
      .to.emit(rewards, "FailedNayResolved")
      .withArgs(CAMPAIGN_ID, voter2.address, 1n);

    // Cannot resolve twice
    await expect(
      rewards.connect(voter2).resolveFailedNay(CAMPAIGN_ID)
    ).to.be.revertedWith("Already resolved");
  });

  it("A1: resolveFailedNay reverts for non-nay voter", async function () {
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: ACTIVATION_THRESHOLD });
    await mock.completeCampaign(CAMPAIGN_ID);

    await expect(
      rewards.connect(voter1).resolveFailedNay(CAMPAIGN_ID)
    ).to.be.revertedWith("E06");
  });

  it("A1: resolveFailedNay reverts if campaign not completed", async function () {
    await voting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: ACTIVATION_THRESHOLD });
    await voting.connect(voter2).voteNay(CAMPAIGN_ID, 0, { value: parseDOT("0.01") });

    // Campaign is Active, not Completed
    await expect(
      rewards.connect(voter2).resolveFailedNay(CAMPAIGN_ID)
    ).to.be.revertedWith("E10");
  });

  // Min reviewer stake — constructor-set, test with fresh deploy
  it("minReviewerStake: threshold controls uniqueReviewers count", async function () {
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

    // Below threshold
    await freshVoting.connect(voter1).voteAye(CAMPAIGN_ID, 0, { value: parseDOT("0.1") });
    let cv = await freshVoting.getCampaignVote(CAMPAIGN_ID);
    expect(cv.uniqueReviewers).to.equal(0n);

    // At threshold
    await freshVoting.connect(voter2).voteAye(CAMPAIGN_ID, 0, { value: parseDOT("0.5") });
    cv = await freshVoting.getCampaignVote(CAMPAIGN_ID);
    expect(cv.uniqueReviewers).to.equal(1n);
  });
});
