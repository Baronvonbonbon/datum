/**
 * add-remaining-images.ts
 *
 * Companion to add-test-images.ts — generates SVG creatives for campaigns 7–99
 * (add-test-images.ts handles 0–6).
 *
 * For each campaign:
 *   • Generates 7 SVGs (one per IAB format) using the topic accent colour
 *   • Pins each SVG to the local Kubo IPFS node
 *   • Builds an updated metadata JSON with creative.images[] and creative.imageUrl
 *   • Pins the metadata JSON
 *   • Calls setMetadata() on DatumCampaigns with the new CID-derived bytes32
 *
 * Usage:
 *   npx ts-node scripts/add-remaining-images.ts
 *
 * Prerequisites:
 *   ipfs daemon   (Kubo running on localhost:5001)
 *   ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
 *   ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST"]'
 */

import { JsonRpcProvider, Wallet, Interface, Network } from "ethers";
import * as fs from "fs";
import * as path from "path";

// ── Config ─────────────────────────────────────────────────────────────────────

const RPC_URL  = "https://eth-rpc-testnet.polkadot.io/";
const KUBO_API = "http://localhost:5001";

// Campaigns 0-6 are handled by add-test-images.ts
const START_INDEX = 7;

const ACCOUNTS = {
  bob:     "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52",
  charlie: "0x1560b7b8d38c812b182b08e8ef739bb88c806d7ba36bd7b01c9177b3536654c1",
};

const TX_OPTS = {
  gasLimit: 500_000_000n,
  type:     0 as const,
  gasPrice: 1_000_000_000_000n,
};

// ── IAB formats ─────────────────────────────────────────────────────────────────

const IAB = [
  { name: "leaderboard",      w: 728, h: 90  },
  { name: "medium-rectangle", w: 300, h: 250 },
  { name: "wide-skyscraper",  w: 160, h: 600 },
  { name: "half-page",        w: 300, h: 600 },
  { name: "mobile-banner",    w: 320, h: 50  },
  { name: "square",           w: 250, h: 250 },
  { name: "large-rectangle",  w: 336, h: 280 },
] as const;

type FormatName = typeof IAB[number]["name"];

// ── Topic → accent colour ───────────────────────────────────────────────────────

const TOPIC_ACCENT: Record<string, string> = {
  "topic:arts-entertainment":    "#ec4899",
  "topic:autos-vehicles":        "#f43f5e",
  "topic:beauty-fitness":        "#f472b6",
  "topic:books-literature":      "#8b5cf6",
  "topic:business-industrial":   "#64748b",
  "topic:computers-electronics": "#06b6d4",
  "topic:finance":               "#3b82f6",
  "topic:food-drink":            "#f97316",
  "topic:gaming":                "#10b981",
  "topic:health":                "#14b8a6",
  "topic:hobbies-leisure":       "#a78bfa",
  "topic:home-garden":           "#84cc16",
  "topic:internet-telecom":      "#0ea5e9",
  "topic:jobs-education":        "#f59e0b",
  "topic:law-government":        "#6366f1",
  "topic:news":                  "#94a3b8",
  "topic:online-communities":    "#7c3aed",
  "topic:people-society":        "#fb923c",
  "topic:pets-animals":          "#4ade80",
  "topic:real-estate":           "#a16207",
  "topic:reference":             "#0891b2",
  "topic:science":               "#818cf8",
  "topic:shopping":              "#e879f9",
  "topic:sports":                "#22c55e",
  "topic:travel":                "#f59e0b",
  "topic:crypto-web3":           "#e6007a",
  "topic:defi":                  "#8b5cf6",
  "topic:nfts":                  "#ec4899",
  "topic:polkadot":              "#e6007a",
  "topic:daos-governance":       "#7c3aed",
};

const DEFAULT_ACCENT = "#e6007a"; // Polkadot pink fallback

// ── Wiki article → topic reverse map ───────────────────────────────────────────

