/**
 * Gas benchmarks for DATUM Alpha-3 contracts (17-contract architecture).
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
 *   npx hardhat run scripts/benchmark-gas.ts                    # Hardhat EVM
 *   npx hardhat run scripts/benchmark-gas.ts --network substrate  # pallet-revive
 *
 * NOTE: For substrate (PVM), claim hashes use Blake2-256 via @noble/hashes.
 *       Install if not present: npm install --save-dev @noble/hashes
 */
import { ethers } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import { fundSigners, isSubstrate, mineBlocks } from "../test/helpers/mine";

// ---------------------------------------------------------------------------
// Claim hash builder — Blake2-256 on PVM, keccak256 on EVM
// ---------------------------------------------------------------------------

let useBlake2 = false;
let blake2bFn: ((data: Uint8Array, opts: { dkLen: number }) => Uint8Array) | null = null;

async function initHashFunction(): Promise<void> {
  useBlake2 = await isSubstrate();
  if (useBlake2) {
    try {
      const mod = await import("@noble/hashes/blake2.js");
      blake2bFn = mod.blake2b;
      console.log("Using Blake2-256 claim hashing (substrate/PVM)");
    } catch {
      console.warn(
        "WARNING: @noble/hashes not installed — falling back to keccak256.\n" +
        "  Install for correct substrate hashing: npm install --save-dev @noble/hashes"
      );
      useBlake2 = false;
    }
  } else {
    console.log("Using keccak256 claim hashing (Hardhat EVM)");
  }
}

