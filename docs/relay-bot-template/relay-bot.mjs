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
//
// SLIM (#2) wire format: the on-chain Claim is slim — campaignId/nonce/prevHash/
// claimHash are derived on-chain; path-specific fields live in an optional proof
// sidecar; SignedClaimBatch carries firstNonce (== on-chain lastNonce+1); cosig
// claimsHash is keccak(concat keccak(abi.encode(slimClaim))). The canonical spec
// is alpha-5/OFFCHAIN-SLIM-PORTING.md; the live client is alpha-5/extension.

import { Wallet, JsonRpcProvider, Contract, verifyTypedData, AbiCoder, keccak256 } from "ethers";
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
  // Fallbacks track the current Paseo MVP slim deploy (2026-06-10). Override
  // any of these via env for other deployments.
  relay:         process.env.RELAY_ADDRESS         || "0x384D9c9676b6344B82a19cB192341892622BBFb0",
  settlement:    process.env.SETTLEMENT_ADDRESS    || "0x7714563C43413Cfc14b2104EA20f4c596ab75901",
  campaigns:     process.env.CAMPAIGNS_ADDRESS     || "0xe9E5813102C26c14d352DaeDb54f07e7F7564143",
  pauseRegistry: process.env.PAUSE_REGISTRY_ADDRESS || "0xa19508Ec7a90Adc8cee76D0C6006e52F5cA7A5dD",
  // SLIM (#2): the AttestationVerifier the EXTENSION submits through — the
  // /.well-known/datum-attest cosig is signed over THIS contract's domain.
  attestationVerifier: process.env.ATTESTATION_VERIFIER_ADDRESS || "0x659d0e2b05e51DB72f81667088a3372f9f21f848",
};

// ── ABIs (minimal — only the functions we need) ─────────────────────────────

// SLIM (#2): SignedClaimBatch matches IDatumSettlement.sol. campaignId/nonce/
// previousClaimHash/claimHash are derived on-chain (not on the claim); the
// path-specific fields live in an optional `proof` sidecar (empty for a plain
// view claim); firstNonce is the explicit replay anchor (== on-chain lastNonce+1).
const RELAY_ABI = [
  {
    inputs: [{ type: "tuple[]", name: "batches", components: [
      { type: "address", name: "user" },
      { type: "uint256", name: "campaignId" },
      { type: "uint256", name: "firstNonce" },
      { type: "tuple[]", name: "claims", components: [
        { type: "address", name: "publisher" },
        { type: "uint256", name: "eventCount" },
        { type: "uint256", name: "rateWei" },
        { type: "uint8",   name: "actionType" },
        { type: "tuple[]", name: "proof", components: [
          { type: "bytes32",    name: "clickSessionHash" },
          { type: "bytes32",    name: "stakeRootUsed" },
          { type: "bytes32",    name: "nullifier" },
          { type: "bytes32",    name: "powNonce" },
          { type: "bytes32[8]", name: "zkProof" },
          { type: "bytes32[3]", name: "actionSig" },
        ]},
      ]},
      { type: "uint256", name: "deadlineBlock" },
      { type: "address", name: "expectedRelaySigner" },
      { type: "address", name: "expectedAdvertiserRelaySigner" },
      { type: "bytes",   name: "userSig" },
      { type: "bytes",   name: "publisherSig" },
      { type: "bytes",   name: "advertiserSig" },
    ]}],
    name: "settleClaimsFor",
    outputs: [{ type: "tuple", name: "result", components: [
      { type: "uint256", name: "settledCount" },
      { type: "uint256", name: "rejectedCount" },
      { type: "uint256", name: "totalPaid" },
    ]}],
    stateMutability: "nonpayable",
    type: "function",
  },
];

