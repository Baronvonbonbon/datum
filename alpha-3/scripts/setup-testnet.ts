// setup-testnet.ts — Automated post-deploy testnet setup for Alpha-3
//
// Prerequisite: Alice funded via faucet + contracts deployed (npm run deploy:testnet)
//
// This script:
//   1. Funds all non-user accounts from Alice (Bob, Charlie, Diana, Eve, Frank, Grace)
//   2. Registers Diana + Eve as publishers
//   2.5. Sets publisher tags via TargetingRegistry (TX-1)
//   2.6. Sets relaySigner for Diana (snapshotted at campaign creation)
//   2.7. Sets publisher profile hash for Diana
//   3. Creates test campaign 1 (Bob as advertiser, Diana as fixed publisher)
//   3.5. Creates test campaign 2 (Charlie as advertiser, open — no fixed publisher)
//   4. Votes aye (Frank) + activates both campaigns
//   5. Sets metadata hashes
//   5.3. Logs rate limiter settings
//   5.5. Submits test reports (Grace)
//   5.7. Wires Diana as reputation reporter (BM-8/BM-9)
//   6. Summary
//
// Uses raw JsonRpcProvider to bypass Paseo eth-rpc receipt bug (getTransactionReceipt
// returns null for confirmed txs). All tx confirmation via nonce polling.
//
// Usage:
//   export DEPLOYER_PRIVATE_KEY="0x..."
//   npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet

import { ethers, network } from "hardhat";
import { JsonRpcProvider, Wallet, Interface, keccak256, toUtf8Bytes } from "ethers";
import { parseDOT, formatDOT } from "../test/helpers/dot";
import * as fs from "fs";

// ── Test accounts ────────────────────────────────────────────────────────────
// Keys stored in gitignored DEPLOY-TESTNET.md.
// Testnet only — NEVER use these on mainnet.
const ACCOUNTS = {
  alice:   { key: "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8", role: "Deployer" },
  bob:     { key: "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52", role: "Advertiser 1" },
  charlie: { key: "0x1560b7b8d38c812b182b08e8ef739bb88c806d7ba36bd7b01c9177b3536654c1", role: "Advertiser 2" },
  diana:   { key: "0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0", role: "Publisher 1" },
  eve:     { key: "0x22adcf911646ca05279aa42b03dcabae2610417af459be43c2ba37f869c15914", role: "Publisher 2" },
  frank:   { key: "0xd8947fdc847ae7e902cf126b449cb8d9e7a9becdd0816397eaeb3b046d77986c", role: "Voter (Aye)" },
  grace:   { key: "0xdfafb7d12292bad165e40ba13bd2254f91123b656f991e3f308e5ccbcfc6a235", role: "Voter (Nay)" },
};

const TO_FUND = ["bob", "charlie", "diana", "eve", "frank", "grace"] as const;
const FUND_AMOUNT = parseDOT("50"); // 50 PAS each

const STATUS_NAMES = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];

const TX_OPTS = {
  gasLimit: 500000000n,
  type: 0,
  gasPrice: 1000000000000n,
};

function log(section: string, msg: string) {
  console.log(`[${section}] ${msg}`);
}

// TX-1: Tag hashes for publisher targeting
function tagHash(tag: string): string {
  return keccak256(toUtf8Bytes(tag));
}

// ── Paseo workaround: nonce-based tx confirmation ────────────────────────────

