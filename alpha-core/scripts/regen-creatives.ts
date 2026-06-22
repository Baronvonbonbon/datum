// regen-creatives.ts
//
// Give EVERY active campaign a *relevant* creative + metadata: topic-matched
// ad copy and a generated SVG banner (medium-rectangle 300x250 + leaderboard
// 728x90), pinned to local Kubo and set on-chain via DatumCampaignCreative.
//
// Unlike fill-missing-creatives.ts (which only fills campaigns whose metadata
// is still bytes32(0) and uses a generic Wikipedia rotation), this OVERWRITES
// existing metadata so the whole demo pool looks intentional and on-topic.
//
// Relevance: each campaign's required tags are read on-chain (getCampaignTags)
// and reverse-mapped to a topic via keccak256("topic:slug"). Open campaigns
// (no required tags) get a general DATUM-network creative.
//
// Run:
//   npx hardhat run scripts/regen-creatives.ts --network polkadotTestnet
//
// Env knobs:
//   DRY_RUN=1     Audit-only: resolve topics + preview, no pinning, no writes.
//   MAX_FILL=N    Cap the number of campaigns processed this run.
//   ONLY=1,2,19   Restrict to a comma-separated set of campaign ids.
//   KUBO_API=URL  Kubo HTTP API base (default http://localhost:5001).

import { network } from "hardhat";
import { JsonRpcProvider, Wallet, Interface, keccak256, toUtf8Bytes } from "ethers";
import * as fs from "fs";
import * as path from "path";

function envKey(name: string): string {
  const k = process.env[name];
  if (!k) throw new Error(`set ${name} in alpha-core/.env`);
  return k;
}
// Campaigns are created by Bob + Charlie (setup-testnet), Bob
// (seed-diana-campaigns), and Alice/deployer (a couple of setup campaigns).
// setMetadata must be sent by the campaign's advertiser.
const ACCOUNTS = {
  alice:   envKey("DEPLOYER_PRIVATE_KEY"),
  bob:     envKey("BOB_PRIVATE_KEY"),
  charlie: envKey("CHARLIE_PRIVATE_KEY"),
};

const _IS_PASEO = network.name === "polkadotTestnet";
const TX_OPTS = {
  gasLimit: _IS_PASEO ? 500000000n : 15000000n,
  type: 0 as const,
  gasPrice: _IS_PASEO ? 1000000000000n : 1000000000n,
};

const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_FILL = process.env.MAX_FILL ? parseInt(process.env.MAX_FILL, 10) : Infinity;
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => parseInt(s.trim(), 10))) : null;
const KUBO_API = process.env.KUBO_API || "http://localhost:5001";
const GATEWAY = "https://ipfs-datum.javcon.io/ipfs/";

// ── Topic creative library ───────────────────────────────────────────────
// One entry per topic tag the seed scripts use. Copy is intentionally generic
// demo advertising (no real-world claims), CTAs point at a relevant reference
// page. Palette drives the generated SVG banner. `wiki` feeds the CTA URL.
interface Creative {
  label: string;   // human topic label
  brand: string;   // fictional demo advertiser
  headline: string;
  body: string;
  cta: string;
  wiki: string;    // Wikipedia article for a safe, on-topic CTA target
  bg1: string; bg2: string; accent: string; // SVG palette
}

