// setup-testnet.ts — Automated post-deploy testnet setup for Alpha-3
//
// Prerequisite: Alice funded via faucet + contracts deployed (npm run deploy:testnet)
//
// This script:
//   1. Funds all non-user accounts from Alice
//   2. Registers Diana + Eve as publishers
//   2.5. Sets publisher tags via TargetingRegistry (TX-1)
//   2.6. Sets relaySigner for Diana (snapshotted at campaign creation)
//   2.7. Sets publisher profile hash for Diana
//   3. Creates 100 competing campaigns (Bob + Charlie as advertisers)
//   4. Frank votes aye + Alice evaluates each campaign to activate
//   5. Sets metadata hashes (Wikipedia article-based bytes32 hashes)
//   5.3. Logs rate limiter settings
//   5.5. Submits test reports (Grace)
//   5.7. Wires Diana as reputation reporter (BM-8/BM-9)
//   5.8. Diana stakes minimum publisher stake (FP-1, graceful skip if not deployed)
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
import * as crypto from "crypto";

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

// Per-account funding amounts. Bob/Charlie each create 50 campaigns (1 PAS each + gas).
// Frank votes on all 100 campaigns (100 PAS stake each to meet quorum, conviction 0 = no lockup).
const FUND_AMOUNTS: Record<string, bigint> = {
  bob:     parseDOT("150"),   // 50 campaigns × 1 PAS budget + gas
  charlie: parseDOT("150"),   // 50 campaigns × 1 PAS budget + gas
  diana:   parseDOT("50"),
  eve:     parseDOT("50"),
  frank:   parseDOT("10500"), // 100 votes × 100 PAS stake (quorum) + 500 gas buffer
  grace:   parseDOT("50"),
};

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

async function waitForBlock(
  provider: JsonRpcProvider,
  targetBlock: number,
  maxWait = 300,
): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const hex = await provider.send("eth_blockNumber", []);
    if (parseInt(hex, 16) >= targetBlock) return;
    if (i % 15 === 0 && i > 0) console.log(`    ...waiting for block ${targetBlock} (${i}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for block ${targetBlock}`);
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
  "function maxPublisherEventsPerWindow() view returns (uint256)",
  "function maxPublisherImpressionsPerWindow() view returns (uint256)",
];

const campaignsAbi = [
  "function createCampaign(address publisher, tuple(uint8 actionType, uint256 budgetPlanck, uint256 dailyCapPlanck, uint256 ratePlanck, address actionVerifier)[] pots, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)",
  "function getCampaignStatus(uint256 campaignId) view returns (uint8)",
  "function setMetadata(uint256 campaignId, bytes32 metadataHash)",
  "event CampaignCreated(uint256 indexed campaignId, address indexed advertiser, address indexed publisher)",
];

const govV2Abi = [
  "function quorumWeighted() view returns (uint256)",
  "function vote(uint256 campaignId, bool aye, uint8 conviction) payable",
  "function evaluateCampaign(uint256 campaignId)",
];

const adminGovAbi = [
  "function activateCampaign(uint256 campaignId)",
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
  "function setSettlement(address addr)",
  "function settlement() view returns (address)",
];

const publisherStakeAbi = [
  "function stake() payable",
  "function requiredStake(address publisher) view returns (uint256)",
  "function staked(address publisher) view returns (uint256)",
  "function isAdequatelyStaked(address publisher) view returns (bool)",
];

// ── Topic taxonomy (canonical tag strings from tagDictionary.ts) ─────────────

const TOPICS = [
  "topic:arts-entertainment",
  "topic:autos-vehicles",
  "topic:beauty-fitness",
  "topic:books-literature",
  "topic:business-industrial",
  "topic:computers-electronics",
  "topic:finance",
  "topic:food-drink",
  "topic:gaming",
  "topic:health",
  "topic:hobbies-leisure",
  "topic:home-garden",
  "topic:internet-telecom",
  "topic:jobs-education",
  "topic:law-government",
  "topic:news",
  "topic:online-communities",
  "topic:people-society",
  "topic:pets-animals",
  "topic:real-estate",
  "topic:reference",
  "topic:science",
  "topic:shopping",
  "topic:sports",
  "topic:travel",
  "topic:crypto-web3",
  "topic:defi",
  "topic:nfts",
  "topic:polkadot",
  "topic:daos-governance",
];

