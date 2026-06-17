// fill-missing-creatives.ts
//
// For every Active campaign on the current network whose IPFS metadata hash is
// still bytes32(0), build a creative + metadata JSON (with a Wikipedia CTA),
// pin to local Kubo IPFS, and call DatumCampaignCreative.setMetadata() as the
// campaign's advertiser. Updates scripts/metadata-cids.json on success.
//
// Run:
//   npx hardhat run scripts/fill-missing-creatives.ts --network polkadotTestnet
//
// Env knobs:
//   DRY_RUN=1       Audit-only: print the list, no pinning, no on-chain writes.
//   MAX_FILL=N      Cap the number of campaigns processed this run.
//   KUBO_API=URL    Kubo HTTP API base (default http://localhost:5001).

import { network } from "hardhat";
import { JsonRpcProvider, Wallet, Interface, keccak256, toUtf8Bytes } from "ethers";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// Keys loaded from gitignored .env (rotated 2026-06-16; no literals in tracked
// sources). dotenv.config() runs in hardhat.config.ts before this module.
function envKey(name: string): string {
  const k = process.env[name];
  if (!k) throw new Error(`set ${name} in alpha-core/.env`);
  return k;
}
const ACCOUNTS = {
  alice:   envKey("DEPLOYER_PRIVATE_KEY"),
  bob:     envKey("BOB_PRIVATE_KEY"),
  charlie: envKey("CHARLIE_PRIVATE_KEY"),
};

const _IS_PASEO = (network.name === "polkadotTestnet");
const TX_OPTS = {
  gasLimit: _IS_PASEO ? 500000000n : 15000000n,
  type: 0,
  gasPrice: _IS_PASEO ? 1000000000000n : 1000000000n,
};

const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_FILL = process.env.MAX_FILL ? parseInt(process.env.MAX_FILL, 10) : Infinity;
const KUBO_API = process.env.KUBO_API || "http://localhost:5001";

// Topics + Wikipedia article pool (same set used by setup-testnet.ts).
const TOPIC_WIKI_FLAT: string[] = [
  "Cinema", "Theatre", "Visual_arts", "Performing_arts",
  "Automobile", "Electric_vehicle", "Formula_One", "Motorcycle",
  "Cosmetics", "Physical_fitness", "Skin_care", "Yoga",
  "Novel", "Literature", "Science_fiction", "Poetry",
  "Entrepreneurship", "Supply_chain", "Manufacturing", "Venture_capital",
  "Computer_science", "Semiconductor", "Microprocessor", "Software_engineering",
  "Stock_market", "Bond_finance", "Hedge_fund", "Index_fund",
  "Cuisine", "Restaurant", "Veganism", "Gastronomy",
  "Video_game", "Esports", "Role-playing_game", "Game_design",
  "Medicine", "Nutrition", "Public_health", "Mental_health",
  "Hobby", "Board_game", "Collecting", "Model_railway",
  "Interior_design", "Gardening", "Home_improvement", "Architecture",
  "Internet", "5G", "Cloud_computing", "Fiber_optic",
  "University", "Online_learning", "Vocational_education", "STEM_education",
  "Law", "Democracy", "Contract_law", "International_law",
  "Journalism", "Newspaper", "Media_bias", "Investigative_journalism",
  "Social_media", "Reddit", "Online_forum", "Discord",
  "Culture", "Sociology", "Demography", "Anthropology",
  "Dog", "Cat", "Animal_cognition", "Veterinary_medicine",
  "Real_estate", "Mortgage", "Urban_planning", "Property_management",
  "Encyclopedia", "Wikipedia", "Library_science", "Database",
  "Physics", "Chemistry", "Quantum_mechanics", "Astronomy",
  "E-commerce", "Retail", "Consumer_behaviour", "Marketplace",
  "Football", "Basketball", "Tennis", "Olympic_Games",
  "Tourism", "Backpacking_travel", "Aviation", "Hotel",
  "Bitcoin", "Ethereum", "Blockchain", "Cryptocurrency",
  "Decentralized_finance", "Uniswap", "Yield_farming", "Aave_protocol",
  "Non-fungible_token", "Digital_art", "OpenSea", "Bored_Ape_Yacht_Club",
  "Polkadot_network", "Substrate_framework", "Parachain", "Relay_chain",
  "Decentralized_autonomous_organization", "On-chain_governance", "Voting_system", "Token_weighted_voting",
];

const STATUS_NAMES = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];