const TOPICS: Record<string, Creative> = {
  "arts-entertainment": { label: "Arts & Entertainment", brand: "Curtain Call", headline: "Front-row seats, every night.", body: "Stream premieres, shows and live performances.", cta: "Explore Shows", wiki: "Performing_arts", bg1: "#2b1055", bg2: "#7597de", accent: "#ffd166" },
  "autos-vehicles":     { label: "Autos & Vehicles", brand: "Veloce Motors", headline: "The road, reimagined.", body: "Next-gen electric drivetrains and smart range.", cta: "See Models", wiki: "Electric_vehicle", bg1: "#0f2027", bg2: "#2c5364", accent: "#e94560" },
  "beauty-fitness":     { label: "Beauty & Fitness", brand: "Lumen Wellness", headline: "Stronger, every day.", body: "Routines, skincare and training that fit your life.", cta: "Start Now", wiki: "Physical_fitness", bg1: "#ee9ca7", bg2: "#ffdde1", accent: "#7a3b69" },
  "books-literature":   { label: "Books & Literature", brand: "Margin Notes", headline: "Your next favourite read.", body: "Curated fiction, essays and new releases.", cta: "Browse Books", wiki: "Literature", bg1: "#3a1c71", bg2: "#d76d77", accent: "#ffaf7b" },
  "business-industrial":{ label: "Business & Industrial", brand: "Forge & Co.", headline: "Scale what you build.", body: "Supply-chain tooling for modern operators.", cta: "Get a Demo", wiki: "Entrepreneurship", bg1: "#141e30", bg2: "#243b55", accent: "#4ade80" },
  "computers-electronics":{ label: "Computers & Electronics", brand: "Silicon Row", headline: "Hardware that keeps up.", body: "Chips, boards and gear for makers and pros.", cta: "Shop Tech", wiki: "Semiconductor", bg1: "#0b486b", bg2: "#f56217", accent: "#ffd166" },
  "finance":            { label: "Finance", brand: "North Ledger", headline: "Markets, made clear.", body: "Track portfolios and plan with confidence.", cta: "Open Account", wiki: "Stock_market", bg1: "#093028", bg2: "#237a57", accent: "#a8ff78" },
  "food-drink":         { label: "Food & Drink", brand: "Table Eight", headline: "Tonight, eat well.", body: "Recipes and reservations from local kitchens.", cta: "Find Tables", wiki: "Gastronomy", bg1: "#c31432", bg2: "#240b36", accent: "#ffd166" },
  "gaming":             { label: "Gaming", brand: "Pixel Forge", headline: "Game on, level up.", body: "New releases, esports and indie gems.", cta: "Play Now", wiki: "Video_game", bg1: "#1f1c2c", bg2: "#928dab", accent: "#e94560" },
  "health":             { label: "Health", brand: "Vita Clinic", headline: "Care that comes to you.", body: "Telehealth, nutrition and preventive care.", cta: "Book a Visit", wiki: "Public_health", bg1: "#11998e", bg2: "#38ef7d", accent: "#0a3d3a" },
  "hobbies-leisure":    { label: "Hobbies & Leisure", brand: "Off Hours", headline: "Make time for the fun stuff.", body: "Board games, models and weekend kits.", cta: "Discover Kits", wiki: "Hobby", bg1: "#4568dc", bg2: "#b06ab3", accent: "#ffd166" },
  "home-garden":        { label: "Home & Garden", brand: "Rooted", headline: "Grow a home you love.", body: "Design, plants and home-improvement ideas.", cta: "Get Inspired", wiki: "Gardening", bg1: "#134e5e", bg2: "#71b280", accent: "#f4f1bb" },
  "internet-telecom":   { label: "Internet & Telecom", brand: "FibreLink", headline: "Faster, everywhere.", body: "Gigabit fibre and 5G that just works.", cta: "Check Coverage", wiki: "Fiber_optic", bg1: "#16222a", bg2: "#3a6073", accent: "#4ade80" },
  "jobs-education":     { label: "Jobs & Education", brand: "Northstar Learn", headline: "Skill up, move up.", body: "Courses and STEM programmes that land jobs.", cta: "Enrol Today", wiki: "Online_learning", bg1: "#283048", bg2: "#859398", accent: "#ffd166" },
  "law-government":     { label: "Law & Government", brand: "Civic Desk", headline: "Know your rights.", body: "Plain-language legal guidance and forms.", cta: "Learn More", wiki: "Law", bg1: "#1e3c72", bg2: "#2a5298", accent: "#cbd5e1" },
  "news":               { label: "News", brand: "The Daily Signal", headline: "The story behind the story.", body: "Independent reporting, no noise.", cta: "Read Today", wiki: "Journalism", bg1: "#232526", bg2: "#414345", accent: "#e94560" },
  "online-communities": { label: "Online Communities", brand: "Hearth", headline: "Find your people.", body: "Forums and groups for every interest.", cta: "Join In", wiki: "Online_forum", bg1: "#5433ff", bg2: "#20bdff", accent: "#ffd166" },
  "people-society":     { label: "People & Society", brand: "Common Ground", headline: "Understand the world.", body: "Culture, sociology and human stories.", cta: "Explore", wiki: "Culture", bg1: "#42275a", bg2: "#734b6d", accent: "#f4f1bb" },
  "pets-animals":       { label: "Pets & Animals", brand: "Paws & Co.", headline: "Happy pets, happy home.", body: "Food, care tips and vet-backed advice.", cta: "Shop Pets", wiki: "Dog", bg1: "#ff9966", bg2: "#ff5e62", accent: "#3a1c1c" },
  "real-estate":        { label: "Real Estate", brand: "Keystone Homes", headline: "Your next address.", body: "Listings, mortgages and neighbourhood data.", cta: "View Listings", wiki: "Real_estate", bg1: "#0f2027", bg2: "#2c5364", accent: "#ffd166" },
  "reference":          { label: "Reference", brand: "Index", headline: "Look it up, fast.", body: "Encyclopedic answers you can trust.", cta: "Search Now", wiki: "Encyclopedia", bg1: "#373b44", bg2: "#4286f4", accent: "#f4f1bb" },
  "science":            { label: "Science", brand: "Quanta Labs", headline: "Curiosity, powered.", body: "Physics, chemistry and the cosmos explained.", cta: "Dive In", wiki: "Physics", bg1: "#0b0b3b", bg2: "#1a73e8", accent: "#a8ff78" },
  "shopping":           { label: "Shopping", brand: "Cartwheel", headline: "Deals worth the click.", body: "A smarter marketplace for everyday finds.", cta: "Shop Deals", wiki: "E-commerce", bg1: "#ee0979", bg2: "#ff6a00", accent: "#fff3b0" },
  "sports":             { label: "Sports", brand: "Endline", headline: "Never miss a moment.", body: "Live scores, highlights and gear.", cta: "Catch Up", wiki: "Sport", bg1: "#005c97", bg2: "#363795", accent: "#4ade80" },
  "travel":             { label: "Travel", brand: "Waypoint", headline: "Go somewhere new.", body: "Flights, stays and trips worth taking.", cta: "Plan a Trip", wiki: "Tourism", bg1: "#2980b9", bg2: "#6dd5fa", accent: "#ffd166" },
  "crypto-web3":        { label: "Crypto & Web3", brand: "ChainView", headline: "On-chain, on point.", body: "Track assets and explore the open web.", cta: "Get Started", wiki: "Cryptocurrency", bg1: "#1a1a2e", bg2: "#16213e", accent: "#e94560" },
  "defi":               { label: "DeFi", brand: "Liquid Markets", headline: "Finance without the middle.", body: "Swap, lend and earn — permissionless.", cta: "Explore DeFi", wiki: "Decentralized_finance", bg1: "#0f0c29", bg2: "#302b63", accent: "#a8ff78" },
  "nfts":               { label: "NFTs", brand: "Mintworks", headline: "Own the original.", body: "Digital art and collectibles, verifiably yours.", cta: "Browse Drops", wiki: "Non-fungible_token", bg1: "#8e2de2", bg2: "#4a00e0", accent: "#ffd166" },
  "polkadot":           { label: "Polkadot", brand: "Parachain HQ", headline: "Build on the relay chain.", body: "Substrate tooling for a multichain future.", cta: "Start Building", wiki: "Polkadot_(blockchain_platform)", bg1: "#1b0033", bg2: "#e6007a", accent: "#ffffff" },
  "daos-governance":    { label: "DAOs & Governance", brand: "Quorum", headline: "Decide together.", body: "On-chain voting and treasury tooling for DAOs.", cta: "Join a DAO", wiki: "Decentralized_autonomous_organization", bg1: "#11998e", bg2: "#38ef7d", accent: "#063a36" },
};

