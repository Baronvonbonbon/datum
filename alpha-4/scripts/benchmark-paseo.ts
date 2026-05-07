/**
 * benchmark-paseo.ts — Live Paseo Testnet Benchmark
 * ===================================================
 * Exercises all major alpha-4 contract functions against the live deployed
 * Paseo contracts.  Uses the same raw JsonRpcProvider + nonce-polling pattern
 * as deploy.ts / setup-testnet.ts to work around the Paseo eth-rpc receipt bug.
 *
 * Usage:
 *   npx hardhat run scripts/benchmark-paseo.ts --network polkadotTestnet
 *
 * Prerequisites:
 *   - Contracts deployed (deployed-addresses.json present)
 *   - setup-testnet.ts has run at least once (Diana registered, is authorizedReporter)
 *   - Bob, Charlie, Frank all have ≥ 30 PAS
 *
 * Benchmark groups
 * ----------------
 *   SETUP     — publisher + reporter state verification
 *   ECO       — settlement + payment split at $2 / $5 / $10 DOT
 *   ZK        — ZK-proof-required campaign (real Groth16 / BN254 ecPairing)
 *   OPEN      — open campaign (publisher = address(0))
 *   SCALE     — 1-claim vs 4-claim batch, 10 vs 1000 impressions
 *   RL        — rate limiter window usage before/after settlement
 *   REP       — reputation recordSettlement + score + anomaly
 *   RPT       — community reports (reportPage / reportAd)
 *   PAUSE     — 2-of-3 guardian pause → unpause flow (C-4)
 *   STAKE     — PublisherStake bonding curve reads (FP-1)
 *   NULLIFIER — NullifierRegistry isUsed reads (FP-5)
 *   VAULT     — TokenRewardVault balance reads
 *   GOVROUTER — AdminGovernance + GovernanceRouter phase-0 reads
 *   PARAMGOV  — ParameterGovernance parameter reads
 *   MULTI     — settleClaimsMulti 2-user × 1-campaign batch
 */

import { ethers, network } from "hardhat";
import {
  JsonRpcProvider,
  Wallet,
  Interface,
  solidityPacked,
  getBytes,
  ZeroHash,
  ZeroAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { parseDOT, formatDOT } from "../test/helpers/dot";
import * as fs from "fs";
import * as path from "path";
import { AbiCoder } from "ethers";

// ── Accounts (same keys as deploy.ts / setup-testnet.ts) ─────────────────────
const ACCOUNTS = {
  alice:   "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8",
  bob:     "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52",
  charlie: "0x1560b7b8d38c812b182b08e8ef739bb88c806d7ba36bd7b01c9177b3536654c1",
  diana:   "0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0",
  eve:     "0x22adcf911646ca05279aa42b03dcabae2610417af459be43c2ba37f869c15914",
  frank:   "0xd8947fdc847ae7e902cf126b449cb8d9e7a9becdd0816397eaeb3b046d77986c",
  grace:   "0xdfafb7d12292bad165e40ba13bd2254f91123b656f991e3f308e5ccbcfc6a235",
};

const TX_OPTS = {
  gasLimit: 500000000n,
  type: 0,
  gasPrice: 1000000000000n,
};

// Paseo eth_call also requires explicit gas + type:0 (legacy); without it the node
// uses EIP-1559 format and rejects the call with "missing revert data".
const CALL_OPTS = {
  gasLimit: 500_000_000n,
  type: 0,
  gasPrice: 1_000_000_000_000n,
};

// ── DOT price scenarios ($1 CPM baseline) ────────────────────────────────────
const SCENARIOS = [
  { label: "$2/DOT",  cpm: parseDOT("0.5"),  budget: parseDOT("2"), daily: parseDOT("2") },
  { label: "$5/DOT",  cpm: parseDOT("0.2"),  budget: parseDOT("2"), daily: parseDOT("2") },
  { label: "$10/DOT", cpm: parseDOT("0.1"),  budget: parseDOT("2"), daily: parseDOT("2") },
] as const;

// ── Payment split helper ──────────────────────────────────────────────────────
function expectedPayments(cpm: bigint, impressions: bigint, claimCount: number) {
  const total = (cpm * impressions) / 1000n * BigInt(claimCount);
  const pub   = (total * 5000n) / 10000n;
  const rem   = total - pub;
  const user  = (rem * 7500n) / 10000n;
  const prot  = rem - user;
  return { total, pub, user, prot };
}

// ── Claim hashing: always keccak256 on EVM ──────────────────────────────────

// ── Real Groth16 proof generation (BN254 via circuits/impression.circom) ─────
const CIRCUITS_DIR  = path.resolve(__dirname, "../circuits");
const WASM_PATH     = path.join(CIRCUITS_DIR, "impression_js", "impression.wasm");
const ZKEY_PATH     = path.join(CIRCUITS_DIR, "impression.zkey");
const ZK_AVAILABLE  = fs.existsSync(WASM_PATH) && fs.existsSync(ZKEY_PATH);
const SCALAR_ORDER  = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

if (!ZK_AVAILABLE) {
  console.warn("[WARN] circuits/impression.zkey not found — run `node scripts/setup-zk.mjs` for real ZK proofs.");
}

// ABI-encode a Groth16 proof as 256 bytes: (uint256[2], uint256[4], uint256[2])
// pi_b G2 point must be in EIP-197 order: [x_imag, x_real, y_imag, y_real]
function encodeProof(proof: {
  pi_a: string[]; pi_b: string[][]; pi_c: string[];
}): string[] {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [
      [proof.pi_a[0], proof.pi_a[1]],
      [
        proof.pi_b[0][1], proof.pi_b[0][0],  // x_imag, x_real
        proof.pi_b[1][1], proof.pi_b[1][0],  // y_imag, y_real
      ],
      [proof.pi_c[0], proof.pi_c[1]],
    ],
  );
  // Split 256-byte encoded proof into 8 × bytes32
  const hex = encoded.startsWith("0x") ? encoded.slice(2) : encoded;
  return Array.from({ length: 8 }, (_, i) => "0x" + hex.slice(i * 64, (i + 1) * 64));
}

// Generate a real Groth16 proof for a claim.
// Returns { proofBytes, nullifierHex } or null if zkey is not available.
// Circuit public inputs: claimHash, nullifier, impressions
// Circuit private witnesses: nonce, secret, campaignId, windowId
// The circuit constraint: Poseidon(secret, campaignId, windowId) === nullifier
// We must pre-compute the actual Poseidon hash and pass it as the nullifier public input.
async function generateZKProof(
  claimHash: string,   // bytes32 hex
  impressions: bigint,
  nonce: bigint,
  campaignId = 1n,
  secret = 12345n,
  windowId = 0n,
): Promise<{ proofArray: string[]; nullifierHex: string } | null> {
  if (!ZK_AVAILABLE) return null;
  const snarkjs = await import("snarkjs");
  // Pre-compute Poseidon(secret, campaignId, windowId) to satisfy circuit constraint
  // Circuit line 63: h.out === nullifier — passes only if provided nullifier equals computed hash
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();
  const poseidonF = poseidon.F;
  const nullifierFe = poseidonF.toObject(poseidon([secret, campaignId, windowId]));
  const nullifierStr = nullifierFe.toString();
  const nullifierHex = "0x" + nullifierFe.toString(16).padStart(64, "0");

  const claimHashFe = (BigInt(claimHash) % SCALAR_ORDER).toString();
  const { proof } = await snarkjs.groth16.fullProve(
    {
      claimHash: claimHashFe,
      nullifier: nullifierStr,
      impressions: impressions.toString(),
      nonce: nonce.toString(),
      secret: secret.toString(),
      campaignId: campaignId.toString(),
      windowId: windowId.toString(),
    },
    WASM_PATH,
    ZKEY_PATH,
  );
  return { proofArray: encodeProof(proof), nullifierHex };
}

// ── Claim chain builder (keccak256) ──────────────────────────────────────────
// Alpha-3 multi-pricing: 9-field preimage adds actionType + clickSessionHash.
// Hash: keccak256(campaignId | publisher | user | eventCount | ratePlanck |
//                 actionType | clickSessionHash | nonce | previousClaimHash)

async function buildClaims(
  provider: JsonRpcProvider,
  campaignId: bigint,
  publisherAddr: string,
  userAddr: string,
  count: number,
  rate: bigint,         // ratePlanck (CPM for view claims)
  eventCount: bigint,   // events per claim
  zkProof: string[] = new Array(8).fill(ZeroHash),
  actionType: number = 0,
  startNonce = 0n,        // on-chain lastNonce (claims start at startNonce+1)
  startPrevHash = ZeroHash, // on-chain lastClaimHash
) {
  const claims = [];
  let prevHash = startPrevHash;
  for (let i = 1; i <= count; i++) {
    const nonce = startNonce + BigInt(i);
    const packed = getBytes(solidityPacked(
      ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
      [campaignId, publisherAddr, userAddr, eventCount, rate, actionType, ZeroHash, nonce, prevHash],
    ));
    const hash = keccak256(packed);
    claims.push({
      campaignId,
      publisher: publisherAddr,
      eventCount,
      ratePlanck: rate,
      actionType,
      clickSessionHash: ZeroHash,
      nonce,
      previousClaimHash: prevHash,
      claimHash: hash,
      zkProof,
      nullifier: ZeroHash,  // bytes32(0) = skip nullifier check
      actionSig: [ZeroHash, ZeroHash, ZeroHash],
    });
    prevHash = hash;
  }
  return claims;
}