const WIKI_TO_TOPIC: Record<string, string> = {
  // arts-entertainment
  "Cinema": "topic:arts-entertainment", "Theatre": "topic:arts-entertainment",
  "Visual_arts": "topic:arts-entertainment", "Performing_arts": "topic:arts-entertainment",
  // autos-vehicles
  "Automobile": "topic:autos-vehicles", "Electric_vehicle": "topic:autos-vehicles",
  "Formula_One": "topic:autos-vehicles", "Motorcycle": "topic:autos-vehicles",
  // beauty-fitness
  "Cosmetics": "topic:beauty-fitness", "Physical_fitness": "topic:beauty-fitness",
  "Skin_care": "topic:beauty-fitness", "Yoga": "topic:beauty-fitness",
  // books-literature
  "Novel": "topic:books-literature", "Literature": "topic:books-literature",
  "Science_fiction": "topic:books-literature", "Poetry": "topic:books-literature",
  // business-industrial
  "Entrepreneurship": "topic:business-industrial", "Supply_chain": "topic:business-industrial",
  "Manufacturing": "topic:business-industrial", "Venture_capital": "topic:business-industrial",
  // computers-electronics
  "Computer_science": "topic:computers-electronics", "Semiconductor": "topic:computers-electronics",
  "Microprocessor": "topic:computers-electronics", "Software_engineering": "topic:computers-electronics",
  // finance
  "Stock_market": "topic:finance", "Bond_finance": "topic:finance",
  "Hedge_fund": "topic:finance", "Index_fund": "topic:finance",
  // food-drink
  "Cuisine": "topic:food-drink", "Restaurant": "topic:food-drink",
  "Veganism": "topic:food-drink", "Gastronomy": "topic:food-drink",
  // gaming
  "Video_game": "topic:gaming", "Esports": "topic:gaming",
  "Role-playing_game": "topic:gaming", "Game_design": "topic:gaming",
  // health
  "Medicine": "topic:health", "Nutrition": "topic:health",
  "Public_health": "topic:health", "Mental_health": "topic:health",
  // hobbies-leisure
  "Hobby": "topic:hobbies-leisure", "Board_game": "topic:hobbies-leisure",
  "Collecting": "topic:hobbies-leisure", "Model_railway": "topic:hobbies-leisure",
  // home-garden
  "Interior_design": "topic:home-garden", "Gardening": "topic:home-garden",
  "Home_improvement": "topic:home-garden", "Architecture": "topic:home-garden",
  // internet-telecom
  "Internet": "topic:internet-telecom", "5G": "topic:internet-telecom",
  "Cloud_computing": "topic:internet-telecom", "Fiber_optic": "topic:internet-telecom",
  // jobs-education
  "University": "topic:jobs-education", "Online_learning": "topic:jobs-education",
  "Vocational_education": "topic:jobs-education", "STEM_education": "topic:jobs-education",
  // law-government
  "Law": "topic:law-government", "Democracy": "topic:law-government",
  "Contract_law": "topic:law-government", "International_law": "topic:law-government",
  // news
  "Journalism": "topic:news", "Newspaper": "topic:news",
  "Media_bias": "topic:news", "Investigative_journalism": "topic:news",
  // online-communities
  "Social_media": "topic:online-communities", "Reddit": "topic:online-communities",
  "Online_forum": "topic:online-communities", "Discord": "topic:online-communities",
  // people-society
  "Culture": "topic:people-society", "Sociology": "topic:people-society",
  "Demography": "topic:people-society", "Anthropology": "topic:people-society",
  // pets-animals
  "Dog": "topic:pets-animals", "Cat": "topic:pets-animals",
  "Animal_cognition": "topic:pets-animals", "Veterinary_medicine": "topic:pets-animals",
  // real-estate
  "Real_estate": "topic:real-estate", "Mortgage": "topic:real-estate",
  "Urban_planning": "topic:real-estate", "Property_management": "topic:real-estate",
  // reference
  "Encyclopedia": "topic:reference", "Wikipedia": "topic:reference",
  "Library_science": "topic:reference", "Database": "topic:reference",
  // science
  "Physics": "topic:science", "Chemistry": "topic:science",
  "Quantum_mechanics": "topic:science", "Astronomy": "topic:science",
  // shopping
  "E-commerce": "topic:shopping", "Retail": "topic:shopping",
  "Consumer_behaviour": "topic:shopping", "Marketplace": "topic:shopping",
  // sports
  "Football": "topic:sports", "Basketball": "topic:sports",
  "Tennis": "topic:sports", "Olympic_Games": "topic:sports",
  // travel
  "Tourism": "topic:travel", "Backpacking_travel": "topic:travel",
  "Aviation": "topic:travel", "Hotel": "topic:travel",
  // crypto-web3
  "Bitcoin": "topic:crypto-web3", "Ethereum": "topic:crypto-web3",
  "Blockchain": "topic:crypto-web3", "Cryptocurrency": "topic:crypto-web3",
  // defi
  "Decentralized_finance": "topic:defi", "Uniswap": "topic:defi",
  "Yield_farming": "topic:defi", "Aave_protocol": "topic:defi",
  // nfts
  "Non-fungible_token": "topic:nfts", "Digital_art": "topic:nfts",
  "OpenSea": "topic:nfts", "Bored_Ape_Yacht_Club": "topic:nfts",
  // polkadot
  "Polkadot_network": "topic:polkadot", "Substrate_framework": "topic:polkadot",
  "Parachain": "topic:polkadot", "Relay_chain": "topic:polkadot",
  // daos-governance
  "Decentralized_autonomous_organization": "topic:daos-governance",
  "On-chain_governance": "topic:daos-governance",
  "Voting_system": "topic:daos-governance",
  "Token_weighted_voting": "topic:daos-governance",
};

