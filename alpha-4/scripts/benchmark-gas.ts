/**
 * Gas benchmarks for DATUM Alpha-4 contracts (EVM).
 *
 * Measures weight (gas units) for seven key operations:
 *   1. createCampaign     (Campaigns -> BudgetLedger escrow)
 *   2. vote (aye)         (GovernanceV2, activates via evaluateCampaign)
 *   3. vote (nay)         (GovernanceV2, terminates via CampaignLifecycle)
 *   4. settleClaims (1)   (Settlement -> BudgetLedger -> PaymentVault)
 *   5. settleClaims (5)   (Settlement, max batch)
 *   6. withdrawUser       (PaymentVault)
 *   7. withdrawPublisher  (PaymentVault)
 *
 * Then runs batch scaling tests (1-5 claims) and prints a scaling table.
 *
 * Outputs markdown tables suitable for BENCHMARKS.md.
 *
 * Run:
 *   npx hardhat run scripts/benchmark-gas.ts
 */
import { ethers } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import { fundSigners } from "../test/helpers/mine";
import { ethersKeccakAbi } from "../test/helpers/hash";

// ---------------------------------------------------------------------------
// Claim hash builder (keccak256)
// ---------------------------------------------------------------------------

function computeClaimHash(
  campaignId: bigint,
  publisher: string,
  user: string,
  eventCount: bigint,
  ratePlanck: bigint,
  actionType: number,
  clickSessionHash: string,
  nonce: bigint,
  previousClaimHash: string
): string {
  const types = ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"];
  const values = [campaignId, publisher, user, eventCount, ratePlanck, actionType, clickSessionHash, nonce, previousClaimHash];
  return ethersKeccakAbi(types, values);
}