const DEFAULT_CREATIVE: Creative = {
  label: "DATUM Network", brand: "DATUM", headline: "Ads that respect you.", body: "Privacy-first, on-chain advertising on Polkadot.", cta: "Learn More", wiki: "Online_advertising", bg1: "#1a1a2e", bg2: "#16213e", accent: "#e94560",
};

// keccak256("topic:slug") → slug, for reverse-mapping on-chain tags.
const TAG_TO_SLUG: Record<string, string> = {};
for (const slug of Object.keys(TOPICS)) {
  TAG_TO_SLUG[keccak256(toUtf8Bytes(`topic:${slug}`)).toLowerCase()] = slug;
}

// ── SVG banner generation ──────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Word-wrap a string to <= width chars per line, max `maxLines` lines.
function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) { lines.push(cur.trim()); cur = w; }
    else cur = (cur + " " + w).trim();
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur.trim());
  return lines.slice(0, maxLines);
}

function svgMediumRectangle(c: Creative): string {
  const headLines = wrap(c.headline, 22, 2);
  const headTspans = headLines.map((l, i) =>
    `<tspan x="24" dy="${i === 0 ? 0 : 26}">${esc(l)}</tspan>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="250" viewBox="0 0 300 250">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c.bg1}"/><stop offset="1" stop-color="${c.bg2}"/></linearGradient></defs>
  <rect width="300" height="250" fill="url(#g)"/>
  <text x="24" y="40" fill="${c.accent}" font-family="Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="2">${esc(c.brand.toUpperCase())}</text>
  <text x="24" y="108" fill="#ffffff" font-family="Arial, sans-serif" font-size="22" font-weight="800">${headTspans}</text>
  <text x="24" y="188" fill="#e8e8f0" font-family="Arial, sans-serif" font-size="12">${esc(wrap(c.body, 36, 1)[0] || "")}</text>
  <rect x="24" y="204" width="${Math.min(140, 24 + c.cta.length * 9)}" height="30" rx="6" fill="${c.accent}"/>
  <text x="${24 + Math.min(140, 24 + c.cta.length * 9) / 2}" y="224" fill="#10101a" font-family="Arial, sans-serif" font-size="12" font-weight="700" text-anchor="middle">${esc(c.cta)} →</text>
  <text x="276" y="240" fill="#ffffff" opacity="0.55" font-family="Arial, sans-serif" font-size="9" text-anchor="end">Ad · DATUM</text>
</svg>`;
}

function svgLeaderboard(c: Creative): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="728" height="90" viewBox="0 0 728 90">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${c.bg1}"/><stop offset="1" stop-color="${c.bg2}"/></linearGradient></defs>
  <rect width="728" height="90" fill="url(#g)"/>
  <text x="28" y="38" fill="${c.accent}" font-family="Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="2">${esc(c.brand.toUpperCase())}</text>
  <text x="28" y="68" fill="#ffffff" font-family="Arial, sans-serif" font-size="22" font-weight="800">${esc(wrap(c.headline, 40, 1)[0] || c.headline)}</text>
  <rect x="556" y="30" width="140" height="32" rx="6" fill="${c.accent}"/>
  <text x="626" y="51" fill="#10101a" font-family="Arial, sans-serif" font-size="13" font-weight="700" text-anchor="middle">${esc(c.cta)} →</text>
  <text x="700" y="82" fill="#ffffff" opacity="0.55" font-family="Arial, sans-serif" font-size="9" text-anchor="end">Ad · DATUM</text>
</svg>`;
}

function buildMetadata(c: Creative, campaignId: number, mrCid: string, lbCid: string): string {
  return JSON.stringify({
    title: `${c.brand} — ${c.label}`.slice(0, 128),
    description: `${c.headline} ${c.body}`.slice(0, 256),
    category: c.label.slice(0, 64),
    creative: {
      type: "text",
      text: c.body.slice(0, 512),
      cta: c.cta.slice(0, 48),
      ctaUrl: `https://en.wikipedia.org/wiki/${c.wiki}`,
      imageUrl: mrCid, // bare CID; renderer resolves via gateway
      images: [
        { format: "medium-rectangle", url: mrCid, alt: `${c.brand} ad` },
        { format: "leaderboard", url: lbCid, alt: `${c.brand} ad` },
      ],
    },
    version: 1,
    _campaignId: campaignId,
  });
}