async function waitForNonce(
  provider: JsonRpcProvider,
  address: string,
  targetNonce: number,
  maxWait = 120,
): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const current = await provider.getTransactionCount(address);
    if (current > targetNonce) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting for tx confirmation (${i}s)`);
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
  value?: bigint,
): Promise<void> {
  const data = iface.encodeFunctionData(method, args);
  const nonce = await provider.getTransactionCount(signer.address);
  await signer.sendTransaction({
    to,
    data,
    value: value ?? 0n,
    ...TX_OPTS,
  });
  await waitForNonce(provider, signer.address, nonce);
}

async function sendTransfer(
  signer: Wallet,
  provider: JsonRpcProvider,
  to: string,
  value: bigint,
): Promise<void> {
  const nonce = await provider.getTransactionCount(signer.address);
  await signer.sendTransaction({
    to,
    value,
    ...TX_OPTS,
  });
  await waitForNonce(provider, signer.address, nonce);
}

async function readCall(
  provider: JsonRpcProvider,
  to: string,
  iface: Interface,
  method: string,
  args: any[],
): Promise<string> {
  const data = iface.encodeFunctionData(method, args);
  return await provider.call({ to, data });
}

// ── ABIs (minimal, only what we need) ────────────────────────────────────────

const publishersAbi = [
  "function getPublisher(address) view returns (bool registered, uint16 takeRateBps)",
  "function registerPublisher(uint16 takeBps)",
  "function setRelaySigner(address signer)",
  "function setProfile(bytes32 hash)",
  "function relaySigner(address) view returns (address)",
  "function profileHash(address) view returns (bytes32)",
];

const rateLimiterAbi = [
  "function windowBlocks() view returns (uint256)",
  "function maxPublisherImpressionsPerWindow() view returns (uint256)",
];

const campaignsAbi = [
  "function createCampaign(address publisher, uint256 dailyCap, uint256 bidCpm, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression) payable returns (uint256)",
  "function getCampaignStatus(uint256 campaignId) view returns (uint8)",
  "function setMetadata(uint256 campaignId, bytes32 metadataHash)",
  "event CampaignCreated(uint256 indexed campaignId, address indexed advertiser, address indexed publisher)",
];

const govV2Abi = [
  "function quorumWeighted() view returns (uint256)",
  "function vote(uint256 campaignId, bool aye, uint8 conviction) payable",
  "function evaluateCampaign(uint256 campaignId)",
];

const targetingAbi = [
  "function setTags(bytes32[] tags)",
];

const reportsAbi = [
  "function reportPage(uint256 campaignId, uint8 reason)",
  "function reportAd(uint256 campaignId, uint8 reason)",
  "function pageReports(uint256) view returns (uint256)",
  "function adReports(uint256) view returns (uint256)",
];

const reputationAbi = [
  "function addReporter(address reporter)",
  "function reporters(address) view returns (bool)",
];

async function main() {
  // Raw provider bypasses hardhat-polkadot receipt bug
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const rawProvider = new JsonRpcProvider(rpcUrl);

  // Build signers from private keys using raw provider
  const alice   = new Wallet(ACCOUNTS.alice.key, rawProvider);
  const bob     = new Wallet(ACCOUNTS.bob.key, rawProvider);
  const charlie = new Wallet(ACCOUNTS.charlie.key, rawProvider);
  const diana   = new Wallet(ACCOUNTS.diana.key, rawProvider);
  const eve     = new Wallet(ACCOUNTS.eve.key, rawProvider);
  const frank   = new Wallet(ACCOUNTS.frank.key, rawProvider);
  const grace   = new Wallet(ACCOUNTS.grace.key, rawProvider);

  const wallets: Record<string, Wallet> = { alice, bob, charlie, diana, eve, frank, grace };

  log("INIT", `Alice (deployer): ${alice.address}`);

  // Load deployed addresses
  const addrFile = __dirname + "/../deployed-addresses.json";
  if (!fs.existsSync(addrFile)) {
    console.error("No deployed-addresses.json found. Run deploy script first:");
    console.error("  npx hardhat run scripts/deploy.ts --network polkadotTestnet");
    process.exitCode = 1;
    return;
  }
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
  log("INIT", "Loaded addresses from " + addrFile);

  // Verify alpha-3 contracts are present (20 keys)
  const alpha3Keys = [
    "pauseRegistry", "timelock", "publishers", "campaigns",
    "budgetLedger", "paymentVault", "campaignLifecycle",
    "attestationVerifier", "governanceV2", "governanceSlash",
    "settlement", "relay", "zkVerifier",
    "targetingRegistry", "campaignValidator", "claimValidator", "governanceHelper",
    "reports", "rateLimiter", "reputation",
  ];
  const missing = alpha3Keys.filter(k => !addrs[k]);
  if (missing.length > 0) {
    console.error("Missing contract addresses:", missing.join(", "));
    console.error("Re-run deploy.ts for alpha-3 (20-contract deploy).");
    process.exitCode = 1;
    return;
  }

  // Interfaces for ABI encoding
  const pubIface = new Interface(publishersAbi);
  const campIface = new Interface(campaignsAbi);
  const govIface = new Interface(govV2Abi);
  const targetIface = new Interface(targetingAbi);
  const reportsIface = new Interface(reportsAbi);
  const reputationIface = new Interface(reputationAbi);
  const rateLimiterIface = new Interface(rateLimiterAbi);

  // ─── Check Alice's balance ───────────────────────────────────────────────
  const aliceBal = await rawProvider.getBalance(alice.address);
  log("INIT", `Alice balance: ${formatDOT(aliceBal)} PAS`);
  const needed = FUND_AMOUNT * BigInt(TO_FUND.length);
  if (aliceBal < needed + parseDOT("50")) {
    console.error(`Alice needs at least ${formatDOT(needed + parseDOT("50"))} PAS to fund accounts + pay gas.`);
    console.error("Use the faucet: https://faucet.polkadot.io/ (Paseo)");
    process.exitCode = 1;
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. FUND NON-USER ACCOUNTS
  // ═══════════════════════════════════════════════════════════════════════════
  log("1", "--- Funding non-user accounts (50 PAS each) ---");

  for (const name of TO_FUND) {
    const w = wallets[name];
    const bal = await rawProvider.getBalance(w.address);
    if (bal >= parseDOT("10")) {
      log("1", `  ${name} already has ${formatDOT(bal)} PAS -- skipping`);
      continue;
    }
    try {
      await sendTransfer(alice, rawProvider, w.address, FUND_AMOUNT);
      const newBal = await rawProvider.getBalance(w.address);
      log("1", `  ${name} funded: ${formatDOT(newBal)} PAS`);
    } catch (err) {
      console.error(`  FAILED to fund ${name}: ${String(err).slice(0, 150)}`);
      process.exitCode = 1;
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. REGISTER PUBLISHERS (Diana + Eve)
  // ═══════════════════════════════════════════════════════════════════════════
  log("2", "--- Registering publishers ---");

  for (const [name, wallet, takeBps] of [
    ["diana", diana, 5000n] as const,
    ["eve",   eve,   4000n] as const,
  ] as [string, typeof diana, bigint][]) {
    // Check if already registered
    const result = await readCall(rawProvider, addrs.publishers, pubIface, "getPublisher", [wallet.address]);
    const decoded = pubIface.decodeFunctionResult("getPublisher", result);
    const registered = decoded[0];

    if (registered) {
      log("2", `  ${name} already registered -- skipping`);
    } else {
      try {
        await sendCall(wallet, rawProvider, addrs.publishers, pubIface, "registerPublisher", [takeBps]);
        log("2", `  ${name} registered (${takeBps} bps take rate)`);
      } catch (err) {
        console.error(`  FAILED to register ${name}: ${String(err).slice(0, 150)}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2.5. SET PUBLISHER TAGS (TX-1 TargetingRegistry)
  // ═══════════════════════════════════════════════════════════════════════════
  log("2.5", "--- Setting publisher tags (TargetingRegistry) ---");

  // Diana: broad coverage — crypto, defi, tech, english
  const dianaTags = [
    tagHash("topic:crypto"),
    tagHash("topic:defi"),
    tagHash("topic:technology"),
    tagHash("locale:en"),
  ];
  try {
    await sendCall(diana, rawProvider, addrs.targetingRegistry, targetIface, "setTags", [dianaTags]);
    log("2.5", `  diana: ${dianaTags.length} tags set (crypto, defi, technology, en)`);
  } catch (err) {
    log("2.5", `  diana tags: ${String(err).slice(0, 100)}`);
  }

  // Eve: niche — crypto only, english
  const eveTags = [
    tagHash("topic:crypto"),
    tagHash("locale:en"),
  ];
  try {
    await sendCall(eve, rawProvider, addrs.targetingRegistry, targetIface, "setTags", [eveTags]);
    log("2.5", `  eve: ${eveTags.length} tags set (crypto, en)`);
  } catch (err) {
    log("2.5", `  eve tags: ${String(err).slice(0, 100)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2.6. SET RELAY SIGNER FOR DIANA
  // IMPORTANT: relaySigner is snapshotted at campaign creation time into the
  // campaign record. Must be set BEFORE creating campaigns, otherwise
  // attestation signatures will be checked against publisher address (fallback).
  // ═══════════════════════════════════════════════════════════════════════════
  log("2.6", "--- Setting relay signer (DatumPublishers) ---");
  try {
    const currentSigner = await readCall(rawProvider, addrs.publishers, pubIface, "relaySigner", [diana.address]);
    const decoded = pubIface.decodeFunctionResult("relaySigner", currentSigner);
    const currentSignerAddr: string = decoded[0];
    if (currentSignerAddr.toLowerCase() === diana.address.toLowerCase()) {
      log("2.6", `  diana relaySigner already set to self -- skipping`);
    } else {
      await sendCall(diana, rawProvider, addrs.publishers, pubIface, "setRelaySigner", [diana.address]);
      log("2.6", `  diana relaySigner set to ${diana.address}`);
    }
  } catch (err) {
    log("2.6", `  setRelaySigner failed: ${String(err).slice(0, 100)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2.7. SET PUBLISHER PROFILE HASH FOR DIANA
  // ═══════════════════════════════════════════════════════════════════════════
  log("2.7", "--- Setting publisher profile hash ---");
  const dianaProfileHash = keccak256(toUtf8Bytes("diana-publisher-profile-alpha3"));
  try {
    await sendCall(diana, rawProvider, addrs.publishers, pubIface, "setProfile", [dianaProfileHash]);
    log("2.7", `  diana profile hash: ${dianaProfileHash.slice(0, 18)}...`);
  } catch (err) {
    log("2.7", `  setProfile failed: ${String(err).slice(0, 100)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CREATE TEST CAMPAIGN (Bob as advertiser, Diana as publisher)
  // ═══════════════════════════════════════════════════════════════════════════
  log("3", "--- Creating test campaign ---");

  const BUDGET    = parseDOT("10");    // 10 PAS
  const DAILY_CAP = parseDOT("10");    // daily cap = budget
  const BID_CPM   = parseDOT("0.016"); // 0.016 PAS per 1000 impressions
  const REQUIRED_TAGS: string[] = [];   // No required tags for basic test campaign

  // We can't parse CampaignCreated from receipt (no receipts on Paseo),
  // so read nextCampaignId before and after to determine the ID
  const campExtraAbi = ["function nextCampaignId() view returns (uint256)"];
  const campExtraIface = new Interface(campExtraAbi);

  let campaignId: bigint;

  try {
    // Read current nextCampaignId (1-indexed, increments after each create)
    const nextBefore = await readCall(rawProvider, addrs.campaigns, campExtraIface, "nextCampaignId", []);
    const nextBeforeVal = BigInt(nextBefore);
    log("3", `  nextCampaignId before: ${nextBeforeVal.toString()}`);

    // Create campaign
    await sendCall(bob, rawProvider, addrs.campaigns, campIface, "createCampaign",
      [diana.address, DAILY_CAP, BID_CPM, REQUIRED_TAGS, false, ethers.ZeroAddress, 0],
      BUDGET
    );

    // The created campaign has ID = nextBeforeVal (it was assigned then incremented)
    campaignId = nextBeforeVal;
    log("3", `Campaign created: ID ${campaignId.toString()}`);
  } catch (err) {
    console.error(`FAILED to create campaign: ${String(err).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }

  log("3", `  Advertiser: Bob (${bob.address})`);
  log("3", `  Publisher: Diana (${diana.address})`);
  log("3", `  Budget: 10 PAS, CPM: 0.016 PAS`);

  // Verify Pending
  const statusResult = await readCall(rawProvider, addrs.campaigns, campIface, "getCampaignStatus", [campaignId]);
  const statusBefore = Number(BigInt(statusResult));
  log("3", `  Status: ${STATUS_NAMES[statusBefore]}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 3.5. CREATE TEST CAMPAIGN 2 (Charlie as advertiser, open — no fixed publisher)
  // Demonstrates open campaigns: any registered publisher can serve impressions.
  // ═══════════════════════════════════════════════════════════════════════════
  log("3.5", "--- Creating open test campaign (Charlie, no fixed publisher) ---");

  let campaignId2: bigint | null = null;
  try {
    const nextBefore2 = await readCall(rawProvider, addrs.campaigns, campExtraIface, "nextCampaignId", []);
    const nextBeforeVal2 = BigInt(nextBefore2);

    await sendCall(charlie, rawProvider, addrs.campaigns, campIface, "createCampaign",
      [ethers.ZeroAddress, parseDOT("5"), parseDOT("0.012"), [], false, ethers.ZeroAddress, 0],
      parseDOT("5")
    );

    campaignId2 = nextBeforeVal2;
    log("3.5", `  Open campaign created: ID ${campaignId2.toString()}`);
    log("3.5", `  Advertiser: Charlie (${charlie.address})`);
    log("3.5", `  Publisher: open (any registered publisher)`);
    log("3.5", `  Budget: 5 PAS, CPM: 0.012 PAS`);
  } catch (err) {
    log("3.5", `  FAILED to create open campaign: ${String(err).slice(0, 200)}`);
    // Non-fatal — continue with campaign 1 only
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. VOTE AYE (Frank) + EVALUATE TO ACTIVATE
  // ═══════════════════════════════════════════════════════════════════════════
  log("4", "--- Voting + activating campaign(s) ---");

  const quorumResult = await readCall(rawProvider, addrs.governanceV2, govIface, "quorumWeighted", []);
  const quorum = BigInt(quorumResult);
  log("4", `  Governance quorum: ${formatDOT(quorum)} PAS (conviction-weighted)`);

  // Conviction 0 = 1x weight. Stake >= quorum to pass with single voter.
  const VOTE_STAKE = quorum > parseDOT("10") ? quorum : parseDOT("2");

  const frankBal = await rawProvider.getBalance(frank.address);
  // Need enough for 2 campaigns + gas (each vote locks VOTE_STAKE)
  const neededForVotes = VOTE_STAKE * 2n + parseDOT("2");
  if (frankBal < neededForVotes) {
    log("4", `  WARNING: Frank has ${formatDOT(frankBal)} PAS, may not have enough for 2 votes (${formatDOT(neededForVotes)} needed)`);
  }

  // Helper: vote + evaluate a single campaign
  async function activateCampaign(cid: bigint, label: string): Promise<void> {
    try {
      await sendCall(frank, rawProvider, addrs.governanceV2, govIface, "vote",
        [cid, true, 0],
        VOTE_STAKE
      );
      log("4", `  Frank voted aye on ${label} (cid=${cid})`);
    } catch (err) {
      log("4", `  vote failed for ${label}: ${String(err).slice(0, 150)}`);
      return;
    }
    try {
      await sendCall(alice, rawProvider, addrs.governanceV2, govIface, "evaluateCampaign", [cid]);
      const statusResult2 = await readCall(rawProvider, addrs.campaigns, campIface, "getCampaignStatus", [cid]);
      const s = Number(BigInt(statusResult2));
      log("4", `  ${label} status: ${STATUS_NAMES[s]}`);
      if (s !== 1) log("4", `  WARNING: ${label} did not activate.`);
    } catch (err) {
      log("4", `  evaluateCampaign failed for ${label}: ${String(err).slice(0, 150)}`);
    }
  }

  await activateCampaign(campaignId, "campaign 1 (Diana)");
  if (campaignId2 !== null) await activateCampaign(campaignId2, "campaign 2 (open)");

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. SET METADATA
  // ═══════════════════════════════════════════════════════════════════════════
  log("5", "--- Setting metadata ---");

  const metaHash = keccak256(toUtf8Bytes("testnet-campaign-" + campaignId.toString()));
  try {
    await sendCall(bob, rawProvider, addrs.campaigns, campIface, "setMetadata", [campaignId, metaHash]);
    log("5", `  Campaign 1 metadata: ${metaHash.slice(0, 18)}...`);
  } catch (err) {
    log("5", `  setMetadata (campaign 1) failed: ${String(err).slice(0, 100)}`);
  }

  if (campaignId2 !== null) {
    const metaHash2 = keccak256(toUtf8Bytes("testnet-campaign-" + campaignId2.toString()));
    try {
      await sendCall(charlie, rawProvider, addrs.campaigns, campIface, "setMetadata", [campaignId2, metaHash2]);
      log("5", `  Campaign 2 metadata: ${metaHash2.slice(0, 18)}...`);
    } catch (err) {
      log("5", `  setMetadata (campaign 2) failed: ${String(err).slice(0, 100)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5.3. RATE LIMITER STATUS (BM-5)
  // ═══════════════════════════════════════════════════════════════════════════
  log("5.3", "--- Rate limiter settings (BM-5) ---");
  if (addrs.rateLimiter) {
    try {
      const [wbRaw, maxRaw] = await Promise.all([
        readCall(rawProvider, addrs.rateLimiter, rateLimiterIface, "windowBlocks", []),
        readCall(rawProvider, addrs.rateLimiter, rateLimiterIface, "maxPublisherImpressionsPerWindow", []),
      ]);
      const wb = rateLimiterIface.decodeFunctionResult("windowBlocks", wbRaw)[0];
      const maxImp = rateLimiterIface.decodeFunctionResult("maxPublisherImpressionsPerWindow", maxRaw)[0];
      log("5.3", `  windowBlocks: ${wb.toString()} (~${(Number(wb) * 6 / 3600).toFixed(1)}h at 6s/block)`);
      log("5.3", `  maxPerWindow: ${maxImp.toString()} impressions`);
    } catch (err) {
      log("5.3", `  read failed: ${String(err).slice(0, 100)}`);
    }
  } else {
    log("5.3", "  rateLimiter address not set -- skipping");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5.5. TEST REPORTS (Grace reports page + ad on both campaigns)
  // ═══════════════════════════════════════════════════════════════════════════
  log("5.5", "--- Submitting test reports (DatumReports) ---");
  const reportCampaigns = [
    { id: campaignId, label: "campaign 1" },
    ...(campaignId2 !== null ? [{ id: campaignId2, label: "campaign 2" }] : []),
  ];
  for (const { id, label } of reportCampaigns) {
    try {
      await sendCall(grace, rawProvider, addrs.reports, reportsIface, "reportPage", [id, 2]); // misleading
      log("5.5", `  grace reported page on ${label} (reason=2 misleading)`);
    } catch (err) {
      log("5.5", `  reportPage (${label}) failed: ${String(err).slice(0, 100)}`);
    }
    try {
      await sendCall(grace, rawProvider, addrs.reports, reportsIface, "reportAd", [id, 3]); // inappropriate
      log("5.5", `  grace reported ad on ${label} (reason=3 inappropriate)`);
    } catch (err) {
      log("5.5", `  reportAd (${label}) failed: ${String(err).slice(0, 100)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5.7. WIRE REPUTATION REPORTER (Diana = relay bot stand-in for testnet)
  // ═══════════════════════════════════════════════════════════════════════════
  log("5.7", "--- Wiring reputation reporter (BM-8/BM-9) ---");
  if (addrs.reputation) {
    try {
      // Check if Diana is already a reporter
      const isReporter = await rawProvider.call({
        to: addrs.reputation,
        data: reputationIface.encodeFunctionData("reporters", [diana.address]),
      });
      const alreadyReporter = reputationIface.decodeFunctionResult("reporters", isReporter)[0];
      if (alreadyReporter) {
        log("5.7", `  diana already approved as reporter -- skipping`);
      } else {
        // Alice (owner) adds Diana as reporter
        await sendCall(alice, rawProvider, addrs.reputation, reputationIface, "addReporter", [diana.address]);
        log("5.7", `  diana (${diana.address}) added as reporter`);
      }
    } catch (err) {
      log("5.7", `  addReporter failed: ${String(err).slice(0, 100)}`);
    }
  } else {
    log("5.7", "  reputation address not set -- skipping (deploy pending)");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Alpha-3 Testnet Setup Complete ===");
  console.log("Campaign 1  : ID", campaignId.toString(), "(Bob → Diana, fixed publisher)");
  if (campaignId2 !== null) {
    console.log("Campaign 2  : ID", campaignId2.toString(), "(Charlie → open, any publisher)");
  }
  console.log("Aye voter   : Frank", frank.address);
  console.log("");
  console.log("Funded accounts:");
  for (const name of TO_FUND) {
    const bal = await rawProvider.getBalance(wallets[name].address);
    console.log(`  ${name.padEnd(8)} ${wallets[name].address}  ${formatDOT(bal)} PAS`);
  }
  console.log("");
  console.log("Alpha-3 contract addresses (20):");
  const alpha3ContractKeys = [
    "pauseRegistry", "timelock", "publishers", "campaigns",
    "budgetLedger", "paymentVault", "campaignLifecycle",
    "attestationVerifier", "governanceV2", "governanceSlash",
    "settlement", "relay", "zkVerifier",
    "targetingRegistry", "campaignValidator", "claimValidator", "governanceHelper",
    "reports", "rateLimiter", "reputation",
  ];
  for (const key of alpha3ContractKeys) {
    console.log(`  ${key.padEnd(24)} ${addrs[key]}`);
  }
  console.log("");
  console.log("Publisher setup:");
  console.log("  diana relaySigner  :", diana.address, "(set to self — relay bot uses Diana key)");
  console.log("  diana isReporter   : true (BM-8/BM-9 recordSettlement authorized)");
  console.log("  diana tags         : topic:crypto, topic:defi, topic:technology, locale:en");
  console.log("  eve tags           : topic:crypto, locale:en");
  console.log("");
  console.log("User accounts (fund via faucet for testing):");
  console.log("  hank     0x615BcbE62B43bB033e65533bB6FcCC8b6FcB5BbD");
  console.log("  iris     0xC59101dab8d0899F74d19a4f13bb2D9A030065af");
  console.log("  jack     0x705f35BC60EE574FA5d1D38Ef2CD4784dE9371d3");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