async function waitForNonce(provider: JsonRpcProvider, address: string, targetNonce: number, maxWait = 120): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const current = await provider.getTransactionCount(address);
    if (current > targetNonce) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting for tx confirmation (${i}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

async function sendCall(signer: Wallet, provider: JsonRpcProvider, to: string, iface: Interface, method: string, args: any[]): Promise<void> {
  const data = iface.encodeFunctionData(method, args);
  const nonce = await provider.getTransactionCount(signer.address);
  await signer.sendTransaction({ to, data, ...TX_OPTS });
  await waitForNonce(provider, signer.address, nonce);
}

async function readCall(provider: JsonRpcProvider, to: string, iface: Interface, method: string, args: any[]): Promise<string> {
  const data = iface.encodeFunctionData(method, args);
  return await provider.call({ to, data });
}

// CIDv0 ("Qm...") → 0x-prefixed 32-byte hex (strip 0x1220 multihash prefix).
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

function buildMetadata(wikiArticle: string, campaignId: number): string {
  const articleTitle = wikiArticle.replace(/_/g, " ");
  return JSON.stringify({
    title: `${articleTitle} – Datum Ad #${campaignId}`.slice(0, 128),
    description: (
      `Explore ${articleTitle} content on the decentralised Datum ad network. ` +
      `Campaign ${campaignId} delivered with privacy-first attribution.`
    ).slice(0, 256),
    category: articleTitle.slice(0, 64),
    version: 1,
    creative: {
      type: "text",
      text: (
        `Learn about ${articleTitle} through verified, privacy-preserving ` +
        `advertising powered by the Datum Protocol.`
      ).slice(0, 512),
      cta: "Learn More",
      ctaUrl: `https://en.wikipedia.org/wiki/${wikiArticle}`,
    },
  });
}

async function pinToKubo(content: string): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append("file", new Blob([content], { type: "application/json" }), "metadata.json");
    const resp = await fetch(`${KUBO_API}/api/v0/add?pin=true&cid-version=0`, { method: "POST", body: formData });
    if (!resp.ok) return null;
    const json = await resp.json() as { Hash: string; Name: string; Size: string };
    return json.Hash;
  } catch {
    return null;
  }
}

const campaignsIface = new Interface([
  "function nextCampaignId() view returns (uint256)",
  "function getCampaignStatus(uint256) view returns (uint8)",
  "function getCampaignAdvertiser(uint256) view returns (address)",
]);

const creativeIface = new Interface([
  "function setMetadata(uint256 campaignId, bytes32 metadataHash)",
  "function campaignMetadata(uint256) view returns (bytes32)",
]);

