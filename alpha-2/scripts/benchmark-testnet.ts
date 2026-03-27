/**
 * Gas benchmarks for DATUM Alpha-2 contracts on Paseo testnet.
 *
 * Uses the already-deployed 13 contracts and pre-funded test accounts.
 * Measures weight (gas units) and DOT cost for key operations, then runs
 * batch-scaling tests from 1 to 50 claims.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY="0x6eda..." \
 *   TESTNET_ACCOUNTS="0x8a4d...(bob),0x40d6...(diana),0xd894...(frank),0x5a59...(hank)" \
 *   npx hardhat run scripts/benchmark-testnet.ts --network polkadotTestnet
 *
 * Accounts needed (in TESTNET_ACCOUNTS order):
 *   Bob (advertiser), Diana (publisher), Frank (voter), Hank (user)
 *
 * NOTE: Claim hashes use Blake2-256 on Paseo (PolkaVM), matching Settlement's
 *       ISystem(0x900).hashBlake256() precompile.
 */
import { ethers } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Blake2-256 claim hash (matches PolkaVM Settlement)
// ---------------------------------------------------------------------------
let blake2bFn: ((data: Uint8Array, opts: { dkLen: number }) => Uint8Array) | null = null;

async function initBlake2(): Promise<void> {
  try {
    // Dynamic import — must use Function constructor to prevent tsc from transpiling to require()
    const dynamicImport = new Function("specifier", "return import(specifier)");
    const mod = await dynamicImport("@noble/hashes/blake2.js");
    blake2bFn = mod.blake2b;
    console.log("Blake2-256 claim hashing loaded (matches PolkaVM Settlement)");
  } catch (e: any) {
    console.error("FATAL: @noble/hashes not installed or import failed:", e.message);
    console.error("Run: npm install --save-dev @noble/hashes");
    process.exit(1);
  }
}

function computeClaimHash(
  campaignId: bigint, publisher: string, user: string,
  impressionCount: bigint, clearingCpmPlanck: bigint,
  nonce: bigint, previousClaimHash: string
): string {
  const types = ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"];
  const values = [campaignId, publisher, user, impressionCount, clearingCpmPlanck, nonce, previousClaimHash];
  const packed = ethers.solidityPacked(types, values);
  const bytes = ethers.getBytes(packed);
  const hash = blake2bFn!(bytes, { dkLen: 32 });
  return ethers.hexlify(hash);
}