// ── SVG generator ───────────────────────────────────────────────────────────────
//
// Three layout families keyed by aspect ratio:
//   ultra-wide  (ar > 3)  → leaderboard, mobile-banner
//   tall        (ar < 0.6)→ wide-skyscraper, half-page
//   square-ish  (other)   → medium-rectangle, square, large-rectangle

function makeSvg(
  w: number, h: number, format: string,
  article: string, topic: string, accent: string,
): string {
  const ar = w / h;

  // ── Ultra-wide horizontal ──────────────────────────────────────────────────
  if (ar > 3) {
    const bar  = Math.max(2, h * 0.055);
    const dotR = h * 0.30;
    const dotX = w - h * 0.55;
    const dotY = h / 2;
    const f1   = h * 0.36;
    const f2   = h * 0.21;
    const tx   = h * 0.4;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#0a0a14"/>
  <rect width="${w}" height="${bar}" fill="${accent}"/>
  <circle cx="${dotX}" cy="${dotY}" r="${dotR * 1.8}" fill="${accent}" opacity="0.07"/>
  <circle cx="${dotX}" cy="${dotY}" r="${dotR}" fill="${accent}" opacity="0.18"/>
  <circle cx="${dotX}" cy="${dotY}" r="${dotR * 0.42}" fill="${accent}"/>
  <text x="${tx}" y="${h * 0.60}" font-family="system-ui,sans-serif" font-size="${f1}" font-weight="700" fill="white">DATUM · ${article.replace(/_/g, " ")}</text>
  <text x="${tx}" y="${h * 0.87}" font-family="system-ui,sans-serif" font-size="${f2}" fill="${accent}">${topic} · Privacy-First Advertising · ${w}×${h}</text>
</svg>`;
  }

  // ── Tall vertical ──────────────────────────────────────────────────────────
  if (ar < 0.6) {
    const cx    = w / 2;
    const circR = w * 0.25;
    const f1    = w * 0.12;
    const f2    = w * 0.075;
    const btnW  = w * 0.62;
    const btnH  = h * 0.05;
    const btnX  = (w - btnW) / 2;
    const btnY  = h * 0.82;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="vg${w}x${h}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0d0d20"/>
      <stop offset="100%" stop-color="#0a0a14"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#vg${w}x${h})"/>
  <rect width="${w}" height="3" fill="${accent}"/>
  <circle cx="${cx}" cy="${h * 0.20}" r="${circR * 1.9}" fill="${accent}" opacity="0.06"/>
  <circle cx="${cx}" cy="${h * 0.20}" r="${circR}" fill="${accent}" opacity="0.16"/>
  <circle cx="${cx}" cy="${h * 0.20}" r="${circR * 0.42}" fill="${accent}"/>
  <text x="${cx}" y="${h * 0.38}" font-family="system-ui,sans-serif" font-size="${f1}" font-weight="800" fill="white" text-anchor="middle">DATUM</text>
  <text x="${cx}" y="${h * 0.45}" font-family="system-ui,sans-serif" font-size="${f2}" fill="${accent}" text-anchor="middle">PROTOCOL</text>
  <text x="${cx}" y="${h * 0.54}" font-family="system-ui,sans-serif" font-size="${f2}" fill="white" text-anchor="middle" opacity="0.80">${article.replace(/_/g, " ")}</text>
  <text x="${cx}" y="${h * 0.61}" font-family="system-ui,sans-serif" font-size="${f2 * 0.85}" fill="white" text-anchor="middle" opacity="0.48">${topic}</text>
  <text x="${cx}" y="${h * 0.70}" font-family="system-ui,sans-serif" font-size="${f2 * 0.75}" fill="white" text-anchor="middle" opacity="0.32">Privacy-First Advertising</text>
  <rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="3" fill="${accent}"/>
  <text x="${cx}" y="${btnY + btnH * 0.70}" font-family="system-ui,sans-serif" font-size="${f2 * 0.88}" fill="white" text-anchor="middle" font-weight="600">Learn More</text>
  <text x="${cx}" y="${h * 0.97}" font-family="system-ui,sans-serif" font-size="${f2 * 0.62}" fill="#3a3a5a" text-anchor="middle">${format} · ${w}×${h}</text>
</svg>`;
  }

  // ── Square-ish ─────────────────────────────────────────────────────────────
  const cx    = w / 2;
  const s     = Math.min(w, h);
  const circR = s * 0.20;
  const f1    = s * 0.10;
  const f2    = s * 0.065;
  const btnW  = w * 0.42;
  const btnH  = h * 0.10;
  const btnX  = w * 0.08;
  const btnY  = h * 0.78;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="rg${w}x${h}" cx="78%" cy="24%" r="65%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#0a0a14" stop-opacity="1"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="#0a0a14"/>
  <rect width="${w}" height="${h}" fill="url(#rg${w}x${h})"/>
  <rect width="${w}" height="3" fill="${accent}"/>
  <circle cx="${w * 0.80}" cy="${h * 0.25}" r="${circR * 1.6}" fill="${accent}" opacity="0.10"/>
  <circle cx="${w * 0.80}" cy="${h * 0.25}" r="${circR}" fill="${accent}" opacity="0.22"/>
  <circle cx="${w * 0.80}" cy="${h * 0.25}" r="${circR * 0.42}" fill="${accent}"/>
  <text x="${w * 0.08}" y="${h * 0.30}" font-family="system-ui,sans-serif" font-size="${f1}" font-weight="800" fill="white">DATUM</text>
  <text x="${w * 0.08}" y="${h * 0.41}" font-family="system-ui,sans-serif" font-size="${f2}" fill="${accent}">PROTOCOL</text>
  <text x="${w * 0.08}" y="${h * 0.55}" font-family="system-ui,sans-serif" font-size="${f2}" fill="white" opacity="0.82">${article.replace(/_/g, " ")}</text>
  <text x="${w * 0.08}" y="${h * 0.65}" font-family="system-ui,sans-serif" font-size="${f2 * 0.88}" fill="white" opacity="0.48">${topic}</text>
  <text x="${w * 0.08}" y="${h * 0.73}" font-family="system-ui,sans-serif" font-size="${f2 * 0.78}" fill="white" opacity="0.32">Privacy-First Advertising</text>
  <rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="4" fill="${accent}"/>
  <text x="${btnX + btnW / 2}" y="${btnY + btnH * 0.67}" font-family="system-ui,sans-serif" font-size="${f2 * 0.90}" fill="white" text-anchor="middle" font-weight="600">Learn More</text>
  <text x="${w * 0.08}" y="${h * 0.97}" font-family="system-ui,sans-serif" font-size="${f2 * 0.62}" fill="#3a3a5a">${format} · ${w}×${h}</text>
</svg>`;
}

// ── IPFS helpers ───────────────────────────────────────────────────────────────

async function uploadToKubo(content: string, filename: string, mime: string): Promise<string> {
  const blob = new Blob([content], { type: mime });
  const form = new FormData();
  form.append("file", blob, filename);
  const resp = await fetch(`${KUBO_API}/api/v0/add?pin=true&cid-version=0`, {
    method: "POST",
    body: form,
    headers: { Connection: "close" },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Kubo add failed ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json() as { Hash: string };
  if (!data.Hash) throw new Error("Kubo returned no Hash");
  return data.Hash;
}

// ── CID → bytes32 ─────────────────────────────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function cidToBytes32(cid: string): string {
  let num = 0n;
  for (const c of cid) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`Bad base58 char: ${c}`);
    num = num * 58n + BigInt(i);
  }
  let leading = 0;
  for (const c of cid) { if (c === "1") leading++; else break; }
  const bytes: number[] = [];
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  const full = new Uint8Array([...new Array(leading).fill(0), ...bytes]);
  if (full.length !== 34 || full[0] !== 0x12 || full[1] !== 0x20)
    throw new Error(`Not a CIDv0 sha256 multihash: ${cid} (len=${full.length})`);
  return "0x" + Array.from(full.slice(2)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Paseo nonce polling ────────────────────────────────────────────────────────

async function waitNonce(provider: JsonRpcProvider, addr: string, target: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if ((await provider.getTransactionCount(addr)) > target) return;
    if (i % 15 === 0 && i > 0) process.stdout.write(`    ... waiting for tx (${i}s)\n`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${target}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  add-remaining-images — campaigns 7–99                        ");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Verify Kubo is running
  try {
    const vr = await fetch(`${KUBO_API}/api/v0/version`, { method: "POST" });
    if (!vr.ok) throw new Error(`status ${vr.status}`);
    const vj = await vr.json() as { Version: string };
    console.log(`✓ Kubo ${vj.Version} reachable at ${KUBO_API}\n`);
  } catch (e) {
    console.error(`✗ Cannot reach Kubo at ${KUBO_API}: ${e}`);
    console.error("  Start the daemon:  ipfs daemon");
    process.exit(1);
  }

  // Load metadata-cids.json (written by setup-testnet.ts step 2.8)
  const cidsPath = path.resolve(__dirname, "metadata-cids.json");
  if (!fs.existsSync(cidsPath)) {
    console.error(`✗ ${cidsPath} not found — run setup-testnet.ts first`);
    process.exit(1);
  }
  const allCids: Array<{ campaignIndex: number; wikiArticle: string; bytes32: string; cid: string | null }>
    = JSON.parse(fs.readFileSync(cidsPath, "utf8"));

  const remaining = allCids.filter(c => c.campaignIndex >= START_INDEX);
  console.log(`Processing ${remaining.length} campaigns (indices ${START_INDEX}–${allCids.length - 1})\n`);

  // ── Step 1: Upload SVGs ───────────────────────────────────────────────────────

  console.log("Step 1: Uploading SVG images to IPFS");
  console.log("─────────────────────────────────────");

  // imageCids[campaignIndex][formatName] = CID
  const imageCids = new Map<number, Map<FormatName, string>>();
  let totalImages = 0;
  let imagesFailed = 0;

  for (const entry of remaining) {
    const { campaignIndex, wikiArticle } = entry;
    const topic   = WIKI_TO_TOPIC[wikiArticle] ?? "";
    const topicLabel = topic ? topic.replace("topic:", "").replace(/-/g, " ") : "general";
    const accent  = TOPIC_ACCENT[topic] ?? DEFAULT_ACCENT;
    const fmtMap  = new Map<FormatName, string>();

    process.stdout.write(`  [${String(campaignIndex).padStart(2)}] ${wikiArticle.replace(/_/g, " ").padEnd(38)} `);

    for (const fmt of IAB) {
      const svg = makeSvg(fmt.w, fmt.h, fmt.name, wikiArticle, topicLabel, accent);
      try {
        const cid = await uploadToKubo(svg, `c${campaignIndex}-${fmt.name}.svg`, "image/svg+xml");
        fmtMap.set(fmt.name as FormatName, cid);
        totalImages++;
      } catch (e) {
        process.stdout.write(`\n    WARN: failed to upload ${fmt.name}: ${e}\n    `);
        imagesFailed++;
      }
    }

    imageCids.set(campaignIndex, fmtMap);
    console.log(`${fmtMap.size}/7 formats`);
  }

  console.log(`\n  Done: ${totalImages} images pinned, ${imagesFailed} failed\n`);

  // ── Step 2: Build + upload metadata JSONs ─────────────────────────────────────

  console.log("Step 2: Building + pinning metadata JSONs");
  console.log("──────────────────────────────────────────");

  // newMetaCids[campaignIndex] = new CID
  const newMetaCids = new Map<number, string>();
  let metaOk = 0, metaFailed = 0;

  for (const entry of remaining) {
    const { campaignIndex, wikiArticle } = entry;
    const fmtMap  = imageCids.get(campaignIndex);
    const topic   = WIKI_TO_TOPIC[wikiArticle] ?? "";
    const topicLabel = topic ? topic.replace("topic:", "").replace(/-/g, " ") : "general";

    const images: Array<{ format: string; url: string; alt: string }> = [];
    if (fmtMap) {
      for (const [fmtName, cid] of fmtMap) {
        images.push({
          format: fmtName,
          url:    cid,
          alt:    `${wikiArticle.replace(/_/g, " ")} advertisement – ${fmtName} format`,
        });
      }
    }

    const articleTitle = wikiArticle.replace(/_/g, " ");
    const title        = `${articleTitle} – Datum Ad #${campaignIndex + 1}`.slice(0, 128);
    const description  = (
      `Explore ${articleTitle} content on the decentralised Datum ad network. ` +
      `Campaign ${campaignIndex + 1} targeting ${topicLabel} audiences with privacy-first delivery.`
    ).slice(0, 256);
    const adText = (
      `Discover the best ${topicLabel} resources. Learn about ${articleTitle} ` +
      `through verified, privacy-preserving advertising powered by Datum Protocol.`
    ).slice(0, 512);

    const creative: Record<string, unknown> = {
      type:   "text",
      text:   adText,
      cta:    "Learn More",
      ctaUrl: `https://en.wikipedia.org/wiki/${wikiArticle}`,
    };
    if (images.length > 0) {
      creative["images"] = images;
      // imageUrl = medium-rectangle for legacy single-slot compatibility
      const mrCid = fmtMap?.get("medium-rectangle");
      if (mrCid) creative["imageUrl"] = mrCid;
    }

    const metadata = {
      title,
      description,
      category: topicLabel.slice(0, 64),
      version:  1,
      creative,
    };

    process.stdout.write(`  [${String(campaignIndex).padStart(2)}] ${articleTitle.padEnd(38)} `);
    try {
      const cid = await uploadToKubo(
        JSON.stringify(metadata, null, 2),
        `metadata-${campaignIndex}.json`,
        "application/json"
      );
      newMetaCids.set(campaignIndex, cid);
      metaOk++;
      console.log(`→ ${cid}`);
    } catch (e) {
      metaFailed++;
      console.log(`FAIL: ${e}`);
    }
  }

  console.log(`\n  Done: ${metaOk} pinned, ${metaFailed} failed\n`);

  // ── Step 4: Update on-chain metadata hashes ───────────────────────────────────

  console.log("Step 4: Updating on-chain metadata hashes");
  console.log("───────────────────────────────────────────");

  const paseoNet = Network.from(420420417);
  const provider = new JsonRpcProvider(RPC_URL, paseoNet, { staticNetwork: paseoNet });

  const addrsPath = path.resolve(__dirname, "../deployed-addresses.json");
  const addrs     = JSON.parse(fs.readFileSync(addrsPath, "utf8"));
  const campAddr: string = addrs.campaigns;
  if (!campAddr) throw new Error("campaigns address missing from deployed-addresses.json");
  console.log(`  Campaigns contract: ${campAddr}`);

  const campIface = new Interface([
    "function nextCampaignId() view returns (uint256)",
    "function setMetadata(uint256 campaignId, bytes32 metadataHash)",
  ]);

  const nextIdRaw  = await provider.call({ to: campAddr, data: campIface.encodeFunctionData("nextCampaignId", []) });
  const nextId     = BigInt(nextIdRaw);
  const baseCampId = nextId - 100n;
  console.log(`  nextCampaignId: ${nextId}  →  baseCampaignId: ${baseCampId}\n`);

  const bob     = new Wallet(ACCOUNTS.bob,     provider);
  const charlie = new Wallet(ACCOUNTS.charlie, provider);

  let onChainOk = 0, onChainFailed = 0;

  for (const entry of remaining) {
    const { campaignIndex } = entry;
    const metaCid = newMetaCids.get(campaignIndex);
    if (!metaCid) {
      console.log(`  [${campaignIndex}] SKIP — no metadata CID`);
      continue;
    }

    let bytes32: string;
    try {
      bytes32 = cidToBytes32(metaCid);
    } catch (e) {
      console.log(`  [${campaignIndex}] SKIP — CID conversion failed: ${e}`);
      onChainFailed++;
      continue;
    }

    const campId     = baseCampId + BigInt(campaignIndex);
    const signer     = campaignIndex % 2 === 0 ? bob : charlie;
    const signerName = campaignIndex % 2 === 0 ? "bob" : "charlie";

    try {
      const nonce = await provider.getTransactionCount(signer.address);
      const data  = campIface.encodeFunctionData("setMetadata", [campId, bytes32]);
      await signer.sendTransaction({ to: campAddr, data, value: 0n, ...TX_OPTS });
      await waitNonce(provider, signer.address, nonce);
      onChainOk++;
      console.log(`  [${String(campaignIndex).padStart(2)}] OK   id=${campId} (${signerName})`);
    } catch (e) {
      onChainFailed++;
      console.log(`  [${String(campaignIndex).padStart(2)}] FAIL id=${campaignIndex}: ${String(e).slice(0, 100)}`);
    }
  }

  // ── Step 5: Seed public gateways (after on-chain updates) ────────────────────

  console.log("\nStep 5: Seeding public gateway caches (fire-and-forget)");
  const allUploadedCids: string[] = [];
  for (const fmtMap of imageCids.values()) {
    allUploadedCids.push(...fmtMap.values());
  }
  for (const cid of newMetaCids.values()) {
    allUploadedCids.push(cid);
  }
  const gateways = ["https://dweb.link/ipfs/", "https://cloudflare-ipfs.com/ipfs/"];
  for (const cid of allUploadedCids) {
    for (const gw of gateways) {
      fetch(`${gw}${cid}`, { method: "HEAD" }).catch(() => {});
    }
  }
  console.log(`  Seeded ${allUploadedCids.length} CIDs → dweb.link + cloudflare-ipfs\n`);

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Summary");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Campaigns processed:    ${remaining.length}`);
  console.log(`  SVG images uploaded:    ${totalImages} (${imagesFailed} failed)`);
  console.log(`  Metadata JSONs pinned:  ${metaOk} (${metaFailed} failed)`);
  console.log(`  On-chain updates:       ${onChainOk} OK, ${onChainFailed} failed`);
  console.log();
  console.log("  Verify via local gateway:");
  let shown = 0;
  for (const [idx, cid] of newMetaCids) {
    console.log(`    [${idx}] http://localhost:8080/ipfs/${cid}?format=raw`);
    if (++shown >= 5) { console.log("    ..."); break; }
  }
  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