async function main() {
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const rawProvider = new JsonRpcProvider(rpcUrl);

  const addrFile = path.join(__dirname, "..", "deployed-addresses.json");
  if (!fs.existsSync(addrFile)) {
    console.error("No deployed-addresses.json found. Deploy first.");
    process.exitCode = 1;
    return;
  }
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
  console.log(`Network: ${network.name}  (chainId via ${rpcUrl})`);
  console.log(`Campaigns:        ${addrs.campaigns}`);
  console.log(`CampaignCreative: ${addrs.campaignCreative}`);
  console.log();

  // Build advertiser wallets keyed by lowercase address.
  const wallets: Record<string, Wallet> = {};
  for (const [name, key] of Object.entries(ACCOUNTS)) {
    const w = new Wallet(key, rawProvider);
    wallets[w.address.toLowerCase()] = w;
    console.log(`  ${name.padEnd(8)} ${w.address}`);
  }
  console.log();

  // Enumerate campaigns.
  const nextIdHex = await readCall(rawProvider, addrs.campaigns, campaignsIface, "nextCampaignId", []);
  const nextId = Number(BigInt(nextIdHex));
  console.log(`nextCampaignId = ${nextId}  (campaigns 1..${nextId - 1})`);

  type Row = { id: number; advertiser: string; wallet: Wallet | null };
  const missing: Row[] = [];

  let activeCount = 0;
  let hasMetaCount = 0;
  let nonActiveCount = 0;
  for (let id = 1; id < nextId; id++) {
    const statusHex = await readCall(rawProvider, addrs.campaigns, campaignsIface, "getCampaignStatus", [id]);
    const status = Number(BigInt(statusHex));
    if (status !== 1) { // 1 = Active
      nonActiveCount++;
      continue;
    }
    activeCount++;
    const metaHex = await readCall(rawProvider, addrs.campaignCreative, creativeIface, "campaignMetadata", [id]);
    // metaHex is a 32-byte word; zero means unset.
    if (metaHex !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
      hasMetaCount++;
      continue;
    }
    const advHex = await readCall(rawProvider, addrs.campaigns, campaignsIface, "getCampaignAdvertiser", [id]);
    const advertiser = "0x" + advHex.slice(-40);
    const wallet = wallets[advertiser.toLowerCase()] || null;
    missing.push({ id, advertiser, wallet });
  }

  console.log();
  console.log(`Audit: ${activeCount} Active, ${hasMetaCount} already have metadata, ${nonActiveCount} non-Active.`);
  console.log(`Missing metadata: ${missing.length}`);
  if (missing.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const unknownAdvertisers = missing.filter(m => !m.wallet);
  if (unknownAdvertisers.length > 0) {
    console.log(`Warning: ${unknownAdvertisers.length} campaign(s) have an advertiser we don't hold keys for:`);
    for (const m of unknownAdvertisers.slice(0, 5)) {
      console.log(`  id=${m.id} advertiser=${m.advertiser}`);
    }
  }

  const fillable = missing.filter(m => !!m.wallet).slice(0, MAX_FILL);
  console.log(`Will fill: ${fillable.length}${DRY_RUN ? " (DRY_RUN, no writes)" : ""}`);
  console.log();

  // Append-or-overwrite metadata-cids.json
  const cidsFile = path.join(__dirname, "metadata-cids.json");
  type CidEntry = { campaignIndex: number; wikiArticle: string; bytes32: string; cid: string | null };
  let existing: CidEntry[] = [];
  if (fs.existsSync(cidsFile)) {
    try { existing = JSON.parse(fs.readFileSync(cidsFile, "utf-8")); } catch {}
  }
  const byIndex = new Map<number, CidEntry>();
  for (const e of existing) byIndex.set(e.campaignIndex, e);

  let filled = 0;
  let pinErrors = 0;
  let txErrors = 0;

  for (const row of fillable) {
    // Deterministic wiki pick: rotate through the flat pool by campaign id so
    // re-running yields the same article for the same id.
    const wikiArticle = TOPIC_WIKI_FLAT[(row.id - 1) % TOPIC_WIKI_FLAT.length];
    const content = buildMetadata(wikiArticle, row.id);

    console.log(`  id=${row.id} advertiser=${row.advertiser.slice(0, 10)}... wiki=${wikiArticle}`);

    if (DRY_RUN) {
      const sha = "0x" + crypto.createHash("sha256").update(content, "utf8").digest("hex");
      console.log(`    (dry) preview-sha256=${sha}`);
      continue;
    }

    const cid = await pinToKubo(content);
    if (!cid) {
      console.log(`    !! pin failed`);
      pinErrors++;
      continue;
    }
    const digest = cidToBytes32(cid);
    try {
      await sendCall(row.wallet!, rawProvider, addrs.campaignCreative, creativeIface, "setMetadata", [row.id, digest]);
    } catch (err: any) {
      console.log(`    !! setMetadata failed: ${String(err.message || err).slice(0, 140)}`);
      txErrors++;
      continue;
    }
    console.log(`    OK cid=${cid} digest=${digest}`);
    // Map campaignIndex = id - 1 to be consistent with the existing file.
    byIndex.set(row.id - 1, { campaignIndex: row.id - 1, wikiArticle, bytes32: digest, cid });
    filled++;

    // Persist after every write so a crash doesn't lose progress.
    const out = Array.from(byIndex.values()).sort((a, b) => a.campaignIndex - b.campaignIndex);
    fs.writeFileSync(cidsFile, JSON.stringify(out, null, 2));
  }

  console.log();
  console.log(`Done. filled=${filled} pinErrors=${pinErrors} txErrors=${txErrors}`);

  // Verification pass for newly filled rows.
  if (filled > 0) {
    console.log();
    console.log("Verifying on-chain digests for filled rows...");
    let verifyFail = 0;
    for (const row of fillable) {
      const entry = byIndex.get(row.id - 1);
      if (!entry || !entry.cid) continue;
      const onchain = await readCall(rawProvider, addrs.campaignCreative, creativeIface, "campaignMetadata", [row.id]);
      if (onchain.toLowerCase() !== entry.bytes32.toLowerCase()) {
        console.log(`  id=${row.id} MISMATCH on-chain=${onchain} expected=${entry.bytes32}`);
        verifyFail++;
      }
    }
    console.log(verifyFail === 0 ? "All verified." : `Verification failures: ${verifyFail}`);
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
