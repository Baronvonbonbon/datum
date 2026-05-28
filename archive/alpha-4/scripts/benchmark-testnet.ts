/**
 * Gas benchmarks for DATUM Alpha-4 contracts on Paseo testnet.
 *
 * Uses the already-deployed contracts and pre-funded test accounts.
 * Measures weight (gas units) and DOT cost for key operations, then runs
 * batch-scaling tests from 1 to 10 claims (inner cap = 50 claims/batch).
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY="0x6eda..." \
 *   TESTNET_ACCOUNTS="0x8a4d...(bob),0x40d6...(diana),0xd894...(frank),0x5a59...(hank)" \
 *   npx hardhat run scripts/benchmark-testnet.ts --network polkadotTestnet
 *
 * Accounts needed (in TESTNET_ACCOUNTS order):
 *   Bob (advertiser), Diana (publisher), Frank (voter), Hank (user)
 *
 * Paseo receipt workaround: eth_getTransactionReceipt returns null for confirmed txs.
 * Gas measurements use eth_estimateGas (static call) against live contract state.
 * State-advancing transactions use raw JsonRpcProvider + nonce polling (no receipt needed).
 */
import { ethers, network } from "hardhat";
import { JsonRpcProvider, Wallet, Interface } from "ethers";
import { parseDOT } from "../test/helpers/dot";
import { ethersKeccakAbi } from "../test/helpers/hash";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Claim hash (keccak256)
// ---------------------------------------------------------------------------
function computeClaimHash(
  campaignId: bigint, publisher: string, user: string,
  impressionCount: bigint, clearingCpmPlanck: bigint,
  nonce: bigint, previousClaimHash: string
): string {
  return ethersKeccakAbi(
    ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
    [campaignId, publisher, user, impressionCount, clearingCpmPlanck, nonce, previousClaimHash],
  );
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
// Paseo workaround: nonce polling (receipt unavailable on Paseo)
// ---------------------------------------------------------------------------
const TX_OPTS = {
  gasLimit: 5000000n,     // 5M weight units — 5 DOT reservation at gasPrice 1T; scales to all signers
  type: 0,
  gasPrice: 1000000000000n,
};

async function waitForNonce(
  provider: JsonRpcProvider,
  address: string,
  targetNonce: number,
  maxWait = 120,
): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const current = await provider.getTransactionCount(address);
    if (current > targetNonce) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting for confirmation (${i}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

// Send a state-changing call and wait for it to be mined (no receipt needed)
async function sendCall(
  signer: Wallet,
  provider: JsonRpcProvider,
  to: string,
  iface: Interface,
  method: string,
  args: any[],
  value = 0n,
): Promise<void> {
  const data = iface.encodeFunctionData(method, args);
  const nonce = await provider.getTransactionCount(signer.address);
  await signer.sendTransaction({ to, data, value, ...TX_OPTS });
  await waitForNonce(provider, signer.address, nonce);
}

// Estimate gas for a call (static, no state change) — Paseo-safe gas measurement
async function estimateGas(
  provider: JsonRpcProvider,
  from: string,
  to: string,
  data: string,
  value = 0n,
): Promise<bigint> {
  const result = await provider.send("eth_estimateGas", [{
    from, to, data,
    value: "0x" + value.toString(16),
    gasLimit: "0x" + TX_OPTS.gasLimit.toString(16),
    gasPrice: "0x" + TX_OPTS.gasPrice.toString(16),
    type: "0x0",
  }]);
  return BigInt(result);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
interface Measurement { label: string; gasUsed: bigint; costPlanck: bigint }

async function main() {

  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const rawProvider = new JsonRpcProvider(rpcUrl);
  const accounts = (network.config as any).accounts || [];

  const deployerKey = accounts[0] || process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("No deployer key — set DEPLOYER_PRIVATE_KEY");

  const testnetKeys = (process.env.TESTNET_ACCOUNTS || "").split(",").filter(Boolean);
  if (testnetKeys.length < 4) {
    console.error("Need TESTNET_ACCOUNTS=bob_key,diana_key,frank_key,hank_key");
    process.exitCode = 1;
    return;
  }

  const alice = new Wallet(deployerKey, rawProvider);
  const bob   = new Wallet(testnetKeys[0], rawProvider);
  const diana = new Wallet(testnetKeys[1], rawProvider);
  const frank = new Wallet(testnetKeys[2], rawProvider);
  const hank  = new Wallet(testnetKeys[3], rawProvider);

  console.log(`Alice   (deployer):   ${alice.address}`);
  console.log(`Bob     (advertiser): ${bob.address}`);
  console.log(`Diana   (publisher):  ${diana.address}`);
  console.log(`Frank   (voter):      ${frank.address}`);
  console.log(`Hank    (user):       ${hank.address}`);

  const addrs = JSON.parse(fs.readFileSync(__dirname + "/../deployed-addresses.json", "utf-8"));
  console.log(`\nUsing deployed contracts from: ${addrs.network} (deployed ${addrs.deployedAt})`);

  const net = await rawProvider.getNetwork();
  const gasPrice = TX_OPTS.gasPrice;
  console.log(`Network: chainId=${net.chainId}  gasPrice=${gasPrice}\n`);

  for (const [name, signer] of [["Alice", alice], ["Bob", bob], ["Diana", diana], ["Frank", frank], ["Hank", hank]] as const) {
    const bal = await rawProvider.getBalance((signer as Wallet).address);
    console.log(`  ${name} balance: ${formatWeiAsDOT(bal)} DOT`);
  }
  console.log();

  // Load contract interfaces from typechain artifacts
  const campaignsIface  = new Interface((await ethers.getContractFactory("DatumCampaigns")).interface.formatJson());
  const govIface        = new Interface((await ethers.getContractFactory("DatumGovernanceV2")).interface.formatJson());
  const settlementIface = new Interface((await ethers.getContractFactory("DatumSettlement")).interface.formatJson());
  const vaultIface      = new Interface((await ethers.getContractFactory("DatumPaymentVault")).interface.formatJson());

  const campaignsAddr  = addrs.campaigns;
  const govAddr        = addrs.governanceV2;
  const settlementAddr = addrs.settlement;
  const vaultAddr      = addrs.paymentVault;

  // Read governance quorum (view call)
  const quorumRaw = await rawProvider.call({ to: govAddr, data: govIface.encodeFunctionData("quorumWeighted") });
  const quorum = BigInt(quorumRaw);
  const STAKE = quorum > parseDOT("10") ? quorum : parseDOT("2");
  console.log(`Governance quorum: ${quorum}  stake: ${STAKE}\n`);

  const results: Measurement[] = [];

  async function measure(label: string, gasUsed: bigint): Promise<void> {
    const costPlanck = gasUsed * gasPrice;
    results.push({ label, gasUsed, costPlanck });
    console.log(`  ${label}: gas=${gasUsed}  cost=${formatWeiAsDOT(costPlanck)} DOT`);
  }

  // Get next campaign ID
  async function getNextCampaignId(): Promise<bigint> {
    const raw = await rawProvider.call({ to: campaignsAddr, data: campaignsIface.encodeFunctionData("nextCampaignId") });
    return BigInt(raw);
  }

  const BID_CPM   = parseDOT("0.016");
  const BUDGET    = parseDOT("10");
  const DAILY_CAP = parseDOT("10");

  // Fund Hank if needed — needs ~200 DOT for ~30 benchmark txs at 5M gasLimit × 1T gasPrice
  {
    const hankBal = await rawProvider.getBalance(hank.address);
    if (hankBal < 200n * 10n ** 18n) {
      const topUp = 250n * 10n ** 18n - hankBal;
      console.log(`Hank balance (${formatWeiAsDOT(hankBal)}) below threshold, topping up to 250 DOT from Alice...`);
      const nonce = await rawProvider.getTransactionCount(alice.address);
      await alice.sendTransaction({ to: hank.address, value: topUp, ...TX_OPTS });
      await waitForNonce(rawProvider, alice.address, nonce);
      console.log(`Hank funded: ${formatWeiAsDOT(await rawProvider.getBalance(hank.address))} DOT\n`);
    }
  }

  // Helper: create + vote aye + evaluate → Active campaign; returns cid
  async function createAndActivate(budget = BUDGET): Promise<bigint> {
    const cid = await getNextCampaignId();
    await sendCall(bob, rawProvider, campaignsAddr, campaignsIface,
      "createCampaign", [diana.address, DAILY_CAP, BID_CPM, 0, []], budget);
    await sendCall(frank, rawProvider, govAddr, govIface,
      "vote", [cid, true, 0], STAKE);
    await sendCall(alice, rawProvider, govAddr, govIface,
      "evaluateCampaign", [cid]);
    return cid;
  }

  // =========================================================================
  // BENCHMARKS — gas measured via eth_estimateGas on live state
  // =========================================================================

  // ─── 1. createCampaign ──────────────────────────────────────────────────
  console.log("1. createCampaign");
  {
    const data = campaignsIface.encodeFunctionData("createCampaign",
      [diana.address, DAILY_CAP, BID_CPM, 0, []]);
    await measure("createCampaign",
      await estimateGas(rawProvider, bob.address, campaignsAddr, data, BUDGET));
    // send for real so campaign exists
    await sendCall(bob, rawProvider, campaignsAddr, campaignsIface,
      "createCampaign", [diana.address, DAILY_CAP, BID_CPM, 0, []], BUDGET);
  }

  // ─── 2. vote (aye) ─────────────────────────────────────────────────────
  console.log("2. vote (aye)");
  {
    // create a campaign to vote on
    const cidVote = await getNextCampaignId();
    await sendCall(bob, rawProvider, campaignsAddr, campaignsIface,
      "createCampaign", [diana.address, DAILY_CAP, BID_CPM, 0, []], BUDGET);
    const voteData = govIface.encodeFunctionData("vote", [cidVote, true, 0]);
    await measure("vote (aye)",
      await estimateGas(rawProvider, frank.address, govAddr, voteData, STAKE));
    await sendCall(frank, rawProvider, govAddr, govIface, "vote", [cidVote, true, 0], STAKE);

    // ─── 3. evaluateCampaign ─────────────────────────────────────────────
    console.log("3. evaluateCampaign");
    const evalData = govIface.encodeFunctionData("evaluateCampaign", [cidVote]);
    await measure("evaluateCampaign (activate)",
      await estimateGas(rawProvider, alice.address, govAddr, evalData));
    await sendCall(alice, rawProvider, govAddr, govIface, "evaluateCampaign", [cidVote]);
  }

  // ─── 4. settleClaims (1 claim) ─────────────────────────────────────────
  console.log("4. settleClaims (1 claim)");
  {
    const cidSettle1 = await createAndActivate();
    console.log(`  Campaign: ${cidSettle1}`);
    const claims1 = buildClaimChain(cidSettle1, diana.address, hank.address, 1, BID_CPM, 1000n);
    const data1 = settlementIface.encodeFunctionData("settleClaims",
      [[{ user: hank.address, campaignId: cidSettle1, claims: claims1 }]]);
    await measure("settleClaims (1 claim)",
      await estimateGas(rawProvider, hank.address, settlementAddr, data1));
    await sendCall(hank, rawProvider, settlementAddr, settlementIface,
      "settleClaims", [[{ user: hank.address, campaignId: cidSettle1, claims: claims1 }]]);
  }

  // ─── 5. settleClaims (5 claims) ────────────────────────────────────────
  console.log("5. settleClaims (5 claims)");
  {
    const cidSettle5 = await createAndActivate(parseDOT("100"));
    console.log(`  Campaign: ${cidSettle5}`);
    const claims5 = buildClaimChain(cidSettle5, diana.address, hank.address, 5, BID_CPM, 1000n);
    const data5 = settlementIface.encodeFunctionData("settleClaims",
      [[{ user: hank.address, campaignId: cidSettle5, claims: claims5 }]]);
    await measure("settleClaims (5 claims)",
      await estimateGas(rawProvider, hank.address, settlementAddr, data5));
    await sendCall(hank, rawProvider, settlementAddr, settlementIface,
      "settleClaims", [[{ user: hank.address, campaignId: cidSettle5, claims: claims5 }]]);
  }

  // ─── 6. withdrawUser ───────────────────────────────────────────────────
  console.log("6. withdrawUser");
  {
    const balRaw = await rawProvider.call({
      to: vaultAddr, data: vaultIface.encodeFunctionData("userBalance", [hank.address])
    });
    const bal = BigInt(balRaw);
    console.log(`  Hank user balance: ${formatWeiAsDOT(bal)} DOT`);
    if (bal < 1n * 10n ** 18n) {
      console.log("  Building balance with extra settlements...");
      for (let i = 0; i < 3; i++) {
        const cid = await createAndActivate(parseDOT("100"));
        const cls = buildClaimChain(cid, diana.address, hank.address, 5, BID_CPM, 1000n);
        await sendCall(hank, rawProvider, settlementAddr, settlementIface,
          "settleClaims", [[{ user: hank.address, campaignId: cid, claims: cls }]]);
      }
      const newBal = BigInt(await rawProvider.call({
        to: vaultAddr, data: vaultIface.encodeFunctionData("userBalance", [hank.address])
      }));
      console.log(`  Balance after top-up: ${formatWeiAsDOT(newBal)} DOT`);
    }
    try {
      const withdrawData = vaultIface.encodeFunctionData("withdrawUser");
      await measure("withdrawUser",
        await estimateGas(rawProvider, hank.address, vaultAddr, withdrawData));
      await sendCall(hank, rawProvider, vaultAddr, vaultIface, "withdrawUser", []);
    } catch (e: any) {
      console.log(`  withdrawUser FAILED: ${e.message?.slice(0, 120)}`);
    }
  }

  // ─── 7. withdrawPublisher ──────────────────────────────────────────────
  console.log("7. withdrawPublisher");
  {
    const balRaw = await rawProvider.call({
      to: vaultAddr, data: vaultIface.encodeFunctionData("publisherBalance", [diana.address])
    });
    const bal = BigInt(balRaw);
    console.log(`  Diana publisher balance: ${formatWeiAsDOT(bal)} DOT`);
    if (bal < 1n * 10n ** 18n) {
      console.log("  Building balance with extra settlements...");
      for (let i = 0; i < 3; i++) {
        const cid = await createAndActivate(parseDOT("100"));
        const cls = buildClaimChain(cid, diana.address, hank.address, 5, BID_CPM, 1000n);
        await sendCall(hank, rawProvider, settlementAddr, settlementIface,
          "settleClaims", [[{ user: hank.address, campaignId: cid, claims: cls }]]);
      }
      const newBal = BigInt(await rawProvider.call({
        to: vaultAddr, data: vaultIface.encodeFunctionData("publisherBalance", [diana.address])
      }));
      console.log(`  Balance after top-up: ${formatWeiAsDOT(newBal)} DOT`);
    }
    try {
      const withdrawData = vaultIface.encodeFunctionData("withdrawPublisher");
      await measure("withdrawPublisher",
        await estimateGas(rawProvider, diana.address, vaultAddr, withdrawData));
      await sendCall(diana, rawProvider, vaultAddr, vaultIface, "withdrawPublisher", []);
    } catch (e: any) {
      console.log(`  withdrawPublisher FAILED: ${e.message?.slice(0, 120)}`);
    }
  }

  // =========================================================================
  // Main results table
  // =========================================================================
  console.log("\n" + "=".repeat(95));
  console.log("DATUM Alpha-4 Testnet Gas Benchmarks — Paseo (Chain ID 420420417)");
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
    const s5Dot = Number(s5.costPlanck) / 1e18;
    const s1Dot = Number(s1.costPlanck) / 1e18;
    console.log(`\nSettlement scale: 5-claim / 1-claim = ${(Number(s5.gasUsed) / Number(s1.gasUsed)).toFixed(2)}x`);
    console.log(`Per-claim cost in 5-batch: ${(s5Dot / 5).toFixed(6)} DOT vs single: ${s1Dot.toFixed(6)} DOT`);
  }

  // =========================================================================
  // Batch scaling benchmark (1 → 10)
  // =========================================================================
  console.log("\n" + "=".repeat(95));
  console.log("Batch Scaling Benchmark — settleClaims (1 to 10 claims)");
  console.log("=".repeat(95) + "\n");

  const BATCH_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const SCALE_IMPRESSIONS = 100n;
  const SCALE_BUDGET = parseDOT("500");

  interface ScalingResult {
    size: number; gasUsed: bigint; perClaim: bigint;
    scaleVs1: string; dotCost: number; perClaimDot: number;
  }
  const scalingResults: ScalingResult[] = [];
  let baseScaleGas = 0n;

  for (const size of BATCH_SIZES) {
    try {
      const cid = await createAndActivate(SCALE_BUDGET);
      const claims = buildClaimChain(cid, diana.address, hank.address, size, BID_CPM, SCALE_IMPRESSIONS);
      const data = settlementIface.encodeFunctionData("settleClaims",
        [[{ user: hank.address, campaignId: cid, claims }]]);
      const gasUsed = await estimateGas(rawProvider, hank.address, settlementAddr, data);
      const perClaim = gasUsed / BigInt(size);
      if (size === 1) baseScaleGas = gasUsed;
      const scale = baseScaleGas > 0n ? (Number(gasUsed) / Number(baseScaleGas)).toFixed(2) : "---";
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
  // Scaling table
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
  // Markdown output
  // =========================================================================
  const date = new Date().toISOString().slice(0, 10);
  console.log(`\n${"=".repeat(95)}`);
  console.log(`MARKDOWN OUTPUT (copy to BENCHMARKS.md)`);
  console.log(`${"=".repeat(95)}\n`);

  console.log(`## Paseo Testnet\n`);
  console.log(`Measured ${date} on Paseo (Chain ID ${net.chainId}). gasPrice=${gasPrice} (eth-rpc 18-decimal wei).`);
  console.log(`Alpha-4: EVM-only (solc 0.8.24), keccak256 claim hashing.`);
  console.log(`Gas measured via \`eth_estimateGas\` against live contract state (Paseo receipt unavailable).\n`);

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

  console.log(`\n_Contracts: PauseRegistry · Timelock · ZKVerifier · Publishers · TargetingRegistry · BudgetLedger · PaymentVault · CampaignValidator · Campaigns · ClaimValidator · GovernanceHelper · CampaignLifecycle · Settlement · GovernanceV2 · GovernanceSlash · Relay · AttestationVerifier._`);
  console.log(`_Claim hashing: keccak256. Cost: gas × gasPrice / 10^18 DOT (eth-rpc 18-decimal)._`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
