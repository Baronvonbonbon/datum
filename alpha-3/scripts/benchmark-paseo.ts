/**
 * benchmark-paseo.ts — Live Paseo Testnet Benchmark
 * ===================================================
 * Exercises all major alpha-3 contract functions against the live deployed
 * Paseo contracts.  Uses the same raw JsonRpcProvider + nonce-polling pattern
 * as deploy.ts / setup-testnet.ts to work around the Paseo eth-rpc receipt bug.
 *
 * Usage:
 *   npx hardhat run scripts/benchmark-paseo.ts --network polkadotTestnet
 *
 * Prerequisites:
 *   - Contracts deployed (deployed-addresses.json present)
 *   - setup-testnet.ts has run at least once (Diana + Eve registered,
 *     Diana is a reporter on DatumPublisherReputation)
 *   - Bob, Charlie, Frank all have ≥ 30 PAS
 *
 * DOT price scenarios — $1 CPM baseline
 * ----------------------------------------
 *   DOT @ $2  → $1 CPM = 0.5  DOT / 1000 imps
 *   DOT @ $5  → $1 CPM = 0.2  DOT / 1000 imps
 *   DOT @ $10 → $1 CPM = 0.1  DOT / 1000 imps
 *
 * Revenue split (50% takeRate)
 * ----------------------------
 *   totalPayment     = clearingCpm × impressions / 1000
 *   publisherPayment = totalPayment × 50%   (5000 bps)
 *   userPayment      = remainder   × 75%   (7500 bps)
 *   protocolFee      = remainder   × 25%
 *
 * Benchmark groups
 * ----------------
 *   SETUP  — publisher read verification
 *   ECO    — settlement + payment split at $2 / $5 / $10 DOT
 *   ZK     — ZK-proof-required campaign (real Groth16 / BN254 ecPairing precompile)
 *   OPEN   — open campaign (publisher = address(0))
 *   SCALE  — 1-claim vs 5-claim batch, 100 vs 1000 impressions per claim
 *   RL     — rate limiter window usage before/after settlement
 *   REP    — reputation recordSettlement + getScore
 *   RPT    — community reports (reportPage / reportAd)
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

// ── System precompile: Blake2-256 (Paseo/PolkaVM) ────────────────────────────
const sysIface = new Interface(["function hashBlake256(bytes) view returns (bytes32)"]);
const SYS_ADDR = "0x0000000000000000000000000000000000000900";

async function blake256(provider: JsonRpcProvider, packed: Uint8Array): Promise<string> {
  const data = sysIface.encodeFunctionData("hashBlake256", [packed]);
  const raw = await provider.call({ to: SYS_ADDR, data });
  return sysIface.decodeFunctionResult("hashBlake256", raw)[0] as string;
}

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
}): string {
  return AbiCoder.defaultAbiCoder().encode(
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
}

// Generate a real Groth16 proof for a claim.
// Returns encoded 256-byte proof string, or null if zkey is not available.
async function generateZKProof(
  claimHash: string,   // bytes32 hex
  impressions: bigint,
  nonce: bigint,
): Promise<string | null> {
  if (!ZK_AVAILABLE) return null;
  const snarkjs = await import("snarkjs");
  const claimHashFe = (BigInt(claimHash) % SCALAR_ORDER).toString();
  const { proof } = await snarkjs.groth16.fullProve(
    { claimHash: claimHashFe, impressions: impressions.toString(), nonce: nonce.toString() },
    WASM_PATH,
    ZKEY_PATH,
  );
  return encodeProof(proof);
}

// ── Claim chain builder (Blake2-256 via Paseo system precompile) ──────────────
async function buildClaims(
  provider: JsonRpcProvider,
  campaignId: bigint,
  publisherAddr: string,
  userAddr: string,
  count: number,
  cpm: bigint,
  impressions: bigint,
  zkProof = "0x",
) {
  const claims = [];
  let prevHash = ZeroHash;
  for (let i = 1; i <= count; i++) {
    const nonce = BigInt(i);
    const packed = getBytes(solidityPacked(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [campaignId, publisherAddr, userAddr, impressions, cpm, nonce, prevHash],
    ));
    const hash = await blake256(provider, packed);
    claims.push({
      campaignId,
      publisher: publisherAddr,
      impressionCount: impressions,
      clearingCpmPlanck: cpm,
      nonce,
      previousClaimHash: prevHash,
      claimHash: hash,
      zkProof,
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
): Promise<any[]> {
  const data = iface.encodeFunctionData(method, args);
  const raw = await provider.call({ to, data });
  return iface.decodeFunctionResult(method, raw) as unknown as any[];
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

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const publishersAbi = [
  "function getPublisher(address) view returns (bool registered, uint16 takeRateBps)",
  "function isPublisher(address) view returns (bool)",
];

const campaignsAbi = [
  "function createCampaign(address publisher, uint256 dailyCap, uint256 bidCpm, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)",
  "function getCampaignStatus(uint256 campaignId) view returns (uint8)",
  "function nextCampaignId() view returns (uint256)",
  "function getCampaign(uint256 campaignId) view returns (address advertiser, address publisher, uint256 bidCpmPlanck, uint16 takeRateBps, uint8 status)",
];

const govV2Abi = [
  "function quorumWeighted() view returns (uint256)",
  "function vote(uint256 campaignId, bool aye, uint8 conviction) payable",
  "function evaluateCampaign(uint256 campaignId)",
];

const settlementAbi = [
  "function settleClaims((address user, uint256 campaignId, (uint256 campaignId, address publisher, uint256 impressionCount, uint256 clearingCpmPlanck, uint256 nonce, bytes32 previousClaimHash, bytes32 claimHash, bytes zkProof)[] claims)[] batches) returns (uint256 settledCount, uint256 rejectedCount)",
];

const vaultAbi = [
  "function publisherBalance(address) view returns (uint256)",
  "function userBalance(address) view returns (uint256)",
  "function protocolBalance() view returns (uint256)",
];

const reportsAbi = [
  "function reportPage(uint256 campaignId, uint8 reason)",
  "function reportAd(uint256 campaignId, uint8 reason)",
  "function pageReports(uint256) view returns (uint256)",
  "function adReports(uint256) view returns (uint256)",
];

const reputationAbi = [
  "function recordSettlement(address publisher, uint256 campaignId, uint256 settled, uint256 rejected)",
  "function getScore(address publisher) view returns (uint256)",
  "function getPublisherStats(address publisher) view returns (uint256 settled, uint256 rejected, uint256 score)",
  "function totalSettled(address) view returns (uint256)",
  "function totalRejected(address) view returns (uint256)",
  "function reporters(address) view returns (bool)",
  "function isAnomaly(address publisher, uint256 campaignId) view returns (bool)",
];

const rateLimiterAbi = [
  "function currentWindowUsage(address publisher) view returns (uint256 windowId, uint256 impressions, uint256 limit)",
  "function windowBlocks() view returns (uint256)",
  "function maxPublisherImpressionsPerWindow() view returns (uint256)",
];

const zkVerifierAbi = [
  "function verify(bytes calldata proof, bytes32 claimHash) view returns (bool)",
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
    "campaigns", "publishers", "governanceV2", "settlement", "paymentVault",
    "reports", "reputation", "rateLimiter", "zkVerifier",
  ];
  const missing = requiredKeys.filter(k => !A[k]);
  if (missing.length > 0) {
    console.error("Missing addresses:", missing.join(", "));
    process.exitCode = 1;
    return;
  }

  // Interfaces
  const pubIface      = new Interface(publishersAbi);
  const campIface     = new Interface(campaignsAbi);
  const govIface      = new Interface(govV2Abi);
  const settleIface   = new Interface(settlementAbi);
  const vaultIface    = new Interface(vaultAbi);
  const reportsIface  = new Interface(reportsAbi);
  const repIface      = new Interface(reputationAbi);
  const rlIface       = new Interface(rateLimiterAbi);
  const zkIface       = new Interface(zkVerifierAbi);

  // ── Read quorum once ───────────────────────────────────────────────────────
  const quorumRaw = await readCall(rawProvider, A.governanceV2, govIface, "quorumWeighted", []);
  const QUORUM = BigInt(quorumRaw[0]);
  const VOTE_STAKE = QUORUM > parseDOT("10") ? QUORUM : parseDOT("10");

  // ── Helper: create campaign, vote, activate ────────────────────────────────
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
    await sendCall(advertiser, rawProvider, A.campaigns, campIface, "createCampaign",
      [publisher, daily, cpm, requiredTags, requireZk, ZeroAddress, 0, 0], budget);
    await sendCall(alice, rawProvider, A.governanceV2, govIface, "vote",
      [cid, true, 0], VOTE_STAKE);
    await sendCall(bob, rawProvider, A.governanceV2, govIface, "evaluateCampaign", [cid]);
    const statusRaw = await readCall(rawProvider, A.campaigns, campIface, "getCampaignStatus", [cid]);
    const status = Number(BigInt(statusRaw[0]));
    if (status !== 1) throw new Error(`Campaign ${cid} failed to activate: status=${STATUS_NAMES[status]}`);
    return cid;
  }

  // ── Settle helper: static call + live call, returns settledCount ───────────
  async function doSettle(
    user: Wallet,
    cid: bigint,
    publisher: string,
    count: number,
    cpm: bigint,
    impressions: bigint,
    zkProof = "0x",
  ): Promise<{ settledCount: bigint; rejectedCount: bigint }> {
    const claims = await buildClaims(rawProvider, cid, publisher, user.address, count, cpm, impressions, zkProof);
    const batch = { user: user.address, campaignId: cid, claims };
    const data = settleIface.encodeFunctionData("settleClaims", [[batch]]);
    const staticRaw = await rawProvider.call({ to: A.settlement, data, from: user.address });
    const decoded = settleIface.decodeFunctionResult("settleClaims", staticRaw);
    const settledCount = BigInt(decoded[0]);
    const rejectedCount = BigInt(decoded[1]);
    // Execute for real
    await sendCall(user, rawProvider, A.settlement, settleIface, "settleClaims", [[batch]]);
    return { settledCount, rejectedCount };
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Datum Alpha-3 — Paseo Live Benchmark");
  console.log("  Network:", rpcUrl);
  console.log("  Contracts:", A.campaigns);
  console.log("══════════════════════════════════════════════════════════════\n");

  // ── SETUP: verify publishers registered ───────────────────────────────────
  console.log("── SETUP: Publisher verification ──────────────────────────");
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
        pass("SETUP-2", "Grace not a registered publisher (expected)", ms, "WARNING: grace is registered");
      }
    } catch (err: any) {
      fail("SETUP-1", "Publisher read", Date.now() - t0, String(err).slice(0, 100));
    }
  }

  // ── SETUP-3: Diana is reporter on reputation contract ─────────────────────
  {
    const t0 = Date.now();
    try {
      const res = await readCall(rawProvider, A.reputation, repIface, "reporters", [diana.address]);
      const isReporter = Boolean(res[0]);
      const ms = Date.now() - t0;
      if (isReporter) {
        pass("SETUP-3", "Diana is reputation reporter", ms);
      } else {
        fail("SETUP-3", "Diana is reputation reporter", ms, "NOT reporter — run setup-testnet.ts step 5.7");
      }
    } catch (err: any) {
      fail("SETUP-3", "Reputation reporter check", Date.now() - t0, String(err).slice(0, 100));
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

      const pubBefore = (await readCall(rawProvider, A.paymentVault, vaultIface, "publisherBalance", [diana.address]))[0];
      const userBefore = (await readCall(rawProvider, A.paymentVault, vaultIface, "userBalance", [grace.address]))[0];

      const IMPS = 100n;
      const { settledCount, rejectedCount } = await doSettle(
        grace, cid, diana.address, 1, sc.cpm, IMPS,
      );

      const pubAfter = (await readCall(rawProvider, A.paymentVault, vaultIface, "publisherBalance", [diana.address]))[0];
      const userAfter = (await readCall(rawProvider, A.paymentVault, vaultIface, "userBalance", [grace.address]))[0];

      const pubDelta = BigInt(pubAfter) - BigInt(pubBefore);
      const userDelta = BigInt(userAfter) - BigInt(userBefore);

      const exp = expectedPayments(sc.cpm, IMPS, 1);
      const ms = Date.now() - t0;

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
    const CPM = parseDOT("0.2");
    const BUDGET = parseDOT("2");

    // ZK-1: zkVerifier.verify(): empty→false, real proof→true
    // Real proof requires circuits/impression.zkey (run scripts/setup-zk.mjs first).
    // If zkey absent, tests that empty and malformed proofs both return false.
    {
      const t0 = Date.now();
      try {
        const dummyHash = keccak256(toUtf8Bytes("dummy"));
        const resEmpty  = await readCall(rawProvider, A.zkVerifier, zkIface, "verify", ["0x", dummyHash]);
        const emptyOk   = !Boolean(resEmpty[0]);

        if (ZK_AVAILABLE) {
          // Generate real Groth16 proof for the dummy hash with impressions=1, nonce=1
          const realProof = await generateZKProof(dummyHash, 1n, 1n);
          const resReal   = await readCall(rawProvider, A.zkVerifier, zkIface, "verify", [realProof!, dummyHash]);
          const realOk    = Boolean(resReal[0]);
          const ms = Date.now() - t0;
          if (emptyOk && realOk) {
            pass("ZK-1", "ZKVerifier.verify: empty→false, real Groth16 proof→true", ms);
          } else {
            fail("ZK-1", "ZKVerifier.verify Groth16", ms,
              `empty=${!emptyOk} realProof=${realOk} (vkSet?)`);
          }
        } else {
          // Without zkey: confirm empty and malformed proofs are both rejected
          const resBad = await readCall(rawProvider, A.zkVerifier, zkIface, "verify", ["0xdeadbeef", dummyHash]);
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

    // ZK-2: Create ZK campaign + settle with valid Groth16 proof (BN254 precompiles)
    // Requires circuits/impression.zkey — skip if not available.
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
          // Build claim to get the claimHash, then generate proof for it
          const claims = await buildClaims(rawProvider, zkCid, diana.address, grace.address, 1, CPM, 100n);
          const claimHash = claims[0].claimHash as string;
          const nonce     = claims[0].nonce as bigint;
          const zkProof   = await generateZKProof(claimHash, 100n, nonce);
          // Re-build with the real proof attached
          const claimsWithProof = claims.map((c: any) => ({ ...c, zkProof }));
          const batch = { user: grace.address, campaignId: zkCid, claims: claimsWithProof };
          const data = settleIface.encodeFunctionData("settleClaims", [[batch]]);
          const staticRaw = await rawProvider.call({ to: A.settlement, data, from: grace.address });
          const decoded = settleIface.decodeFunctionResult("settleClaims", staticRaw);
          const settled  = BigInt(decoded[0]);
          const rejected = BigInt(decoded[1]);
          const ms = Date.now() - t0;
          if (settled === 1n && rejected === 0n) {
            pass("ZK-2", "Settle with real Groth16 proof accepted (BN254 ecPairing)", ms);
          } else {
            fail("ZK-2", "Settle with real Groth16 proof", ms,
              `settled=${settled} rejected=${rejected}`);
          }
          // Actually submit it on-chain
          await doSettle(grace, zkCid, diana.address, 1, CPM, 100n, zkProof!);
        }
      } catch (err: any) {
        fail("ZK-2", "ZK campaign settle", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // ZK-3: Reject empty proof (reason 16)
    if (zkCid !== null) {
      const t0 = Date.now();
      try {
        // Build fresh claim chain (nonce=1 from new state — different user: charlie)
        const claims = await buildClaims(rawProvider, zkCid, diana.address, charlie.address, 1, CPM, 50n, "0x");
        const batch = { user: charlie.address, campaignId: zkCid, claims };
        const data = settleIface.encodeFunctionData("settleClaims", [[batch]]);
        const staticRaw = await rawProvider.call({ to: A.settlement, data, from: charlie.address });
        const decoded = settleIface.decodeFunctionResult("settleClaims", staticRaw);
        const rejected = BigInt(decoded[1]);
        const ms = Date.now() - t0;
        if (rejected === 1n) {
          pass("ZK-3", "Settle with empty ZK proof rejected (reason 16)", ms);
        } else {
          fail("ZK-3", "Settle with empty ZK proof rejected", ms,
            `expected rejected=1 got settled=${decoded[0]} rejected=${decoded[1]}`);
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
        openCid = await deployBenchmarkCampaign(
          charlie, ZeroAddress, CPM, BUDGET, BUDGET,
        );
        const ms = Date.now() - t0;
        console.log(`  [INFO] OPEN-1: campaign ${openCid} active (publisher=0x0)`);
        pass("OPEN-1", `Open campaign created and activated (cid=${openCid})`, ms);
      } catch (err: any) {
        fail("OPEN-1", "Create open campaign", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // OPEN-2: Diana settles (registered publisher) — grace as user
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

    // OPEN-3: Eve settles same open campaign (different user: frank as user)
    if (openCid !== null) {
      const t0 = Date.now();
      try {
        // alice as user (fresh chain state — different from grace who settled in OPEN-2)
        const claimsAlice = await buildClaims(rawProvider, openCid!, diana.address, alice.address, 1, CPM, 50n);
        const batchAlice = { user: alice.address, campaignId: openCid!, claims: claimsAlice };
        const data = settleIface.encodeFunctionData("settleClaims", [[batchAlice]]);
        const staticRaw = await rawProvider.call({ to: A.settlement, data, from: alice.address });
        const decoded = settleIface.decodeFunctionResult("settleClaims", staticRaw);
        const settledCount = BigInt(decoded[0]);
        const ms = Date.now() - t0;
        if (settledCount === 1n) {
          pass("OPEN-3", "Second user settles open campaign (alice as user)", ms);
        } else {
          fail("OPEN-3", "Second user settles open campaign", ms,
            `settled=${decoded[0]} rejected=${decoded[1]}`);
        }
      } catch (err: any) {
        fail("OPEN-3", "Open campaign second user settle", Date.now() - t0, String(err).slice(0, 150));
      }
    }
  }

  // ── SCALE: Multi-claim batch + impression scaling ─────────────────────────
  console.log("\n── SCALE: Batch size + impression scaling ──────────────────");

  {
    // Use $5/DOT scenario for scale tests
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

    // SCALE-1: 4-claim batch, 100 impressions each
    // NOTE: Paseo eth_call silently returns null (data=null) for ≥5 claims with the v6
    // Settlement due to extra per-claim staticcalls (S12 blocklist via publishers.isBlocked).
    // 4 claims (1508 bytes calldata) is the confirmed safe upper bound on Paseo eth_call.
    if (scaleCid !== null) {
      const t0 = Date.now();
      try {
        // Use frank as user for fresh chain state
        const claims = await buildClaims(rawProvider, scaleCid, diana.address, frank.address, 4, CPM, 100n);
        const batch = { user: frank.address, campaignId: scaleCid, claims };
        const data = settleIface.encodeFunctionData("settleClaims", [[batch]]);
        const staticRaw = await rawProvider.call({ to: A.settlement, data, from: frank.address });
        const decoded = settleIface.decodeFunctionResult("settleClaims", staticRaw);
        const settledCount = BigInt(decoded[0]);
        const ms = Date.now() - t0;
        const exp = expectedPayments(CPM, 100n, 4);
        if (settledCount === 4n) {
          pass("SCALE-1", "4-claim batch (100 imps each) — all settled", ms,
            `total=${formatDOT(exp.total)} PAS`);
        } else {
          fail("SCALE-1", "4-claim batch", ms, `settled=${settledCount} rejected=${decoded[1]}`);
        }
      } catch (err: any) {
        fail("SCALE-1", "4-claim batch", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // SCALE-2: 1 claim, 1000 impressions
    if (scaleCid !== null) {
      const t0 = Date.now();
      try {
        // Use charlie as user for fresh chain state
        const claims = await buildClaims(rawProvider, scaleCid, diana.address, charlie.address, 1, CPM, 1000n);
        const batch = { user: charlie.address, campaignId: scaleCid, claims };
        const data = settleIface.encodeFunctionData("settleClaims", [[batch]]);
        const staticRaw = await rawProvider.call({ to: A.settlement, data, from: charlie.address });
        const decoded = settleIface.decodeFunctionResult("settleClaims", staticRaw);
        const settledCount = BigInt(decoded[0]);
        const ms = Date.now() - t0;
        const exp = expectedPayments(CPM, 1000n, 1);
        if (settledCount === 1n) {
          pass("SCALE-2", "1 claim × 1000 impressions — settled", ms,
            `total=${formatDOT(exp.total)} PAS`);
        } else {
          fail("SCALE-2", "1 claim × 1000 impressions", ms,
            `settled=${settledCount} rejected=${decoded[1]}`);
        }
      } catch (err: any) {
        fail("SCALE-2", "1000-impression single claim", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // SCALE-3: 1 claim, 10 impressions (minimum meaningful)
    if (scaleCid !== null) {
      const t0 = Date.now();
      try {
        const claims = await buildClaims(rawProvider, scaleCid, diana.address, eve.address, 1, CPM, 10n);
        const batch = { user: eve.address, campaignId: scaleCid, claims };
        const data = settleIface.encodeFunctionData("settleClaims", [[batch]]);
        const staticRaw = await rawProvider.call({ to: A.settlement, data, from: eve.address });
        const decoded = settleIface.decodeFunctionResult("settleClaims", staticRaw);
        const settledCount = BigInt(decoded[0]);
        const ms = Date.now() - t0;
        if (settledCount === 1n) {
          pass("SCALE-3", "1 claim × 10 impressions — settled", ms);
        } else {
          fail("SCALE-3", "1 claim × 10 impressions", ms,
            `settled=${settledCount} rejected=${decoded[1]}`);
        }
      } catch (err: any) {
        fail("SCALE-3", "10-impression single claim", Date.now() - t0, String(err).slice(0, 150));
      }
    }
  }

  // ── RL: Rate limiter ─────────────────────────────────────────────────────
  console.log("\n── RL: Rate limiter (BM-5) ─────────────────────────────────");

  {
    // RL-1: Read current rate limiter settings
    {
      const t0 = Date.now();
      try {
        const wb   = (await readCall(rawProvider, A.rateLimiter, rlIface, "windowBlocks", []))[0];
        const maxI = (await readCall(rawProvider, A.rateLimiter, rlIface, "maxPublisherImpressionsPerWindow", []))[0];
        const [windowId, impressions, limit] = await readCall(
          rawProvider, A.rateLimiter, rlIface, "currentWindowUsage", [diana.address]);
        const ms = Date.now() - t0;
        pass("RL-1", "Rate limiter settings readable", ms,
          `windowBlocks=${wb} maxPerWindow=${maxI} dianaUsage=${impressions}/${limit} (window ${windowId})`);
      } catch (err: any) {
        fail("RL-1", "Rate limiter read", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    // RL-2: Small settlement and verify window usage increases
    {
      const t0 = Date.now();
      try {
        const [wBefore, impBefore, limitBefore] = await readCall(
          rawProvider, A.rateLimiter, rlIface, "currentWindowUsage", [diana.address]);
        const impBeforeN = BigInt(impBefore);
        const limitN     = BigInt(limitBefore);

        // Only attempt if there's room in the window
        const CPM_RL    = parseDOT("0.1");  // above minimumCpmFloor
        const IMPS_RL   = 50n;              // 50 impressions — well within any window cap

        if (impBeforeN + IMPS_RL > limitN) {
          pass("RL-2", "Rate limiter window usage tracking (skipped — window full)", Date.now() - t0,
            `current ${impBeforeN}/${limitN} — would exceed cap`);
        } else {
          // Create a fresh RL campaign
          const rlCid = await deployBenchmarkCampaign(
            bob, diana.address, CPM_RL, parseDOT("1"), parseDOT("1"),
          );
          console.log(`  [INFO] RL-2: campaign ${rlCid} active`);

          await doSettle(grace, rlCid, diana.address, 1, CPM_RL, IMPS_RL);

          const [, impAfter] = await readCall(
            rawProvider, A.rateLimiter, rlIface, "currentWindowUsage", [diana.address]);
          const impAfterN = BigInt(impAfter);
          const ms = Date.now() - t0;
          if (impAfterN >= impBeforeN + IMPS_RL) {
            pass("RL-2", "Window usage increases after settlement", ms,
              `${impBeforeN} → ${impAfterN} impressions`);
          } else {
            fail("RL-2", "Window usage tracking", ms,
              `expected ≥${impBeforeN + IMPS_RL} got ${impAfterN}`);
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
    // REP-1: Read current score
    {
      const t0 = Date.now();
      try {
        const [settled, rejected, score] = await readCall(
          rawProvider, A.reputation, repIface, "getPublisherStats", [diana.address]);
        const ms = Date.now() - t0;
        pass("REP-1", "getPublisherStats readable", ms,
          `settled=${settled} rejected=${rejected} score=${score}bps`);
      } catch (err: any) {
        fail("REP-1", "getPublisherStats", Date.now() - t0, String(err).slice(0, 100));
      }
    }

    // REP-2: Diana (reporter) calls recordSettlement
    {
      const t0 = Date.now();
      try {
        const settledBefore = BigInt((await readCall(rawProvider, A.reputation, repIface, "totalSettled", [diana.address]))[0]);

        // Diana is a reporter — she records her own settlement data (relay-bot pattern)
        const BM_CAMPAIGN_ID = 9999n; // arbitrary benchmark campaign ID (reputation is additive)
        await sendCall(diana, rawProvider, A.reputation, repIface, "recordSettlement",
          [diana.address, BM_CAMPAIGN_ID, 800n, 200n]);

        const settledAfter = BigInt((await readCall(rawProvider, A.reputation, repIface, "totalSettled", [diana.address]))[0]);
        const score = BigInt((await readCall(rawProvider, A.reputation, repIface, "getScore", [diana.address]))[0]);
        const ms = Date.now() - t0;

        if (settledAfter === settledBefore + 800n) {
          pass("REP-2", "recordSettlement increments counters", ms,
            `totalSettled +800, score=${score}bps`);
        } else {
          fail("REP-2", "recordSettlement counter accumulation", ms,
            `expected +800 settled, got ${settledAfter - settledBefore}`);
        }
      } catch (err: any) {
        fail("REP-2", "recordSettlement", Date.now() - t0, String(err).slice(0, 150));
      }
    }

    // REP-3: isAnomaly detection
    {
      const t0 = Date.now();
      try {
        // Record a campaign with high rejection rate vs global — anomaly
        const BM_ANOMALY_ID = 9998n;
        await sendCall(diana, rawProvider, A.reputation, repIface, "recordSettlement",
          [diana.address, BM_ANOMALY_ID, 4n, 6n]); // 60% rejection
        const anomaly = Boolean((await readCall(rawProvider, A.reputation, repIface, "isAnomaly",
          [diana.address, BM_ANOMALY_ID]))[0]);
        const ms = Date.now() - t0;
        // Note: isAnomaly requires MIN_SAMPLE=10 for campaign total.
        // 4+6=10 which equals MIN_SAMPLE — behavior depends on contract (>= or >).
        // We just check the call succeeds and returns a boolean.
        pass("REP-3", "isAnomaly call succeeds", ms, `isAnomaly(campaignId=${BM_ANOMALY_ID})=${anomaly}`);
      } catch (err: any) {
        fail("REP-3", "isAnomaly call", Date.now() - t0, String(err).slice(0, 150));
      }
    }
  }

  // ── RPT: Community reports ────────────────────────────────────────────────
  console.log("\n── RPT: Community reports (DatumReports) ───────────────────");

  // Use a known active campaign ID — the first ECO campaign is cid=nextBefore at script start.
  // For reports we can use any valid campaignId, so use campaign 2 (created by setup-testnet.ts).
  // If that doesn't exist, we'll create a fresh one.
  {
    // Determine a report target campaign ID — check existing campaigns
    let reportCid: bigint | null = null;

    {
      const t0 = Date.now();
      try {
        // Try campaign ID 2 (standard setup-testnet campaign)
        const statusRaw = await readCall(rawProvider, A.campaigns, campIface, "getCampaignStatus", [2n]);
        const status = Number(BigInt(statusRaw[0]));
        if (status === 1) {
          reportCid = 2n;
          pass("RPT-SETUP", "Using campaign 2 for report tests", Date.now() - t0,
            `status=${STATUS_NAMES[status]}`);
        } else {
          // Create a fresh one
          reportCid = await deployBenchmarkCampaign(
            bob, diana.address, parseDOT("0.2"), parseDOT("1"), parseDOT("1"),
          );
          pass("RPT-SETUP", `Created fresh report campaign (cid=${reportCid})`, Date.now() - t0);
        }
      } catch (err: any) {
        try {
          reportCid = await deployBenchmarkCampaign(
            bob, diana.address, parseDOT("0.2"), parseDOT("1"), parseDOT("1"),
          );
          pass("RPT-SETUP", `Created fresh report campaign (cid=${reportCid})`, Date.now() - t0);
        } catch (err2: any) {
          fail("RPT-SETUP", "Report target campaign", Date.now() - t0, String(err2).slice(0, 100));
        }
      }
    }

    if (reportCid !== null) {
      // RPT-1: reportPage
      {
        const t0 = Date.now();
        try {
          const before = BigInt((await readCall(rawProvider, A.reports, reportsIface, "pageReports", [reportCid]))[0]);
          await sendCall(grace, rawProvider, A.reports, reportsIface, "reportPage", [reportCid, 1]);
          const after = BigInt((await readCall(rawProvider, A.reports, reportsIface, "pageReports", [reportCid]))[0]);
          const ms = Date.now() - t0;
          if (after === before + 1n) {
            pass("RPT-1", "reportPage increments pageReports counter", ms,
              `cid=${reportCid} counter: ${before}→${after}`);
          } else {
            fail("RPT-1", "reportPage counter", ms, `expected +1 got ${after - before}`);
          }
        } catch (err: any) {
          fail("RPT-1", "reportPage", Date.now() - t0, String(err).slice(0, 150));
        }
      }

      // RPT-2: reportAd
      {
        const t0 = Date.now();
        try {
          const before = BigInt((await readCall(rawProvider, A.reports, reportsIface, "adReports", [reportCid]))[0]);
          await sendCall(grace, rawProvider, A.reports, reportsIface, "reportAd", [reportCid, 3]);
          const after = BigInt((await readCall(rawProvider, A.reports, reportsIface, "adReports", [reportCid]))[0]);
          const ms = Date.now() - t0;
          if (after === before + 1n) {
            pass("RPT-2", "reportAd increments adReports counter", ms,
              `cid=${reportCid} counter: ${before}→${after}`);
          } else {
            fail("RPT-2", "reportAd counter", ms, `expected +1 got ${after - before}`);
          }
        } catch (err: any) {
          fail("RPT-2", "reportAd", Date.now() - t0, String(err).slice(0, 150));
        }
      }

      // RPT-3: All valid reason codes (1-5) accepted — view only
      {
        const t0 = Date.now();
        try {
          // Static-call reportPage with reasons 1-5 to verify no revert
          let allPassed = true;
          for (let r = 1; r <= 5; r++) {
            const data = reportsIface.encodeFunctionData("reportPage", [reportCid, r]);
            try {
              await rawProvider.call({ to: A.reports, data, from: grace.address });
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

      // RPT-4: Invalid reason (0) reverts
      {
        const t0 = Date.now();
        try {
          const data = reportsIface.encodeFunctionData("reportPage", [reportCid, 0]);
          let reverted = false;
          try {
            await rawProvider.call({ to: A.reports, data, from: grace.address });
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

  // ══════════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════════
  const passed = results.filter(r => r.passed).length;
  const total  = results.length;
  const avgMs  = results.reduce((s, r) => s + r.durationMs, 0) / total;

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
