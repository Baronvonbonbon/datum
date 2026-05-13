#!/usr/bin/env node
// DATUM Bulletin Chain Renewer Bot (F7, Phase A)
//
// Watches the Hub for `BulletinRenewalDue` events on DatumCampaigns, then
// invokes `transactionStorage.renew(block, index)` on Bulletin Chain
// (Paseo: wss://paseo-bulletin-rpc.polkadot.io) and posts the new (block,
// index) back to Hub via `confirmBulletinRenewal`. The bot pulls its
// per-renewal DOT reward from the campaign's escrow on Hub.
//
// Trust model: this bot is one possible renewer. Advertisers approve specific
// renewer addresses on each campaign (`setApprovedBulletinRenewer`) or
// enable open mode (`setOpenBulletinRenewal`). The Hub-side
// `MAX_RETENTION_ADVANCE_BLOCKS` bound caps damage from any individual
// fraudulent confirmation.
//
// Env vars (gitignored .env in relay-bot/):
//   HUB_RPC               EVM RPC for Polkadot Hub
//   HUB_PRIVATE_KEY       EVM key for confirmBulletinRenewal calls
//   CAMPAIGNS_ADDRESS     DatumCampaigns contract address
//   BULLETIN_RPC          (optional, default wss://paseo-bulletin-rpc.polkadot.io)
//   BULLETIN_MNEMONIC     Bulletin Chain account mnemonic (must have faucet auth)
//   POLL_INTERVAL_SEC     (optional, default 60s) Hub event poll cadence

import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const HUB_RPC          = required("HUB_RPC");
const HUB_PRIVATE_KEY  = required("HUB_PRIVATE_KEY");
const CAMPAIGNS_ADDR   = required("CAMPAIGNS_ADDRESS");
const BULLETIN_RPC     = process.env.BULLETIN_RPC || "wss://paseo-bulletin-rpc.polkadot.io";
const BULLETIN_MNEMONIC = required("BULLETIN_MNEMONIC");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SEC ?? 60) * 1000;

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// ── ABI (minimal — only methods/events we use) ────────────────────────────────

const CAMPAIGNS_ABI = [
  "event BulletinRenewalDue(uint256 indexed campaignId, uint64 expiryHubBlock, uint256 escrowBalance)",
  "function getBulletinCreative(uint256 campaignId) view returns (tuple(bytes32 cidDigest, uint8 cidCodec, uint32 bulletinBlock, uint32 bulletinIndex, uint64 expiryHubBlock, uint64 retentionHorizonBlock, uint32 version))",
  "function confirmBulletinRenewal(uint256 campaignId, uint32 newBulletinBlock, uint32 newBulletinIndex)",
  "function bulletinRenewerReward() view returns (uint256)",
  "function bulletinRenewalEscrow(uint256 campaignId) view returns (uint256)",
];

// ── Hub provider + wallet ─────────────────────────────────────────────────────

const hubProvider = new JsonRpcProvider(HUB_RPC);
const hubWallet   = new Wallet(HUB_PRIVATE_KEY, hubProvider);
const campaigns   = new Contract(CAMPAIGNS_ADDR, CAMPAIGNS_ABI, hubWallet);
console.log(`[bulletin-renewer] Hub signer: ${hubWallet.address}`);

// ── Bulletin Chain client + signer ────────────────────────────────────────────

const entropy = mnemonicToEntropy(BULLETIN_MNEMONIC);
const miniSecret = entropyToMiniSecret(entropy);
const derive = sr25519CreateDerive(miniSecret);
const keypair = derive("");
const bulletinSigner = getPolkadotSigner(keypair.publicKey, "Sr25519", keypair.sign);

const bulletinClient = createClient(getWsProvider(BULLETIN_RPC));
const bulletinApi = bulletinClient.getUnsafeApi();
console.log(`[bulletin-renewer] Bulletin Chain RPC: ${BULLETIN_RPC}`);

// ── Renewal flow ──────────────────────────────────────────────────────────────

const inFlight = new Set(); // campaignIds currently being processed

async function handleRenewalDue(campaignId) {
  const idStr = String(campaignId);
  if (inFlight.has(idStr)) {
    console.log(`[bulletin-renewer] #${idStr}: already in flight, skipping`);
    return;
  }
  inFlight.add(idStr);
  try {
    console.log(`[bulletin-renewer] #${idStr}: renewal due, fetching current ref`);
    const ref = await campaigns.getBulletinCreative(campaignId);
    const oldBlock = Number(ref.bulletinBlock);
    const oldIndex = Number(ref.bulletinIndex);
    if (oldBlock === 0) {
      console.warn(`[bulletin-renewer] #${idStr}: no Bulletin ref on Hub, nothing to renew`);
      return;
    }

    console.log(`[bulletin-renewer] #${idStr}: calling transactionStorage.renew(${oldBlock}, ${oldIndex}) on Bulletin Chain`);
    const renewResult = await bulletinApi.tx.TransactionStorage
      .renew({ block: oldBlock, index: oldIndex })
      .signAndSubmit(bulletinSigner);
    if (!renewResult.ok) {
      throw new Error(`Bulletin renew extrinsic failed for #${idStr}`);
    }
    const renewed = renewResult.events.find(
      (e) => e.type === "TransactionStorage" && e.value?.type === "Renewed",
    );
    if (!renewed) throw new Error("Renewed event not found in receipt");
    const newIndex = renewed.value.value.index ?? renewed.value.value.transactionIndex ?? 0;
    const newBlock = renewResult.block.number;
    console.log(`[bulletin-renewer] #${idStr}: Bulletin renewed → (${newBlock}, ${newIndex})`);

    console.log(`[bulletin-renewer] #${idStr}: confirming on Hub`);
    const tx = await campaigns.confirmBulletinRenewal(campaignId, newBlock, newIndex);
    const receipt = await tx.wait();
    console.log(`[bulletin-renewer] #${idStr}: Hub confirmation in tx ${receipt.hash}`);
  } catch (err) {
    console.error(`[bulletin-renewer] #${idStr} renewal failed:`, err?.message ?? err);
  } finally {
    inFlight.delete(idStr);
  }
}

// ── Event watcher ─────────────────────────────────────────────────────────────

let lastScannedBlock = 0;

async function pollOnce() {
  try {
    const head = await hubProvider.getBlockNumber();
    if (lastScannedBlock === 0) lastScannedBlock = Math.max(0, head - 1000);
    if (head <= lastScannedBlock) return;

    const filter = campaigns.filters.BulletinRenewalDue();
    const logs = await campaigns.queryFilter(filter, lastScannedBlock + 1, head);
    if (logs.length > 0) {
      console.log(`[bulletin-renewer] poll: ${logs.length} BulletinRenewalDue events in blocks ${lastScannedBlock + 1}..${head}`);
    }
    for (const log of logs) {
      const campaignId = log.args?.campaignId ?? log.args?.[0];
      if (campaignId !== undefined) await handleRenewalDue(campaignId);
    }
    lastScannedBlock = head;
  } catch (err) {
    console.error("[bulletin-renewer] poll error:", err?.message ?? err);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[bulletin-renewer] polling every ${POLL_INTERVAL_MS / 1000}s`);
  // Initial scan + interval
  await pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[bulletin-renewer] fatal:", err);
  process.exit(1);
});

// Graceful shutdown — disconnects Bulletin Chain WS cleanly
process.on("SIGINT", () => {
  console.log("[bulletin-renewer] shutting down");
  bulletinClient.destroy();
  process.exit(0);
});