function buildClaimChain(
  campaignId: bigint,
  publisher: string,
  user: string,
  count: number,
  cpm: bigint,
  impressions: bigint
) {
  const claims = [];
  let prevHash = ethers.ZeroHash;
  for (let i = 1; i <= count; i++) {
    const nonce = BigInt(i);
    const claimHash = computeClaimHash(
      campaignId, publisher, user, impressions, cpm, 0, ethers.ZeroHash, nonce, prevHash
    );
    claims.push({
      campaignId,
      publisher,
      eventCount: impressions,
      ratePlanck: cpm,
      actionType: 0,
      clickSessionHash: ethers.ZeroHash,
      nonce,
      previousClaimHash: prevHash,
      claimHash,
      zkProof: new Array(8).fill(ethers.ZeroHash),
      nullifier: ethers.ZeroHash,
      actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
    });
    prevHash = claimHash;
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const net = await ethers.provider.getNetwork();
  console.log(`Network: chainId=${net.chainId}`);
  await fundSigners();

  const signers = await ethers.getSigners();
  const [owner, voter1, voter2, advertiser, publisher, user] = signers;

  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 1n;
  console.log(`gasPrice: ${gasPrice}\n`);

  // ---------------------------------------------------------------------------
  // Parameters — short delays for benchmarks
  // ---------------------------------------------------------------------------
  const TAKE_RATE_BPS = 5000;
  const TAKE_RATE_DELAY = 10n;
  const PENDING_TIMEOUT = 100n;
  const MIN_CPM_FLOOR = 0n;
  const INACTIVITY_TIMEOUT = 100n;

  // Governance
  const QUORUM = parseDOT("1");
  const SLASH_BPS = 1000n;
  const TERMINATION_QUORUM = QUORUM;
  const BASE_GRACE = 10n;
  const GRACE_PER_QUORUM = 5n;
  const MAX_GRACE = 100n;

  // Campaign
  const BID_CPM = parseDOT("0.016"); // clean denomination (10^6 multiple)
  const BUDGET = parseDOT("50");
  const DAILY_CAP = parseDOT("50"); // high cap to avoid daily-cap rejections
  const IMPRESSIONS_1 = 1000n;
  const IMPRESSIONS_5 = 200n; // 5 claims x 200 impressions each

  // ---------------------------------------------------------------------------
  // Deploy all 13 core contracts in dependency order (alpha-4)
  // ---------------------------------------------------------------------------
  console.log("Deploying 13 contracts...\n");

  // Tier 0: No dependencies
  const pauseRegistry = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
    owner.address, voter1.address, voter2.address
  );
  console.log("  PauseRegistry:", await pauseRegistry.getAddress());

  const timelock = await (await ethers.getContractFactory("DatumTimelock")).deploy();
  console.log("  Timelock:", await timelock.getAddress());

  const zkVerifier = await (await ethers.getContractFactory("DatumZKVerifier")).deploy();
  console.log("  ZKVerifier:", await zkVerifier.getAddress());

  const budgetLedger = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
  console.log("  BudgetLedger:", await budgetLedger.getAddress());

  const paymentVault = await (await ethers.getContractFactory("DatumPaymentVault")).deploy();
  console.log("  PaymentVault:", await paymentVault.getAddress());

  // Tier 1: Depends on PauseRegistry
  const publishers = await (await ethers.getContractFactory("DatumPublishers")).deploy(
    TAKE_RATE_DELAY, await pauseRegistry.getAddress()
  );
  console.log("  Publishers:", await publishers.getAddress());

  const lifecycle = await (await ethers.getContractFactory("DatumCampaignLifecycle")).deploy(
    await pauseRegistry.getAddress(), INACTIVITY_TIMEOUT
  );
  console.log("  CampaignLifecycle:", await lifecycle.getAddress());

  // Tier 2: Depends on Publishers + PauseRegistry
  const campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(
    MIN_CPM_FLOOR, PENDING_TIMEOUT,
    await publishers.getAddress(), await pauseRegistry.getAddress()
  );
  console.log("  Campaigns:", await campaigns.getAddress());

  // Tier 3: Depends on Campaigns + Publishers + PauseRegistry
  const claimValidator = await (await ethers.getContractFactory("DatumClaimValidator")).deploy(
    await campaigns.getAddress(),
    await publishers.getAddress(),
    await pauseRegistry.getAddress()
  );
  console.log("  ClaimValidator:", await claimValidator.getAddress());

  const settlement = await (await ethers.getContractFactory("DatumSettlement")).deploy(
    await pauseRegistry.getAddress()
  );
  console.log("  Settlement:", await settlement.getAddress());

  const governance = await (await ethers.getContractFactory("DatumGovernanceV2")).deploy(
    await campaigns.getAddress(),
    QUORUM, SLASH_BPS,
    TERMINATION_QUORUM, BASE_GRACE, GRACE_PER_QUORUM, MAX_GRACE,
    await pauseRegistry.getAddress()
  );
  console.log("  GovernanceV2:", await governance.getAddress());

  // Tier 4: Depends on Settlement + Campaigns + PauseRegistry
  const relay = await (await ethers.getContractFactory("DatumRelay")).deploy(
    await settlement.getAddress(),
    await campaigns.getAddress(),
    await pauseRegistry.getAddress()
  );
  console.log("  Relay:", await relay.getAddress());

  const attestationVerifier = await (await ethers.getContractFactory("DatumAttestationVerifier")).deploy(
    await settlement.getAddress(),
    await campaigns.getAddress(),
    await pauseRegistry.getAddress()
  );
  console.log("  AttestationVerifier:", await attestationVerifier.getAddress());

  // ---------------------------------------------------------------------------
  // Wire cross-contract references (alpha-4)
  // ---------------------------------------------------------------------------
  console.log("\nWiring cross-contract references...");

  // Settlement.configure(budgetLedger, paymentVault, lifecycle, relay) — 4 args
  await (await settlement.configure(
    await budgetLedger.getAddress(),
    await paymentVault.getAddress(),
    await lifecycle.getAddress(),
    await relay.getAddress()
  )).wait();

  await (await settlement.setClaimValidator(await claimValidator.getAddress())).wait();
  await (await settlement.setAttestationVerifier(await attestationVerifier.getAddress())).wait();
  await (await settlement.setPublishers(await publishers.getAddress())).wait();

  // Campaigns: 4 setters
  await (await campaigns.setBudgetLedger(await budgetLedger.getAddress())).wait();
  await (await campaigns.setLifecycleContract(await lifecycle.getAddress())).wait();
  await (await campaigns.setGovernanceContract(await governance.getAddress())).wait();
  await (await campaigns.setSettlementContract(await settlement.getAddress())).wait();

  // BudgetLedger: 3 setters
  await (await budgetLedger.setCampaigns(await campaigns.getAddress())).wait();
  await (await budgetLedger.setSettlement(await settlement.getAddress())).wait();
  await (await budgetLedger.setLifecycle(await lifecycle.getAddress())).wait();

  // PaymentVault: 1 setter
  await (await paymentVault.setSettlement(await settlement.getAddress())).wait();

  // CampaignLifecycle: 4 setters
  await (await lifecycle.setCampaigns(await campaigns.getAddress())).wait();
  await (await lifecycle.setBudgetLedger(await budgetLedger.getAddress())).wait();
  await (await lifecycle.setGovernanceContract(await governance.getAddress())).wait();
  await (await lifecycle.setSettlementContract(await settlement.getAddress())).wait();

  // GovernanceV2: lifecycle only (campaigns is wired in the constructor and
  // setCampaigns is lock-once "already set" if called again)
  await (await governance.setLifecycle(await lifecycle.getAddress())).wait();

  // Register publisher
  await (await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS)).wait();

  console.log("All 13 contracts deployed and wired.\n");

  // ---------------------------------------------------------------------------
  // Measurement infrastructure
  // ---------------------------------------------------------------------------
  interface Measurement { label: string; gasUsed: bigint }
  const results: Measurement[] = [];

  async function measure(label: string, txPromise: Promise<any>): Promise<bigint> {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed as bigint;
    results.push({ label, gasUsed });
    console.log(`  ${label}: gasUsed=${gasUsed}`);
    return gasUsed;
  }

  // Parse campaign ID from CampaignCreated event
  async function createCampaignAndGetId(signer: any, budget = BUDGET): Promise<bigint> {
    const pots = [{ actionType: 0, budgetPlanck: budget, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }];
    const tx = await campaigns.connect(signer).createCampaign(
      publisher.address, pots, [], false, ethers.ZeroAddress, 0n, 0n, { value: budget }
    );
    const receipt = await tx.wait();
    const log = receipt!.logs.find((l: any) => {
      try {
        return campaigns.interface.parseLog({ topics: l.topics, data: l.data })?.name === "CampaignCreated";
      } catch { return false; }
    });
    const parsed = campaigns.interface.parseLog({ topics: log!.topics as string[], data: log!.data });
    return parsed!.args[0] as bigint;
  }

  // Vote aye + mine past grace + evaluate to activate
  async function activateCampaign(cid: bigint, voter: any) {
    await (await governance.connect(voter).vote(cid, true, 0, { value: QUORUM })).wait();
    // Mine past ayeGrace (baseGraceBlocks + buffer)
    for (let i = 0; i < Number(BASE_GRACE) + Number(GRACE_PER_QUORUM) + 2; i++) {
      await ethers.provider.send("evm_mine", []);
    }
    await (await governance.evaluateCampaign(cid)).wait();
  }

  // =========================================================================
  // BENCHMARKS
  // =========================================================================

  // ---------------------------------------------------------------------------
  // 1. createCampaign (Campaigns -> BudgetLedger.initializeBudget{value})
  // ---------------------------------------------------------------------------
  console.log("1. createCampaign");
  const benchPots = [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }];
  await measure("createCampaign",
    campaigns.connect(advertiser).createCampaign(
      publisher.address, benchPots, [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    )
  );

  // Pre-create campaigns for subsequent benchmarks
  const cidVote = await createCampaignAndGetId(advertiser);
  const cidSettle1 = await createCampaignAndGetId(advertiser);
  const cidSettle5 = await createCampaignAndGetId(advertiser);

  // ---------------------------------------------------------------------------
  // 2. vote (aye) — GovernanceV2
  // ---------------------------------------------------------------------------
  console.log("2. vote (aye)");
  const cidAye = await createCampaignAndGetId(advertiser);
  await measure("vote (aye)",
    governance.connect(voter1).vote(cidAye, true, 0, { value: QUORUM })
  );

  // Activate the settlement campaigns
  await activateCampaign(cidSettle1, voter2);
  await activateCampaign(cidSettle5, voter2);

  // ---------------------------------------------------------------------------
  // 3. vote (nay) — GovernanceV2, terminates via CampaignLifecycle
  // ---------------------------------------------------------------------------
  console.log("3. vote (nay)");
  await activateCampaign(cidVote, voter1);

  await measure("vote (nay)",
    governance.connect(voter2).vote(cidVote, false, 0, { value: QUORUM })
  );

  // Mine past the grace period, then evaluate to terminate
  const graceBlocks = Number(BASE_GRACE) + 2 * Number(GRACE_PER_QUORUM) + 1;
  for (let i = 0; i < graceBlocks; i++) {
    await ethers.provider.send("evm_mine", []);
  }
  await (await governance.evaluateCampaign(cidVote)).wait();

  // ---------------------------------------------------------------------------
  // 4. settleClaims — 1 claim (Settlement -> BudgetLedger -> PaymentVault)
  // ---------------------------------------------------------------------------
  console.log("4. settleClaims (1 claim)");
  {
    const status = await campaigns.getCampaignStatus(cidSettle1);
    const remaining = await budgetLedger.getRemainingBudget(cidSettle1, 0);
    console.log(`  cidSettle1=${cidSettle1} status=${status} remainingBudget=${remaining}`);
  }
  const claims1 = buildClaimChain(cidSettle1, publisher.address, user.address, 1, BID_CPM, IMPRESSIONS_1);

  try {
    const sr = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId: cidSettle1, claims: claims1 }
    ]);
    console.log(`  staticCall: settled=${sr.settledCount} rejected=${sr.rejectedCount} totalPaid=${sr.totalPaid}`);
  } catch (e: any) {
    console.log(`  staticCall failed: ${e.message?.slice(0, 120)}`);
  }

  await measure("settleClaims (1 claim)",
    settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cidSettle1, claims: claims1 }
    ])
  );

  {
    const pubBal = await paymentVault.publisherBalance(publisher.address);
    const userBal = await paymentVault.userBalance(user.address);
    const protoBal = await paymentVault.protocolBalance();
    console.log(`  after: publisherBal=${pubBal} userBal=${userBal} protocolBal=${protoBal}`);
  }

  // ---------------------------------------------------------------------------
  // 5. settleClaims — 5 claims (MAX_CLAIMS_PER_BATCH)
  // ---------------------------------------------------------------------------
  console.log("5. settleClaims (5 claims)");
  const claims5 = buildClaimChain(cidSettle5, publisher.address, user.address, 5, BID_CPM, IMPRESSIONS_5);
  await measure("settleClaims (5 claims)",
    settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cidSettle5, claims: claims5 }
    ])
  );

  // ---------------------------------------------------------------------------
  // 6. withdrawUser (PaymentVault)
  // ---------------------------------------------------------------------------
  console.log("6. withdrawUser");
  {
    const userBal = await paymentVault.userBalance(user.address);
    console.log(`  userBalance: ${userBal}`);
    if (userBal === 0n) {
      console.log("  Re-settling to fund user balance...");
      const cidW = await createCampaignAndGetId(advertiser);
      await activateCampaign(cidW, voter1);
      const claimsW = buildClaimChain(cidW, publisher.address, user.address, 1, BID_CPM, IMPRESSIONS_1);
      await (await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cidW, claims: claimsW }
      ])).wait();
      const newBal = await paymentVault.userBalance(user.address);
      console.log(`  userBalance after re-settle: ${newBal}`);
    }
  }
  await measure("withdrawUser",
    paymentVault.connect(user).withdrawUser()
  );

  // ---------------------------------------------------------------------------
  // 7. withdrawPublisher (PaymentVault)
  // ---------------------------------------------------------------------------
  console.log("7. withdrawPublisher");
  {
    const pubBal = await paymentVault.publisherBalance(publisher.address);
    console.log(`  publisherBalance: ${pubBal}`);
    if (pubBal === 0n) {
      console.log("  Re-settling to fund publisher balance...");
      const cidW = await createCampaignAndGetId(advertiser);
      await activateCampaign(cidW, voter1);
      const claimsW = buildClaimChain(cidW, publisher.address, user.address, 1, BID_CPM, IMPRESSIONS_1);
      await (await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cidW, claims: claimsW }
      ])).wait();
      const newBal = await paymentVault.publisherBalance(publisher.address);
      console.log(`  publisherBalance after re-settle: ${newBal}`);
    }
  }
  await measure("withdrawPublisher",
    paymentVault.connect(publisher).withdrawPublisher()
  );

  // =========================================================================
  // Results table
  // =========================================================================
  console.log("\n=== Main Benchmark Results ===\n");
  console.log(
    `${"Function".padEnd(30)} | ${"gasUsed (weight)".padEnd(22)} | DOT cost (at gasPrice=${gasPrice})`
  );
  console.log("-".repeat(90));
  for (const r of results) {
    const cost = (r.gasUsed * gasPrice).toString();
    console.log(`${r.label.padEnd(30)} | ${r.gasUsed.toString().padEnd(22)} | ${cost}`);
  }

  const settle1Gas = results.find(r => r.label === "settleClaims (1 claim)")!.gasUsed;
  const settle5Gas = results.find(r => r.label === "settleClaims (5 claims)")!.gasUsed;
  console.log(`\nsettleClaims scale: 5-claim / 1-claim = ${(Number(settle5Gas) / Number(settle1Gas)).toFixed(2)}x`);
  console.log(`Per-claim cost in 5-batch: ${(Number(settle5Gas) / 5).toFixed(0)} vs single: ${Number(settle1Gas)}`);

  // =========================================================================
  // Batch scaling section
  // =========================================================================
  console.log("\n=== Batch Scaling Benchmark ===\n");
  console.log("Testing settleClaims at batch sizes 1-10 (contract inner cap = 50 claims/batch)...\n");

  const BATCH_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const SCALE_IMPRESSIONS = 100n;
  const SCALE_BUDGET = parseDOT("5000");

  interface ScalingResult {
    size: number;
    gasUsed: bigint;
    perClaim: bigint;
    scaleVs1: string;
  }
  const scalingResults: ScalingResult[] = [];
  let baseScaleGas = 0n;

  for (const size of BATCH_SIZES) {
    const cid = await createCampaignAndGetId(advertiser, SCALE_BUDGET);
    await activateCampaign(cid, voter1);

    const claims = buildClaimChain(
      cid, publisher.address, user.address, size, BID_CPM, SCALE_IMPRESSIONS
    );

    try {
      const tx = await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cid, claims }
      ]);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed as bigint;
      const perClaim = gasUsed / BigInt(size);
      if (size === 1) baseScaleGas = gasUsed;
      const scale = baseScaleGas > 0n
        ? (Number(gasUsed) / Number(baseScaleGas)).toFixed(2)
        : "---";

      scalingResults.push({ size, gasUsed, perClaim, scaleVs1: scale });
    } catch (err: any) {
      const reason = err.message?.slice(0, 120) ?? String(err).slice(0, 120);
      console.log(`  Batch size ${size}: FAILED — ${reason}`);
      break;
    }
  }

  console.log("| Batch Size | Gas Used | Per-Claim Gas | Scaling vs 1 |");
  console.log("|------------|----------|---------------|--------------|");
  for (const r of scalingResults) {
    console.log(
      `| ${String(r.size).padEnd(10)} | ${String(r.gasUsed).padEnd(8)} | ${String(r.perClaim).padEnd(13)} | ${r.scaleVs1.padEnd(12)} |`
    );
  }

  if (scalingResults.length >= 2) {
    const first = scalingResults[0];
    const last = scalingResults[scalingResults.length - 1];
    const marginal = (Number(last.gasUsed) - Number(first.gasUsed)) / (last.size - first.size);
    const overhead = Number(first.gasUsed) - marginal;
    console.log(`\nScaling analysis:`);
    console.log(`  Base overhead (tx + 1st claim): ~${first.gasUsed}`);
    console.log(`  Marginal cost per additional claim: ~${marginal.toFixed(0)}`);
    console.log(`  Estimated fixed overhead: ~${overhead.toFixed(0)}`);
    console.log(`  Efficiency gain at batch 5: ${((1 - Number(last.perClaim) / Number(first.gasUsed)) * 100).toFixed(1)}% per-claim savings`);
  }

  // =========================================================================
  // Multi-campaign scaling: 1 user settling across N campaigns (settleClaims)
  // =========================================================================
  console.log("\n=== Multi-Campaign Scaling (1 user × N campaigns × 1 claim each) ===\n");

  const MULTI_CAMP_SIZES = [1, 2, 3, 5, 8, 10];
  interface MultiCampResult { campaigns: number; gasUsed: bigint; perCampaign: bigint; scaleVs1: string }
  const multiCampResults: MultiCampResult[] = [];
  let baseMultiCampGas = 0n;

  // Get a fresh user signer for multi-campaign tests
  const multiUser = signers[7] ?? user;

  for (const campCount of MULTI_CAMP_SIZES) {
    // Create N campaigns, activate each, build 1 claim per campaign
    const batches = [];
    for (let c = 0; c < campCount; c++) {
      const cid = await createCampaignAndGetId(advertiser, SCALE_BUDGET);
      await activateCampaign(cid, voter1);
      const claims = buildClaimChain(cid, publisher.address, multiUser.address, 1, BID_CPM, SCALE_IMPRESSIONS);
      batches.push({ user: multiUser.address, campaignId: cid, claims });
    }

    try {
      const tx = await settlement.connect(multiUser).settleClaims(batches);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed as bigint;
      const perCampaign = gasUsed / BigInt(campCount);
      if (campCount === 1) baseMultiCampGas = gasUsed;
      const scale = baseMultiCampGas > 0n
        ? (Number(gasUsed) / Number(baseMultiCampGas)).toFixed(2)
        : "---";
      multiCampResults.push({ campaigns: campCount, gasUsed, perCampaign, scaleVs1: scale });
    } catch (err: any) {
      console.log(`  ${campCount} campaigns: FAILED — ${err.message?.slice(0, 120)}`);
      break;
    }
  }

  console.log("| Campaigns | Gas Used | Per-Campaign Gas | Scaling vs 1 |");
  console.log("|-----------|----------|------------------|--------------|");
  for (const r of multiCampResults) {
    console.log(
      `| ${String(r.campaigns).padEnd(9)} | ${String(r.gasUsed).padEnd(8)} | ${String(r.perCampaign).padEnd(16)} | ${r.scaleVs1.padEnd(12)} |`
    );
  }

  if (multiCampResults.length >= 2) {
    const first = multiCampResults[0];
    const last = multiCampResults[multiCampResults.length - 1];
    const marginal = (Number(last.gasUsed) - Number(first.gasUsed)) / (last.campaigns - first.campaigns);
    console.log(`\n  Marginal cost per additional campaign: ~${marginal.toFixed(0)}`);
    console.log(`  Fixed overhead: ~${(Number(first.gasUsed) - marginal).toFixed(0)}`);
  }

  // =========================================================================
  // Multi-user scaling: N users × 1 campaign × 1 claim (settleClaimsMulti)
  // =========================================================================
  console.log("\n=== Multi-User Scaling (N users × 1 campaign × 1 claim, settleClaimsMulti) ===\n");

  const MULTI_USER_SIZES = [1, 2, 3, 5, 8, 10];
  interface MultiUserResult { users: number; gasUsed: bigint; perUser: bigint; scaleVs1: string }
  const multiUserResults: MultiUserResult[] = [];
  let baseMultiUserGas = 0n;

  // We need enough distinct signers — hardhat gives us 20 by default
  const allSigners = await ethers.getSigners();

  // Impersonate the relay contract so settleClaimsMulti passes E32 auth for all users
  const relayAddr = await relay.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [relayAddr]);
  // 10000 ETH in hex (enough to cover gas for all benchmark TXs)
  await ethers.provider.send("hardhat_setBalance", [relayAddr, "0x21E19E0C9BAB2400000"]);
  const relaySigner = await ethers.getSigner(relayAddr);

  for (const userCount of MULTI_USER_SIZES) {
    // Create 1 campaign with enough budget for all users
    const cid = await createCampaignAndGetId(advertiser, SCALE_BUDGET);
    await activateCampaign(cid, voter1);

    // Build settleClaimsMulti batches: each user has 1 campaign with 1 claim
    const userBatches = [];
    for (let u = 0; u < userCount; u++) {
      const userSigner = allSigners[8 + u]; // start from signer index 8 to avoid collisions
      const claims = buildClaimChain(cid, publisher.address, userSigner.address, 1, BID_CPM, SCALE_IMPRESSIONS);
      userBatches.push({
        user: userSigner.address,
        campaigns: [{ campaignId: cid, claims }]
      });
    }

    try {
      // Call as relay contract (passes E32 auth for all users)
      const tx = await settlement.connect(relaySigner).settleClaimsMulti(userBatches);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed as bigint;
      const perUser = gasUsed / BigInt(userCount);
      if (userCount === 1) baseMultiUserGas = gasUsed;
      const scale = baseMultiUserGas > 0n
        ? (Number(gasUsed) / Number(baseMultiUserGas)).toFixed(2)
        : "---";
      multiUserResults.push({ users: userCount, gasUsed, perUser, scaleVs1: scale });
    } catch (err: any) {
      console.log(`  ${userCount} users: FAILED — ${err.message?.slice(0, 120)}`);
      break;
    }
  }

  console.log("| Users | Gas Used | Per-User Gas | Scaling vs 1 |");
  console.log("|-------|----------|--------------|--------------|");
  for (const r of multiUserResults) {
    console.log(
      `| ${String(r.users).padEnd(5)} | ${String(r.gasUsed).padEnd(8)} | ${String(r.perUser).padEnd(12)} | ${r.scaleVs1.padEnd(12)} |`
    );
  }

  if (multiUserResults.length >= 2) {
    const first = multiUserResults[0];
    const last = multiUserResults[multiUserResults.length - 1];
    const marginal = (Number(last.gasUsed) - Number(first.gasUsed)) / (last.users - first.users);
    console.log(`\n  Marginal cost per additional user: ~${marginal.toFixed(0)}`);
    console.log(`  Fixed overhead: ~${(Number(first.gasUsed) - marginal).toFixed(0)}`);
  }

  // =========================================================================
  // Multi-user × multi-campaign (settleClaimsMulti N users × M campaigns)
  // =========================================================================
  console.log("\n=== Multi-User × Multi-Campaign (settleClaimsMulti) ===\n");

  const MULTI_COMBOS: { users: number; camps: number; claimsPerCamp: number }[] = [
    { users: 1, camps: 1, claimsPerCamp: 1 },
    { users: 2, camps: 2, claimsPerCamp: 1 },
    { users: 3, camps: 3, claimsPerCamp: 1 },
    { users: 5, camps: 2, claimsPerCamp: 1 },
    { users: 2, camps: 5, claimsPerCamp: 1 },
    { users: 5, camps: 5, claimsPerCamp: 1 },
    { users: 10, camps: 1, claimsPerCamp: 1 },
    { users: 1, camps: 10, claimsPerCamp: 1 },
    // Multi-claim per campaign combos
    { users: 5, camps: 2, claimsPerCamp: 5 },
    { users: 2, camps: 5, claimsPerCamp: 5 },
    { users: 10, camps: 10, claimsPerCamp: 1 },
    // Max load: 10u × 10c × 10claims = 1000 claims
    { users: 10, camps: 10, claimsPerCamp: 10 },
  ];
  interface ComboResult { users: number; camps: number; claimsPerCamp: number; totalClaims: number; gasUsed: bigint; perClaim: bigint }
  const comboResults: ComboResult[] = [];

  for (const combo of MULTI_COMBOS) {
    // Create M campaigns with enough budget for all claims
    const campaignIds: bigint[] = [];
    for (let c = 0; c < combo.camps; c++) {
      const cid = await createCampaignAndGetId(advertiser, SCALE_BUDGET);
      await activateCampaign(cid, voter1);
      campaignIds.push(cid);
    }

    // Build batches: N users × M campaigns × K claims each
    const userBatches = [];
    for (let u = 0; u < combo.users; u++) {
      const userSigner = allSigners[8 + u];
      const campClaims = campaignIds.map(cid => ({
        campaignId: cid,
        claims: buildClaimChain(cid, publisher.address, userSigner.address, combo.claimsPerCamp, BID_CPM, SCALE_IMPRESSIONS)
      }));
      userBatches.push({
        user: userSigner.address,
        campaigns: campClaims
      });
    }

    const totalClaims = combo.users * combo.camps * combo.claimsPerCamp;

    try {
      const tx = await settlement.connect(relaySigner).settleClaimsMulti(userBatches);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed as bigint;
      const perClaim = gasUsed / BigInt(totalClaims);
      comboResults.push({ users: combo.users, camps: combo.camps, claimsPerCamp: combo.claimsPerCamp, totalClaims, gasUsed, perClaim });
    } catch (err: any) {
      console.log(`  ${combo.users}u × ${combo.camps}c × ${combo.claimsPerCamp}cl: FAILED — ${err.message?.slice(0, 120)}`);
    }
  }

  console.log("| Users | Campaigns | Claims/Camp | Total Claims | Gas Used   | Per-Claim Gas |");
  console.log("|-------|-----------|-------------|--------------|------------|---------------|");
  for (const r of comboResults) {
    console.log(
      `| ${String(r.users).padEnd(5)} | ${String(r.camps).padEnd(9)} | ${String(r.claimsPerCamp).padEnd(11)} | ${String(r.totalClaims).padEnd(12)} | ${String(r.gasUsed).padEnd(10)} | ${String(r.perClaim).padEnd(13)} |`
    );
  }

  // =========================================================================
  // Markdown output
  // =========================================================================
  const date = new Date().toISOString().slice(0, 10);
  const netName = `Hardhat EVM (chainId ${net.chainId})`;

  console.log(`\n=== Markdown (for BENCHMARKS.md) ===\n`);
  console.log(`### Main Operations\n`);
  console.log(`| Function | gasUsed (weight) | gasPrice | Est. cost (planck) |`);
  console.log(`|----------|-----------------|----------|-------------------|`);
  for (const r of results) {
    const cost = r.gasUsed * gasPrice;
    console.log(`| \`${r.label}\` | ${r.gasUsed} | ${gasPrice} | ${cost} |`);
  }

  console.log(`\n### Batch Scaling (settleClaims)\n`);
  console.log(`| Batch Size | Gas Used | Per-Claim Gas | Scaling vs 1 |`);
  console.log(`|------------|----------|---------------|--------------|`);
  for (const r of scalingResults) {
    console.log(`| ${r.size} | ${r.gasUsed} | ${r.perClaim} | ${r.scaleVs1}x |`);
  }

  console.log(`\n_Measured ${date} on ${netName}. Alpha-4 (EVM, solc 0.8.24)._`);
  console.log(`_Contracts: PauseRegistry + Timelock + ZKVerifier + Publishers + BudgetLedger + PaymentVault + Campaigns + ClaimValidator + CampaignLifecycle + Settlement + GovernanceV2 + Relay + AttestationVerifier._`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
