#!/usr/bin/env node
// DATUM Publisher Relay — Reference Implementation
//
// A publisher relay endpoint that:
//   1. Co-signs claim batches via EIP-712 (publisher attestation)
//   2. Accepts user-signed batches and queues them for on-chain submission
//   3. Periodically submits queued batches via DatumRelay.settleClaimsFor()
//
// The publisher pays gas for relay submissions. Revenue from the campaign's
// take-rate share reimburses the publisher.
//
// Security features:
//   - Per-IP rate limiting (sliding window)
//   - EIP-712 user signature verification on every submitted batch
//   - Input validation (address format, nonce ranges, batch size caps)
//   - Request body size limit (256 KB)
//   - Localhost-only flush endpoint
//   - No private keys or sensitive data exposed in public endpoints
//
// Usage:
//   1. Copy .env.example to .env, fill in your publisher key + addresses
//   2. npm install
//   3. node relay-bot.mjs
//   4. (Optional) Expose via Cloudflare tunnel: cloudflared tunnel --url http://127.0.0.1:3400

import { Wallet, JsonRpcProvider, Contract, verifyTypedData } from "ethers";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────────────────────

// Load .env if present (simple key=value parser, no dependency needed)
try {
  const envPath = path.resolve(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
} catch { /* .env is optional */ }

const RPC_URL = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io/";
const PORT = parseInt(process.env.PORT || "3400", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "300000", 10);

const PUBLISHER_KEY = process.env.PUBLISHER_KEY;
if (!PUBLISHER_KEY || PUBLISHER_KEY === "0xYOUR_PRIVATE_KEY_HERE") {
  console.error("ERROR: Set PUBLISHER_KEY in .env or environment. See .env.example.");
  process.exit(1);
}

const ADDRESSES = {
  relay:         process.env.RELAY_ADDRESS         || "0x0c2F453B48f4eC13f4c6f4d5708765A2f57Ca65B",
  settlement:    process.env.SETTLEMENT_ADDRESS    || "0x6dCbe782CFa9255adc94fdb821E6A7bc092fccc3",
  campaigns:     process.env.CAMPAIGNS_ADDRESS     || "0x1337cD3be712079688EbbD2DA2455F981522ab1d",
  pauseRegistry: process.env.PAUSE_REGISTRY_ADDRESS || "0xFa0e0D4cb23a9616f780Cb0Ad4055E9b5fE6d1bD",
};

// ── ABIs (minimal — only the functions we need) ─────────────────────────────

const RELAY_ABI = [
  {
    inputs: [{ type: "tuple[]", name: "batches", components: [
      { type: "address", name: "user" },
      { type: "uint256", name: "campaignId" },
      { type: "tuple[]", name: "claims", components: [
        { type: "uint256", name: "campaignId" },
        { type: "address", name: "publisher" },
        { type: "uint256", name: "impressionCount" },
        { type: "uint256", name: "clearingCpmPlanck" },
        { type: "uint256", name: "nonce" },
        { type: "bytes32", name: "previousClaimHash" },
        { type: "bytes32", name: "claimHash" },
        { type: "bytes",   name: "zkProof" },
      ]},
      { type: "uint256", name: "deadline" },
      { type: "bytes",   name: "signature" },
      { type: "bytes",   name: "publisherSig" },
    ]}],
    name: "settleClaimsFor",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

const SETTLEMENT_ABI = [
  { type: "event", name: "ClaimSettled", inputs: [
    { type: "uint256", name: "campaignId", indexed: true },
    { type: "address", name: "user", indexed: true },
    { type: "uint256", name: "nonce" },
    { type: "uint256", name: "publisherPayment" },
    { type: "uint256", name: "userPayment" },
    { type: "uint256", name: "protocolFee" },
  ]},
  { type: "event", name: "ClaimRejected", inputs: [
    { type: "uint256", name: "campaignId", indexed: true },
    { type: "address", name: "user", indexed: true },
    { type: "uint256", name: "nonce" },
    { type: "uint8",   name: "reasonCode" },
  ]},
];

const PAUSE_ABI = [
  { inputs: [], name: "paused", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
];

const CAMPAIGNS_ABI = [
  {
    inputs: [{ type: "uint256", name: "campaignId" }],
    name: "getCampaignForSettlement",
    outputs: [
      { type: "uint8",   name: "status" },
      { type: "address", name: "publisher" },
      { type: "uint256", name: "bidCpmPlanck" },
      { type: "uint256", name: "remainingBudget" },
      { type: "uint16",  name: "snapshotTakeRateBps" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

// ── EIP-712 types ────────────────────────────────────────────────────────────

const PUBLISHER_ATTESTATION_TYPES = {
  PublisherAttestation: [
    { name: "campaignId", type: "uint256" },
    { name: "user",       type: "address" },
    { name: "firstNonce", type: "uint256" },
    { name: "lastNonce",  type: "uint256" },
    { name: "claimCount", type: "uint256" },
  ],
};

const CLAIM_BATCH_TYPES = {
  ClaimBatch: [
    { name: "user",       type: "address" },
    { name: "campaignId", type: "uint256" },
    { name: "firstNonce", type: "uint256" },
    { name: "lastNonce",  type: "uint256" },
    { name: "claimCount", type: "uint256" },
    { name: "deadline",   type: "uint256" },
  ],
};

// ── Globals ──────────────────────────────────────────────────────────────────

const provider = new JsonRpcProvider(RPC_URL);
const publisher = new Wallet(PUBLISHER_KEY, provider);
const relay = new Contract(ADDRESSES.relay, RELAY_ABI, publisher);
const settlement = new Contract(ADDRESSES.settlement, SETTLEMENT_ABI, provider);
const pauseRegistry = new Contract(ADDRESSES.pauseRegistry, PAUSE_ABI, provider);
const campaigns = new Contract(ADDRESSES.campaigns, CAMPAIGNS_ABI, provider);

let eip712Domain = null;
const pendingQueue = [];

const stats = {
  started: new Date().toISOString(),
  attestationsIssued: 0,
  batchesReceived: 0,
  batchesSubmitted: 0,
  claimsSettled: 0,
  claimsRejected: 0,
  lastPollAt: null,
  lastSubmitAt: null,
  errors: [],
};

const QUEUE_FILE = path.resolve(__dirname, "pending-queue.json");

// ── Rate Limiting ────────────────────────────────────────────────────────────

const rateLimitBuckets = new Map();

function rateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateLimitBuckets.set(key, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
  if (bucket.timestamps.length >= maxRequests) return false;
  bucket.timestamps.push(now);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < 120_000);
    if (bucket.timestamps.length === 0) rateLimitBuckets.delete(key);
  }
}, 300_000);

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDOT(planck) {
  const val = BigInt(planck);
  const whole = val / 10_000_000_000n;
  const frac = val % 10_000_000_000n;
  return `${whole}.${frac.toString().padStart(10, "0").replace(/0+$/, "") || "0"}`;
}

function log(section, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${section}] ${msg}`);
}

function logError(section, msg) {
  stats.errors.push({ ts: new Date().toISOString(), section, msg });
  if (stats.errors.length > 50) stats.errors.shift();
  console.error(`[${new Date().toISOString().slice(11, 19)}] [${section}] ERROR: ${msg}`);
}

function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function isValidUint(val) {
  if (typeof val === "number") return Number.isInteger(val) && val >= 0;
  if (typeof val === "string") return /^\d+$/.test(val);
  return false;
}

function isValidBytes32(val) {
  return typeof val === "string" && /^0x[0-9a-fA-F]{64}$/.test(val);
}

function getClientIp(req) {
  return req.headers["cf-connecting-ip"]
    || (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket?.remoteAddress
    || "unknown";
}

async function getEIP712Domain() {
  if (eip712Domain) return eip712Domain;
  const network = await provider.getNetwork();
  eip712Domain = {
    name: "DatumRelay",
    version: "1",
    chainId: network.chainId,
    verifyingContract: ADDRESSES.relay,
  };
  return eip712Domain;
}

// ── Queue Persistence ────────────────────────────────────────────────────────

function saveQueue() {
  try {
    const serializable = pendingQueue.map((entry) => ({
      ...entry,
      batches: entry.batches.map((b) => ({
        ...b,
        campaignId: b.campaignId.toString(),
        claims: b.claims.map((c) => ({
          ...c,
          campaignId: c.campaignId.toString(),
          impressionCount: c.impressionCount.toString(),
          clearingCpmPlanck: c.clearingCpmPlanck.toString(),
          nonce: c.nonce.toString(),
        })),
        deadline: b.deadline.toString(),
      })),
    }));
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(serializable, null, 2));
  } catch (err) {
    logError("QUEUE", `Failed to save queue: ${err.message}`);
  }
}

function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    for (const entry of data) {
      pendingQueue.push({
        ...entry,
        batches: entry.batches.map((b) => ({
          ...b,
          campaignId: BigInt(b.campaignId),
          claims: b.claims.map((c) => ({
            ...c,
            campaignId: BigInt(c.campaignId),
            impressionCount: BigInt(c.impressionCount),
            clearingCpmPlanck: BigInt(c.clearingCpmPlanck),
            nonce: BigInt(c.nonce),
          })),
          deadline: BigInt(b.deadline),
        })),
      });
    }
    if (pendingQueue.length > 0) {
      log("QUEUE", `Loaded ${pendingQueue.length} pending entries from disk`);
    }
  } catch (err) {
    logError("QUEUE", `Failed to load queue: ${err.message}`);
  }
}

// ── Publisher Attestation ────────────────────────────────────────────────────

async function signAttestation(campaignId, user, firstNonce, lastNonce, claimCount) {
  const domain = await getEIP712Domain();
  const value = {
    campaignId: BigInt(campaignId),
    user,
    firstNonce: BigInt(firstNonce),
    lastNonce: BigInt(lastNonce),
    claimCount: BigInt(claimCount),
  };
  return publisher.signTypedData(domain, PUBLISHER_ATTESTATION_TYPES, value);
}

// ── Signature Verification ──────────────────────────────────────────────────

async function verifyUserSignature(batch) {
  const domain = await getEIP712Domain();
  const claims = batch.claims;
  if (!claims || claims.length === 0) return false;

  const value = {
    user: batch.user,
    campaignId: BigInt(batch.campaignId),
    firstNonce: BigInt(claims[0].nonce),
    lastNonce: BigInt(claims[claims.length - 1].nonce),
    claimCount: BigInt(claims.length),
    deadline: BigInt(batch.deadline),
  };

  try {
    const recovered = verifyTypedData(domain, CLAIM_BATCH_TYPES, value, batch.signature);
    return recovered.toLowerCase() === batch.user.toLowerCase();
  } catch {
    return false;
  }
}

// ── Relay Submission ─────────────────────────────────────────────────────────

async function submitPendingBatches() {
  if (pendingQueue.length === 0) return;

  try {
    const paused = await pauseRegistry.paused();
    if (paused) {
      log("POLL", "System is paused — skipping submission");
      return;
    }
  } catch (err) {
    logError("POLL", `Pause check failed: ${err.message}`);
    return;
  }

  const currentBlock = await provider.getBlockNumber();

  // Remove expired batches
  const valid = [];
  let expiredCount = 0;
  for (const entry of pendingQueue) {
    const allExpired = entry.batches.every((b) => BigInt(b.deadline) <= BigInt(currentBlock));
    if (allExpired) expiredCount++;
    else valid.push(entry);
  }
  if (expiredCount > 0) {
    log("POLL", `Removed ${expiredCount} expired entries`);
    pendingQueue.length = 0;
    pendingQueue.push(...valid);
    saveQueue();
  }

  if (pendingQueue.length === 0) return;

  const allBatches = [];
  for (const entry of pendingQueue) {
    for (const b of entry.batches) {
      if (BigInt(b.deadline) > BigInt(currentBlock)) {
        allBatches.push(b);
      }
    }
  }

  if (allBatches.length === 0) return;

  log("SUBMIT", `Submitting ${allBatches.length} batch(es) via relay...`);

  try {
    const contractBatches = allBatches.map((b) => ({
      user: b.user,
      campaignId: BigInt(b.campaignId),
      claims: b.claims.map((c) => ({
        campaignId: BigInt(c.campaignId),
        publisher: c.publisher,
        impressionCount: BigInt(c.impressionCount),
        clearingCpmPlanck: BigInt(c.clearingCpmPlanck),
        nonce: BigInt(c.nonce),
        previousClaimHash: c.previousClaimHash,
        claimHash: c.claimHash,
        zkProof: c.zkProof || "0x",
      })),
      deadline: BigInt(b.deadline),
      signature: b.signature,
      publisherSig: b.publisherSig || "0x",
    }));

    const tx = await relay.settleClaimsFor(contractBatches);
    log("SUBMIT", `TX sent: ${tx.hash}`);

    const receipt = await tx.wait();
    log("SUBMIT", `TX confirmed in block ${receipt.blockNumber}`);

    let settledCount = 0;
    let rejectedCount = 0;
    const iface = settlement.interface;

    for (const logEntry of receipt.logs) {
      try {
        const parsed = iface.parseLog(logEntry);
        if (parsed?.name === "ClaimSettled") settledCount++;
        else if (parsed?.name === "ClaimRejected") {
          rejectedCount++;
          log("SUBMIT", `  Rejected: campaign=${parsed.args.campaignId} nonce=${parsed.args.nonce} reason=${parsed.args.reasonCode}`);
        }
      } catch { /* log from different contract */ }
    }

    stats.batchesSubmitted += allBatches.length;
    stats.claimsSettled += settledCount;
    stats.claimsRejected += rejectedCount;
    stats.lastSubmitAt = new Date().toISOString();

    log("SUBMIT", `Result: ${settledCount} settled, ${rejectedCount} rejected`);

    pendingQueue.length = 0;
    saveQueue();
  } catch (err) {
    logError("SUBMIT", `Relay submission failed: ${(err.message || String(err)).slice(0, 200)}`);
  }
}

// ── HTTP Server ──────────────────────────────────────────────────────────────

const app = express();

app.use(express.json({ limit: "256kb" }));

// CORS + security headers
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.options("*", (_req, res) => res.sendStatus(204));

// Publisher attestation — matches extension's publisherAttestation.ts
app.post("/.well-known/datum-attest", async (req, res) => {
  const ip = getClientIp(req);
  if (!rateLimit(`attest:${ip}`, 10, 60_000)) {
    return res.status(429).json({ error: "Too many requests. Try again in a minute." });
  }

  try {
    const { campaignId, user, firstNonce, lastNonce, claimCount } = req.body;

    if (!isValidUint(campaignId)) return res.status(400).json({ error: "Invalid campaignId" });
    if (!isValidAddress(user)) return res.status(400).json({ error: "Invalid user address" });
    if (!isValidUint(firstNonce)) return res.status(400).json({ error: "Invalid firstNonce" });
    if (!isValidUint(lastNonce)) return res.status(400).json({ error: "Invalid lastNonce" });
    if (!isValidUint(claimCount) || Number(claimCount) === 0) return res.status(400).json({ error: "Invalid claimCount" });

    const nonceRange = Number(BigInt(lastNonce) - BigInt(firstNonce)) + 1;
    if (nonceRange !== Number(claimCount)) {
      return res.status(400).json({ error: "claimCount does not match nonce range" });
    }
    if (Number(claimCount) > 100) {
      return res.status(400).json({ error: "Batch too large (max 100 claims)" });
    }

    // Verify campaign is active and assigned to this publisher (or open)
    try {
      const [status, cPublisher] = await campaigns.getCampaignForSettlement(BigInt(campaignId));
      if (Number(status) !== 1) {
        return res.status(403).json({ error: "Campaign is not Active" });
      }
      const zero = "0x0000000000000000000000000000000000000000";
      if (cPublisher.toLowerCase() !== publisher.address.toLowerCase() && cPublisher !== zero) {
        return res.status(403).json({ error: "Campaign publisher mismatch" });
      }
    } catch (err) {
      logError("ATTEST", `Campaign lookup failed: ${(err.message || "").slice(0, 100)}`);
      // Proceed — on-chain contract will reject invalid claims
    }

    const signature = await signAttestation(campaignId, user, firstNonce, lastNonce, claimCount);
    stats.attestationsIssued++;
    log("ATTEST", `Signed: campaign=${campaignId} user=${user.slice(0, 10)}... nonces=${firstNonce}-${lastNonce}`);

    res.json({ signature });
  } catch (err) {
    logError("ATTEST", `Failed: ${err.message}`);
    res.status(500).json({ error: "Attestation signing failed" });
  }
});

// Accept user-signed claim batches
app.post("/relay/submit", async (req, res) => {
  const ip = getClientIp(req);
  if (!rateLimit(`submit:${ip}`, 5, 60_000)) {
    return res.status(429).json({ error: "Too many requests. Try again in a minute." });
  }

  try {
    const { batches } = req.body;

    if (!batches || !Array.isArray(batches) || batches.length === 0) {
      return res.status(400).json({ error: "Missing or empty batches array" });
    }
    if (batches.length > 10) {
      return res.status(400).json({ error: "Too many batches (max 10 per request)" });
    }

    const enrichedBatches = [];
    for (const b of batches) {
      if (!isValidAddress(b.user)) return res.status(400).json({ error: "Invalid user address" });
      if (!isValidUint(b.campaignId)) return res.status(400).json({ error: "Invalid campaignId" });
      if (!b.claims || !Array.isArray(b.claims) || b.claims.length === 0) {
        return res.status(400).json({ error: "Missing claims array" });
      }
      if (b.claims.length > 100) return res.status(400).json({ error: "Too many claims (max 100)" });
      if (!isValidUint(b.deadline)) return res.status(400).json({ error: "Invalid deadline" });
      if (!b.signature || typeof b.signature !== "string" || b.signature.length < 130) {
        return res.status(400).json({ error: "Missing or invalid signature" });
      }

      for (const c of b.claims) {
        if (!isValidUint(c.campaignId)) return res.status(400).json({ error: "Invalid campaignId in claim" });
        if (!isValidAddress(c.publisher)) return res.status(400).json({ error: "Invalid publisher in claim" });
        if (!isValidUint(c.impressionCount)) return res.status(400).json({ error: "Invalid impressionCount" });
        if (!isValidUint(c.clearingCpmPlanck)) return res.status(400).json({ error: "Invalid clearingCpmPlanck" });
        if (!isValidUint(c.nonce)) return res.status(400).json({ error: "Invalid nonce" });
        if (!isValidBytes32(c.previousClaimHash)) return res.status(400).json({ error: "Invalid previousClaimHash" });
        if (!isValidBytes32(c.claimHash)) return res.status(400).json({ error: "Invalid claimHash" });
      }

      // Verify user's EIP-712 signature
      const sigValid = await verifyUserSignature(b);
      if (!sigValid) {
        log("RELAY", `Rejected: invalid signature from ${b.user?.slice(0, 10)}... ip=${ip}`);
        return res.status(403).json({ error: "Invalid user signature" });
      }

      // Auto-sign publisher attestation if not already present
      let publisherSig = b.publisherSig || "0x";
      if (publisherSig === "0x" || publisherSig.length < 10) {
        try {
          const claimsArr = b.claims;
          if (claimsArr.length > 0) {
            publisherSig = await signAttestation(
              b.campaignId, b.user,
              claimsArr[0].nonce,
              claimsArr[claimsArr.length - 1].nonce,
              claimsArr.length
            );
            stats.attestationsIssued++;
          }
        } catch (err) {
          logError("RELAY", `Auto-attestation failed: ${(err.message || "").slice(0, 100)}`);
        }
      }

      enrichedBatches.push({
        user: b.user,
        campaignId: BigInt(b.campaignId),
        claims: b.claims.map((c) => ({
          campaignId: BigInt(c.campaignId),
          publisher: c.publisher,
          impressionCount: BigInt(c.impressionCount),
          clearingCpmPlanck: BigInt(c.clearingCpmPlanck),
          nonce: BigInt(c.nonce),
          previousClaimHash: c.previousClaimHash,
          claimHash: c.claimHash,
          zkProof: c.zkProof || "0x",
        })),
        deadline: BigInt(b.deadline),
        signature: b.signature,
        publisherSig,
      });
    }

    pendingQueue.push({
      receivedAt: new Date().toISOString(),
      ip,
      batches: enrichedBatches,
    });
    stats.batchesReceived += enrichedBatches.length;
    saveQueue();

    log("RELAY", `Queued ${enrichedBatches.length} batch(es) — queue depth: ${pendingQueue.length}`);

    res.json({
      queued: enrichedBatches.length,
      queueDepth: pendingQueue.length,
      message: "Batches queued for next relay cycle",
    });
  } catch (err) {
    logError("RELAY", `Queue failed: ${err.message}`);
    res.status(500).json({ error: "Failed to queue batches" });
  }
});

// Immediate flush — localhost only
app.post("/relay/flush", async (req, res) => {
  const ip = getClientIp(req);
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
    return res.status(403).json({ error: "Flush is only accessible from localhost" });
  }

  const count = pendingQueue.length;
  if (count === 0) return res.json({ message: "Queue empty" });

  try {
    await submitPendingBatches();
    res.json({ message: `Flushed ${count} entries`, settled: stats.claimsSettled, rejected: stats.claimsRejected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public status (no sensitive data)
app.get("/relay/status", (req, res) => {
  const ip = getClientIp(req);
  if (!rateLimit(`status:${ip}`, 30, 60_000)) {
    return res.status(429).json({ error: "Too many requests" });
  }

  res.json({
    publisher: publisher.address,
    queueDepth: pendingQueue.length,
    pollIntervalMs: POLL_INTERVAL_MS,
    stats: {
      started: stats.started,
      attestationsIssued: stats.attestationsIssued,
      batchesReceived: stats.batchesReceived,
      batchesSubmitted: stats.batchesSubmitted,
      claimsSettled: stats.claimsSettled,
      claimsRejected: stats.claimsRejected,
      lastPollAt: stats.lastPollAt,
      lastSubmitAt: stats.lastSubmitAt,
    },
  });
});

// Health check
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Catch-all
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  log("INIT", "DATUM Publisher Relay starting...");
  log("INIT", `Publisher: ${publisher.address}`);
  log("INIT", `RPC: ${RPC_URL}`);
  log("INIT", `Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  try {
    const network = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    const bal = await provider.getBalance(publisher.address);
    log("INIT", `Chain ID: ${network.chainId}, block: ${block}, balance: ${formatDOT(bal)} PAS`);

    eip712Domain = {
      name: "DatumRelay",
      version: "1",
      chainId: network.chainId,
      verifyingContract: ADDRESSES.relay,
    };

    if (bal === 0n) {
      log("INIT", "WARNING: Publisher has zero balance — gas payments will fail");
    }
  } catch (err) {
    logError("INIT", `RPC failed: ${err.message}`);
    log("INIT", "Will retry on next poll cycle");
  }

  loadQueue();

  app.listen(PORT, "0.0.0.0", () => {
    log("HTTP", `Listening on http://0.0.0.0:${PORT}`);
  });

  async function poll() {
    stats.lastPollAt = new Date().toISOString();
    try { await submitPendingBatches(); }
    catch (err) { logError("POLL", `Poll failed: ${err.message}`); }
  }

  setTimeout(poll, 10_000);
  setInterval(poll, POLL_INTERVAL_MS);

  log("INIT", "Publisher relay running.");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