// CIDv0 ("Qm...") → 0x 32-byte hex (strip 0x1220 multihash prefix).
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function cidToBytes32(cid: string): string {
  let num = 0n;
  for (const ch of cid) { const i = BASE58.indexOf(ch); if (i < 0) throw new Error(`bad base58: ${ch}`); num = num * 58n + BigInt(i); }
  let lead = 0; for (const ch of cid) { if (ch === "1") lead++; else break; }
  const bytes: number[] = []; while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  const full = new Uint8Array([...new Array(lead).fill(0), ...bytes]);
  if (full.length !== 34 || full[0] !== 0x12 || full[1] !== 0x20) throw new Error(`not CIDv0 sha256: ${cid}`);
  return "0x" + Array.from(full.slice(2)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pin(content: string, name: string, type: string): Promise<string | null> {
  try {
    const fd = new FormData();
    fd.append("file", new Blob([content], { type }), name);
    const r = await fetch(`${KUBO_API}/api/v0/add?pin=true&cid-version=0`, { method: "POST", body: fd });
    if (!r.ok) return null;
    return ((await r.json()) as { Hash: string }).Hash;
  } catch { return null; }
}

async function waitForNonce(p: JsonRpcProvider, addr: string, target: number, maxWait = 120): Promise<void> {
  for (let i = 0; i < maxWait; i++) { if ((await p.getTransactionCount(addr)) > target) return; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`timeout waiting for nonce > ${target}`);
}

const campIface = new Interface([
  "function nextCampaignId() view returns (uint256)",
  "function getCampaignStatus(uint256) view returns (uint8)",
  "function getCampaignAdvertiser(uint256) view returns (address)",
  "function getCampaignTags(uint256) view returns (bytes32[])",
]);
const creativeIface = new Interface([
  "function setMetadata(uint256 campaignId, bytes32 metadataHash)",
  "function campaignMetadata(uint256) view returns (bytes32)",
]);

async function read(p: JsonRpcProvider, to: string, iface: Interface, m: string, a: any[]): Promise<string> {
  return p.call({ to, data: iface.encodeFunctionData(m, a) });
}

async function main() {
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const p = new JsonRpcProvider(rpcUrl);
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf-8"));
  console.log(`Network: ${network.name} (${rpcUrl})`);
  console.log(`Campaigns:        ${addrs.campaigns}`);
  console.log(`CampaignCreative: ${addrs.campaignCreative}`);

  const wallets: Record<string, Wallet> = {};
  for (const [name, key] of Object.entries(ACCOUNTS)) {
    const w = new Wallet(key, p);
    wallets[w.address.toLowerCase()] = w;
    console.log(`  ${name.padEnd(8)} ${w.address}`);
  }

  const nextId = Number(BigInt(await read(p, addrs.campaigns, campIface, "nextCampaignId", [])));
  console.log(`nextCampaignId = ${nextId} (campaigns 1..${nextId - 1})\n`);

  // Cache SVG CIDs per topic slug so identical topics dedup (content-addressed).
  const mrCache: Record<string, string> = {};
  const lbCache: Record<string, string> = {};

  let done = 0, skipped = 0, pinErr = 0, txErr = 0;
  const topicCounts: Record<string, number> = {};

  for (let id = 1; id < nextId && done < MAX_FILL; id++) {
    if (ONLY && !ONLY.has(id)) continue;
    const status = Number(BigInt(await read(p, addrs.campaigns, campIface, "getCampaignStatus", [id])));
    if (status !== 1) { skipped++; continue; } // 1 = Active

    const advHex = await read(p, addrs.campaigns, campIface, "getCampaignAdvertiser", [id]);
    const advertiser = ("0x" + advHex.slice(-40)).toLowerCase();
    const wallet = wallets[advertiser];
    if (!wallet) { console.log(`  id=${id} SKIP — advertiser ${advertiser} not held`); skipped++; continue; }

    // Resolve topic from required tags.
    const tags = campIface.decodeFunctionResult("getCampaignTags", await read(p, addrs.campaigns, campIface, "getCampaignTags", [id]))[0] as string[];
    let slug = "(default)";
    let c = DEFAULT_CREATIVE;
    for (const t of tags) {
      const s = TAG_TO_SLUG[t.toLowerCase()];
      if (s) { slug = s; c = TOPICS[s]; break; }
    }
    topicCounts[slug] = (topicCounts[slug] || 0) + 1;
    console.log(`  id=${id} adv=${advertiser.slice(0, 8)} topic=${slug} brand="${c.brand}"`);

    if (DRY_RUN) { done++; continue; }

    // Pin (or reuse) the two SVG banners for this topic.
    if (!mrCache[slug]) {
      const cid = await pin(svgMediumRectangle(c), "mr.svg", "image/svg+xml");
      if (!cid) { console.log(`    !! mr pin failed`); pinErr++; continue; }
      mrCache[slug] = cid;
    }
    if (!lbCache[slug]) {
      const cid = await pin(svgLeaderboard(c), "lb.svg", "image/svg+xml");
      if (!cid) { console.log(`    !! lb pin failed`); pinErr++; continue; }
      lbCache[slug] = cid;
    }

    const metaCid = await pin(buildMetadata(c, id, mrCache[slug], lbCache[slug]), "metadata.json", "application/json");
    if (!metaCid) { console.log(`    !! metadata pin failed`); pinErr++; continue; }

    const digest = cidToBytes32(metaCid);
    try {
      const nonce = await p.getTransactionCount(wallet.address);
      await wallet.sendTransaction({ to: addrs.campaignCreative, data: creativeIface.encodeFunctionData("setMetadata", [id, digest]), ...TX_OPTS });
      await waitForNonce(p, wallet.address, nonce);
    } catch (e: any) {
      console.log(`    !! setMetadata failed: ${String(e.message || e).slice(0, 120)}`);
      txErr++; continue;
    }
    console.log(`    OK meta=${metaCid} mr=${mrCache[slug]}`);
    done++;
  }

  console.log(`\nDone. updated=${done} skipped=${skipped} pinErrors=${pinErr} txErrors=${txErr}`);
  console.log(`Topic spread:`, topicCounts);
  if (!DRY_RUN && done > 0) console.log(`Gateway sample: ${GATEWAY}<cid>`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