// ── Paseo workaround: nonce-based confirmation ────────────────────────────────
async function waitForNonce(
  provider: JsonRpcProvider,
  address: string,
  targetNonce: number,
  maxWait = 120,
): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const current = await provider.getTransactionCount(address);
    if (current > targetNonce) return;
    if (i % 15 === 0 && i > 0) process.stdout.write(`    ...waiting (${i}s)\n`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

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

async function readCall(
  provider: JsonRpcProvider,
  to: string,
  iface: Interface,
  method: string,
  args: any[],
): Promise<any> {
  const data = iface.encodeFunctionData(method, args);
  const raw = await provider.call({ to, data });
  return iface.decodeFunctionResult(method, raw);
}

// ── Result tracking ───────────────────────────────────────────────────────────
interface BenchmarkResult {
  id: string;
  label: string;
  passed: boolean;
  durationMs: number;
  notes: string;
}

const results: BenchmarkResult[] = [];

function pass(id: string, label: string, ms: number, notes = "") {
  results.push({ id, label, passed: true, durationMs: ms, notes });
  console.log(`  [PASS] ${id}: ${label} (${ms}ms)${notes ? "  — " + notes : ""}`);
}

function fail(id: string, label: string, ms: number, reason: string) {
  results.push({ id, label, passed: false, durationMs: ms, notes: reason });
  console.log(`  [FAIL] ${id}: ${label} (${ms}ms)  — ${reason}`);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}

// ── ABI helper — inline claim tuple string ────────────────────────────────────
// Alpha-3 Claim struct (9-field hash, multi-action-type support)
const CLAIM_T = [
  "uint256 campaignId",
  "address publisher",
  "uint256 eventCount",
  "uint256 ratePlanck",
  "uint8 actionType",
  "bytes32 clickSessionHash",
  "uint256 nonce",
  "bytes32 previousClaimHash",
  "bytes32 claimHash",
  "bytes32[8] zkProof",
  "bytes32 nullifier",
  "bytes32[3] actionSig",
].join(", ");

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const publishersAbi = [
  "function getPublisher(address) view returns (bool registered, uint16 takeRateBps)",
  "function isPublisher(address) view returns (bool)",
  "function isBlocked(address) view returns (bool)",
  "function allowlistEnabled(address) view returns (bool)",
];

const campaignsAbi = [
  `function createCampaign(address publisher, (uint8 actionType, uint256 budgetPlanck, uint256 dailyCapPlanck, uint256 ratePlanck, address actionVerifier)[] pots, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)`,
  "function getCampaignStatus(uint256 campaignId) view returns (uint8)",
  "function nextCampaignId() view returns (uint256)",
  "function getCampaign(uint256 campaignId) view returns (address advertiser, address publisher, uint256 pendingExpiryBlock, uint256 terminationBlock, uint16 snapshotTakeRateBps, uint8 status)",
  "function togglePause(uint256 campaignId, bool pause) external",
  // Inline reports (merged from DatumReports)
  "function reportPage(uint256 campaignId, uint8 reason)",
  "function reportAd(uint256 campaignId, uint8 reason)",
  "function pageReports(uint256) view returns (uint256)",
  "function adReports(uint256) view returns (uint256)",
];

const govRouterAdminAbi = [
  // GovernanceRouter with merged AdminGovernance
  "function adminActivateCampaign(uint256 campaignId)",
  "function adminTerminateCampaign(uint256 campaignId)",
];

const govRouterAbi = [
  "function governor() view returns (address)",
  "function phase() view returns (uint8)",
];

const settlementAbi = [
  `function settleClaims((address user, uint256 campaignId, (${CLAIM_T})[] claims)[] batches) returns (uint256 settledCount, uint256 rejectedCount, uint256 totalPaid)`,
  `function settleClaimsMulti((address user, (uint256 campaignId, (${CLAIM_T})[] claims)[] campaigns)[] batches) returns (uint256 settledCount, uint256 rejectedCount, uint256 totalPaid)`,
  "function lastNonce(address user, uint256 campaignId, uint8 actionType) view returns (uint256)",
  "function lastClaimHash(address user, uint256 campaignId, uint8 actionType) view returns (bytes32)",
  // Inline reputation (merged from DatumPublisherReputation)
  "function recordSettlement(address publisher, uint256 campaignId, uint256 settled, uint256 rejected)",
  "function getReputationScore(address publisher) view returns (uint16)",
  "function getPublisherStats(address publisher) view returns (uint256 settled, uint256 rejected, uint16 score)",
  "function isAnomaly(address publisher, uint256 campaignId) view returns (bool)",
  "function repTotalSettled(address) view returns (uint256)",
  "function repTotalRejected(address) view returns (uint256)",
  "function authorizedReporters(address) view returns (bool)",
  // Inline rate limiter (merged from DatumSettlementRateLimiter)
  "function currentWindowUsage(address publisher) view returns (uint256 windowId, uint256 events, uint256 limit)",
  "function rlWindowBlocks() view returns (uint256)",
  "function rlMaxEventsPerWindow() view returns (uint256)",
  // Inline nullifier (merged from DatumNullifierRegistry)
  "function isNullifierUsed(uint256 windowId, bytes32 nullifier) view returns (bool)",
  "function nullifierWindowBlocks() view returns (uint256)",
];

const vaultAbi = [
  "function publisherBalance(address) view returns (uint256)",
  "function userBalance(address) view returns (uint256)",
  "function protocolBalance() view returns (uint256)",
];

const tokenVaultAbi = [
  "function userTokenBalance(address token, address user) view returns (uint256)",
  "function campaignTokenBudget(address token, uint256 campaignId) view returns (uint256)",
];

// Alpha-4: Reports inline on Campaigns, Reputation + RateLimiter inline on Settlement.
// reportsIface → campIface; repIface/rlIface → settlIface (defined below).

const zkVerifierAbi = [
  // Alpha-3: 4-arg verify — proof, publicInputsHash (claimHash), nullifier, impressionCount
  "function verify(bytes proof, bytes32 publicInputsHash, bytes32 nullifier, uint256 impressionCount) view returns (bool)",
];

const pauseRegistryAbi = [
  "function paused() view returns (bool)",
  "function guardians(uint256) view returns (address)",
  "function propose(uint8 action) returns (uint256 proposalId)",
  "function approve(uint256 proposalId)",
  "function pause()",
];

const publisherStakeAbi = [
  "function staked(address publisher) view returns (uint256)",
  "function requiredStake(address publisher) view returns (uint256)",
  "function isAdequatelyStaked(address publisher) view returns (bool)",
  "function baseStakePlanck() view returns (uint256)",
  "function planckPerImpression() view returns (uint256)",
  "function unstakeDelayBlocks() view returns (uint256)",
  "function cumulativeImpressions(address publisher) view returns (uint256)",
];

// Nullifier functions are inline on Settlement — alias settleIface below
const nullifierAbi = [
  "function isNullifierUsed(uint256 campaignId, bytes32 nullifier) view returns (bool)",
  "function nullifierWindowBlocks() view returns (uint256)",
];

const paramGovAbi = [
  "function quorum() view returns (uint256)",
  "function votingPeriodBlocks() view returns (uint256)",
  "function timelockBlocks() view returns (uint256)",
  "function proposeBond() view returns (uint256)",
  "function nextProposalId() view returns (uint256)",
];

const STATUS_NAMES = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const rawProvider = new JsonRpcProvider(rpcUrl);

  const alice   = new Wallet(ACCOUNTS.alice,   rawProvider);
  const bob     = new Wallet(ACCOUNTS.bob,     rawProvider);
  const charlie = new Wallet(ACCOUNTS.charlie, rawProvider);
  const diana   = new Wallet(ACCOUNTS.diana,   rawProvider);
  const eve     = new Wallet(ACCOUNTS.eve,     rawProvider);
  const frank   = new Wallet(ACCOUNTS.frank,   rawProvider);
  const grace   = new Wallet(ACCOUNTS.grace,   rawProvider);

  // Load deployed addresses
  const addrFile = __dirname + "/../deployed-addresses.json";
  if (!fs.existsSync(addrFile)) {
    console.error("deployed-addresses.json not found — run deploy.ts first");
    process.exitCode = 1;
    return;
  }
  const A = JSON.parse(fs.readFileSync(addrFile, "utf-8"));

  const requiredKeys = [
    "campaigns", "publishers", "governanceRouter",
    "settlement", "paymentVault",
    "zkVerifier", "pauseRegistry", "publisherStake",
    "tokenRewardVault", "parameterGovernance",
  ];
  const missing = requiredKeys.filter(k => !A[k]);
  if (missing.length > 0) {
    console.error("Missing addresses:", missing.join(", "));
    process.exitCode = 1;
    return;
  }

  // Interfaces
  const pubIface       = new Interface(publishersAbi);
  const campIface      = new Interface(campaignsAbi);
  const adminGovIface  = new Interface(govRouterAdminAbi);
  const govRouterIface = new Interface(govRouterAbi);
  const settleIface    = new Interface(settlementAbi);
  const vaultIface     = new Interface(vaultAbi);
  const tvaultIface    = new Interface(tokenVaultAbi);
  // Reports → campIface (inline on Campaigns); Reputation + RateLimiter → settleIface (inline on Settlement)
  const reportsIface   = campIface;  // reportPage/reportAd/pageReports/adReports are on Campaigns
  const repIface       = settleIface;  // reputation + rate limiter inline on Settlement
  const rlIface        = settleIface;
  const zkIface        = new Interface(zkVerifierAbi);
  const pauseIface     = new Interface(pauseRegistryAbi);
  const stakeIface     = new Interface(publisherStakeAbi);
  const nullIface      = new Interface(nullifierAbi);
  const paramIface     = new Interface(paramGovAbi);

  // ── Helper: create campaign, activate via AdminGovernance ─────────────────
  async function deployBenchmarkCampaign(
    advertiser: Wallet,
    publisher: string,
    cpm: bigint,
    budget: bigint,
    daily: bigint,
    requiredTags: string[] = [],
    requireZk = false,
  ): Promise<bigint> {
    const nextRaw = await readCall(rawProvider, A.campaigns, campIface, "nextCampaignId", []);
    const cid = BigInt(nextRaw[0]);
    const pot = {
      actionType: 0,
      budgetPlanck: budget,
      dailyCapPlanck: daily,
      ratePlanck: cpm,
      actionVerifier: ZeroAddress,
    };
    await sendCall(
      advertiser, rawProvider, A.campaigns, campIface, "createCampaign",
      [publisher, [pot], requiredTags, requireZk, ZeroAddress, 0, 0],
      budget,
    );
    // Activate via AdminGovernance (Phase 0) — same pattern as setup-testnet.ts Phase 4b
    await sendCall(alice, rawProvider, A.governanceRouter, adminGovIface, "adminActivateCampaign", [cid]);
    const statusRaw = await readCall(rawProvider, A.campaigns, campIface, "getCampaignStatus", [cid]);
    const status = Number(BigInt(statusRaw[0]));
    if (status !== 1) throw new Error(`Campaign ${cid} failed to activate: status=${STATUS_NAMES[status]}`);
    return cid;
  }

  // ── Settle helper: real TX + nonce-delta to measure settled count ─────────
  // Paseo's eth_call forbids SSTORE (nonReentrant hits it first), so we can't
  // use staticCall on settleClaims. Instead: read lastNonce before/after real TX.
  async function doSettle(
    user: Wallet,
    cid: bigint,
    publisher: string,
    count: number,
    rate: bigint,
    eventCount: bigint,
    zkProof: string[] = new Array(8).fill(ZeroHash),
    actionType: number = 0,
  ): Promise<{ settledCount: bigint; rejectedCount: bigint; totalPaid: bigint }> {
    const nonceBefore = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [user.address, cid, actionType]))[0]);
    const prevHash = nonceBefore === 0n
      ? ZeroHash
      : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [user.address, cid, actionType]))[0] as string;
    const claims = await buildClaims(rawProvider, cid, publisher, user.address, count, rate, eventCount, zkProof, actionType, nonceBefore, prevHash);
    const batch = { user: user.address, campaignId: cid, claims };
    await sendCall(user, rawProvider, A.settlement, settleIface, "settleClaims", [[batch]]);
    const nonceAfter = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [user.address, cid, actionType]))[0]);
    const settledCount  = nonceAfter - nonceBefore;
    const rejectedCount = BigInt(count) - settledCount;
    return { settledCount, rejectedCount, totalPaid: 0n };
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Datum Alpha-4 — Paseo Live Benchmark");
  console.log("  Target: EVM (solc 0.8.24)");
  console.log("  Network:", rpcUrl);
  console.log("  Contracts:", A.campaigns);
  console.log("══════════════════════════════════════════════════════════════\n");

  // ── SETUP: verify publishers registered ──────────────────────────────────
  console.log("── SETUP: Publisher + reporter state ───────────────────────");

  {
    const t0 = Date.now();
    try {
      const dRes = await readCall(rawProvider, A.publishers, pubIface, "getPublisher", [diana.address]);
      const eRes = await readCall(rawProvider, A.publishers, pubIface, "getPublisher", [grace.address]);
      const dianaReg = Boolean(dRes[0]);
      const graceReg = Boolean(eRes[0]);
      const ms = Date.now() - t0;
      if (dianaReg) {
        pass("SETUP-1", "Diana registered as publisher", ms, `takeRate=${dRes[1]}bps`);
      } else {
        fail("SETUP-1", "Diana registered as publisher", ms, "NOT registered — run setup-testnet.ts");
      }
      if (!graceReg) {
        pass("SETUP-2", "Grace not a registered publisher (expected)", ms);
      } else {
        pass("SETUP-2", "Grace is also registered (non-fatal)", ms, "WARN: grace is registered");
      }
    } catch (err: any) {
      fail("SETUP-1", "Publisher read", Date.now() - t0, String(err).slice(0, 100));
    }
  }

  // SETUP-3: Reputation is inline on Settlement (alpha-4) — check getReputationScore is callable
  {
    const t0 = Date.now();
    try {
      await readCall(rawProvider, A.settlement, repIface, "getReputationScore", [alice.address]);
      const ms = Date.now() - t0;
      pass("SETUP-3", "Settlement.getReputationScore() callable (inline reputation)", ms);
    } catch (err: any) {
      fail("SETUP-3", "Settlement.getReputationScore read", Date.now() - t0, String(err).slice(0, 100));
    }
  }

  // SETUP-4: GovernanceRouter.governor() is deployer (Phase 0 — admin governance merged inline)
  {
    const t0 = Date.now();
    try {
      const govInRouter = (await readCall(rawProvider, A.governanceRouter, govRouterIface, "governor", []))[0];
      const ms = Date.now() - t0;
      // In alpha-4, deployer is the initial governor (AdminGovernance merged inline)
      pass("SETUP-4", "GovernanceRouter.governor() readable", ms, `governor=${govInRouter}`);
    } catch (err: any) {
      fail("SETUP-4", "GovernanceRouter.governor read", Date.now() - t0, String(err).slice(0, 100));
    }
  }

  // ── ECO: Economic settlement at $2 / $5 / $10 DOT ────────────────────────
  console.log("\n── ECO: Settlement economics at $2 / $5 / $10 DOT ─────────");

  for (const sc of SCENARIOS) {
    const id = `ECO-${sc.label.replace("/", "")}`;
    const t0 = Date.now();
    try {
      const cid = await deployBenchmarkCampaign(
        bob, diana.address, sc.cpm, sc.budget, sc.daily,
      );
      console.log(`  [INFO] ${id}: campaign ${cid} active`);

      const pubBefore = BigInt((await readCall(rawProvider, A.paymentVault, vaultIface, "publisherBalance", [diana.address]))[0]);
      const userBefore = BigInt((await readCall(rawProvider, A.paymentVault, vaultIface, "userBalance", [grace.address]))[0]);

      const IMPS = 100n;
      const { settledCount, rejectedCount, totalPaid } = await doSettle(
        grace, cid, diana.address, 1, sc.cpm, IMPS,
      );

      const pubAfter  = BigInt((await readCall(rawProvider, A.paymentVault, vaultIface, "publisherBalance", [diana.address]))[0]);
      const userAfter = BigInt((await readCall(rawProvider, A.paymentVault, vaultIface, "userBalance", [grace.address]))[0]);

      const pubDelta  = pubAfter  - pubBefore;
      const userDelta = userAfter - userBefore;
      const exp = expectedPayments(sc.cpm, IMPS, 1);
      const ms  = Date.now() - t0;

      if (settledCount !== 1n) {
        fail(id, `Settlement at ${sc.label} (100 imps)`, ms,
          `settledCount=${settledCount} rejectedCount=${rejectedCount}`);
        continue;
      }
      if (pubDelta !== exp.pub) {
        fail(id, `Settlement at ${sc.label} (100 imps)`, ms,
          `pubDelta ${formatDOT(pubDelta)} != expected ${formatDOT(exp.pub)}`);
        continue;
      }
      if (userDelta !== exp.user) {
        fail(id, `Settlement at ${sc.label} (100 imps)`, ms,
          `userDelta ${formatDOT(userDelta)} != expected ${formatDOT(exp.user)}`);
        continue;
      }
      pass(id, `Settlement at ${sc.label} (100 imps)`, ms,
        `total=${formatDOT(exp.total)} pub=${formatDOT(exp.pub)} user=${formatDOT(exp.user)} proto=${formatDOT(exp.prot)} PAS`);
    } catch (err: any) {
      fail(id, `Settlement at ${sc.label}`, Date.now() - t0, String(err).slice(0, 150));
    }
  }

  // ── ZK: ZK-proof-required campaign ───────────────────────────────────────
  console.log("\n── ZK: ZK-proof-required campaign ──────────────────────────");

  {
    const CPM    = parseDOT("0.2");
    const BUDGET = parseDOT("2");

    // ZK-1: zkVerifier.verify(proof, publicInputsHash, nullifier, impressionCount)
    // verify(bytes, bytes32, bytes32, uint256) — empty → false, real proof → true
    {
      const t0 = Date.now();
      try {
        const dummyHash = keccak256(toUtf8Bytes("dummy"));
        // Empty proof (len != 256) → verify returns false (vkSet check passes but length check fails)
        const resEmpty  = await readCall(rawProvider, A.zkVerifier, zkIface, "verify",
          ["0x", dummyHash, ZeroHash, 1n]);
        const emptyOk   = !Boolean(resEmpty[0]);

        if (ZK_AVAILABLE) {
          const zkResult = await generateZKProof(dummyHash, 1n, 1n, 1n);
          const proofBytes = "0x" + zkResult!.proofArray.map(h => h.slice(2)).join("");
          const resReal   = await readCall(rawProvider, A.zkVerifier, zkIface, "verify",
            [proofBytes, dummyHash, zkResult!.nullifierHex, 1n]);
          const realOk    = Boolean(resReal[0]);
          const ms = Date.now() - t0;
          if (emptyOk && realOk) {
            pass("ZK-1", "ZKVerifier.verify: empty→false, real Groth16 proof→true", ms);
          } else {
            fail("ZK-1", "ZKVerifier.verify Groth16", ms,
              `empty=${!emptyOk} realProof=${realOk} (vkSet?)`);
          }
        } else {
          const resBad = await readCall(rawProvider, A.zkVerifier, zkIface, "verify",
            ["0xdeadbeef", dummyHash, ZeroHash, 1n]);
          const badOk  = !Boolean(resBad[0]);
          const ms = Date.now() - t0;
          if (emptyOk && badOk) {
            pass("ZK-1", "ZKVerifier.verify: empty→false, malformed→false (no vk set)", ms);
          } else {
            fail("ZK-1", "ZKVerifier.verify precompile wiring", ms,
              `empty=${!emptyOk} malformed=${badOk}`);
          }
        }
      } catch (err: any) {
        fail("ZK-1", "ZKVerifier.verify call", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    let zkCid: bigint | null = null;

    // ZK-2: Create ZK campaign + settle with valid Groth16 proof
    {
      const t0 = Date.now();
      try {
        zkCid = await deployBenchmarkCampaign(
          bob, diana.address, CPM, BUDGET, BUDGET, [], true,
        );
        console.log(`  [INFO] ZK-2: campaign ${zkCid} active (requireZk=true)`);

        if (!ZK_AVAILABLE) {
          fail("ZK-2", "Settle with real Groth16 proof — SKIP (run setup-zk.mjs first)", Date.now() - t0, "no zkey");
        } else {
          const nonceBefore = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [grace.address, zkCid, 0]))[0]);
          const zkPrevHash = nonceBefore === 0n ? ZeroHash : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [grace.address, zkCid, 0]))[0] as string;
          const claims = await buildClaims(rawProvider, zkCid, diana.address, grace.address, 1, CPM, 100n, new Array(8).fill(ZeroHash), 0, nonceBefore, zkPrevHash);
          const claimHash = claims[0].claimHash as string;
          const nonce     = claims[0].nonce as bigint;
          const zkResult  = await generateZKProof(claimHash, 100n, nonce, zkCid);
          const claimsWithProof = claims.map((c: any) => ({
            ...c, zkProof: zkResult!.proofArray, nullifier: zkResult!.nullifierHex,
          }));
          const batch = { user: grace.address, campaignId: zkCid, claims: claimsWithProof };
          await sendCall(grace, rawProvider, A.settlement, settleIface, "settleClaims", [[batch]]);
          const nonceAfter = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [grace.address, zkCid, 0]))[0]);
          const settled  = nonceAfter - nonceBefore;
          const rejected = 1n - settled;
          const ms = Date.now() - t0;
          if (settled === 1n && rejected === 0n) {
            pass("ZK-2", "Settle with real Groth16 proof accepted (BN254 ecPairing)", ms);
          } else {
            fail("ZK-2", "Settle with real Groth16 proof", ms,
              `settled=${settled} rejected=${rejected}`);
          }
        }
      } catch (err: any) {
        fail("ZK-2", "ZK campaign settle", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // ZK-3: Reject empty proof on ZK-required campaign (charlie as user)
    if (zkCid !== null) {
      const t0 = Date.now();
      try {
        const nonceBefore = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [charlie.address, zkCid, 0]))[0]);
        const zk3PrevHash = nonceBefore === 0n ? ZeroHash : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [charlie.address, zkCid, 0]))[0] as string;
        const claims = await buildClaims(rawProvider, zkCid, diana.address, charlie.address, 1, CPM, 50n, new Array(8).fill(ZeroHash), 0, nonceBefore, zk3PrevHash);
        const batch = { user: charlie.address, campaignId: zkCid, claims };
        // Paseo eth_call forbids SSTORE → use real TX + nonce-delta (rejected → nonce stays at 0)
        await sendCall(charlie, rawProvider, A.settlement, settleIface, "settleClaims", [[batch]]);
        const nonceAfter = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [charlie.address, zkCid, 0]))[0]);
        const settled  = nonceAfter - nonceBefore;
        const rejected = 1n - settled;
        const ms = Date.now() - t0;
        if (rejected === 1n) {
          pass("ZK-3", "Settle with empty ZK proof rejected (reason 16)", ms);
        } else {
          fail("ZK-3", "Settle with empty ZK proof rejected", ms,
            `expected rejected=1 got settled=${settled} rejected=${rejected}`);
        }
      } catch (err: any) {
        fail("ZK-3", "ZK empty proof rejection", Date.now() - t0, String(err).slice(0, 150));
      }
    }
  }

  // ── OPEN: Open campaign (publisher = address(0)) ──────────────────────────
  console.log("\n── OPEN: Open campaign (any publisher) ────────────────────");

  {
    const CPM    = parseDOT("0.2");
    const BUDGET = parseDOT("2");
    let openCid: bigint | null = null;

    // OPEN-1: Create open campaign
    {
      const t0 = Date.now();
      try {
        openCid = await deployBenchmarkCampaign(charlie, ZeroAddress, CPM, BUDGET, BUDGET);
        console.log(`  [INFO] OPEN-1: campaign ${openCid} active (publisher=0x0)`);
        pass("OPEN-1", `Open campaign created and activated (cid=${openCid})`, Date.now() - t0);
      } catch (err: any) {
        fail("OPEN-1", "Create open campaign", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // OPEN-2: Diana settles (registered publisher)
    if (openCid !== null) {
      const t0 = Date.now();
      try {
        const { settledCount, rejectedCount } = await doSettle(
          grace, openCid, diana.address, 1, CPM, 100n,
        );
        const ms = Date.now() - t0;
        if (settledCount === 1n) {
          pass("OPEN-2", "Diana settles open campaign claim", ms);
        } else {
          fail("OPEN-2", "Diana settles open campaign claim", ms,
            `settled=${settledCount} rejected=${rejectedCount}`);
        }
      } catch (err: any) {
        fail("OPEN-2", "Open campaign settlement (Diana)", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // OPEN-3: Second user (alice) settles same open campaign
    if (openCid !== null) {
      const t0 = Date.now();
      try {
        const nonceBefore = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [alice.address, openCid!, 0]))[0]);
        const o3PrevHash = nonceBefore === 0n ? ZeroHash : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [alice.address, openCid!, 0]))[0] as string;
        const claims = await buildClaims(rawProvider, openCid!, diana.address, alice.address, 1, CPM, 50n, new Array(8).fill(ZeroHash), 0, nonceBefore, o3PrevHash);
        const batch  = { user: alice.address, campaignId: openCid!, claims };
        // Paseo eth_call forbids SSTORE → use real TX + nonce-delta
        await sendCall(alice, rawProvider, A.settlement, settleIface, "settleClaims", [[batch]]);
        const nonceAfter = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [alice.address, openCid!, 0]))[0]);
        const settled3 = nonceAfter - nonceBefore;
        const ms = Date.now() - t0;
        if (settled3 === 1n) {
          pass("OPEN-3", "Second user (alice) settles open campaign", ms);
        } else {
          fail("OPEN-3", "Second user settles open campaign", ms,
            `settled=${settled3}`);
        }
      } catch (err: any) {
        fail("OPEN-3", "Open campaign second user settle", Date.now() - t0, String(err).slice(0, 150));
      }
    }
  }

  // ── SCALE: Multi-claim batch + impression scaling ─────────────────────────
  console.log("\n── SCALE: Batch size + impression scaling ──────────────────");

  {
    const CPM    = parseDOT("0.2");
    const BUDGET = parseDOT("5");
    let scaleCid: bigint | null = null;

    {
      const t0 = Date.now();
      try {
        scaleCid = await deployBenchmarkCampaign(bob, diana.address, CPM, BUDGET, BUDGET);
        console.log(`  [INFO] SCALE: campaign ${scaleCid} active`);
        pass("SCALE-SETUP", `Scale campaign created (cid=${scaleCid})`, Date.now() - t0);
      } catch (err: any) {
        fail("SCALE-SETUP", "Create scale campaign", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // SCALE-1: 3-claim batch, 100 impressions each (frank as user)
    if (scaleCid !== null) {
      const t0 = Date.now();
      try {
        const nonceBefore = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [frank.address, scaleCid, 0]))[0]);
        const s1PrevHash = nonceBefore === 0n ? ZeroHash : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [frank.address, scaleCid, 0]))[0] as string;
        const claims = await buildClaims(rawProvider, scaleCid, diana.address, frank.address, 3, CPM, 100n, new Array(8).fill(ZeroHash), 0, nonceBefore, s1PrevHash);
        const batch  = { user: frank.address, campaignId: scaleCid, claims };
        // Paseo eth_call forbids SSTORE → use real TX + nonce-delta
        await sendCall(frank, rawProvider, A.settlement, settleIface, "settleClaims", [[batch]]);
        const nonceAfter = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [frank.address, scaleCid, 0]))[0]);
        const settled = nonceAfter - nonceBefore;
        const rej1    = 3n - settled;
        const ms = Date.now() - t0;
        const exp = expectedPayments(CPM, 100n, 3);
        if (settled === 3n) {
          pass("SCALE-1", "3-claim batch (100 imps each) — all settled", ms,
            `total=${formatDOT(exp.total)} PAS`);
        } else {
          fail("SCALE-1", "3-claim batch", ms, `settled=${settled} rejected=${rej1}`);
        }
      } catch (err: any) {
        fail("SCALE-1", "3-claim batch", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // SCALE-1b: 4-claim batch
    if (scaleCid !== null) {
      const t0 = Date.now();
      try {
        const nonceBefore = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [grace.address, scaleCid, 0]))[0]);
        const s1bPrevHash = nonceBefore === 0n ? ZeroHash : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [grace.address, scaleCid, 0]))[0] as string;
        const claims = await buildClaims(rawProvider, scaleCid, diana.address, grace.address, 4, CPM, 100n, new Array(8).fill(ZeroHash), 0, nonceBefore, s1bPrevHash);
        const batch  = { user: grace.address, campaignId: scaleCid, claims };
        await sendCall(grace, rawProvider, A.settlement, settleIface, "settleClaims", [[batch]]);
        const nonceAfter = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [grace.address, scaleCid, 0]))[0]);
        const settled = nonceAfter - nonceBefore;
        const rej    = 4n - settled;
        const ms = Date.now() - t0;
        if (settled === 4n) {
          pass("SCALE-1b", "4-claim batch (EVM) — all settled", ms,
            `total=${formatDOT(expectedPayments(CPM, 100n, 4).total)} PAS`);
        } else {
          fail("SCALE-1b", "4-claim batch (EVM)", ms, `settled=${settled} rejected=${rej}`);
        }
      } catch (err: any) {
        fail("SCALE-1b", "4-claim batch (EVM)", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // SCALE-2: 1 claim, 1000 impressions (charlie)
    if (scaleCid !== null) {
      const t0 = Date.now();
      try {
        const nonceBefore = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [charlie.address, scaleCid, 0]))[0]);
        const s2PrevHash = nonceBefore === 0n ? ZeroHash : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [charlie.address, scaleCid, 0]))[0] as string;
        const claims = await buildClaims(rawProvider, scaleCid, diana.address, charlie.address, 1, CPM, 1000n, new Array(8).fill(ZeroHash), 0, nonceBefore, s2PrevHash);
        const batch  = { user: charlie.address, campaignId: scaleCid, claims };
        // Paseo eth_call forbids SSTORE → use real TX + nonce-delta
        await sendCall(charlie, rawProvider, A.settlement, settleIface, "settleClaims", [[batch]]);
        const nonceAfter = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [charlie.address, scaleCid, 0]))[0]);
        const settled2 = nonceAfter - nonceBefore;
        const rej2     = 1n - settled2;
        const ms = Date.now() - t0;
        const exp = expectedPayments(CPM, 1000n, 1);
        if (settled2 === 1n) {
          pass("SCALE-2", "1 claim × 1000 impressions — settled", ms,
            `total=${formatDOT(exp.total)} PAS`);
        } else {
          fail("SCALE-2", "1 claim × 1000 impressions", ms,
            `settled=${settled2} rejected=${rej2}`);
        }
      } catch (err: any) {
        fail("SCALE-2", "1000-impression single claim", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // SCALE-3: 1 claim, 10 impressions (eve)
    if (scaleCid !== null) {
      const t0 = Date.now();
      try {
        const nonceBefore = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [eve.address, scaleCid, 0]))[0]);
        const s3PrevHash = nonceBefore === 0n ? ZeroHash : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [eve.address, scaleCid, 0]))[0] as string;
        const claims = await buildClaims(rawProvider, scaleCid, diana.address, eve.address, 1, CPM, 10n, new Array(8).fill(ZeroHash), 0, nonceBefore, s3PrevHash);
        const batch  = { user: eve.address, campaignId: scaleCid, claims };
        // Paseo eth_call forbids SSTORE → use real TX + nonce-delta
        await sendCall(eve, rawProvider, A.settlement, settleIface, "settleClaims", [[batch]]);
        const nonceAfter = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [eve.address, scaleCid, 0]))[0]);
        const settled3s = nonceAfter - nonceBefore;
        const rej3      = 1n - settled3s;
        const ms = Date.now() - t0;
        if (settled3s === 1n) {
          pass("SCALE-3", "1 claim × 10 impressions — settled", ms);
        } else {
          fail("SCALE-3", "1 claim × 10 impressions", ms,
            `settled=${settled3s} rejected=${rej3}`);
        }
      } catch (err: any) {
        fail("SCALE-3", "10-impression single claim", Date.now() - t0, String(err).slice(0, 150));
      }
    }
  }

  // ── RL: Rate limiter (BM-5) ───────────────────────────────────────────────
  console.log("\n── RL: Rate limiter (BM-5) ─────────────────────────────────");

  {
    // RL-1: Read current rate limiter settings
    {
      const t0 = Date.now();
      try {
        const wb   = BigInt((await readCall(rawProvider, A.settlement, rlIface, "rlWindowBlocks", []))[0]);
        const maxI = BigInt((await readCall(rawProvider, A.settlement, rlIface, "rlMaxEventsPerWindow", []))[0]);
        const res  = await readCall(rawProvider, A.settlement, rlIface, "currentWindowUsage", [diana.address]);
        const [windowId, events, limit] = [BigInt(res[0]), BigInt(res[1]), BigInt(res[2])];
        const ms = Date.now() - t0;
        pass("RL-1", "Rate limiter settings readable", ms,
          `windowBlocks=${wb} maxPerWindow=${maxI} dianaUsage=${events}/${limit} (window ${windowId})`);
      } catch (err: any) {
        fail("RL-1", "Rate limiter read", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    // RL-2: Small settlement and verify window usage increases
    {
      const t0 = Date.now();
      try {
        const resBefore = await readCall(rawProvider, A.settlement, rlIface, "currentWindowUsage", [diana.address]);
        const impBefore = BigInt(resBefore[1]);
        const limitN    = BigInt(resBefore[2]);
        const IMPS_RL   = 50n;

        if (impBefore + IMPS_RL > limitN) {
          pass("RL-2", "Rate limiter window usage tracking (skipped — window full)", Date.now() - t0,
            `current ${impBefore}/${limitN} — would exceed cap`);
        } else {
          const rlCid = await deployBenchmarkCampaign(
            bob, diana.address, parseDOT("0.1"), parseDOT("1"), parseDOT("1"),
          );
          console.log(`  [INFO] RL-2: campaign ${rlCid} active`);
          await doSettle(grace, rlCid, diana.address, 1, parseDOT("0.1"), IMPS_RL);
          const resAfter  = await readCall(rawProvider, A.settlement, rlIface, "currentWindowUsage", [diana.address]);
          const windowAfter = BigInt(resAfter[0]);
          const impAfter  = BigInt(resAfter[1]);
          const ms = Date.now() - t0;
          const windowBefore = BigInt(resBefore[0]);
          // Window may have rolled over between reads — if so, impAfter is just
          // the new-window count (>= IMPS_RL). Both cases prove usage tracking works.
          if (impAfter >= impBefore + IMPS_RL || (windowAfter > windowBefore && impAfter >= IMPS_RL)) {
            pass("RL-2", "Window usage increases after settlement", ms,
              `${impBefore} → ${impAfter} events` + (windowAfter > windowBefore ? ` (window rolled ${windowBefore}→${windowAfter})` : ""));
          } else {
            fail("RL-2", "Window usage tracking", ms,
              `expected ≥${impBefore + IMPS_RL} got ${impAfter}`);
          }
        }
      } catch (err: any) {
        fail("RL-2", "Rate limiter settlement tracking", Date.now() - t0, String(err).slice(0, 150));
      }
    }
  }

  // ── REP: Reputation tracking (BM-8/9) ────────────────────────────────────
  console.log("\n── REP: Publisher reputation (BM-8/9) ─────────────────────");

  {
    // REP-1: Read current score via getPublisherStats
    {
      const t0 = Date.now();
      try {
        const res  = await readCall(rawProvider, A.settlement, repIface, "getPublisherStats", [diana.address]);
        const [settled, rejected, score] = [BigInt(res[0]), BigInt(res[1]), BigInt(res[2])];
        const ms = Date.now() - t0;
        pass("REP-1", "getPublisherStats readable", ms,
          `settled=${settled} rejected=${rejected} score=${score}bps`);
      } catch (err: any) {
        fail("REP-1", "getPublisherStats", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    // REP-2: L-5 — authorizedReporters check (not just reporters mapping)
    {
      const t0 = Date.now();
      try {
        // Diana should be an authorized reporter if setup-testnet.ts ran step 5.7
        const isAuth = Boolean((await readCall(rawProvider, A.settlement, repIface, "authorizedReporters", [diana.address]))[0]);
        const ms = Date.now() - t0;
        if (isAuth) {
          pass("REP-2", "Diana is an authorized reporter (L-5)", ms);
        } else {
          // Settlement is the primary reporter; relay-bot diana is optional
          pass("REP-2", "Diana not in authorizedReporters (settlement is primary reporter)", ms,
            "WARN: run setup-testnet.ts step 5.7 to add Diana as supplemental reporter");
        }
      } catch (err: any) {
        fail("REP-2", "authorizedReporters check", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    // REP-3: Post-settlement reputation auto-update (settlement is primary reporter)
    // Create a small campaign and settle — reputation should update automatically
    {
      const t0 = Date.now();
      try {
        const settledBefore = BigInt((await readCall(rawProvider, A.settlement, repIface, "repTotalSettled", [diana.address]))[0]);

        // Small campaign + 1 claim → settlement emits reputation record automatically
        const repCid = await deployBenchmarkCampaign(
          bob, diana.address, parseDOT("0.1"), parseDOT("1"), parseDOT("1"),
        );
        await doSettle(eve, repCid, diana.address, 1, parseDOT("0.1"), 20n);

        const settledAfter = BigInt((await readCall(rawProvider, A.settlement, repIface, "repTotalSettled", [diana.address]))[0]);
        const score = BigInt((await readCall(rawProvider, A.settlement, repIface, "getReputationScore", [diana.address]))[0]);
        const ms = Date.now() - t0;

        if (settledAfter > settledBefore) {
          pass("REP-3", "Reputation auto-updates on settlement (FP-16)", ms,
            `totalSettled +${settledAfter - settledBefore}, score=${score}bps`);
        } else {
          fail("REP-3", "Reputation auto-update via settlement", ms,
            `totalSettled unchanged (${settledBefore} → ${settledAfter})`);
        }
      } catch (err: any) {
        fail("REP-3", "Reputation auto-update", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // REP-4: isAnomaly call (BM-9)
    {
      const t0 = Date.now();
      try {
        // Use dummy campaign ID — checks if call succeeds
        const anomaly = Boolean((await readCall(rawProvider, A.settlement, repIface, "isAnomaly",
          [diana.address, 9998n]))[0]);
        const ms = Date.now() - t0;
        pass("REP-4", "isAnomaly call succeeds (BM-9)", ms, `isAnomaly(diana, 9998)=${anomaly}`);
      } catch (err: any) {
        fail("REP-4", "isAnomaly call", Date.now() - t0, String(err).slice(0, 150));
      }
    }
  }

  // ── RPT: Community reports ────────────────────────────────────────────────
  console.log("\n── RPT: Community reports (inline on Campaigns) ───────────────────");

  {
    let reportCid: bigint | null = null;

    {
      // Always create a fresh campaign — per-address dedup (AUDIT-023) prevents
      // the same address from reporting the same campaign twice across runs.
      const t0 = Date.now();
      try {
        reportCid = await deployBenchmarkCampaign(
          bob, diana.address, parseDOT("0.2"), parseDOT("1"), parseDOT("1"),
        );
        pass("RPT-SETUP", `Created fresh report campaign (cid=${reportCid})`, Date.now() - t0);
      } catch (err: any) {
        fail("RPT-SETUP", "Report target campaign", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    if (reportCid !== null) {
      // RPT-1: reportPage increments counter (use frank — fresh campaign so no dedup issue)
      {
        const t0 = Date.now();
        try {
          const before = BigInt((await readCall(rawProvider, A.campaigns, reportsIface, "pageReports", [reportCid]))[0]);
          await sendCall(frank, rawProvider, A.campaigns, reportsIface, "reportPage", [reportCid, 1]);
          const after  = BigInt((await readCall(rawProvider, A.campaigns, reportsIface, "pageReports", [reportCid]))[0]);
          const ms = Date.now() - t0;
          if (after === before + 1n) {
            pass("RPT-1", "reportPage increments pageReports counter", ms,
              `cid=${reportCid} ${before}→${after}`);
          } else {
            fail("RPT-1", "reportPage counter", ms, `expected +1 got ${after - before}`);
          }
        } catch (err: any) {
          fail("RPT-1", "reportPage", Date.now() - t0, String(err).slice(0, 150));
        }
      }

      // RPT-2: reportAd increments counter (use grace — fresh campaign so no dedup issue)
      {
        const t0 = Date.now();
        try {
          const before = BigInt((await readCall(rawProvider, A.campaigns, reportsIface, "adReports", [reportCid]))[0]);
          await sendCall(grace, rawProvider, A.campaigns, reportsIface, "reportAd", [reportCid, 3]);
          const after  = BigInt((await readCall(rawProvider, A.campaigns, reportsIface, "adReports", [reportCid]))[0]);
          const ms = Date.now() - t0;
          if (after === before + 1n) {
            pass("RPT-2", "reportAd increments adReports counter", ms,
              `cid=${reportCid} ${before}→${after}`);
          } else {
            fail("RPT-2", "reportAd counter", ms, `expected +1 got ${after - before}`);
          }
        } catch (err: any) {
          fail("RPT-2", "reportAd", Date.now() - t0, String(err).slice(0, 150));
        }
      }

      // RPT-3: Reasons 1-5 accepted (static call)
      {
        const t0 = Date.now();
        try {
          let allPassed = true;
          for (let r = 1; r <= 5; r++) {
            const data = reportsIface.encodeFunctionData("reportPage", [reportCid, r]);
            try {
              await rawProvider.call({ to: A.campaigns, data, from: grace.address });
            } catch {
              allPassed = false;
              break;
            }
          }
          const ms = Date.now() - t0;
          if (allPassed) {
            pass("RPT-3", "reportPage reasons 1-5 all accepted (static)", ms);
          } else {
            fail("RPT-3", "reportPage reason range", ms, "one or more reasons 1-5 reverted");
          }
        } catch (err: any) {
          fail("RPT-3", "reportPage reason validation", Date.now() - t0, String(err).slice(0, 100));
        }
      }

      // RPT-4: Reason 0 reverts
      {
        const t0 = Date.now();
        try {
          const data = reportsIface.encodeFunctionData("reportPage", [reportCid, 0]);
          let reverted = false;
          try {
            await rawProvider.call({ to: A.campaigns, data, from: grace.address });
          } catch {
            reverted = true;
          }
          const ms = Date.now() - t0;
          if (reverted) {
            pass("RPT-4", "reportPage with reason=0 reverts", ms);
          } else {
            fail("RPT-4", "reportPage with reason=0 should revert", ms, "call did not revert");
          }
        } catch (err: any) {
          fail("RPT-4", "reportPage reason=0 revert check", Date.now() - t0, String(err).slice(0, 100));
        }
      }
    }
  }

  // ── STAKE: PublisherStake bonding curve (FP-1) ────────────────────────────
  console.log("\n── STAKE: PublisherStake bonding curve (FP-1) ──────────────");

  {
    // STAKE-1: Read contract parameters
    {
      const t0 = Date.now();
      try {
        const base    = BigInt((await readCall(rawProvider, A.publisherStake, stakeIface, "baseStakePlanck", []))[0]);
        const perImp  = BigInt((await readCall(rawProvider, A.publisherStake, stakeIface, "planckPerImpression", []))[0]);
        const delay   = BigInt((await readCall(rawProvider, A.publisherStake, stakeIface, "unstakeDelayBlocks", []))[0]);
        const ms = Date.now() - t0;
        pass("STAKE-1", "PublisherStake parameters readable", ms,
          `base=${formatDOT(base)} perImp=${perImp} planck delay=${delay} blocks`);
      } catch (err: any) {
        fail("STAKE-1", "PublisherStake params read", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    // STAKE-2: Diana's staked balance and required stake
    {
      const t0 = Date.now();
      try {
        const staked    = BigInt((await readCall(rawProvider, A.publisherStake, stakeIface, "staked", [diana.address]))[0]);
        const required  = BigInt((await readCall(rawProvider, A.publisherStake, stakeIface, "requiredStake", [diana.address]))[0]);
        const adequate  = Boolean((await readCall(rawProvider, A.publisherStake, stakeIface, "isAdequatelyStaked", [diana.address]))[0]);
        const cumImps   = BigInt((await readCall(rawProvider, A.publisherStake, stakeIface, "cumulativeImpressions", [diana.address]))[0]);
        const ms = Date.now() - t0;
        pass("STAKE-2", "Diana stake/required/adequate reads", ms,
          `staked=${formatDOT(staked)} required=${formatDOT(required)} adequate=${adequate} cumImps=${cumImps}`);
      } catch (err: any) {
        fail("STAKE-2", "Diana stake reads", Date.now() - t0, String(err).slice(0, 100));
      }
    }
  }

  // ── NULLIFIER: NullifierRegistry replay prevention (FP-5) ─────────────────
  console.log("\n── NULLIFIER: NullifierRegistry (FP-5) ─────────────────────");

  {
    // NULLIFIER-1: isUsed() for a never-submitted nullifier → false
    {
      const t0 = Date.now();
      try {
        const fakeNullifier = keccak256(toUtf8Bytes("benchmark-nullifier-test"));
        const used = Boolean((await readCall(rawProvider, A.settlement, nullIface, "isNullifierUsed",
          [999n, fakeNullifier]))[0]);
        const ms = Date.now() - t0;
        if (!used) {
          pass("NULLIFIER-1", "isUsed() returns false for fresh nullifier", ms);
        } else {
          fail("NULLIFIER-1", "isUsed() should return false for fresh nullifier", ms, "returned true unexpectedly");
        }
      } catch (err: any) {
        fail("NULLIFIER-1", "isUsed() read", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    // NULLIFIER-2: windowBlocks readable
    {
      const t0 = Date.now();
      try {
        const wb = BigInt((await readCall(rawProvider, A.settlement, nullIface, "nullifierWindowBlocks", []))[0]);
        const ms = Date.now() - t0;
        pass("NULLIFIER-2", "windowBlocks readable", ms, `windowBlocks=${wb}`);
      } catch (err: any) {
        fail("NULLIFIER-2", "windowBlocks read", Date.now() - t0, String(err).slice(0, 100));
      }
    }
  }

  // ── VAULT: TokenRewardVault (ERC-20 sidecar) ──────────────────────────────
  console.log("\n── VAULT: TokenRewardVault (ERC-20 sidecar) ─────────────────");

  {
    // VAULT-1: Read balances for a dummy token address (returns 0 — contract exists + no revert)
    {
      const t0 = Date.now();
      try {
        const fakeToken = "0x0000000000000000000000000000000000000001";
        const userBal = BigInt((await readCall(rawProvider, A.tokenRewardVault, tvaultIface,
          "userTokenBalance", [fakeToken, grace.address]))[0]);
        const campBal = BigInt((await readCall(rawProvider, A.tokenRewardVault, tvaultIface,
          "campaignTokenBudget", [fakeToken, 1n]))[0]);
        const ms = Date.now() - t0;
        pass("VAULT-1", "TokenRewardVault balance reads succeed", ms,
          `userBal=${userBal} campBudget=${campBal} (dummy token)`);
      } catch (err: any) {
        fail("VAULT-1", "TokenRewardVault read", Date.now() - t0, String(err).slice(0, 100));
      }
    }
  }

  // ── GOVROUTER: AdminGovernance + GovernanceRouter (Phase 0) ───────────────
  console.log("\n── GOVROUTER: AdminGovernance + GovernanceRouter ───────────");

  {
    // GOVROUTER-1: GovernanceRouter phase and governor
    {
      const t0 = Date.now();
      try {
        const gov   = (await readCall(rawProvider, A.governanceRouter, govRouterIface, "governor", []))[0];
        const phase = BigInt((await readCall(rawProvider, A.governanceRouter, govRouterIface, "phase", []))[0]);
        const ms = Date.now() - t0;
        const phaseNames = ["Admin", "Council", "FullDAO"];
        const phaseName  = phaseNames[Number(phase)] ?? `unknown(${phase})`;
        // Alpha-4: AdminGovernance merged into GovernanceRouter; governor is deployer (Alice)
        // in Phase 0, not a separate contract address.
        if (gov.toLowerCase() === alice.address.toLowerCase()) {
          pass("GOVROUTER-1", `Router.governor=deployer (Phase 0 Admin), phase=${phaseName}`, ms);
        } else {
          fail("GOVROUTER-1", "Router.governor mismatch", ms,
            `got ${gov} expected ${alice.address} (deployer)`);
        }
      } catch (err: any) {
        fail("GOVROUTER-1", "GovernanceRouter reads", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    // GOVROUTER-2: AdminGovernance can activate a test campaign (end-to-end)
    {
      const t0 = Date.now();
      try {
        const cid = await deployBenchmarkCampaign(
          bob, diana.address, parseDOT("0.1"), parseDOT("1"), parseDOT("1"),
        );
        const ms = Date.now() - t0;
        pass("GOVROUTER-2", `AdminGovernance activated campaign ${cid} via router`, ms);
      } catch (err: any) {
        fail("GOVROUTER-2", "AdminGovernance activation via router", Date.now() - t0, String(err).slice(0, 150));
      }
    }
  }

  // ── PARAMGOV: ParameterGovernance reads ───────────────────────────────────
  console.log("\n── PARAMGOV: ParameterGovernance ───────────────────────────");

  {
    // PARAMGOV-1: Read all governance parameters
    {
      const t0 = Date.now();
      try {
        const quorum      = BigInt((await readCall(rawProvider, A.parameterGovernance, paramIface, "quorum", []))[0]);
        const votingBlks  = BigInt((await readCall(rawProvider, A.parameterGovernance, paramIface, "votingPeriodBlocks", []))[0]);
        const timelockBlks= BigInt((await readCall(rawProvider, A.parameterGovernance, paramIface, "timelockBlocks", []))[0]);
        const bond        = BigInt((await readCall(rawProvider, A.parameterGovernance, paramIface, "proposeBond", []))[0]);
        const nextId      = BigInt((await readCall(rawProvider, A.parameterGovernance, paramIface, "nextProposalId", []))[0]);
        const ms = Date.now() - t0;
        pass("PARAMGOV-1", "ParameterGovernance parameters readable", ms,
          `quorum=${formatDOT(quorum)} votingBlks=${votingBlks} timelockBlks=${timelockBlks} bond=${formatDOT(bond)} nextId=${nextId}`);
      } catch (err: any) {
        fail("PARAMGOV-1", "ParameterGovernance reads", Date.now() - t0, String(err).slice(0, 100));
      }
    }
  }

  // ── MULTI: settleClaimsMulti — 2-user × 1-campaign batch ─────────────────
  console.log("\n── MULTI: settleClaimsMulti (2 users × 1 campaign) ─────────");

  {
    const CPM    = parseDOT("0.2");
    const BUDGET = parseDOT("3");

    // MULTI-1: Create shared campaign, settle for frank + charlie in one TX
    {
      const t0 = Date.now();
      try {
        const multiCid = await deployBenchmarkCampaign(
          bob, diana.address, CPM, BUDGET, BUDGET,
        );
        console.log(`  [INFO] MULTI: campaign ${multiCid} active`);

        // Read on-chain nonce/prevHash before building claims (idempotent on re-run)
        const frankNonceBefore   = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [frank.address,   multiCid, 0]))[0]);
        const charlieNonceBefore = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [charlie.address, multiCid, 0]))[0]);
        const frankPrevHash   = frankNonceBefore   === 0n ? ZeroHash : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [frank.address,   multiCid, 0]))[0] as string;
        const charliePrevHash = charlieNonceBefore === 0n ? ZeroHash : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [charlie.address, multiCid, 0]))[0] as string;

        // Build claims for two different users (frank, charlie)
        const claimsFrank   = await buildClaims(rawProvider, multiCid, diana.address, frank.address,   1, CPM, 50n, new Array(8).fill(ZeroHash), 0, frankNonceBefore,   frankPrevHash);
        const claimsCharlie = await buildClaims(rawProvider, multiCid, diana.address, charlie.address, 1, CPM, 75n, new Array(8).fill(ZeroHash), 0, charlieNonceBefore, charliePrevHash);

        // settleClaimsMulti: each entry has a user + array of CampaignClaims
        const frankBatch   = { user: frank.address,   campaigns: [{ campaignId: multiCid, claims: claimsFrank }] };
        const charlieBatch = { user: charlie.address, campaigns: [{ campaignId: multiCid, claims: claimsCharlie }] };

        // Paseo eth_call forbids SSTORE → use real TX + nonce-delta.
        // diana is the publisher's relaySigner → passes E32 auth check for both user batches.

        await sendCall(diana, rawProvider, A.settlement, settleIface, "settleClaimsMulti",
          [[frankBatch, charlieBatch]]);

        const frankNonceAfter   = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [frank.address,   multiCid, 0]))[0]);
        const charlieNonceAfter = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [charlie.address, multiCid, 0]))[0]);

        const settled  = (frankNonceAfter - frankNonceBefore) + (charlieNonceAfter - charlieNonceBefore);
        const rejected = 2n - settled;
        const ms = Date.now() - t0;

        if (settled === 2n && rejected === 0n) {
          pass("MULTI-1", "settleClaimsMulti 2-user × 1-campaign: both settled", ms);
        } else {
          fail("MULTI-1", "settleClaimsMulti 2-user batch", ms,
            `settled=${settled} rejected=${rejected} (frank: ${frankNonceAfter - frankNonceBefore}, charlie: ${charlieNonceAfter - charlieNonceBefore})`);
        }
      } catch (err: any) {
        fail("MULTI-1", "settleClaimsMulti", Date.now() - t0, String(err).slice(0, 200));
      }
    }
  }

  // ── PAUSE: 2-of-3 guardian pause/unpause flow (C-4) ─────────────────────
  // Run last — pauses the whole system, then unpauses. Any mid-test failure
  // leaves the system paused; re-run or manually unpause via guardian approve().
  console.log("\n── PAUSE: 2-of-3 guardian pause/unpause (C-4) ──────────────");

  {
    // PAUSE-1: Read current paused state and guardians
    {
      const t0 = Date.now();
      try {
        const isPaused = Boolean((await readCall(rawProvider, A.pauseRegistry, pauseIface, "paused", []))[0]);
        const g0 = (await readCall(rawProvider, A.pauseRegistry, pauseIface, "guardians", [0]))[0];
        const g1 = (await readCall(rawProvider, A.pauseRegistry, pauseIface, "guardians", [1]))[0];
        const g2 = (await readCall(rawProvider, A.pauseRegistry, pauseIface, "guardians", [2]))[0];
        const ms = Date.now() - t0;
        pass("PAUSE-1", "PauseRegistry state readable", ms,
          `paused=${isPaused} g0=${g0.slice(0,10)}... g1=${g1.slice(0,10)}... g2=${g2.slice(0,10)}...`);
        if (isPaused) {
          console.log("  [WARN] System is already paused — skipping PAUSE-2/3/4/5/6");
        }
      } catch (err: any) {
        fail("PAUSE-1", "PauseRegistry reads", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    // PAUSE-2/3: Alice proposes pause, Bob approves → system pauses
    // PAUSE-4: Verify paused state
    // PAUSE-5/6: Alice proposes unpause, Bob approves → system unpauses
    {
      // Check if currently unpaused before running pause flow
      let skipPauseFlow = false;
      try {
        const isPaused = Boolean((await readCall(rawProvider, A.pauseRegistry, pauseIface, "paused", []))[0]);
        if (isPaused) skipPauseFlow = true;
      } catch { skipPauseFlow = true; }

      if (skipPauseFlow) {
        console.log("  [SKIP] PAUSE-2/3/4/5/6 — system already paused");
      } else {
        // PAUSE-2: Alice (guardian 0) proposes a pause
        let proposalId: bigint | null = null;
        {
          const t0 = Date.now();
          try {
            // Get Alice's nonce before the tx
            const nonceBefore = await rawProvider.getTransactionCount(alice.address);
            const data = pauseIface.encodeFunctionData("propose", [1]);  // action=1 → pause
            await alice.sendTransaction({ to: A.pauseRegistry, data, ...TX_OPTS });
            await waitForNonce(rawProvider, alice.address, nonceBefore);

            // Read proposalId from event logs or estimate as nonce+1 (no easy view fn)
            // We'll assume it's 1 + the previous proposal nonce.
            // Since we can't easily read _proposalNonce (private), use a workaround:
            // re-call propose staticCall to check that a second call from same guardian reverts (state proof)
            // Instead: just use 1n for the first benchmark run; increment if needed.
            // For idempotency, we try proposalId=1 then 2 up to 10.
            const ms = Date.now() - t0;
            pass("PAUSE-2", "Guardian 0 (Alice) proposed pause", ms, "proposalId TBD");
          } catch (err: any) {
            fail("PAUSE-2", "Guardian propose pause", Date.now() - t0, String(err).slice(0, 150));
            skipPauseFlow = true;
          }
        }

        if (!skipPauseFlow) {
          // Try to find which proposalId was created by checking approvability
          // Binary-search proposalIds 1..20 to find the one Bob can approve
          {
            const t0 = Date.now();
            try {
              // Try each proposalId; find the one that Bob hasn't voted on yet
              let approvedId: bigint | null = null;
              for (let pid = 1n; pid <= 20n; pid++) {
                try {
                  const data = pauseIface.encodeFunctionData("approve", [pid]);
                  // static call — only succeeds if proposal exists, not executed, Bob hasn't voted
                  await rawProvider.call({ to: A.pauseRegistry, data, from: bob.address });
                  approvedId = pid;
                  break;
                } catch { /* try next */ }
              }

              if (approvedId === null) {
                fail("PAUSE-3", "Find approvable proposalId", Date.now() - t0, "no valid proposal found (guardian not set up?)");
                skipPauseFlow = true;
              } else {
                // PAUSE-3: Bob (guardian 1) approves → system pauses
                await sendCall(bob, rawProvider, A.pauseRegistry, pauseIface, "approve", [approvedId]);
                const isPaused = Boolean((await readCall(rawProvider, A.pauseRegistry, pauseIface, "paused", []))[0]);
                const ms = Date.now() - t0;
                if (isPaused) {
                  pass("PAUSE-3", `Guardian 1 (Bob) approved proposalId=${approvedId} → system PAUSED`, ms);
                } else {
                  fail("PAUSE-3", "System should be paused after 2nd guardian approve", ms, "paused=false");
                  skipPauseFlow = true;
                }
              }
            } catch (err: any) {
              fail("PAUSE-3", "Guardian approve", Date.now() - t0, String(err).slice(0, 150));
              skipPauseFlow = true;
            }
          }

          // PAUSE-4: Verify settlement rejects with "P" while paused
          // Paseo eth_call forbids SSTORE (nonReentrant) → use real TX + settlement nonce-delta.
          // The pause check fires and the TX reverts; the settlement lastNonce stays unchanged.
          if (!skipPauseFlow) {
            const t0 = Date.now();
            try {
              const settlNonceBefore = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [grace.address, 1n, 0]))[0]);
              const p4PrevHash = settlNonceBefore === 0n ? ZeroHash : (await readCall(rawProvider, A.settlement, settleIface, "lastClaimHash", [grace.address, 1n, 0]))[0] as string;
              const fakeClaims = await buildClaims(rawProvider, 1n, diana.address, grace.address, 1, parseDOT("0.1"), 1n, new Array(8).fill(ZeroHash), 0, settlNonceBefore, p4PrevHash);
              const batch = { user: grace.address, campaignId: 1n, claims: fakeClaims };
              // Send real TX — expect it to be included but reverted due to pause
              const ethNonceBefore = await rawProvider.getTransactionCount(grace.address);
              const data = settleIface.encodeFunctionData("settleClaims", [[batch]]);
              await grace.sendTransaction({ to: A.settlement, data, ...TX_OPTS });
              await waitForNonce(rawProvider, grace.address, ethNonceBefore);
              const settlNonceAfter = BigInt((await readCall(rawProvider, A.settlement, settleIface, "lastNonce", [grace.address, 1n, 0]))[0]);
              const ms = Date.now() - t0;
              if (settlNonceAfter === settlNonceBefore) {
                pass("PAUSE-4", "Settlement reverts with 'P' while system paused (nonce unchanged)", ms);
              } else {
                fail("PAUSE-4", "Settlement should revert while paused", ms,
                  `settlNonce advanced from ${settlNonceBefore} to ${settlNonceAfter}`);
              }
            } catch (err: any) {
              fail("PAUSE-4", "Pause enforcement check", Date.now() - t0, String(err).slice(0, 150));
            }
          }

          // PAUSE-5: Alice proposes unpause
          if (!skipPauseFlow) {
            const t0 = Date.now();
            try {
              await sendCall(alice, rawProvider, A.pauseRegistry, pauseIface, "propose", [2]);  // action=2 → unpause
              pass("PAUSE-5", "Guardian 0 (Alice) proposed unpause", Date.now() - t0);
            } catch (err: any) {
              fail("PAUSE-5", "Guardian propose unpause", Date.now() - t0, String(err).slice(0, 150));
              skipPauseFlow = true;
            }
          }

          // PAUSE-6: Bob approves unpause → system unpauses
          if (!skipPauseFlow) {
            const t0 = Date.now();
            try {
              let unpaused = false;
              for (let pid = 1n; pid <= 30n; pid++) {
                try {
                  const data = pauseIface.encodeFunctionData("approve", [pid]);
                  await rawProvider.call({ to: A.pauseRegistry, data, from: bob.address });
                  await sendCall(bob, rawProvider, A.pauseRegistry, pauseIface, "approve", [pid]);
                  const isPaused = Boolean((await readCall(rawProvider, A.pauseRegistry, pauseIface, "paused", []))[0]);
                  if (!isPaused) { unpaused = true; break; }
                } catch { /* try next */ }
              }
              const ms = Date.now() - t0;
              if (unpaused) {
                pass("PAUSE-6", "Guardian 1 (Bob) approved unpause → system UNPAUSED", ms);
              } else {
                fail("PAUSE-6", "System should be unpaused after guardian approve", ms, "paused still true");
              }
            } catch (err: any) {
              fail("PAUSE-6", "Guardian approve unpause", Date.now() - t0, String(err).slice(0, 150));
              console.log("\n  *** CRITICAL: system may still be paused! Run guardian approve() to unpause. ***\n");
            }
          }
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════════
  const passed = results.filter(r => r.passed).length;
  const total  = results.length;
  const avgMs  = total > 0 ? results.reduce((s, r) => s + r.durationMs, 0) / total : 0;

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  BENCHMARK SUMMARY");
  console.log(`  ${passed}/${total} passed   avg latency: ${avgMs.toFixed(0)}ms`);
  console.log("══════════════════════════════════════════════════════════════");

  const failed = results.filter(r => !r.passed);
  if (failed.length > 0) {
    console.log("\nFailed:");
    for (const f of failed) {
      console.log(`  ✗ ${f.id}: ${f.label}`);
      console.log(`      ${f.notes}`);
    }
  }

  console.log("\nAll results:");
  console.log("  ID".padEnd(28) + "Status   ms       Notes");
  console.log("  " + "─".repeat(80));
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const notes  = r.notes.length > 50 ? r.notes.slice(0, 47) + "..." : r.notes;
    console.log(
      `  ${r.id.padEnd(26)} ${status}     ${String(r.durationMs).padStart(6)}ms  ${notes}`
    );
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