function buildClaimChain(
  campaignId: bigint, publisher: string, user: string,
  count: number, cpm: bigint, impressions: bigint
) {
  const claims = [];
  let prevHash = ethers.ZeroHash;
  for (let i = 1; i <= count; i++) {
    const nonce = BigInt(i);
    const claimHash = computeClaimHash(campaignId, publisher, user, impressions, cpm, nonce, prevHash);
    claims.push({
      campaignId, publisher, impressionCount: impressions,
      clearingCpmPlanck: cpm, nonce, previousClaimHash: prevHash,
      claimHash, zkProof: "0x",
    });
    prevHash = claimHash;
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function formatWeiAsDOT(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
interface Measurement { label: string; gasUsed: bigint; costPlanck: bigint }

async function main() {
  await initBlake2();

  const signers = await ethers.getSigners();
  if (signers.length < 5) {
    console.error("Need 5 signers: Alice (deployer) + Bob (advertiser) + Diana (publisher) + Frank (voter) + Hank (user)");
    console.error('Set TESTNET_ACCOUNTS="bob_key,diana_key,frank_key,hank_key"');
    process.exitCode = 1;
    return;
  }

  const [alice, bob, diana, frank, hank] = signers;
  console.log(`Alice   (deployer):   ${alice.address}`);
  console.log(`Bob     (advertiser): ${bob.address}`);
  console.log(`Diana   (publisher):  ${diana.address}`);
  console.log(`Frank   (voter):      ${frank.address}`);
  console.log(`Hank    (user):       ${hank.address}`);

  // Load deployed addresses
  const addrs = JSON.parse(fs.readFileSync(__dirname + "/../deployed-addresses.json", "utf-8"));
  console.log(`\nUsing deployed contracts from: ${addrs.network} (deployed ${addrs.deployedAt})`);

  const net = await ethers.provider.getNetwork();
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 1n;
  console.log(`Network: chainId=${net.chainId}  gasPrice=${gasPrice}\n`);

  // Check balances
  for (const [name, signer] of [["Alice", alice], ["Bob", bob], ["Diana", diana], ["Frank", frank], ["Hank", hank]] as const) {
    const bal = await ethers.provider.getBalance((signer as any).address);
    console.log(`  ${name} balance: ${formatWeiAsDOT(bal)} DOT`);
  }
  console.log();

  // Attach to deployed contracts
  const publishers    = await ethers.getContractAt("DatumPublishers", addrs.publishers);
  const campaigns     = await ethers.getContractAt("DatumCampaigns", addrs.campaigns);
  const budgetLedger  = await ethers.getContractAt("DatumBudgetLedger", addrs.budgetLedger);
  const paymentVault  = await ethers.getContractAt("DatumPaymentVault", addrs.paymentVault);
  const settlement    = await ethers.getContractAt("DatumSettlement", addrs.settlement);
  const governance    = await ethers.getContractAt("DatumGovernanceV2", addrs.governanceV2);
  const lifecycle     = await ethers.getContractAt("DatumCampaignLifecycle", addrs.campaignLifecycle);

  const results: Measurement[] = [];

  async function measure(label: string, txPromise: Promise<any>): Promise<bigint> {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed as bigint;
    const costPlanck = gasUsed * gasPrice;
    results.push({ label, gasUsed, costPlanck });
    console.log(`  ${label}: gas=${gasUsed}  cost=${formatWeiAsDOT(costPlanck)} DOT`);
    return gasUsed;
  }

  const BID_CPM   = parseDOT("0.016");  // clean denomination (10^6 multiple)
  const BUDGET    = parseDOT("10");
  const DAILY_CAP = parseDOT("10");
  const CATEGORY  = 6; // Computers & Electronics

  // Fund Hank if needed (he's the user/claim-sender, needs gas)
  // Note: eth-rpc uses 18-decimal denomination, so 5 DOT = 5×10^18 wei
  {
    const hankBal = await ethers.provider.getBalance(hank.address);
    const MIN_BALANCE = 5n * 10n ** 18n; // 5 DOT in 18-decimal wei
    if (hankBal < MIN_BALANCE) {
      const FUND_AMOUNT = 50n * 10n ** 18n; // 50 DOT in 18-decimal wei
      console.log(`Hank balance too low (${formatWeiAsDOT(hankBal)}), funding with 50 DOT from Alice...`);
      const tx = await alice.sendTransaction({ to: hank.address, value: FUND_AMOUNT });
      await tx.wait();
      const newBal = await ethers.provider.getBalance(hank.address);
      console.log(`Hank funded: ${formatWeiAsDOT(newBal)} DOT\n`);
    }
  }

  // Check governance quorum
  const quorum = await governance.quorumWeighted();
  const STAKE = quorum > parseDOT("10") ? quorum : parseDOT("2");
  console.log(`Governance quorum: ${quorum}  stake: ${STAKE}\n`);

  // Helper: parse campaign ID from CampaignCreated event
  function parseCampaignId(receipt: any): bigint {
    for (const log of receipt.logs) {
      try {
        const parsed = campaigns.interface.parseLog(log);
        if (parsed?.name === "CampaignCreated") return parsed.args.campaignId;
      } catch {}
    }
    throw new Error("CampaignCreated event not found");
  }

  // Helper: create + vote aye + evaluate → Active campaign
  async function createAndActivate(budget = BUDGET): Promise<bigint> {
    const tx = await campaigns.connect(bob).createCampaign(
      diana.address, DAILY_CAP, BID_CPM, CATEGORY, { value: budget }
    );
    const receipt = await tx.wait();
    const cid = parseCampaignId(receipt);
    await (await governance.connect(frank).vote(cid, true, 0, { value: STAKE })).wait();
    await (await governance.connect(alice).evaluateCampaign(cid)).wait();
    return cid;
  }

  // =========================================================================
  // BENCHMARKS
  // =========================================================================

  // ─── 1. createCampaign ──────────────────────────────────────────────────
  console.log("1. createCampaign");
  await measure("createCampaign",
    campaigns.connect(bob).createCampaign(
      diana.address, DAILY_CAP, BID_CPM, CATEGORY, { value: BUDGET }
    )
  );

  // ─── 2. vote (aye) ─────────────────────────────────────────────────────
  console.log("2. vote (aye)");
  const cidVoteTx = await campaigns.connect(bob).createCampaign(
    diana.address, DAILY_CAP, BID_CPM, CATEGORY, { value: BUDGET }
  );
  const cidVoteReceipt = await cidVoteTx.wait();
  const cidVote = parseCampaignId(cidVoteReceipt);
  await measure("vote (aye)",
    governance.connect(frank).vote(cidVote, true, 0, { value: STAKE })
  );

  // ─── 3. evaluateCampaign (Pending→Active) ────────────────────────────
  console.log("3. evaluateCampaign");
  // cidVote has an aye vote meeting quorum — evaluate should transition Pending→Active
  await measure("evaluateCampaign (activate)",
    governance.connect(alice).evaluateCampaign(cidVote)
  );

  // ─── 4. settleClaims (1 claim) ─────────────────────────────────────────
  console.log("4. settleClaims (1 claim)");
  const cidSettle1 = await createAndActivate();
  console.log(`  Campaign: ${cidSettle1}`);
  const claims1 = buildClaimChain(cidSettle1, diana.address, hank.address, 1, BID_CPM, 1000n);
  await measure("settleClaims (1 claim)",
    settlement.connect(hank).settleClaims([
      { user: hank.address, campaignId: cidSettle1, claims: claims1 }
    ])
  );

  // ─── 5. settleClaims (5 claims) ────────────────────────────────────────
  console.log("5. settleClaims (5 claims)");
  const cidSettle5 = await createAndActivate(parseDOT("100")); // larger budget for 5 claims
  console.log(`  Campaign: ${cidSettle5}`);
  const claims5 = buildClaimChain(cidSettle5, diana.address, hank.address, 5, BID_CPM, 1000n);
  await measure("settleClaims (5 claims)",
    settlement.connect(hank).settleClaims([
      { user: hank.address, campaignId: cidSettle5, claims: claims5 }
    ])
  );

  // ─── 6. withdrawUser (PaymentVault) ────────────────────────────────────
  console.log("6. withdrawUser");
  {
    const bal = await paymentVault.userBalance(hank.address);
    console.log(`  Hank user balance: ${formatWeiAsDOT(bal)} DOT`);
    // E58: dust guard — balance below existential deposit. Need to accumulate
    // more earnings or use a higher CPM. Try to settle more claims first.
    if (bal < 1n * 10n ** 18n) {
      console.log("  Balance below withdrawal threshold — settling more claims to build up balance...");
      for (let i = 0; i < 3; i++) {
        const cid = await createAndActivate(parseDOT("100"));
        const cls = buildClaimChain(cid, diana.address, hank.address, 5, BID_CPM, 1000n);
        await (await settlement.connect(hank).settleClaims([
          { user: hank.address, campaignId: cid, claims: cls }
        ])).wait();
      }
      const newBal = await paymentVault.userBalance(hank.address);
      console.log(`  Hank user balance after top-up: ${formatWeiAsDOT(newBal)} DOT`);
    }
  }
  try {
    await measure("withdrawUser",
      paymentVault.connect(hank).withdrawUser()
    );
  } catch (e: any) {
    console.log(`  withdrawUser FAILED: ${e.message?.slice(0, 120)}`);
    console.log("  (E58 = balance below existential deposit dust guard)");
  }

  // ─── 7. withdrawPublisher (PaymentVault) ───────────────────────────────
  console.log("7. withdrawPublisher");
  {
    const bal = await paymentVault.publisherBalance(diana.address);
    console.log(`  Diana publisher balance: ${formatWeiAsDOT(bal)} DOT`);
    if (bal < 1n * 10n ** 18n) {
      console.log("  Balance below withdrawal threshold — settling more claims to build up balance...");
      for (let i = 0; i < 3; i++) {
        const cid = await createAndActivate(parseDOT("100"));
        const cls = buildClaimChain(cid, diana.address, hank.address, 5, BID_CPM, 1000n);
        await (await settlement.connect(hank).settleClaims([
          { user: hank.address, campaignId: cid, claims: cls }
        ])).wait();
      }
      const newBal = await paymentVault.publisherBalance(diana.address);
      console.log(`  Diana publisher balance after top-up: ${formatWeiAsDOT(newBal)} DOT`);
    }
  }
  try {
    await measure("withdrawPublisher",
      paymentVault.connect(diana).withdrawPublisher()
    );
  } catch (e: any) {
    console.log(`  withdrawPublisher FAILED: ${e.message?.slice(0, 120)}`);
    console.log("  (E58 = balance below existential deposit dust guard)");
  }

  // =========================================================================
  // Main results table
  // =========================================================================
  console.log("\n" + "=".repeat(95));
  console.log("DATUM Alpha-2 Testnet Gas Benchmarks — Paseo (Chain ID 420420417)");
  console.log("=".repeat(95));
  console.log(`${"Function".padEnd(30)} | ${"Gas (weight)".padEnd(16)} | ${"Cost (DOT)".padEnd(16)} | Cost (USD @$5)`);
  console.log("-".repeat(90));
  for (const r of results) {
    const dotCost = Number(r.costPlanck) / 1e18;
    const usdCost = dotCost * 5;
    console.log(`${r.label.padEnd(30)} | ${r.gasUsed.toString().padEnd(16)} | ${dotCost.toFixed(6).padEnd(16)} | $${usdCost.toFixed(4)}`);
  }

  const s1 = results.find(r => r.label === "settleClaims (1 claim)");
  const s5 = results.find(r => r.label === "settleClaims (5 claims)");
  if (s1 && s5) {
    const s1Dot = Number(s1.costPlanck) / 1e18;
    const s5Dot = Number(s5.costPlanck) / 1e18;
    console.log(`\nSettlement scale: 5-claim / 1-claim = ${(Number(s5.gasUsed) / Number(s1.gasUsed)).toFixed(2)}x`);
    console.log(`Per-claim cost in 5-batch: ${(s5Dot / 5).toFixed(6)} DOT vs single: ${s1Dot.toFixed(6)} DOT`);
  }

  // =========================================================================
  // Batch scaling benchmark (1 → 50)
  // =========================================================================
  console.log("\n" + "=".repeat(95));
  console.log("Batch Scaling Benchmark — settleClaims (1 to 50 claims)");
  console.log("=".repeat(95) + "\n");

  const BATCH_SIZES = [1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50];
  const SCALE_IMPRESSIONS = 100n;
  const SCALE_BUDGET = parseDOT("500"); // large budget to avoid exhaustion

  interface ScalingResult {
    size: number;
    gasUsed: bigint;
    perClaim: bigint;
    scaleVs1: string;
    dotCost: number;
    perClaimDot: number;
  }
  const scalingResults: ScalingResult[] = [];
  let baseScaleGas = 0n;

  for (const size of BATCH_SIZES) {
    try {
      const cid = await createAndActivate(SCALE_BUDGET);
      const claims = buildClaimChain(cid, diana.address, hank.address, size, BID_CPM, SCALE_IMPRESSIONS);

      const tx = await settlement.connect(hank).settleClaims([
        { user: hank.address, campaignId: cid, claims }
      ]);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed as bigint;
      const perClaim = gasUsed / BigInt(size);
      if (size === 1) baseScaleGas = gasUsed;
      const scale = baseScaleGas > 0n
        ? (Number(gasUsed) / Number(baseScaleGas)).toFixed(2)
        : "---";
      const dotCost = Number(gasUsed * gasPrice) / 1e18;
      const perClaimDot = dotCost / size;

      scalingResults.push({ size, gasUsed, perClaim, scaleVs1: scale, dotCost, perClaimDot });
      console.log(`  Batch ${String(size).padStart(2)}: gas=${gasUsed}  per-claim=${perClaim}  scale=${scale}x  cost=${dotCost.toFixed(6)} DOT`);
    } catch (err: any) {
      const reason = err.message?.slice(0, 200) ?? String(err).slice(0, 200);
      console.log(`  Batch ${size}: FAILED — ${reason}`);
      if (reason.includes("E28")) {
        console.log(`  Hit batch cap (E28) at size ${size}.`);
        break;
      }
    }
  }

  // =========================================================================
  // Print all tables
  // =========================================================================
  console.log("\n" + "=".repeat(95));
  console.log("SCALING TABLE");
  console.log("=".repeat(95));
  console.log(`| Batch Size | Gas Used | Per-Claim Gas | Scaling vs 1 | Cost (DOT) | Per-Claim DOT |`);
  console.log(`|------------|----------|---------------|--------------|------------|---------------|`);
  for (const r of scalingResults) {
    console.log(
      `| ${String(r.size).padEnd(10)} | ${String(r.gasUsed).padEnd(8)} | ${String(r.perClaim).padEnd(13)} | ${r.scaleVs1.padEnd(12)}x | ${r.dotCost.toFixed(6).padEnd(10)} | ${r.perClaimDot.toFixed(6).padEnd(13)} |`
    );
  }

  // Marginal cost analysis
  if (scalingResults.length >= 2) {
    const first = scalingResults[0];
    const last = scalingResults[scalingResults.length - 1];
    const marginal = (Number(last.gasUsed) - Number(first.gasUsed)) / (last.size - first.size);
    const overhead = Number(first.gasUsed) - marginal;
    console.log(`\nScaling analysis:`);
    console.log(`  Base overhead (tx + 1st claim): ~${first.gasUsed}`);
    console.log(`  Marginal cost per additional claim: ~${marginal.toFixed(0)}`);
    console.log(`  Estimated fixed overhead: ~${overhead.toFixed(0)}`);
    console.log(`  Efficiency gain at batch ${last.size}: ${((1 - Number(last.perClaim) / Number(first.gasUsed)) * 100).toFixed(1)}% per-claim savings`);
  }

  // =========================================================================
  // Markdown output (for BENCHMARKS.md)
  // =========================================================================
  const date = new Date().toISOString().slice(0, 10);

  console.log(`\n${"=".repeat(95)}`);
  console.log(`MARKDOWN OUTPUT (copy to BENCHMARKS.md)`);
  console.log(`${"=".repeat(95)}\n`);

  console.log(`## Alpha-2 Testnet Benchmarks — Paseo\n`);
  console.log(`Measured ${date} on Paseo (Chain ID ${net.chainId}). gasPrice=${gasPrice} (eth-rpc 18-decimal).`);
  console.log(`Alpha-2: 13 contracts, resolc 1.0.0, Blake2-256 claim hashing.\n`);

  console.log(`### Main Operations\n`);
  console.log(`| Function | Gas (weight) | Cost (DOT) | Cost (USD @$5) |`);
  console.log(`|----------|-------------|-----------|---------------|`);
  for (const r of results) {
    const dotCost = Number(r.costPlanck) / 1e18;
    const usdCost = dotCost * 5;
    console.log(`| \`${r.label}\` | ${r.gasUsed} | ${dotCost.toFixed(6)} | $${usdCost.toFixed(4)} |`);
  }

  console.log(`\n### Batch Scaling (settleClaims)\n`);
  console.log(`| Batch Size | Gas Used | Per-Claim Gas | Scaling vs 1 | Cost (DOT) | Per-Claim DOT |`);
  console.log(`|------------|----------|---------------|--------------|------------|---------------|`);
  for (const r of scalingResults) {
    console.log(`| ${r.size} | ${r.gasUsed} | ${r.perClaim} | ${r.scaleVs1}x | ${r.dotCost.toFixed(6)} | ${r.perClaimDot.toFixed(6)} |`);
  }

  if (scalingResults.length >= 2) {
    const first = scalingResults[0];
    const last = scalingResults[scalingResults.length - 1];
    const marginal = (Number(last.gasUsed) - Number(first.gasUsed)) / (last.size - first.size);
    console.log(`\n**Scaling analysis:** Fixed overhead ~${first.gasUsed} gas. Marginal cost per additional claim: ~${marginal.toFixed(0)} gas. Efficiency gain at batch ${last.size}: ${((1 - Number(last.perClaim) / Number(first.gasUsed)) * 100).toFixed(1)}% per-claim savings.`);
  }

  console.log(`\n_Contracts: PauseRegistry + Timelock + ZKVerifier + Publishers + BudgetLedger + PaymentVault + Campaigns + CampaignLifecycle + Settlement + GovernanceV2 + GovernanceSlash + Relay + AttestationVerifier._`);
  console.log(`_Claim hashing: Blake2-256 (ISystem 0x900 precompile on PolkaVM). Cost denomination: eth-rpc 18-decimal (cost DOT = gas × gasPrice / 10^18)._`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
