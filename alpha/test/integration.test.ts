import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumPublishers, DatumCampaigns, DatumGovernanceV2, DatumGovernanceSlash, DatumSettlement, DatumRelay, DatumPauseRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { mineBlocks, isSubstrate, fundSigners } from "./helpers/mine";

// Integration tests: Scenarios A-F
// A: Happy path (create -> aye vote -> evaluate activate -> settle claims -> complete -> evaluate resolve -> withdraw)
// B: Termination path (create -> activate -> nay vote -> evaluate terminate -> finalize slash -> claim)
// F: Publisher relay — full flow with EIP-712 signature via DatumRelay
// C: Pending expiry (create -> never vote -> expire -> budget returned)
// D: Nonce gap (batch gap at claim 5 of 10 -> only 1-4 settle)
// E: Take rate snapshot (register at 30% -> create -> update to 80% -> settle -> verify 30%)

describe("Integration", function () {
  let publishers: DatumPublishers;
  let campaigns: DatumCampaigns;
  let v2: DatumGovernanceV2;
  let slash: DatumGovernanceSlash;
  let settlement: DatumSettlement;
  let relay: DatumRelay;

  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;

  // Config — all amounts in planck (1 DOT = 10^10 planck)
  let PENDING_TIMEOUT: bigint;
  let TAKE_RATE_DELAY: bigint;
  const MIN_CPM = 0n;
  const QUORUM_WEIGHTED = parseDOT("0.5");       // 0.5 DOT weighted quorum
  const SLASH_BPS = 1000n;                         // 10% slash
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
      pub.address, dailyCap, bidCpm, 0, { value: budget }
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

    // Deploy pause registry
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    const pauseReg = await PauseFactory.deploy();

    // Deploy publishers
    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(TAKE_RATE_DELAY);

    // Deploy campaigns
    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(MIN_CPM, PENDING_TIMEOUT, await publishers.getAddress(), await pauseReg.getAddress());

    // Deploy GovernanceV2 (no pauseRegistry)
    const V2Factory = await ethers.getContractFactory("DatumGovernanceV2");
    v2 = await V2Factory.deploy(
      await campaigns.getAddress(),
      QUORUM_WEIGHTED,
      SLASH_BPS,
      BASE_LOCKUP,
      MAX_LOCKUP
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
    relay = await RelayFactory.deploy(await settlement.getAddress(), await campaigns.getAddress(), await pauseReg.getAddress());

    // Wire contracts directly
    await campaigns.setGovernanceContract(await v2.getAddress());
    await campaigns.setSettlementContract(await settlement.getAddress());
    await settlement.setRelayContract(await relay.getAddress());

    // Register publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  // Scenario A: Happy path
  it("A: Happy path — create, evaluate activate, settle, complete, withdraw", async function () {
    const campaignId = await createTestCampaign();

    // Vote aye (voter1 stakes 0.5 DOT at conviction 0 -> 0.5 DOT weight = quorum)
    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });

    // Evaluate to activate (aye > 50%, total >= quorum)
    await v2.evaluateCampaign(campaignId);

    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(1); // Active

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
    const refundExpected = await campaigns.getCampaignRemainingBudget(campaignId);
    const advBalBefore = await ethers.provider.getBalance(advertiser.address);
    const completeTx = await campaigns.connect(advertiser).completeCampaign(campaignId);
    const completeReceipt = await completeTx.wait();
    const advBalAfter = await ethers.provider.getBalance(advertiser.address);

    if (!(await isSubstrate())) {
      const gasUsed = completeReceipt!.gasUsed * completeReceipt!.gasPrice;
      expect(advBalAfter - advBalBefore + gasUsed).to.equal(refundExpected);
    }
    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(3); // Completed

    // Evaluate to mark resolved
    await v2.evaluateCampaign(campaignId);
    expect(await v2.resolved(campaignId)).to.be.true;

    // Mine past lockup (conviction 0 -> BASE_LOCKUP * 1 = 5 blocks)
    const [, , , lockedUntil] = await v2.getVote(campaignId, voter1.address);
    const curBlock = await ethers.provider.getBlockNumber();
    const blocksNeeded = Number(lockedUntil) - curBlock + 1;
    if (blocksNeeded > 0) {
      await mineBlocks(blocksNeeded);
    }

    // Withdraw stake (no slash — voter1 is aye, campaign Completed = aye wins)
    const balBefore = await ethers.provider.getBalance(voter1.address);
    const withdrawTx = await v2.connect(voter1).withdraw(campaignId);
    const withdrawReceipt = await withdrawTx.wait();
    const balAfter = await ethers.provider.getBalance(voter1.address);

    if (!(await isSubstrate())) {
      const gasUsed = withdrawReceipt!.gasUsed * withdrawReceipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(QUORUM_WEIGHTED);
    }

    // Vote should be zeroed
    const [dir] = await v2.getVote(campaignId, voter1.address);
    expect(dir).to.equal(0);
  });

  // Scenario B: Termination path
  it("B: Termination path — nay majority terminates; slash distributed to nay voters", async function () {
    const campaignId = await createTestCampaign();

    // Activate via aye vote + evaluate
    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);
    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(1);

    // Nay vote with larger weight to gain majority
    const nayStake = QUORUM_WEIGHTED * 2n;
    await v2.connect(voter2).vote(campaignId, false, 0, { value: nayStake });

    // Evaluate to terminate (nay >= 50%)
    await v2.evaluateCampaign(campaignId);
    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(4); // Terminated
    expect(await v2.resolved(campaignId)).to.be.true;

    // Mine past lockup for both voters
    const [, , , lockedUntil1] = await v2.getVote(campaignId, voter1.address);
    const [, , , lockedUntil2] = await v2.getVote(campaignId, voter2.address);
    const maxLocked = lockedUntil1 > lockedUntil2 ? lockedUntil1 : lockedUntil2;
    const curBlock = await ethers.provider.getBlockNumber();
    const blocksNeeded = Number(maxLocked) - curBlock + 1;
    if (blocksNeeded > 0) {
      await mineBlocks(blocksNeeded);
    }

    // Aye voter (voter1) withdraws — should be slashed (Terminated = aye loses)
    await v2.connect(voter1).withdraw(campaignId);
    const expectedSlash = QUORUM_WEIGHTED * SLASH_BPS / 10000n;
    expect(await v2.slashCollected(campaignId)).to.equal(expectedSlash);

    // Finalize slash
    await slash.finalizeSlash(campaignId);
    expect(await slash.finalized(campaignId)).to.be.true;

    // Nay voter (voter2) claims slash reward
    const claimable = await slash.getClaimable(campaignId, voter2.address);
    expect(claimable).to.equal(expectedSlash);

    const balBefore = await ethers.provider.getBalance(voter2.address);
    await slash.connect(voter2).claimSlashReward(campaignId);
    const balAfter = await ethers.provider.getBalance(voter2.address);

    // Verify claimed
    expect(await slash.getClaimable(campaignId, voter2.address)).to.equal(0n);
  });

  // Scenario C: Pending expiry
  it("C: Pending expiry — budget returned to advertiser after timeout", async function () {
    const campaignId = await createTestCampaign();

    // Don't vote — let it expire
    await mineBlocks(PENDING_TIMEOUT + 1n);

    const advBalBefore = await ethers.provider.getBalance(advertiser.address);
    await campaigns.connect(user).expirePendingCampaign(campaignId);
    const advBalAfter = await ethers.provider.getBalance(advertiser.address);

    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(5); // Expired
    expect(advBalAfter - advBalBefore).to.equal(BUDGET);
  });

  // Scenario D: Nonce gap at claim 3 (within MAX_CLAIMS_PER_BATCH=5)
  it("D: Gap at claim 3 of 5 — only 1-2 settle", async function () {
    const campaignId = await createTestCampaign();
    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);

    const impressions = 100n;
    const cpm = BID_CPM;
    const all5 = buildClaims(campaignId, publisher.address, user.address, 5, cpm, impressions);

    // Introduce gap: skip nonce 3 (replace index 2 with wrong nonce)
    const gapped = [...all5];
    gapped[2] = { ...gapped[2], nonce: 4n };

    const batch = { user: user.address, campaignId, claims: gapped };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);

    expect(result.settledCount).to.equal(2n);
    expect(result.rejectedCount).to.equal(3n);

    await settlement.connect(user).settleClaims([batch]);

    // Only 2 claims settled: verify nonce state
    expect(await settlement.lastNonce(user.address, campaignId)).to.equal(2n);
  });

  // Scenario F: Publisher relay — full flow with EIP-712 signature
  it("F: Publisher relay — full flow with signature", async function () {
    const campaignId = await createTestCampaign();

    // Activate via aye vote + evaluate
    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);
    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(1); // Active

    // Build claims
    const impressions = 1000n;
    const cpm = BID_CPM;
    const claims = buildClaims(campaignId, publisher.address, user.address, 3, cpm, impressions);

    // User signs batch off-chain (domain is the relay contract)
    const domain = {
      name: "DatumRelay",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await relay.getAddress(),
    };
    const types = {
      ClaimBatch: [
        { name: "user", type: "address" },
        { name: "campaignId", type: "uint256" },
        { name: "firstNonce", type: "uint256" },
        { name: "lastNonce", type: "uint256" },
        { name: "claimCount", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const deadline = (await ethers.provider.getBlockNumber()) + 200;
    const value = {
      user: user.address,
      campaignId,
      firstNonce: claims[0].nonce,
      lastNonce: claims[claims.length - 1].nonce,
      claimCount: claims.length,
      deadline,
    };
    const signature = await user.signTypedData(domain, types, value);

    // Publisher relays the signed batch
    const signedBatch = {
      user: user.address,
      campaignId,
      claims,
      deadline,
      signature,
      publisherSig: "0x",
    };

    // Record balances before relay settlement
    const pubBalBefore = await settlement.publisherBalance(publisher.address);
    const userBalBefore = await settlement.userBalance(user.address);
    const protoBalBefore = await settlement.protocolBalance();

    const result = await relay.connect(publisher).settleClaimsFor.staticCall([signedBatch]);
    expect(result.settledCount).to.equal(3n);
    expect(result.rejectedCount).to.equal(0n);

    await relay.connect(publisher).settleClaimsFor([signedBatch]);

    // Verify 3-way split for 3 claims (delta, not absolute — shared deployment)
    const totalPayment = (cpm * impressions) / 1000n * 3n;
    const pubPmt = (totalPayment * 5000n) / 10000n;
    const remainder = totalPayment - pubPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protFee = remainder - userPmt;

    expect(await settlement.publisherBalance(publisher.address) - pubBalBefore).to.equal(pubPmt);
    expect(await settlement.userBalance(user.address) - userBalBefore).to.equal(userPmt);
    expect(await settlement.protocolBalance() - protoBalBefore).to.equal(protFee);

    // Publisher withdraws
    const pubBalContract = await settlement.publisherBalance(publisher.address);
    expect(pubBalContract).to.be.gt(0n);
    await settlement.connect(publisher).withdrawPublisher();
    expect(await settlement.publisherBalance(publisher.address)).to.equal(0n);
  });

  // Scenario E: Take rate snapshot
  it("E: Take rate snapshot — settlement uses rate at campaign creation, not updated rate", async function () {
    // Publisher registers at 30%
    const lowPublisher = (await ethers.getSigners())[7];
    await publishers.connect(lowPublisher).registerPublisher(3000); // 30%

    // Create campaign at 30%
    const campaignId = await createTestCampaign(BUDGET, DAILY_CAP, BID_CPM, lowPublisher as any);

    const [,,,,takeRate] = await campaigns.getCampaignForSettlement(campaignId);
    expect(takeRate).to.equal(3000);

    // Publisher queues update to 80%
    await publishers.connect(lowPublisher).updateTakeRate(8000);

    // Mine past delay
    await mineBlocks(TAKE_RATE_DELAY + 1n);
    await publishers.connect(lowPublisher).applyTakeRateUpdate();

    // Verify live rate is 80%
    expect((await publishers.getPublisher(lowPublisher.address)).takeRateBps).to.equal(8000);

    // Activate and settle
    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);

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