// Wikipedia articles per topic — used to generate deterministic metadata hashes.
// On mainnet these would be real IPFS CIDs; here they're keccak256 of the article name.
const TOPIC_WIKI: Record<string, string[]> = {
  "topic:arts-entertainment":    ["Cinema", "Theatre", "Visual_arts", "Performing_arts"],
  "topic:autos-vehicles":        ["Automobile", "Electric_vehicle", "Formula_One", "Motorcycle"],
  "topic:beauty-fitness":        ["Cosmetics", "Physical_fitness", "Skin_care", "Yoga"],
  "topic:books-literature":      ["Novel", "Literature", "Science_fiction", "Poetry"],
  "topic:business-industrial":   ["Entrepreneurship", "Supply_chain", "Manufacturing", "Venture_capital"],
  "topic:computers-electronics": ["Computer_science", "Semiconductor", "Microprocessor", "Software_engineering"],
  "topic:finance":               ["Stock_market", "Bond_finance", "Hedge_fund", "Index_fund"],
  "topic:food-drink":            ["Cuisine", "Restaurant", "Veganism", "Gastronomy"],
  "topic:gaming":                ["Video_game", "Esports", "Role-playing_game", "Game_design"],
  "topic:health":                ["Medicine", "Nutrition", "Public_health", "Mental_health"],
  "topic:hobbies-leisure":       ["Hobby", "Board_game", "Collecting", "Model_railway"],
  "topic:home-garden":           ["Interior_design", "Gardening", "Home_improvement", "Architecture"],
  "topic:internet-telecom":      ["Internet", "5G", "Cloud_computing", "Fiber_optic"],
  "topic:jobs-education":        ["University", "Online_learning", "Vocational_education", "STEM_education"],
  "topic:law-government":        ["Law", "Democracy", "Contract_law", "International_law"],
  "topic:news":                  ["Journalism", "Newspaper", "Media_bias", "Investigative_journalism"],
  "topic:online-communities":    ["Social_media", "Reddit", "Online_forum", "Discord"],
  "topic:people-society":        ["Culture", "Sociology", "Demography", "Anthropology"],
  "topic:pets-animals":          ["Dog", "Cat", "Animal_cognition", "Veterinary_medicine"],
  "topic:real-estate":           ["Real_estate", "Mortgage", "Urban_planning", "Property_management"],
  "topic:reference":             ["Encyclopedia", "Wikipedia", "Library_science", "Database"],
  "topic:science":               ["Physics", "Chemistry", "Quantum_mechanics", "Astronomy"],
  "topic:shopping":              ["E-commerce", "Retail", "Consumer_behaviour", "Marketplace"],
  "topic:sports":                ["Football", "Basketball", "Tennis", "Olympic_Games"],
  "topic:travel":                ["Tourism", "Backpacking_travel", "Aviation", "Hotel"],
  "topic:crypto-web3":           ["Bitcoin", "Ethereum", "Blockchain", "Cryptocurrency"],
  "topic:defi":                  ["Decentralized_finance", "Uniswap", "Yield_farming", "Aave_protocol"],
  "topic:nfts":                  ["Non-fungible_token", "Digital_art", "OpenSea", "Bored_Ape_Yacht_Club"],
  "topic:polkadot":              ["Polkadot_network", "Substrate_framework", "Parachain", "Relay_chain"],
  "topic:daos-governance":       ["Decentralized_autonomous_organization", "On-chain_governance", "Voting_system", "Token_weighted_voting"],
};

// ── Seeded pseudo-random (LCG) ───────────────────────────────────────────────
// Deterministic — same 100 campaigns every run.

let _lcgState = 0xdeadbeef;

function lcg(): number {
  _lcgState = ((_lcgState * 1664525 + 1013904223) >>> 0);
  return _lcgState;
}

function randFloat(): number {
  return lcg() / 0x100000000;
}

function randInt(max: number): number {
  return Math.floor(randFloat() * max);
}

// ── Campaign configuration ───────────────────────────────────────────────────

const USDT_PRECOMPILE = "0x000007C000000000000000000000000001200000";
const USDT_PER_IMPRESSION = 1000n; // 0.001 USDT (6 decimals) per impression

interface CampaignSpec {
  advertiserKey: "bob" | "charlie";
  budget: bigint;
  dailyCap: bigint;
  bidCpm: bigint;       // planck
  topicIndices: number[];
  hasSidecar: boolean;
  wikiArticle: string;
  metadataBytes32: string; // SHA-256 of pinned IPFS content (filled in step 2.8)
}

// ── Metadata generation + IPFS pinning ──────────────────────────────────────

/**
 * Convert a CIDv0 ("Qm...") to a 0x-prefixed 32-byte hex string by stripping the
 * 0x1220 multihash prefix.  This gives the same bytes32 that bytes32ToCid() expects:
 * the SHA-256 of the dag-pb block (not SHA-256 of the raw JSON content).
 * Using cidToBytes32(actualCid) ensures the extension can reconstruct the correct URL.
 */