function computeClaimHash(
  campaignId: bigint,
  publisher: string,
  user: string,
  impressionCount: bigint,
  clearingCpmPlanck: bigint,
  nonce: bigint,
  previousClaimHash: string
): string {
  const types = ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"];
  const values = [campaignId, publisher, user, impressionCount, clearingCpmPlanck, nonce, previousClaimHash];

  if (useBlake2 && blake2bFn) {
    const packed = ethers.solidityPacked(types, values);
    const bytes = ethers.getBytes(packed);
    const hash = blake2bFn(bytes, { dkLen: 32 });
    return ethers.hexlify(hash);
  } else {
    return ethers.solidityPackedKeccak256(types, values);
  }
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
      campaignId, publisher, user, impressions, cpm, nonce, prevHash
    );
    claims.push({
      campaignId,
      publisher,
      impressionCount: impressions,
      clearingCpmPlanck: cpm,
      nonce,
      previousClaimHash: prevHash,
      claimHash,
      zkProof: "0x",
    });
    prevHash = claimHash;
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const substrate = await isSubstrate();
  const net = await ethers.provider.getNetwork();
  console.log(`Network: chainId=${net.chainId} substrate=${substrate}`);

  await initHashFunction();
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
  const TAKE_RATE_DELAY = substrate ? 3n : 10n;
  const PENDING_TIMEOUT = substrate ? 3n : 100n;
  const MIN_CPM_FLOOR = 0n;
  const INACTIVITY_TIMEOUT = substrate ? 10n : 100n;

  // Governance
  const QUORUM = parseDOT("1");
  const SLASH_BPS = 1000n;
  const TERMINATION_QUORUM = QUORUM;
  const BASE_GRACE = substrate ? 3n : 10n;
  const GRACE_PER_QUORUM = substrate ? 1n : 5n;
  const MAX_GRACE = substrate ? 30n : 100n;

  // Campaign
  const BID_CPM = parseDOT("0.016"); // clean denomination (10^6 multiple)
  const BUDGET = parseDOT("50");
  const DAILY_CAP = parseDOT("50"); // high cap to avoid daily-cap rejections
  const IMPRESSIONS_1 = 1000n;
  const IMPRESSIONS_5 = 200n; // 5 claims x 200 impressions each

  // ---------------------------------------------------------------------------
  // Deploy all 17 contracts in dependency order (alpha-3)
  // ---------------------------------------------------------------------------
  console.log("Deploying 17 contracts...\n");

  // Tier 0: No dependencies
  const pauseRegistry = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy();
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

  // Tier 2: Depends on Publishers + PauseRegistry
  const targeting = await (await ethers.getContractFactory("DatumTargetingRegistry")).deploy(
    await publishers.getAddress(), await pauseRegistry.getAddress()
  );
  console.log("  TargetingRegistry:", await targeting.getAddress());

  const lifecycle = await (await ethers.getContractFactory("DatumCampaignLifecycle")).deploy(
    await pauseRegistry.getAddress(), INACTIVITY_TIMEOUT
  );
  console.log("  CampaignLifecycle:", await lifecycle.getAddress());

  // Tier 3: Depends on Publishers + TargetingRegistry
  const campaignValidator = await (await ethers.getContractFactory("DatumCampaignValidator")).deploy(
    await publishers.getAddress(), await targeting.getAddress()
  );
  console.log("  CampaignValidator:", await campaignValidator.getAddress());

  // Tier 4: Depends on CampaignValidator + PauseRegistry
  const campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(
    MIN_CPM_FLOOR, PENDING_TIMEOUT,
    await campaignValidator.getAddress(), await pauseRegistry.getAddress()
  );
  console.log("  Campaigns:", await campaigns.getAddress());

  // Tier 5: Depends on Campaigns + Publishers + PauseRegistry
  const claimValidator = await (await ethers.getContractFactory("DatumClaimValidator")).deploy(
    await campaigns.getAddress(),
    await publishers.getAddress(),
    await pauseRegistry.getAddress()
  );
  console.log("  ClaimValidator:", await claimValidator.getAddress());

  const governanceHelper = await (await ethers.getContractFactory("DatumGovernanceHelper")).deploy(
    await campaigns.getAddress()
  );
  console.log("  GovernanceHelper:", await governanceHelper.getAddress());

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

  // Tier 6: Depends on GovernanceV2 + Campaigns
  const governanceSlash = await (await ethers.getContractFactory("DatumGovernanceSlash")).deploy(
    await governance.getAddress(), await campaigns.getAddress()
  );
  console.log("  GovernanceSlash:", await governanceSlash.getAddress());

  // Tier 7: Depends on Settlement + Campaigns + PauseRegistry
  const relay = await (await ethers.getContractFactory("DatumRelay")).deploy(
    await settlement.getAddress(),
    await campaigns.getAddress(),
    await pauseRegistry.getAddress()
  );
  console.log("  Relay:", await relay.getAddress());

  const attestationVerifier = await (await ethers.getContractFactory("DatumAttestationVerifier")).deploy(
    await settlement.getAddress(),
    await campaigns.getAddress()
  );
  console.log("  AttestationVerifier:", await attestationVerifier.getAddress());

  // ---------------------------------------------------------------------------
  // Wire cross-contract references (18 ops, alpha-3)
  // ---------------------------------------------------------------------------
  console.log("\nWiring cross-contract references...");

  // Settlement.configure(budgetLedger, paymentVault, lifecycle, relay) — 4 args (alpha-3)
  await (await settlement.configure(
    await budgetLedger.getAddress(),
    await paymentVault.getAddress(),
    await lifecycle.getAddress(),
    await relay.getAddress()
  )).wait();

  await (await settlement.setClaimValidator(await claimValidator.getAddress())).wait();
  await (await settlement.setAttestationVerifier(await attestationVerifier.getAddress())).wait();

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

  // GovernanceV2: 3 setters
  await (await governance.setSlashContract(await governanceSlash.getAddress())).wait();
  await (await governance.setLifecycle(await lifecycle.getAddress())).wait();
  await (await governance.setHelper(await governanceHelper.getAddress())).wait();

  // Register publisher
  await (await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS)).wait();

  console.log("All 17 contracts deployed and wired.\n");

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
    const tx = await campaigns.connect(signer).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, [], { value: budget }
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

  // Vote aye + evaluate to activate
  async function activateCampaign(cid: bigint, voter: any) {
    await (await governance.connect(voter).vote(cid, true, 0, { value: QUORUM })).wait();
    await (await governance.evaluateCampaign(cid)).wait();
  }

  // =========================================================================
  // BENCHMARKS
  // =========================================================================

  // ---------------------------------------------------------------------------
  // 1. createCampaign (Campaigns -> BudgetLedger.initializeBudget{value})
  // ---------------------------------------------------------------------------
  console.log("1. createCampaign");
  await measure("createCampaign",
    campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, [], { value: BUDGET }
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
  if (substrate) {
    await mineBlocks(graceBlocks);
  } else {
    for (let i = 0; i < graceBlocks; i++) {
      await ethers.provider.send("evm_mine", []);
    }
  }
  await (await governance.evaluateCampaign(cidVote)).wait();

  // ---------------------------------------------------------------------------
  // 4. settleClaims — 1 claim (Settlement -> BudgetLedger -> PaymentVault)
  // ---------------------------------------------------------------------------
  console.log("4. settleClaims (1 claim)");
  {
    const status = await campaigns.getCampaignStatus(cidSettle1);
    const remaining = await budgetLedger.getRemainingBudget(cidSettle1);
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
  // Markdown output
  // =========================================================================
  const date = new Date().toISOString().slice(0, 10);
  const netName = substrate
    ? "pallet-revive dev chain (chainId 420420420)"
    : `Hardhat EVM (chainId ${net.chainId})`;

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

  console.log(`\n_Measured ${date} on ${netName}. Alpha-3 (17 contracts, resolc 1.0)._`);
  console.log(`_Contracts: PauseRegistry + Timelock + ZKVerifier + Publishers + TargetingRegistry + BudgetLedger + PaymentVault + CampaignValidator + Campaigns + ClaimValidator + GovernanceHelper + CampaignLifecycle + Settlement + GovernanceV2 + GovernanceSlash + Relay + AttestationVerifier._`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
