import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumPublishers,
  DatumCampaigns,
  DatumGovernanceV2,
  DatumGovernanceSlash,
  DatumSettlement,
  DatumRelay,
  DatumPauseRegistry,
  DatumBudgetLedger,
  DatumPaymentVault,
  DatumCampaignLifecycle,
  DatumAttestationVerifier,
  DatumClaimValidator,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { mineBlocks, isSubstrate, fundSigners } from "./helpers/mine";

// Integration tests for alpha-2 (12-contract architecture):
// A: Happy path (create → vote → activate → settle → complete → resolve → withdraw)
// B: Termination path (create → activate → nay → terminate → slash)
// C: Pending expiry (timeout → expire → refund)
// D: Nonce gap in claims
// E: Take rate snapshot
// F: Publisher relay full flow

describe("Integration", function () {
  let publishers: DatumPublishers;
  let campaigns: DatumCampaigns;
  let v2: DatumGovernanceV2;
  let slash: DatumGovernanceSlash;
  let settlement: DatumSettlement;
  let relay: DatumRelay;
  let pauseReg: DatumPauseRegistry;
  let ledger: DatumBudgetLedger;
  let vault: DatumPaymentVault;
  let lifecycle: DatumCampaignLifecycle;
  let verifier: DatumAttestationVerifier;
  let claimValidator: DatumClaimValidator;

  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;

  let PENDING_TIMEOUT: bigint;
  let TAKE_RATE_DELAY: bigint;
  const MIN_CPM = 0n;
  const QUORUM_WEIGHTED = parseDOT("0.5");
  const SLASH_BPS = 1000n;
  const TERMINATION_QUORUM = parseDOT("0.5");
  const BASE_GRACE = 5n;
  const GRACE_PER_QUORUM = 10n;
  const MAX_GRACE = 30n;

  const BUDGET = parseDOT("2");
  const DAILY_CAP = parseDOT("1");
  const BID_CPM = parseDOT("0.01");
  const TAKE_RATE_BPS = 5000;

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

  async function createTestCampaign(budget = BUDGET, dailyCap = DAILY_CAP, bidCpm = BID_CPM, pub = publisher) {
    const tx = await campaigns.connect(advertiser).createCampaign(
      pub.address, dailyCap, bidCpm, 0, [], { value: budget }
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

    // Deploy all 12 contracts
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy();

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(TAKE_RATE_DELAY, await pauseReg.getAddress());

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    const VaultFactory = await ethers.getContractFactory("DatumPaymentVault");
    vault = await VaultFactory.deploy();

    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    const CampValFactory = await ethers.getContractFactory("DatumCampaignValidator");
    const campaignValidator = await CampValFactory.deploy(await publishers.getAddress(), ethers.ZeroAddress);
    campaigns = await CampaignsFactory.deploy(MIN_CPM, PENDING_TIMEOUT, await campaignValidator.getAddress(), await pauseReg.getAddress());

    const LifecycleFactory = await ethers.getContractFactory("DatumCampaignLifecycle");
    lifecycle = await LifecycleFactory.deploy(await pauseReg.getAddress(), 432000n);

    const V2Factory = await ethers.getContractFactory("DatumGovernanceV2");
    v2 = await V2Factory.deploy(
      await campaigns.getAddress(),
      QUORUM_WEIGHTED,
      SLASH_BPS,
      TERMINATION_QUORUM,
      BASE_GRACE,
      GRACE_PER_QUORUM,
      MAX_GRACE,
      await pauseReg.getAddress()
    );

    const SlashFactory = await ethers.getContractFactory("DatumGovernanceSlash");
    slash = await SlashFactory.deploy(await v2.getAddress(), await campaigns.getAddress());

    const ValidatorFactory = await ethers.getContractFactory("DatumClaimValidator");
    claimValidator = await ValidatorFactory.deploy(
      await campaigns.getAddress(),
      await publishers.getAddress(),
      await pauseReg.getAddress()
    );

    const SettleFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettleFactory.deploy(await pauseReg.getAddress());

    const RelayFactory = await ethers.getContractFactory("DatumRelay");
    relay = await RelayFactory.deploy(await settlement.getAddress(), await campaigns.getAddress(), await pauseReg.getAddress());

    // Wire all contracts (alpha-2 extended wiring)
    const HelperFactory = await ethers.getContractFactory("DatumGovernanceHelper");
    const govHelper = await HelperFactory.deploy(await campaigns.getAddress());

    await v2.setSlashContract(await slash.getAddress());
    await v2.setLifecycle(await lifecycle.getAddress());
    await v2.setHelper(await govHelper.getAddress());

    await campaigns.setGovernanceContract(await v2.getAddress());
    await campaigns.setSettlementContract(await settlement.getAddress());
    await campaigns.setLifecycleContract(await lifecycle.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());

    await ledger.setCampaigns(await campaigns.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(await lifecycle.getAddress());

    await vault.setSettlement(await settlement.getAddress());

    const VerifierFactory = await ethers.getContractFactory("DatumAttestationVerifier");
    verifier = await VerifierFactory.deploy(await settlement.getAddress(), await campaigns.getAddress());

    await settlement.configure(
      await ledger.getAddress(),
      await vault.getAddress(),
      await lifecycle.getAddress(),
      await relay.getAddress()
    );
    await settlement.setClaimValidator(await claimValidator.getAddress());
    await settlement.setAttestationVerifier(await verifier.getAddress());

    await lifecycle.setCampaigns(await campaigns.getAddress());
    await lifecycle.setBudgetLedger(await ledger.getAddress());
    await lifecycle.setGovernanceContract(await v2.getAddress());
    await lifecycle.setSettlementContract(await settlement.getAddress());

    // Register publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  // Scenario A: Happy path
  it("A: Happy path — create, vote, activate, settle, complete, resolve, withdraw", async function () {
    const campaignId = await createTestCampaign();

    // Vote aye (conviction 0 = 1x weight, no lockup)
    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });

    // Evaluate → Active
    await v2.evaluateCampaign(campaignId);
    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(1);

    // Settle 3 claims
    const impressions = 1000n;
    const cpm = BID_CPM;
    const claims = buildClaims(campaignId, publisher.address, user.address, 3, cpm, impressions);
    const batch = { user: user.address, campaignId, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.settledCount).to.equal(3n);
    await settlement.connect(user).settleClaims([batch]);

    // Verify balances in PaymentVault
    const totalPayment = (cpm * impressions) / 1000n * 3n;
    const pubPmt = (totalPayment * 5000n) / 10000n;
    const remainder = totalPayment - pubPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protFee = remainder - userPmt;

    expect(await vault.publisherBalance(publisher.address)).to.equal(pubPmt);
    expect(await vault.userBalance(user.address)).to.equal(userPmt);
    expect(await vault.protocolBalance()).to.equal(protFee);

    // Complete campaign via Lifecycle — refund remaining budget to advertiser
    const advBalBefore = await ethers.provider.getBalance(advertiser.address);
    const remaining = await ledger.getRemainingBudget(campaignId);
    const completeTx = await lifecycle.connect(advertiser).completeCampaign(campaignId);
    const completeReceipt = await completeTx.wait();
    const advBalAfter = await ethers.provider.getBalance(advertiser.address);

    if (!(await isSubstrate())) {
      const gasUsed = completeReceipt!.gasUsed * completeReceipt!.gasPrice;
      expect(advBalAfter - advBalBefore + gasUsed).to.equal(remaining);
    }
    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(3); // Completed

    // Evaluate to mark resolved
    await v2.evaluateCampaign(campaignId);
    expect(await v2.resolved(campaignId)).to.be.true;

    // Withdraw voter stake (conviction 0 = no lockup needed)
    const [, , , lockedUntil] = await v2.getVote(campaignId, voter1.address);
    const curBlock = await ethers.provider.getBlockNumber();
    if (Number(lockedUntil) > curBlock) {
      await mineBlocks(Number(lockedUntil) - curBlock + 1);
    }

    await v2.connect(voter1).withdraw(campaignId);
    const [dir] = await v2.getVote(campaignId, voter1.address);
    expect(dir).to.equal(0);
  });

  // Scenario B: Termination path
  it("B: Termination path — nay majority terminates via Lifecycle; slash distributed", async function () {
    const campaignId = await createTestCampaign();

    // Activate
    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);
    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(1);

    // Nay vote with larger weight
    const nayStake = QUORUM_WEIGHTED * 2n;
    await v2.connect(voter2).vote(campaignId, false, 0, { value: nayStake });

    // Mine past grace period (capped linear)
    // total = 0.5 + 1.0 = 1.5 DOT, grace = 5 + (1.5*10/0.5) = 5 + 30 = 35 > MAX_GRACE=30 → 30
    await mineBlocks(MAX_GRACE + 1n);

    // Evaluate → terminates via Lifecycle
    await v2.evaluateCampaign(campaignId);
    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(4); // Terminated
    expect(await v2.resolved(campaignId)).to.be.true;

    // Aye voter withdraws — slashed
    await v2.connect(voter1).withdraw(campaignId);
    const expectedSlash = QUORUM_WEIGHTED * SLASH_BPS / 10000n;
    expect(await v2.slashCollected(campaignId)).to.equal(expectedSlash);

    // Finalize and claim
    await slash.finalizeSlash(campaignId);
    expect(await slash.finalized(campaignId)).to.be.true;

    const claimable = await slash.getClaimable(campaignId, voter2.address);
    expect(claimable).to.equal(expectedSlash);

    await slash.connect(voter2).claimSlashReward(campaignId);
    expect(await slash.getClaimable(campaignId, voter2.address)).to.equal(0n);
  });

  // Scenario C: Pending expiry
  it("C: Pending expiry — budget returned via Lifecycle", async function () {
    const campaignId = await createTestCampaign();

    await mineBlocks(PENDING_TIMEOUT + 1n);

    const advBalBefore = await ethers.provider.getBalance(advertiser.address);
    await lifecycle.connect(user).expirePendingCampaign(campaignId);
    const advBalAfter = await ethers.provider.getBalance(advertiser.address);

    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(5); // Expired
    expect(advBalAfter - advBalBefore).to.equal(BUDGET);
  });

  // Scenario D: Nonce gap
  it("D: Gap at claim 3 of 5 — only 1-2 settle", async function () {
    const campaignId = await createTestCampaign();
    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);

    const all5 = buildClaims(campaignId, publisher.address, user.address, 5, BID_CPM, 100n);
    const gapped = [...all5];
    gapped[2] = { ...gapped[2], nonce: 4n };

    const batch = { user: user.address, campaignId, claims: gapped };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);

    expect(result.settledCount).to.equal(2n);
    expect(result.rejectedCount).to.equal(3n);

    await settlement.connect(user).settleClaims([batch]);
    expect(await settlement.lastNonce(user.address, campaignId)).to.equal(2n);
  });

  // Scenario E: Take rate snapshot
  it("E: Take rate snapshot — settlement uses rate at creation, not updated rate", async function () {
    const lowPublisher = (await ethers.getSigners())[7];
    await publishers.connect(lowPublisher).registerPublisher(3000); // 30%

    const campaignId = await createTestCampaign(BUDGET, DAILY_CAP, BID_CPM, lowPublisher as any);

    const [, , , takeRate] = await campaigns.getCampaignForSettlement(campaignId);
    expect(takeRate).to.equal(3000);

    // Update to 80%
    await publishers.connect(lowPublisher).updateTakeRate(8000);
    await mineBlocks(TAKE_RATE_DELAY + 1n);
    await publishers.connect(lowPublisher).applyTakeRateUpdate();

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

    expect(await vault.publisherBalance(lowPublisher.address)).to.equal(pubPmtAt30);
  });

  // Scenario F: Publisher relay
  it("F: Publisher relay — full flow with EIP-712 signature", async function () {
    const campaignId = await createTestCampaign();

    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);
    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(1);

    const impressions = 1000n;
    const cpm = BID_CPM;
    const claims = buildClaims(campaignId, publisher.address, user.address, 3, cpm, impressions);

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

    const signedBatch = {
      user: user.address,
      campaignId,
      claims,
      deadline,
      signature,
      publisherSig: "0x",
    };

    const pubBalBefore = await vault.publisherBalance(publisher.address);
    const userBalBefore = await vault.userBalance(user.address);
    const protoBalBefore = await vault.protocolBalance();

    const result = await relay.connect(publisher).settleClaimsFor.staticCall([signedBatch]);
    expect(result.settledCount).to.equal(3n);

    await relay.connect(publisher).settleClaimsFor([signedBatch]);

    const totalPayment = (cpm * impressions) / 1000n * 3n;
    const pubPmt = (totalPayment * 5000n) / 10000n;
    const remainder = totalPayment - pubPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protFee = remainder - userPmt;

    expect(await vault.publisherBalance(publisher.address) - pubBalBefore).to.equal(pubPmt);
    expect(await vault.userBalance(user.address) - userBalBefore).to.equal(userPmt);
    expect(await vault.protocolBalance() - protoBalBefore).to.equal(protFee);

    // Publisher withdraws from vault
    await vault.connect(publisher).withdrawPublisher();
    expect(await vault.publisherBalance(publisher.address)).to.equal(0n);
  });

  // Scenario G: Settlement blocklist check (S12)
  it("G: settlement rejects claims for blocked publisher (reason 11)", async function () {
    const campaignId = await createTestCampaign();

    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);
    expect(await campaigns.getCampaignStatus(campaignId)).to.equal(1);

    // Block the publisher AFTER campaign activation
    await publishers.blockAddress(publisher.address);

    const impressions = 1000n;
    const cpm = BID_CPM;
    const claims = buildClaims(campaignId, publisher.address, user.address, 1, cpm, impressions);

    const result = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId, claims }
    ]);
    expect(result.rejectedCount).to.equal(1n);
    expect(result.settledCount).to.equal(0n);

    // Verify reason code 11 (blocked publisher) in ClaimRejected event
    await expect(
      settlement.connect(user).settleClaims([{ user: user.address, campaignId, claims }])
    ).to.emit(settlement, "ClaimRejected").withArgs(campaignId, user.address, 1n, 11);

    // Unblock for subsequent tests
    await publishers.unblockAddress(publisher.address);
  });

  // Scenario G2: Settlement allows claims for unblocked publisher
  it("G2: settlement allows claims after publisher unblocked", async function () {
    const campaignId = await createTestCampaign();

    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);

    const impressions = 1000n;
    const cpm = BID_CPM;
    const claims = buildClaims(campaignId, publisher.address, user.address, 1, cpm, impressions);

    const result = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId, claims }
    ]);
    expect(result.settledCount).to.equal(1n);
    expect(result.rejectedCount).to.equal(0n);
  });

  // =========================================================================
  // P1: Mandatory publisher attestation (DatumAttestationVerifier)
  // =========================================================================

  // H1: attested settlement with valid publisher co-sig succeeds
  it("H1: attested settlement with valid publisher co-sig", async function () {
    const campaignId = await createTestCampaign();

    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);

    const impressions = 1000n;
    const cpm = BID_CPM;
    const claims = buildClaims(campaignId, publisher.address, user.address, 1, cpm, impressions);

    // Publisher signs attestation
    const domain = {
      name: "DatumAttestationVerifier",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await verifier.getAddress(),
    };
    const types = {
      PublisherAttestation: [
        { name: "campaignId", type: "uint256" },
        { name: "user", type: "address" },
        { name: "firstNonce", type: "uint256" },
        { name: "lastNonce", type: "uint256" },
        { name: "claimCount", type: "uint256" },
      ],
    };
    const value = {
      campaignId,
      user: user.address,
      firstNonce: claims[0].nonce,
      lastNonce: claims[claims.length - 1].nonce,
      claimCount: claims.length,
    };
    const publisherSig = await publisher.signTypedData(domain, types, value);

    const result = await verifier.connect(user).settleClaimsAttested.staticCall([
      { user: user.address, campaignId, claims, publisherSig }
    ]);
    expect(result.settledCount).to.equal(1n);

    await verifier.connect(user).settleClaimsAttested([
      { user: user.address, campaignId, claims, publisherSig }
    ]);
  });

  // H2: attested settlement without co-sig reverts E33
  it("H2: attested settlement without publisher co-sig reverts E33", async function () {
    const campaignId = await createTestCampaign();

    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);

    const impressions = 1000n;
    const cpm = BID_CPM;
    const claims = buildClaims(campaignId, publisher.address, user.address, 1, cpm, impressions);

    await expect(
      verifier.connect(user).settleClaimsAttested([
        { user: user.address, campaignId, claims, publisherSig: "0x" }
      ])
    ).to.be.revertedWith("E33");
  });

  // H3: attested settlement with wrong signer reverts E34
  it("H3: attested settlement with wrong publisher signer reverts E34", async function () {
    const campaignId = await createTestCampaign();

    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);

    const impressions = 1000n;
    const cpm = BID_CPM;
    const claims = buildClaims(campaignId, publisher.address, user.address, 1, cpm, impressions);

    // user signs instead of publisher
    const domain = {
      name: "DatumAttestationVerifier",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await verifier.getAddress(),
    };
    const types = {
      PublisherAttestation: [
        { name: "campaignId", type: "uint256" },
        { name: "user", type: "address" },
        { name: "firstNonce", type: "uint256" },
        { name: "lastNonce", type: "uint256" },
        { name: "claimCount", type: "uint256" },
      ],
    };
    const wrongSig = await user.signTypedData(domain, types, {
      campaignId,
      user: user.address,
      firstNonce: claims[0].nonce,
      lastNonce: claims[claims.length - 1].nonce,
      claimCount: claims.length,
    });

    await expect(
      verifier.connect(user).settleClaimsAttested([
        { user: user.address, campaignId, claims, publisherSig: wrongSig }
      ])
    ).to.be.revertedWith("E34");
  });

  // H4: non-user caller reverts E32
  it("H4: attested settlement by non-user reverts E32", async function () {
    const campaignId = await createTestCampaign();

    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);

    const claims = buildClaims(campaignId, publisher.address, user.address, 1, BID_CPM, 1000n);

    await expect(
      verifier.connect(publisher).settleClaimsAttested([
        { user: user.address, campaignId, claims, publisherSig: "0x" }
      ])
    ).to.be.revertedWith("E32");
  });

  // H5: open campaign attestation verifies against claims[0].publisher
  it("H5: attested settlement on open campaign verifies serving publisher", async function () {
    // Create open campaign (publisher=address(0))
    const tx = await campaigns.connect(advertiser).createCampaign(
      ethers.ZeroAddress, DAILY_CAP, BID_CPM, 0, [], { value: BUDGET }
    );
    await tx.wait();
    const campaignId = await campaigns.nextCampaignId() - 1n;

    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);

    const claims = buildClaims(campaignId, publisher.address, user.address, 1, BID_CPM, 1000n);

    // Publisher signs attestation (serving publisher, not campaign publisher)
    const domain = {
      name: "DatumAttestationVerifier",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await verifier.getAddress(),
    };
    const types = {
      PublisherAttestation: [
        { name: "campaignId", type: "uint256" },
        { name: "user", type: "address" },
        { name: "firstNonce", type: "uint256" },
        { name: "lastNonce", type: "uint256" },
        { name: "claimCount", type: "uint256" },
      ],
    };
    const publisherSig = await publisher.signTypedData(domain, types, {
      campaignId,
      user: user.address,
      firstNonce: claims[0].nonce,
      lastNonce: claims[claims.length - 1].nonce,
      claimCount: claims.length,
    });

    const result = await verifier.connect(user).settleClaimsAttested.staticCall([
      { user: user.address, campaignId, claims, publisherSig }
    ]);
    expect(result.settledCount).to.equal(1n);

    await verifier.connect(user).settleClaimsAttested([
      { user: user.address, campaignId, claims, publisherSig }
    ]);
  });

  // H6: open campaign attestation with wrong signer reverts E34
  it("H6: open campaign attested settlement with wrong signer reverts E34", async function () {
    const tx = await campaigns.connect(advertiser).createCampaign(
      ethers.ZeroAddress, DAILY_CAP, BID_CPM, 0, [], { value: BUDGET }
    );
    await tx.wait();
    const campaignId = await campaigns.nextCampaignId() - 1n;

    await v2.connect(voter1).vote(campaignId, true, 0, { value: QUORUM_WEIGHTED });
    await v2.evaluateCampaign(campaignId);

    const claims = buildClaims(campaignId, publisher.address, user.address, 1, BID_CPM, 1000n);

    // User signs instead of publisher — should fail
    const domain = {
      name: "DatumAttestationVerifier",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await verifier.getAddress(),
    };
    const types = {
      PublisherAttestation: [
        { name: "campaignId", type: "uint256" },
        { name: "user", type: "address" },
        { name: "firstNonce", type: "uint256" },
        { name: "lastNonce", type: "uint256" },
        { name: "claimCount", type: "uint256" },
      ],
    };
    const wrongSig = await user.signTypedData(domain, types, {
      campaignId,
      user: user.address,
      firstNonce: claims[0].nonce,
      lastNonce: claims[claims.length - 1].nonce,
      claimCount: claims.length,
    });

    await expect(
      verifier.connect(user).settleClaimsAttested([
        { user: user.address, campaignId, claims, publisherSig: wrongSig }
      ])
    ).to.be.revertedWith("E34");
  });
});