const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function cidToBytes32(cid: string): string {
  let num = 0n;
  for (const c of cid) {
    const idx = BASE58_CHARS.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 char in CID: ${c}`);
    num = num * 58n + BigInt(idx);
  }
  let leadingZeros = 0;
  for (const c of cid) {
    if (c === "1") leadingZeros++;
    else break;
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  const full = new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes]);
  if (full.length !== 34 || full[0] !== 0x12 || full[1] !== 0x20) {
    throw new Error(`Not a CIDv0 sha256 multihash: ${cid}`);
  }
  return "0x" + Array.from(full.slice(2)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function buildMetadata(topic: string, wikiArticle: string, idx: number): string {
  const topicLabel = topic.replace("topic:", "").replace(/-/g, " ");
  const articleTitle = wikiArticle.replace(/_/g, " ");
  const category = topicLabel.slice(0, 64);
  const title = `${articleTitle} – Datum Ad #${idx + 1}`.slice(0, 128);
  const description = (
    `Explore ${articleTitle} content on the decentralised Datum ad network. ` +
    `Campaign ${idx + 1} targeting ${topicLabel} audiences with privacy-first delivery.`
  ).slice(0, 256);
  const adText = (
    `Discover the best ${topicLabel} resources. Learn about ${articleTitle} ` +
    `through verified, privacy-preserving advertising powered by Datum Protocol.`
  ).slice(0, 512);
  return JSON.stringify({
    title,
    description,
    category,
    version: 1,
    creative: {
      type: "text",
      text: adText,
      cta: "Learn More",
      ctaUrl: `https://en.wikipedia.org/wiki/${wikiArticle}`,
    },
  });
}

function contentToBytes32(content: string): string {
  const hash = crypto.createHash("sha256").update(content, "utf8").digest();
  return "0x" + hash.toString("hex");
}

async function pinToKubo(content: string, apiBase = "http://localhost:5001"): Promise<string | null> {
  try {
    // Node 18 global fetch with FormData
    const formData = new FormData();
    formData.append("file", new Blob([content], { type: "application/json" }), "metadata.json");
    const resp = await fetch(`${apiBase}/api/v0/add?pin=true&cid-version=0`, {
      method: "POST",
      body: formData,
    });
    if (!resp.ok) return null;
    const json = await resp.json() as { Hash: string; Name: string; Size: string };
    return json.Hash; // CIDv0 "Qm..."
  } catch {
    return null;
  }
}

// Build 100 campaign specs deterministically
const NUM_CAMPAIGNS = 100;
const CAMPAIGN_BUDGET = parseDOT("1"); // 1 PAS per campaign
// CPM range: 0.3–0.7 PAS (expressed as planck range)
const CPM_MIN = parseDOT("0.3");
const CPM_RANGE = parseDOT("0.4"); // added to min

const CAMPAIGN_SPECS: CampaignSpec[] = [];
for (let i = 0; i < NUM_CAMPAIGNS; i++) {
  const advertiserKey = (i % 2 === 0 ? "bob" : "charlie") as "bob" | "charlie";

  // CPM: 0.3 to 0.7 PAS
  const bidCpm = CPM_MIN + BigInt(Math.floor(randFloat() * Number(CPM_RANGE)));

  // Tag distribution: 20% untagged, 60% single-tag, 20% two-tag
  const tagRoll = randFloat();
  let topicIndices: number[];
  if (tagRoll < 0.20) {
    topicIndices = [];
  } else if (tagRoll < 0.80) {
    topicIndices = [randInt(TOPICS.length)];
  } else {
    const t1 = randInt(TOPICS.length);
    const t2 = (t1 + 1 + randInt(TOPICS.length - 1)) % TOPICS.length;
    topicIndices = [t1, t2];
  }

  // Sidecar: ~20% of campaigns carry USDT per-impression reward
  const hasSidecar = randFloat() < 0.20;

  // Wikipedia article for metadata hash
  const primaryIdx = topicIndices.length > 0 ? topicIndices[0] : randInt(TOPICS.length);
  const wikiList = TOPIC_WIKI[TOPICS[primaryIdx]];
  const wikiArticle = wikiList[randInt(wikiList.length)];

  CAMPAIGN_SPECS.push({ advertiserKey, budget: CAMPAIGN_BUDGET, dailyCap: CAMPAIGN_BUDGET, bidCpm, topicIndices, hasSidecar, wikiArticle, metadataBytes32: "" });
}

// ── Main ─────────────────────────────────────────────────────────────────────

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
  const advWallets: Record<"bob" | "charlie", Wallet> = { bob, charlie };

  log("INIT", `Alice (deployer): ${alice.address}`);

  // Load deployed addresses
  const isEvm = process.env.DATUM_EVM === "1";
  const addrFile = __dirname + "/../" + (isEvm ? "deployed-addresses-evm.json" : "deployed-addresses.json");
  if (!fs.existsSync(addrFile)) {
    console.error("No " + (isEvm ? "deployed-addresses-evm.json" : "deployed-addresses.json") + " found. Run deploy script first:");
    console.error("  npx hardhat run scripts/deploy.ts --network polkadotTestnet");
    process.exitCode = 1;
    return;
  }
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
  log("INIT", "Loaded addresses from " + addrFile);

  // Verify alpha-3 core contracts are present (21 keys; FP contracts are checked per-step)
  const alpha3Keys = [
    "pauseRegistry", "timelock", "publishers", "campaigns",
    "budgetLedger", "paymentVault", "campaignLifecycle",
    "attestationVerifier", "governanceV2", "governanceSlash",
    "settlement", "relay", "zkVerifier",
    "targetingRegistry", "campaignValidator", "claimValidator", "governanceHelper",
    "reports", "rateLimiter", "reputation", "tokenRewardVault",
  ];
  const missing = alpha3Keys.filter(k => !addrs[k]);
  if (missing.length > 0) {
    console.error("Missing contract addresses:", missing.join(", "));
    console.error("Re-run deploy.ts for alpha-3 (21-contract deploy).");
    process.exitCode = 1;
    return;
  }
  // FP contracts (22-26) are deployed separately; steps below skip gracefully if absent
  const fpKeys = ["publisherStake", "challengeBonds", "publisherGovernance", "nullifierRegistry", "parameterGovernance"];
  const missingFp = fpKeys.filter(k => !addrs[k]);
  if (missingFp.length > 0) {
    log("INIT", `FP contracts not yet deployed (${missingFp.join(", ")}) — FP steps will be skipped`);
  }

  // Interfaces for ABI encoding
  const pubIface = new Interface(publishersAbi);
  const campIface = new Interface(campaignsAbi);
  const govIface = new Interface(govV2Abi);
  const adminGovIface = new Interface(adminGovAbi);
  const targetIface = new Interface(targetingAbi);
  const reportsIface = new Interface(reportsAbi);
  const reputationIface = new Interface(reputationAbi);
  const rateLimiterIface = new Interface(rateLimiterAbi);

  // ─── Check Alice's balance ───────────────────────────────────────────────
  const aliceBal = await rawProvider.getBalance(alice.address);
  log("INIT", `Alice balance: ${formatDOT(aliceBal)} PAS`);
  const totalNeeded = Object.values(FUND_AMOUNTS).reduce((a, b) => a + b, 0n);
  if (aliceBal < totalNeeded + parseDOT("100")) {
    console.error(`Alice needs at least ${formatDOT(totalNeeded + parseDOT("100"))} PAS to fund all accounts.`);
    console.error("Use the faucet: https://faucet.polkadot.io/ (Paseo)");
    process.exitCode = 1;
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. FUND NON-USER ACCOUNTS
  // ═══════════════════════════════════════════════════════════════════════════
  log("1", `--- Funding non-user accounts (variable amounts for 100-campaign load) ---`);

  for (const name of TO_FUND) {
    const w = wallets[name];
    const target = FUND_AMOUNTS[name];
    const bal = await rawProvider.getBalance(w.address);
    if (bal >= target * 3n / 4n) {
      log("1", `  ${name} already has ${formatDOT(bal)} PAS (target ${formatDOT(target)}) -- skipping`);
      continue;
    }
    try {
      await sendTransfer(alice, rawProvider, w.address, target);
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

  // Diana: broad coverage — crypto, defi, polkadot, technology, finance, english
  const dianaTags = [
    tagHash("topic:crypto-web3"),
    tagHash("topic:defi"),
    tagHash("topic:polkadot"),
    tagHash("topic:computers-electronics"),
    tagHash("topic:finance"),
    tagHash("locale:en"),
  ];
  try {
    await sendCall(diana, rawProvider, addrs.targetingRegistry, targetIface, "setTags", [dianaTags]);
    log("2.5", `  diana: ${dianaTags.length} tags set (crypto-web3, defi, polkadot, computers-electronics, finance, locale:en)`);
  } catch (err) {
    log("2.5", `  diana tags: ${String(err).slice(0, 100)}`);
  }

  // Eve: niche — crypto, nfts, daos-governance, english
  const eveTags = [
    tagHash("topic:crypto-web3"),
    tagHash("topic:nfts"),
    tagHash("topic:daos-governance"),
    tagHash("locale:en"),
  ];
  try {
    await sendCall(eve, rawProvider, addrs.targetingRegistry, targetIface, "setTags", [eveTags]);
    log("2.5", `  eve: ${eveTags.length} tags set (crypto-web3, nfts, daos-governance, locale:en)`);
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
  // 2.8. GENERATE + PIN IPFS METADATA
  //
  // Each campaign gets a JSON metadata object built from its topic + wiki article.
  // Content is pinned to the local Kubo daemon (http://localhost:5001).
  // bytes32 on-chain = cidToBytes32(actualCid) — SHA-256 of the dag-pb block as
  // embedded in the CIDv0 multihash.  This is what bytes32ToCid() expects, so the
  // extension poller can reconstruct the correct IPFS URL from the on-chain hash.
  // Fallback (Kubo unavailable): contentToBytes32(raw JSON) stored instead — the URL
  // reconstructed by bytes32ToCid() will be wrong, but the on-chain hash is still set.
  // ═══════════════════════════════════════════════════════════════════════════
  log("2.8", "--- Generating + pinning IPFS metadata for all campaigns ---");

  let pinOk = 0;
  let pinFail = 0;
  const cidsRecord: Array<{ campaignIndex: number; wikiArticle: string; bytes32: string; cid: string | null }> = [];

  for (let i = 0; i < CAMPAIGN_SPECS.length; i++) {
    const spec = CAMPAIGN_SPECS[i];
    const primaryTopic = spec.topicIndices.length > 0
      ? TOPICS[spec.topicIndices[0]]
      : TOPICS[i % TOPICS.length]; // deterministic for untagged
    const content = buildMetadata(primaryTopic, spec.wikiArticle, i);

    const cid = await pinToKubo(content);
    if (cid) {
      // Use the CID-derived bytes32: cidToBytes32 strips 0x1220 multihash prefix,
      // giving SHA-256 of the dag-pb block.  bytes32ToCid() reconstructs the correct URL.
      spec.metadataBytes32 = cidToBytes32(cid);
      pinOk++;
      cidsRecord.push({ campaignIndex: i, wikiArticle: spec.wikiArticle, bytes32: spec.metadataBytes32, cid });
    } else {
      // Fallback: raw-JSON SHA-256.  bytes32ToCid() will produce a non-existent CID,
      // but the hash is at least deterministic and non-zero so the poller picks it up.
      spec.metadataBytes32 = contentToBytes32(content);
      pinFail++;
      cidsRecord.push({ campaignIndex: i, wikiArticle: spec.wikiArticle, bytes32: spec.metadataBytes32, cid: null });
      if (pinFail === 1) log("2.8", "  Kubo unavailable or pin failed — using contentToBytes32 fallback");
    }
    if ((i + 1) % 25 === 0) log("2.8", `  ${i + 1}/${CAMPAIGN_SPECS.length} processed (${pinOk} pinned, ${pinFail} hash-only)...`);
  }
  log("2.8", `  Done: ${pinOk} pinned to IPFS, ${pinFail} hash-only (Kubo unavailable)`);

  // Write CID reference file alongside this script
  const cidsFile = __dirname + "/metadata-cids.json";
  fs.writeFileSync(cidsFile, JSON.stringify(cidsRecord, null, 2));
  log("2.8", `  CID reference written to ${cidsFile}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CREATE 100 COMPETING CAMPAIGNS
  //
  // Each campaign has:
  //   - CPM: 0.30–0.70 PAS (randomly assigned)
  //   - Tags: 20% untagged, 60% single-topic, 20% two-topic
  //   - ~20% carry a USDT precompile sidecar (1000 µUSDT/impression)
  //   - Metadata: keccak256("wikipedia:" + article) — deterministic demo hash
  //   - Budget: 1 PAS each
  //   - All open (no fixed publisher) — any registered publisher can serve
  // ═══════════════════════════════════════════════════════════════════════════
  log("3", `--- Creating ${NUM_CAMPAIGNS} competing campaigns (CPM: 0.30–0.70 PAS each) ---`);

  // Read nextCampaignId ONCE before the loop to get the base ID.
  // On Paseo, eth_call state lags behind chain tip — reading inside the loop returns stale values.
  // IDs are sequential: base, base+1, ..., base+N-1 (contract increments atomically on each create).
  const campExtraAbi = ["function nextCampaignId() view returns (uint256)"];
  const campExtraIface = new Interface(campExtraAbi);
  const baseIdRaw = await readCall(rawProvider, addrs.campaigns, campExtraIface, "nextCampaignId", []);
  const baseCampaignId = BigInt(baseIdRaw);
  log("3", `  nextCampaignId (base): ${baseCampaignId}`);

  const allCampaignIds: bigint[] = [];
  const allCampaignSpecs: CampaignSpec[] = [];

  let createFailed = 0;
  for (let i = 0; i < CAMPAIGN_SPECS.length; i++) {
    const spec = CAMPAIGN_SPECS[i];
    const adv = advWallets[spec.advertiserKey];
    const tags = spec.topicIndices.map(idx => tagHash(TOPICS[idx]));
    const tagLabels = spec.topicIndices.map(idx => TOPICS[idx]).join(", ") || "untagged";
    const rewardToken = spec.hasSidecar ? USDT_PRECOMPILE : ethers.ZeroAddress;
    const rewardPerImpression = spec.hasSidecar ? USDT_PER_IMPRESSION : 0n;
    const cpmFmt = (Number(spec.bidCpm) / 1e10).toFixed(3);

    // Compute ID from base + offset (avoids Paseo eth_call state-lag)
    const campaignId = baseCampaignId + BigInt(allCampaignIds.length);

    try {
      await sendCall(
        adv, rawProvider, addrs.campaigns, campIface, "createCampaign",
        [ethers.ZeroAddress, [{ actionType: 0, budgetPlanck: spec.budget, dailyCapPlanck: spec.dailyCap, ratePlanck: spec.bidCpm, actionVerifier: ethers.ZeroAddress }], tags, false, rewardToken, rewardPerImpression, 0n],
        spec.budget,
      );

      allCampaignIds.push(campaignId);
      allCampaignSpecs.push(spec);
      const sidecarLabel = spec.hasSidecar ? " +USDT" : "";
      log("3", `  [${(i + 1).toString().padStart(3)}] ID ${campaignId} | ${spec.advertiserKey} | CPM ${cpmFmt} PAS | ${tagLabels}${sidecarLabel}`);
    } catch (err) {
      createFailed++;
      log("3", `  [${(i + 1).toString().padStart(3)}] FAILED (${spec.advertiserKey}, CPM ${cpmFmt}): ${String(err).slice(0, 120)}`);
    }
  }
  log("3", `Created ${allCampaignIds.length}/${CAMPAIGN_SPECS.length} campaigns (${createFailed} failed)`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. VOTE AYE (Frank) + EVALUATE TO ACTIVATE — all campaigns
  // ═══════════════════════════════════════════════════════════════════════════
  log("4", "--- Voting + activating all campaigns ---");

  const quorumResult = await readCall(rawProvider, addrs.governanceV2, govIface, "quorumWeighted", []);
  const quorum = BigInt(quorumResult);
  log("4", `  Governance quorum: ${formatDOT(quorum)} PAS (conviction-weighted)`);

  // Conviction 0 = 1x weight. Single Frank vote covers quorum.
  const VOTE_STAKE = quorum > parseDOT("10") ? quorum : parseDOT("2");
  log("4", `  Vote stake per campaign: ${formatDOT(VOTE_STAKE)} PAS (conviction 0, no lockup)`);

  const frankBal = await rawProvider.getBalance(frank.address);
  const neededForVotes = VOTE_STAKE * BigInt(allCampaignIds.length) + parseDOT("10");
  if (frankBal < neededForVotes) {
    log("4", `  WARNING: Frank has ${formatDOT(frankBal)} PAS, needs ~${formatDOT(neededForVotes)} PAS for ${allCampaignIds.length} votes`);
  }

  // Phase 4a: Frank votes aye on all campaigns
  log("4", `  Phase 4a: Voting on ${allCampaignIds.length} campaigns...`);
  let voteOk = 0;
  const votedIds: bigint[] = [];
  for (let i = 0; i < allCampaignIds.length; i++) {
    const cid = allCampaignIds[i];
    try {
      await sendCall(frank, rawProvider, addrs.governanceV2, govIface, "vote",
        [cid, true, 0],
        VOTE_STAKE,
      );
      votedIds.push(cid);
      voteOk++;
      if ((i + 1) % 10 === 0) log("4", `    voted on ${i + 1}/${allCampaignIds.length}...`);
    } catch (err) {
      log("4", `    vote failed for ID ${cid}: ${String(err).slice(0, 100)}`);
    }
  }
  log("4", `  Voted on ${voteOk}/${allCampaignIds.length} campaigns`);

  // Phase 4b: Wait for BASE_GRACE_BLOCKS (10) past the last vote before evaluating
  // evaluateCampaign reverts with E53 if block.number < lastVote + baseGraceBlocks
  {
    const curHex = await rawProvider.send("eth_blockNumber", []);
    const curBlock = parseInt(curHex, 16);
    const graceBlocks = 10; // matches deploy.ts BASE_GRACE_BLOCKS
    const targetBlock = curBlock + graceBlocks + 1;
    log("4", `  Waiting for grace period (block ${curBlock} → ${targetBlock}, +${graceBlocks + 1} blocks)...`);
    await waitForBlock(rawProvider, targetBlock);
  }

  // Phase 4b: Alice activates all campaigns via AdminGovernance (Phase 0 governor).
  // GovernanceV2 votes above demonstrate conviction-weighted voting; activation goes
  // through the Router's current governor (AdminGovernance) since the Phase 2
  // transition requires a 48h Timelock delay and hasn't happened on testnet yet.
  log("4", `  Phase 4b: Activating ${allCampaignIds.length} campaigns via AdminGovernance...`);
  let activateOk = 0;
  for (let i = 0; i < allCampaignIds.length; i++) {
    const cid = allCampaignIds[i];
    try {
      await sendCall(alice, rawProvider, addrs.adminGovernance, adminGovIface, "activateCampaign", [cid]);
      const statusRaw = await readCall(rawProvider, addrs.campaigns, campIface, "getCampaignStatus", [cid]);
      const s = Number(BigInt(statusRaw));
      if (s === 1) {
        activateOk++;
      } else {
        log("4", `    WARNING: ID ${cid} status ${STATUS_NAMES[s]} after activate`);
      }
      if ((i + 1) % 10 === 0) log("4", `    activated ${i + 1}/${allCampaignIds.length}...`);
    } catch (err) {
      log("4", `    activate failed for ID ${cid}: ${String(err).slice(0, 100)}`);
    }
  }
  log("4", `  Activated ${activateOk}/${allCampaignIds.length} campaigns`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. SET METADATA — real IPFS SHA-256 bytes32 for all campaigns
  //    (generated + pinned in step 2.8; bytes32 = SHA-256 of JSON content)
  // ═══════════════════════════════════════════════════════════════════════════
  log("5", "--- Setting metadata (real IPFS SHA-256 bytes32) ---");

  let metaOk = 0;
  for (let i = 0; i < allCampaignIds.length; i++) {
    const cid = allCampaignIds[i];
    const spec = allCampaignSpecs[i];
    const adv = advWallets[spec.advertiserKey];
    const metaHash = spec.metadataBytes32 || keccak256(toUtf8Bytes("wikipedia:" + spec.wikiArticle));

    try {
      await sendCall(adv, rawProvider, addrs.campaigns, campIface, "setMetadata", [cid, metaHash]);
      metaOk++;
      if ((i + 1) % 20 === 0) log("5", `    metadata set for ${i + 1}/${allCampaignIds.length}...`);
    } catch (err) {
      log("5", `    setMetadata failed for ID ${cid} (${spec.wikiArticle}): ${String(err).slice(0, 100)}`);
    }
  }
  log("5", `  Set metadata on ${metaOk}/${allCampaignIds.length} campaigns`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 5.3. RATE LIMITER STATUS (BM-5)
  // ═══════════════════════════════════════════════════════════════════════════
  log("5.3", "--- Rate limiter settings (BM-5) ---");
  if (addrs.rateLimiter) {
    try {
      const [wbRaw, maxRaw] = await Promise.all([
        readCall(rawProvider, addrs.rateLimiter, rateLimiterIface, "windowBlocks", []),
        readCall(rawProvider, addrs.rateLimiter, rateLimiterIface, "maxPublisherEventsPerWindow", []),
      ]);
      const wb = rateLimiterIface.decodeFunctionResult("windowBlocks", wbRaw)[0];
      const maxImp = rateLimiterIface.decodeFunctionResult("maxPublisherEventsPerWindow", maxRaw)[0];
      log("5.3", `  windowBlocks: ${wb.toString()} (~${(Number(wb) * 6 / 3600).toFixed(1)}h at 6s/block)`);
      log("5.3", `  maxPerWindow: ${maxImp.toString()} events`);
    } catch (err) {
      log("5.3", `  read failed: ${String(err).slice(0, 100)}`);
    }
  } else {
    log("5.3", "  rateLimiter address not set -- skipping");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5.5. TEST REPORTS (Grace reports page + ad on first 2 campaigns)
  // ═══════════════════════════════════════════════════════════════════════════
  log("5.5", "--- Submitting test reports (DatumReports) ---");
  const reportTargets = allCampaignIds.slice(0, 2).map((id, i) => ({ id, label: `campaign ${i + 1}` }));
  for (const { id, label } of reportTargets) {
    try {
      await sendCall(grace, rawProvider, addrs.reports, reportsIface, "reportPage", [id, 2]); // misleading
      log("5.5", `  grace reported page on ${label} ID ${id} (reason=2 misleading)`);
    } catch (err) {
      log("5.5", `  reportPage (${label}) failed: ${String(err).slice(0, 100)}`);
    }
    try {
      await sendCall(grace, rawProvider, addrs.reports, reportsIface, "reportAd", [id, 3]); // inappropriate
      log("5.5", `  grace reported ad on ${label} ID ${id} (reason=3 inappropriate)`);
    } catch (err) {
      log("5.5", `  reportAd (${label}) failed: ${String(err).slice(0, 100)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5.7. WIRE REPUTATION → SETTLEMENT (FP-16: Settlement is sole trusted caller)
  // ═══════════════════════════════════════════════════════════════════════════
  log("5.7", "--- Wiring reputation.settlement (FP-16) ---");
  if (addrs.reputation && addrs.settlement) {
    try {
      const currentRaw = await rawProvider.call({
        to: addrs.reputation,
        data: reputationIface.encodeFunctionData("settlement", []),
      });
      const current = reputationIface.decodeFunctionResult("settlement", currentRaw)[0];
      if (current.toLowerCase() === addrs.settlement.toLowerCase()) {
        log("5.7", `  already wired to settlement (${addrs.settlement}) -- skipping`);
      } else {
        await sendCall(alice, rawProvider, addrs.reputation, reputationIface, "setSettlement", [addrs.settlement]);
        log("5.7", `  reputation.settlement set to ${addrs.settlement}`);
      }
    } catch (err) {
      log("5.7", `  setSettlement failed: ${String(err).slice(0, 100)}`);
    }
  } else {
    log("5.7", "  reputation or settlement address not set -- skipping (deploy pending)");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5.8. PUBLISHER STAKE — Diana stakes minimum required stake (FP-1)
  // ═══════════════════════════════════════════════════════════════════════════
  log("5.8", "--- Publisher stake (FP-1) ---");
  if (addrs.publisherStake) {
    const stakeIface = new Interface(publisherStakeAbi);
    try {
      const [requiredRaw, stakedRaw] = await Promise.all([
        readCall(rawProvider, addrs.publisherStake, stakeIface, "requiredStake", [diana.address]),
        readCall(rawProvider, addrs.publisherStake, stakeIface, "staked", [diana.address]),
      ]);
      const required = BigInt(stakeIface.decodeFunctionResult("requiredStake", requiredRaw)[0]);
      const alreadyStaked = BigInt(stakeIface.decodeFunctionResult("staked", stakedRaw)[0]);

      if (alreadyStaked >= required) {
        log("5.8", `  diana already adequately staked: ${formatDOT(alreadyStaked)} PAS (required: ${formatDOT(required)} PAS) -- skipping`);
      } else {
        const toStake = required - alreadyStaked + parseDOT("1"); // required + 1 PAS buffer
        log("5.8", `  diana staking ${formatDOT(toStake)} PAS (required: ${formatDOT(required)} PAS, already staked: ${formatDOT(alreadyStaked)} PAS)`);
        await sendCall(diana, rawProvider, addrs.publisherStake, stakeIface, "stake", [], toStake);
        const newStakedRaw = await readCall(rawProvider, addrs.publisherStake, stakeIface, "staked", [diana.address]);
        const newStaked = BigInt(stakeIface.decodeFunctionResult("staked", newStakedRaw)[0]);
        log("5.8", `  diana new staked total: ${formatDOT(newStaked)} PAS`);
      }
    } catch (err) {
      log("5.8", `  stake check/stake failed: ${String(err).slice(0, 150)}`);
    }
  } else {
    log("5.8", "  publisherStake address not set -- skipping (FP contracts not yet deployed)");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Alpha-3 Testnet Setup Complete ===");
  console.log(`\n${allCampaignIds.length} competing campaigns seeded (CPM range: 0.30–0.70 PAS):`);

  // Build summary stats
  const sidecarCount = allCampaignSpecs.filter(s => s.hasSidecar).length;
  const untaggedCount = allCampaignSpecs.filter(s => s.topicIndices.length === 0).length;
  const oneTagCount = allCampaignSpecs.filter(s => s.topicIndices.length === 1).length;
  const twoTagCount = allCampaignSpecs.filter(s => s.topicIndices.length === 2).length;
  const bobCount = allCampaignSpecs.filter(s => s.advertiserKey === "bob").length;
  const charlieCount = allCampaignSpecs.filter(s => s.advertiserKey === "charlie").length;

  console.log(`  Advertisers : Bob (${bobCount}), Charlie (${charlieCount})`);
  console.log(`  Tags        : ${untaggedCount} untagged, ${oneTagCount} single-topic, ${twoTagCount} two-topic`);
  console.log(`  USDT sidecar: ${sidecarCount} campaigns carry 0.001 USDT/impression`);
  const pinnedCount = cidsRecord.filter(r => r.cid !== null).length;
  console.log(`  Metadata    : Real IPFS SHA-256 bytes32 (${pinnedCount}/${CAMPAIGN_SPECS.length} pinned to Kubo; see scripts/metadata-cids.json)`);;
  console.log(`  Budget      : 1 PAS per campaign (${allCampaignIds.length} PAS total committed)`);

  // Show top 10 by CPM
  const sortedBySpec = allCampaignIds
    .map((id, i) => ({ id, spec: allCampaignSpecs[i] }))
    .sort((a, b) => (a.spec.bidCpm > b.spec.bidCpm ? -1 : 1));

  console.log("\nTop 10 campaigns by CPM:");
  for (const { id, spec } of sortedBySpec.slice(0, 10)) {
    const cpmFmt = (Number(spec.bidCpm) / 1e10).toFixed(3);
    const tagLabels = spec.topicIndices.map(i => TOPICS[i]).join(", ") || "untagged";
    const sidecar = spec.hasSidecar ? " [+USDT]" : "";
    console.log(`  ID ${String(id).padStart(4)} | CPM ${cpmFmt} PAS | ${tagLabels}${sidecar}`);
  }

  console.log("\nAuction mechanics:");
  console.log("  Second-price (Vickrey) — winner pays effective second bid");
  console.log("  effectiveBid = CPM × interestWeight (from user profile × tag match)");
  console.log("  Floor: 30% of winner's CPM. Solo: 70% of bid.");
  console.log("  USDT sidecars do not affect DOT auction ordering — pure incentive bonus");

  console.log("\nFunded accounts:");
  for (const name of TO_FUND) {
    const bal = await rawProvider.getBalance(wallets[name].address);
    console.log(`  ${name.padEnd(8)} ${wallets[name].address}  ${formatDOT(bal)} PAS`);
  }

  console.log("\nAlpha-3 contract addresses (21 core + FP if deployed):");
  const alpha3ContractKeys = [
    "pauseRegistry", "timelock", "publishers", "campaigns",
    "budgetLedger", "paymentVault", "campaignLifecycle",
    "attestationVerifier", "governanceV2", "governanceSlash",
    "settlement", "relay", "zkVerifier",
    "targetingRegistry", "campaignValidator", "claimValidator", "governanceHelper",
    "reports", "rateLimiter", "reputation", "tokenRewardVault",
    "publisherStake", "challengeBonds", "publisherGovernance", "nullifierRegistry", "parameterGovernance",
  ];
  for (const key of alpha3ContractKeys) {
    if (addrs[key]) console.log(`  ${key.padEnd(24)} ${addrs[key]}`);
    else console.log(`  ${key.padEnd(24)} (not deployed)`);
  }

  console.log("\nPublisher setup:");
  console.log("  diana relaySigner  :", diana.address, "(set to self — relay bot uses Diana key)");
  console.log("  diana isReporter   : true (BM-8/BM-9 recordSettlement authorized)");
  console.log("  diana tags         : topic:crypto-web3, topic:defi, topic:polkadot, topic:computers-electronics, topic:finance, locale:en");
  console.log("  eve tags           : topic:crypto-web3, topic:nfts, topic:daos-governance, locale:en");

  console.log("\nUser accounts (fund via faucet for testing):");
  console.log("  hank     0x615BcbE62B43bB033e65533bB6FcCC8b6FcB5BbD");
  console.log("  iris     0xC59101dab8d0899F74d19a4f13bb2D9A030065af");
  console.log("  jack     0x705f35BC60EE574FA5d1D38Ef2CD4784dE9371d3");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