const SETTLEMENT_ABI = [
  // SLIM (#2): ClaimSettled gained publisher/eventCount/rateWei/actionType.
  { type: "event", name: "ClaimSettled", inputs: [
    { type: "uint256", name: "campaignId", indexed: true },
    { type: "address", name: "user", indexed: true },
    { type: "address", name: "publisher", indexed: true },
    { type: "uint256", name: "eventCount" },
    { type: "uint256", name: "rateWei" },
    { type: "uint8",   name: "actionType" },
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
  // SLIM (#2): a stale batch (expired deadline / firstNonce != lastNonce+1) is
  // skipped, not reverted. reason: 0=deadline, 1=anchor. (Relay also reverts
  // E87 if two batches in one call target the same user/campaign/actionType.)
  { type: "event", name: "BatchSkippedStale", inputs: [
    { type: "address", name: "user", indexed: true },
    { type: "uint256", name: "campaignId", indexed: true },
    { type: "uint256", name: "firstNonce" },
    { type: "uint256", name: "claimCount" },
    { type: "uint8",   name: "reason" },
  ]},
  // SLIM (#2): read the chain head to compute firstNonce (== lastNonce+1) for an envelope.
  {
    inputs: [
      { type: "address", name: "user" },
      { type: "uint256", name: "campaignId" },
      { type: "uint8",   name: "actionType" },
    ],
    name: "lastNonce",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
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

// SLIM (#2): this endpoint serves the EXTENSION, which submits via
// DatumAttestationVerifier — so the publisher signs that contract's typehash:
//   PublisherAttestation(uint256 campaignId,address user,uint256 firstNonce,
//                        bytes32 claimsHash,uint256 deadlineBlock)
// over the DatumAttestationVerifier domain. (The relay's own settleClaimsFor
// path signs the same 5-field anchored type on the DatumRelay domain — see
// signRelayAttestation below.)
const PUBLISHER_ATTESTATION_TYPES = {
  PublisherAttestation: [
    { name: "campaignId",   type: "uint256" },
    { name: "user",         type: "address" },
    { name: "firstNonce",   type: "uint256" },
    { name: "claimsHash",   type: "bytes32" },
    { name: "deadlineBlock", type: "uint256" },
  ],
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// SLIM (#2): matches DatumRelay.BATCH_TYPEHASH — the user signs the nonce RANGE.
// firstNonce must equal the on-chain lastNonce+1; lastNonce = firstNonce+count-1.
const CLAIM_BATCH_TYPES = {
  ClaimBatch: [
    { name: "user",         type: "address" },
    { name: "campaignId",   type: "uint256" },
    { name: "firstNonce",   type: "uint256" },
    { name: "lastNonce",    type: "uint256" },
    { name: "claimCount",   type: "uint256" },
    { name: "deadlineBlock", type: "uint256" },
  ],
};

// SLIM (#2): the on-chain slim Claim tuple, for the content claimsHash that the
// publisher cosig binds: keccak256( concat_i keccak256(abi.encode(slimClaim_i)) ).
const CLAIM_PROOF_TUPLE =
  "tuple(bytes32 clickSessionHash,bytes32 stakeRootUsed,bytes32 nullifier,bytes32 powNonce,bytes32[8] zkProof,bytes32[3] actionSig)";
const SLIM_CLAIM_TUPLE =
  `tuple(address publisher,uint256 eventCount,uint256 rateWei,uint8 actionType,${CLAIM_PROOF_TUPLE}[] proof)`;

function contentHashClaims(slimClaims) {
  const coder = AbiCoder.defaultAbiCoder();
  const hashes = slimClaims.map((c) => keccak256(coder.encode([SLIM_CLAIM_TUPLE], [c])));
  return keccak256("0x" + hashes.map((h) => h.slice(2)).join(""));
}

// SLIM (#2): build the on-chain slim claim from an envelope claim. The envelope
// carries publisher/eventCount/rateWei/actionType + an optional proof sidecar.
function toSlimClaim(c) {
  const proof = Array.isArray(c.proof) ? c.proof : [];
  return {
    publisher: c.publisher,
    eventCount: BigInt(c.eventCount),
    rateWei: BigInt(c.rateWei),
    actionType: Number(c.actionType ?? 0),
    proof: proof.map((p) => ({
      clickSessionHash: p.clickSessionHash,
      stakeRootUsed: p.stakeRootUsed,
      nullifier: p.nullifier,
      powNonce: p.powNonce,
      zkProof: p.zkProof,
      actionSig: p.actionSig,
    })),
  };
}

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

// SLIM (#2): the publisher attestation (for the extension's AttestationVerifier
// path) is signed over the DatumAttestationVerifier domain, NOT DatumRelay.
let attestationDomain = null;
async function getAttestationDomain() {
  if (attestationDomain) return attestationDomain;
  const network = await provider.getNetwork();
  attestationDomain = {
    name: "DatumAttestationVerifier",
    version: "1",
    chainId: network.chainId,
    verifyingContract: ADDRESSES.attestationVerifier,
  };
  return attestationDomain;
}

// ── Queue Persistence ────────────────────────────────────────────────────────

// SLIM (#2): the queue stores received envelopes (JSON-safe: addresses, decimal
// strings, hex). No per-field BigInt round-trip is needed — submission and
// signature verification BigInt() the fields they consume (campaignId,
// firstNonce, deadlineBlock, eventCount, rateWei).
function saveQueue() {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(pendingQueue, null, 2));
  } catch (err) {
    logError("QUEUE", `Failed to save queue: ${err.message}`);
  }
}

function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    for (const entry of data) pendingQueue.push(entry);
    if (pendingQueue.length > 0) {
      log("QUEUE", `Loaded ${pendingQueue.length} pending entries from disk`);
    }
  } catch (err) {
    logError("QUEUE", `Failed to load queue: ${err.message}`);
  }
}

// ── Publisher Attestation ────────────────────────────────────────────────────

// SLIM (#2): the extension sends an already-computed content claimsHash; the
// publisher signs over (campaignId, user, firstNonce, claimsHash, deadlineBlock)
// on the DatumAttestationVerifier domain. (A production publisher SHOULD also
// re-derive claimsHash from claims it actually served before signing.)
async function signAttestation(campaignId, user, firstNonce, claimsHash, deadlineBlock) {
  const domain = await getAttestationDomain();
  const value = {
    campaignId: BigInt(campaignId),
    user,
    firstNonce: BigInt(firstNonce),
    claimsHash,
    deadlineBlock: BigInt(deadlineBlock),
  };
  return publisher.signTypedData(domain, PUBLISHER_ATTESTATION_TYPES, value);
}

// SLIM (#2): the RELAY path (settleClaimsFor) publisher cosig — same 5-field
// anchored typehash as the AttestationVerifier path, but on the DatumRelay
// domain. Used to auto-attest batches arriving at /claim for on-chain relay
// submission. SLIM-AUDIT-1 (2026-06-10): firstNonce added on-chain so a cosig
// can't be replayed for a second identical-content batch at the next nonce.
const RELAY_PUBLISHER_ATTESTATION_TYPES = {
  PublisherAttestation: [
    { name: "campaignId",   type: "uint256" },
    { name: "user",         type: "address" },
    { name: "firstNonce",   type: "uint256" },
    { name: "claimsHash",   type: "bytes32" },
    { name: "deadlineBlock", type: "uint256" },
  ],
};

async function signRelayAttestation(campaignId, user, firstNonce, claimsHash, deadlineBlock) {
  const domain = await getEIP712Domain(); // DatumRelay
  const value = {
    campaignId: BigInt(campaignId),
    user,
    firstNonce: BigInt(firstNonce),
    claimsHash,
    deadlineBlock: BigInt(deadlineBlock),
  };
  return publisher.signTypedData(domain, RELAY_PUBLISHER_ATTESTATION_TYPES, value);
}

// ── Signature Verification ──────────────────────────────────────────────────

async function verifyUserSignature(batch) {
  const domain = await getEIP712Domain();
  const claims = batch.claims;
  if (!claims || claims.length === 0) return false;

  // SLIM (#2): the user signs the nonce RANGE. firstNonce is an explicit envelope
  // field (must == on-chain lastNonce+1); lastNonce = firstNonce + count - 1.
  const firstNonce = BigInt(batch.firstNonce);
  const value = {
    user: batch.user,
    campaignId: BigInt(batch.campaignId),
    firstNonce,
    lastNonce: firstNonce + BigInt(claims.length) - 1n,
    claimCount: BigInt(claims.length),
    deadlineBlock: BigInt(batch.deadlineBlock),
  };

  try {
    const recovered = verifyTypedData(domain, CLAIM_BATCH_TYPES, value, batch.userSig);
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
    const allExpired = entry.batches.every((b) => BigInt(b.deadlineBlock) <= BigInt(currentBlock));
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
      if (BigInt(b.deadlineBlock) > BigInt(currentBlock)) {
        allBatches.push(b);
      }
    }
  }

  if (allBatches.length === 0) return;

  log("SUBMIT", `Submitting ${allBatches.length} batch(es) via relay...`);

  try {
    // SLIM (#2): build the on-chain SignedClaimBatch — firstNonce + slim claims
    // (proof sidecar empty for plain views) + the relay/advertiser delegation
    // fields. firstNonce must equal the on-chain lastNonce+1, else the batch is
    // skipped (BatchSkippedStale, not a revert). Don't put two batches for the
    // same (user, campaignId, actionType) in one call (relay reverts E87).
    const contractBatches = allBatches.map((b) => ({
      user: b.user,
      campaignId: BigInt(b.campaignId),
      firstNonce: BigInt(b.firstNonce),
      claims: b.claims.map(toSlimClaim),
      deadlineBlock: BigInt(b.deadlineBlock),
      expectedRelaySigner: b.expectedRelaySigner || ZERO_ADDRESS,
      expectedAdvertiserRelaySigner: b.expectedAdvertiserRelaySigner || ZERO_ADDRESS,
      userSig: b.userSig,
      publisherSig: b.publisherSig || "0x",
      advertiserSig: b.advertiserSig || "0x",
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
    // SLIM (#2): the extension's publisherAttestation.ts sends
    //   { campaignId, user, firstNonce, claimsHash, deadlineBlock }
    const { campaignId, user, firstNonce, claimsHash, deadlineBlock } = req.body;

    if (!isValidUint(campaignId)) return res.status(400).json({ error: "Invalid campaignId" });
    if (!isValidAddress(user)) return res.status(400).json({ error: "Invalid user address" });
    if (!isValidUint(firstNonce)) return res.status(400).json({ error: "Invalid firstNonce" });
    if (typeof claimsHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(claimsHash)) {
      return res.status(400).json({ error: "Invalid claimsHash" });
    }
    if (!isValidUint(deadlineBlock)) return res.status(400).json({ error: "Invalid deadlineBlock" });

    // Verify campaign is active and assigned to this publisher (or open)
    try {
      const [status, cPublisher] = await campaigns.getCampaignForSettlement(BigInt(campaignId));
      if (Number(status) !== 1) {
        return res.status(403).json({ error: "Campaign is not Active" });
      }
      if (cPublisher.toLowerCase() !== publisher.address.toLowerCase() && cPublisher !== ZERO_ADDRESS) {
        return res.status(403).json({ error: "Campaign publisher mismatch" });
      }
    } catch (err) {
      logError("ATTEST", `Campaign lookup failed: ${(err.message || "").slice(0, 100)}`);
      // Proceed — on-chain contract will reject invalid claims
    }

    const signature = await signAttestation(campaignId, user, firstNonce, claimsHash, deadlineBlock);
    stats.attestationsIssued++;
    log("ATTEST", `Signed: campaign=${campaignId} user=${user.slice(0, 10)}... firstNonce=${firstNonce}`);

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
      if (!isValidUint(b.firstNonce)) return res.status(400).json({ error: "Invalid firstNonce" });
      if (!isValidUint(b.deadlineBlock)) return res.status(400).json({ error: "Invalid deadlineBlock" });
      if (!b.userSig || typeof b.userSig !== "string" || b.userSig.length < 130) {
        return res.status(400).json({ error: "Missing or invalid userSig" });
      }

      // SLIM (#2): validate slim claims {publisher, eventCount, rateWei, actionType}.
      for (const c of b.claims) {
        if (!isValidAddress(c.publisher)) return res.status(400).json({ error: "Invalid publisher in claim" });
        if (!isValidUint(c.eventCount)) return res.status(400).json({ error: "Invalid eventCount" });
        if (!isValidUint(c.rateWei)) return res.status(400).json({ error: "Invalid rateWei" });
        if (c.proof !== undefined && !Array.isArray(c.proof)) return res.status(400).json({ error: "Invalid proof sidecar" });
      }

      // Verify user's EIP-712 signature (over the firstNonce range)
      const sigValid = await verifyUserSignature(b);
      if (!sigValid) {
        log("RELAY", `Rejected: invalid userSig from ${b.user?.slice(0, 10)}... ip=${ip}`);
        return res.status(403).json({ error: "Invalid user signature" });
      }

      // Auto-sign the RELAY-path publisher attestation if not already present.
      // SLIM (#2): binds the content claimsHash of the slim claims + deadlineBlock.
      let publisherSig = b.publisherSig || "0x";
      if (publisherSig === "0x" || publisherSig.length < 10) {
        try {
          const claimsHash = contentHashClaims(b.claims.map(toSlimClaim));
          publisherSig = await signRelayAttestation(b.campaignId, b.user, b.firstNonce, claimsHash, b.deadlineBlock);
          stats.attestationsIssued++;
        } catch (err) {
          logError("RELAY", `Auto-attestation failed: ${(err.message || "").slice(0, 100)}`);
        }
      }

      // Queue the slim envelope as-is (JSON-safe); the submitter BigInt()s fields.
      enrichedBatches.push({
        user: b.user,
        campaignId: String(b.campaignId),
        firstNonce: String(b.firstNonce),
        claims: b.claims,
        deadlineBlock: String(b.deadlineBlock),
        expectedRelaySigner: b.expectedRelaySigner || ZERO_ADDRESS,
        expectedAdvertiserRelaySigner: b.expectedAdvertiserRelaySigner || ZERO_ADDRESS,
        userSig: b.userSig,
        publisherSig,
        advertiserSig: b.advertiserSig || "0x",
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
