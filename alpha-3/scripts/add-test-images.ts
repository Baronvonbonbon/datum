/**
 * add-test-images.ts
 *
 * Generates SVG test images for all 7 IAB ad formats, uploads them to the local
 * Kubo IPFS node (localhost:5001), builds updated campaign metadata JSONs with
 * creative.images[], pins those to IPFS, and calls setMetadata() on DatumCampaigns
 * for campaigns 0–6:
 *
 *   0 — Motorcycle        leaderboard only          (red,    Autos & Vehicles)
 *   1 — Backpacking       medium-rectangle only      (green,  Travel)
 *   2 — Newspaper         wide-skyscraper only       (slate,  News)
 *   3 — Culture           half-page only             (amber,  People & Society)
 *   4 — Restaurant        mobile-banner only         (orange, Food & Drink)
 *   5 — Hedge fund        square only                (blue,   Finance)
 *   6 — Online forum      all 7 formats + imageUrl   (purple, Online Communities)
 *
 * Usage:
 *   npx ts-node scripts/add-test-images.ts
 *
 * Prerequisites:
 *   ipfs daemon   (Kubo running on localhost:5001)
 *   ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
 *   ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST"]'
 */

import { JsonRpcProvider, Wallet, Interface } from "ethers";
import * as fs from "fs";
import * as path from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL  = "https://eth-rpc-testnet.polkadot.io/";
const KUBO_API = "http://localhost:5001";

const ACCOUNTS = {
  bob:     "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52",
  charlie: "0x1560b7b8d38c812b182b08e8ef739bb88c806d7ba36bd7b01c9177b3536654c1",
};

const TX_OPTS = {
  gasLimit: 500_000_000n,
  type:     0 as const,
  gasPrice: 1_000_000_000_000n,
};

// ── IAB format specs ──────────────────────────────────────────────────────────

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
const FORMAT_MAP = new Map(IAB.map(f => [f.name, f] as [FormatName, typeof f]));

// ── Campaign definitions ──────────────────────────────────────────────────────

interface CampaignDef {
  index:     number;
  signer:    "bob" | "charlie";
  formats:   FormatName[];
  legacy:    boolean;          // also set creative.imageUrl (medium-rectangle cid)
  article:   string;
  topic:     string;
  category:  string;
  accent:    string;
  ctaUrl:    string;
}

const CAMPAIGNS: CampaignDef[] = [
  {
    index: 0, signer: "bob",
    formats: ["leaderboard"], legacy: false,
    article: "Motorcycle", topic: "Autos & Vehicles", category: "autos vehicles",
    accent: "#f43f5e", ctaUrl: "https://en.wikipedia.org/wiki/Motorcycle",
  },
  {
    index: 1, signer: "charlie",
    formats: ["medium-rectangle"], legacy: false,
    article: "Backpacking travel", topic: "Travel", category: "travel",
    accent: "#22c55e", ctaUrl: "https://en.wikipedia.org/wiki/Backpacking_travel",
  },
  {
    index: 2, signer: "bob",
    formats: ["wide-skyscraper"], legacy: false,
    article: "Newspaper", topic: "News", category: "news",
    accent: "#94a3b8", ctaUrl: "https://en.wikipedia.org/wiki/Newspaper",
  },
  {
    index: 3, signer: "charlie",
    formats: ["half-page"], legacy: false,
    article: "Culture", topic: "People & Society", category: "people and society",
    accent: "#f59e0b", ctaUrl: "https://en.wikipedia.org/wiki/Culture",
  },
  {
    index: 4, signer: "bob",
    formats: ["mobile-banner"], legacy: false,
    article: "Restaurant", topic: "Food & Drink", category: "food and drink",
    accent: "#f97316", ctaUrl: "https://en.wikipedia.org/wiki/Restaurant",
  },
  {
    index: 5, signer: "charlie",
    formats: ["square"], legacy: false,
    article: "Hedge fund", topic: "Finance", category: "finance",
    accent: "#3b82f6", ctaUrl: "https://en.wikipedia.org/wiki/Hedge_fund",
  },
  {
    index: 6, signer: "bob",
    formats: ["leaderboard", "medium-rectangle", "wide-skyscraper",
              "half-page", "mobile-banner", "square", "large-rectangle"],
    legacy: true,
    article: "Online forum", topic: "Online Communities", category: "online communities",
    accent: "#7c3aed", ctaUrl: "https://en.wikipedia.org/wiki/Online_forum",
  },
];

// ── SVG generator ─────────────────────────────────────────────────────────────
//
// Three layout families:
//   ultra-wide  ar > 3   → leaderboard (728×90), mobile-banner (320×50)
//   tall        ar < 0.6 → wide-skyscraper (160×600), half-page (300×600)
//   square-ish  otherwise→ medium-rectangle, square, large-rectangle

function makeSvg(
  w: number, h: number, format: string,
  article: string, topic: string, accent: string,
): string {
  const ar = w / h;

  /* ── Ultra-wide horizontal ── */
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
  <text x="${tx}" y="${h * 0.60}" font-family="system-ui,sans-serif" font-size="${f1}" font-weight="700" fill="white">DATUM · ${article}</text>
  <text x="${tx}" y="${h * 0.87}" font-family="system-ui,sans-serif" font-size="${f2}" fill="${accent}">${topic} · Privacy-First Advertising · ${w}×${h}</text>
</svg>`;
  }

  /* ── Tall vertical ── */
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
    <linearGradient id="vg${w}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0d0d20"/>
      <stop offset="100%" stop-color="#0a0a14"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#vg${w})"/>
  <rect width="${w}" height="3" fill="${accent}"/>
  <circle cx="${cx}" cy="${h * 0.20}" r="${circR * 1.9}" fill="${accent}" opacity="0.06"/>
  <circle cx="${cx}" cy="${h * 0.20}" r="${circR}" fill="${accent}" opacity="0.16"/>
  <circle cx="${cx}" cy="${h * 0.20}" r="${circR * 0.42}" fill="${accent}"/>
  <text x="${cx}" y="${h * 0.38}" font-family="system-ui,sans-serif" font-size="${f1}" font-weight="800" fill="white" text-anchor="middle">DATUM</text>
  <text x="${cx}" y="${h * 0.45}" font-family="system-ui,sans-serif" font-size="${f2}" fill="${accent}" text-anchor="middle">PROTOCOL</text>
  <text x="${cx}" y="${h * 0.54}" font-family="system-ui,sans-serif" font-size="${f2}" fill="white" text-anchor="middle" opacity="0.80">${article}</text>
  <text x="${cx}" y="${h * 0.61}" font-family="system-ui,sans-serif" font-size="${f2 * 0.85}" fill="white" text-anchor="middle" opacity="0.48">${topic}</text>
  <text x="${cx}" y="${h * 0.70}" font-family="system-ui,sans-serif" font-size="${f2 * 0.75}" fill="white" text-anchor="middle" opacity="0.32">Privacy-First Advertising</text>
  <rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="3" fill="${accent}"/>
  <text x="${cx}" y="${btnY + btnH * 0.70}" font-family="system-ui,sans-serif" font-size="${f2 * 0.88}" fill="white" text-anchor="middle" font-weight="600">Learn More</text>
  <text x="${cx}" y="${h * 0.97}" font-family="system-ui,sans-serif" font-size="${f2 * 0.62}" fill="#3a3a5a" text-anchor="middle">${format} · ${w}×${h}</text>
</svg>`;
  }

  /* ── Square-ish ── */
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
  <text x="${w * 0.08}" y="${h * 0.55}" font-family="system-ui,sans-serif" font-size="${f2}" fill="white" opacity="0.82">${article}</text>
  <text x="${w * 0.08}" y="${h * 0.65}" font-family="system-ui,sans-serif" font-size="${f2 * 0.88}" fill="white" opacity="0.48">${topic}</text>
  <text x="${w * 0.08}" y="${h * 0.73}" font-family="system-ui,sans-serif" font-size="${f2 * 0.78}" fill="white" opacity="0.32">Privacy-First Advertising</text>
  <rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="4" fill="${accent}"/>
  <text x="${btnX + btnW / 2}" y="${btnY + btnH * 0.67}" font-family="system-ui,sans-serif" font-size="${f2 * 0.90}" fill="white" text-anchor="middle" font-weight="600">Learn More</text>
  <text x="${w * 0.08}" y="${h * 0.97}" font-family="system-ui,sans-serif" font-size="${f2 * 0.62}" fill="#3a3a5a">${format} · ${w}×${h}</text>
</svg>`;
}

// ── IPFS upload ───────────────────────────────────────────────────────────────

async function uploadToKubo(content: string, filename: string, mime: string): Promise<string> {
  const blob = new Blob([content], { type: mime });
  const form = new FormData();
  form.append("file", blob, filename);
  const resp = await fetch(`${KUBO_API}/api/v0/add?pin=true&cid-version=0`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Kubo add failed ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json() as { Hash: string };
  if (!data.Hash) throw new Error("Kubo returned no Hash");
  return data.Hash;
}

// ── CID → bytes32 (same as fix-metadata-hashes.ts) ──────────────────────────

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

// ── Paseo nonce-polling ───────────────────────────────────────────────────────

async function waitNonce(provider: JsonRpcProvider, addr: string, target: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if ((await provider.getTransactionCount(addr)) > target) return;
    if (i % 15 === 0 && i > 0) process.stdout.write(`    ... waiting for tx (${i}s)\n`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${target}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  add-test-images — Upload SVG ads to IPFS + update metadata   ");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Check Kubo is reachable
  try {
    const vr = await fetch(`${KUBO_API}/api/v0/version`, { method: "POST" });
    if (!vr.ok) throw new Error(`status ${vr.status}`);
    const vj = await vr.json() as { Version: string };
    console.log(`✓ Kubo ${vj.Version} reachable at ${KUBO_API}\n`);
  } catch (e) {
    console.error(`✗ Cannot reach Kubo at ${KUBO_API}: ${e}`);
    console.error("  Start the daemon:  ipfs daemon");
    console.error("  Allow CORS:        ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '[\"*\"]'");
    process.exit(1);
  }

  // ── Step 1: Generate + upload SVGs ─────────────────────────────────────────
  //
  // For campaigns 0-5: one topic-specific SVG for their primary format.
  // For campaign 6: one full-set of 7 purple (Datum brand) SVGs.
  // The large-rectangle format is only used in campaign 6.

  console.log("Step 1: Uploading SVG images to IPFS");
  console.log("─────────────────────────────────────");

  // Map: `${campaignIndex}:${formatName}` → CID
  const imageCids = new Map<string, string>();

  // Campaigns 0-5: single format, topic-specific color
  for (const camp of CAMPAIGNS.slice(0, 6)) {
    const fmtName = camp.formats[0];
    const fmt = FORMAT_MAP.get(fmtName)!;
    const svg = makeSvg(fmt.w, fmt.h, fmtName, camp.article, camp.topic, camp.accent);
    const key = `${camp.index}:${fmtName}`;
    process.stdout.write(`  [${camp.index}] ${fmtName.padEnd(18)} ${fmt.w}×${fmt.h}  `);
    const cid = await uploadToKubo(svg, `campaign-${camp.index}-${fmtName}.svg`, "image/svg+xml");
    imageCids.set(key, cid);
    console.log(`→ ${cid}`);
  }

  // Campaign 6: all 7 formats in purple Datum brand style
  const camp6 = CAMPAIGNS[6];
  console.log(`\n  [6] All 7 formats (Online forum, purple):`);
  for (const fmtName of camp6.formats) {
    const fmt = FORMAT_MAP.get(fmtName)!;
    const svg = makeSvg(fmt.w, fmt.h, fmtName, camp6.article, camp6.topic, camp6.accent);
    const key = `6:${fmtName}`;
    process.stdout.write(`      ${fmtName.padEnd(18)} ${fmt.w}×${fmt.h}  `);
    const cid = await uploadToKubo(svg, `campaign-6-${fmtName}.svg`, "image/svg+xml");
    imageCids.set(key, cid);
    console.log(`→ ${cid}`);
  }

  // ── Step 2: Build + upload metadata JSONs ───────────────────────────────────

  console.log("\nStep 2: Building and uploading metadata JSONs");
  console.log("──────────────────────────────────────────────");

  // Map: campaignIndex → CID of the new metadata JSON
  const metaCids = new Map<number, string>();

  for (const camp of CAMPAIGNS) {
    const idx = camp.index;
    const images: Array<{ format: string; url: string; alt: string }> = [];

    for (const fmtName of camp.formats) {
      const key = `${idx}:${fmtName}`;
      const cid = imageCids.get(key);
      if (!cid) { console.warn(`  WARN: no image CID for ${key}`); continue; }
      images.push({
        format: fmtName,
        url:    cid,
        alt:    `${camp.article} advertisement – ${fmtName} format`,
      });
    }

    const title       = `${camp.article} – Datum Ad #${idx + 1}`.slice(0, 128);
    const description = (
      `Explore ${camp.article} content on the decentralised Datum ad network. ` +
      `Campaign ${idx + 1} targeting ${camp.topic} audiences with privacy-first delivery.`
    ).slice(0, 256);
    const adText = (
      `Discover the best ${camp.topic} resources. Learn about ${camp.article} ` +
      `through verified, privacy-preserving advertising powered by Datum Protocol.`
    ).slice(0, 512);

    const creative: Record<string, unknown> = {
      type:   "text",
      text:   adText,
      cta:    "Learn More",
      ctaUrl: camp.ctaUrl,
    };
    if (images.length > 0) creative["images"] = images;
    // Campaign 6 also gets legacy imageUrl pointing to the medium-rectangle CID
    if (camp.legacy) {
      const fallback = imageCids.get("6:medium-rectangle");
      if (fallback) creative["imageUrl"] = fallback;
    }

    const metadata = {
      title,
      description,
      category: camp.category,
      version:  1,
      creative,
    };

    process.stdout.write(`  [${idx}] ${camp.article.padEnd(22)} ${images.length} image(s)  `);
    const cid = await uploadToKubo(JSON.stringify(metadata, null, 2), `metadata-${idx}.json`, "application/json");
    metaCids.set(idx, cid);
    console.log(`→ ${cid}`);
  }

  // ── Step 3: Seed public gateway caches ─────────────────────────────────────

  console.log("\nStep 3: Seeding public gateway caches (fire-and-forget)");
  const allCids = [...imageCids.values(), ...metaCids.values()];
  const gateways = ["https://dweb.link/ipfs/", "https://cloudflare-ipfs.com/ipfs/"];
  for (const cid of allCids) {
    for (const gw of gateways) {
      fetch(`${gw}${cid}`, { method: "HEAD" }).catch(() => {});
    }
  }
  console.log(`  Seeded ${allCids.length} CIDs → dweb.link + cloudflare-ipfs`);

  // ── Step 4: Update on-chain metadata hashes ─────────────────────────────────

  console.log("\nStep 4: Updating on-chain metadata hashes");
  console.log("───────────────────────────────────────────");

  const provider = new JsonRpcProvider(RPC_URL);

  // Load deployed addresses
  const addrsPath = path.resolve(__dirname, "../deployed-addresses.json");
  const addrs     = JSON.parse(fs.readFileSync(addrsPath, "utf8"));
  const campAddr: string = addrs.campaigns;
  if (!campAddr) throw new Error("campaigns address missing from deployed-addresses.json");
  console.log(`  Campaigns contract: ${campAddr}`);

  const campIface = new Interface([
    "function nextCampaignId() view returns (uint256)",
    "function setMetadata(uint256 campaignId, bytes32 metadataHash)",
    "function getCampaignMetadata(uint256 campaignId) view returns (bytes32)",
  ]);

  // Derive base campaign ID
  const nextIdRaw   = await provider.call({ to: campAddr, data: campIface.encodeFunctionData("nextCampaignId", []) });
  const nextId      = BigInt(nextIdRaw);
  const baseCampId  = nextId - 100n;
  console.log(`  nextCampaignId: ${nextId}  →  baseCampaignId: ${baseCampId}\n`);

  const bob     = new Wallet(ACCOUNTS.bob,     provider);
  const charlie = new Wallet(ACCOUNTS.charlie, provider);

  let ok = 0, failed = 0;

  for (const camp of CAMPAIGNS) {
    const campId = baseCampId + BigInt(camp.index);
    const metaCid = metaCids.get(camp.index);
    if (!metaCid) { console.log(`  [${camp.index}] SKIP — no metadata CID`); continue; }

    let bytes32: string;
    try {
      bytes32 = cidToBytes32(metaCid);
    } catch (e) {
      console.log(`  [${camp.index}] SKIP — CID conversion failed: ${e}`);
      failed++;
      continue;
    }

    const signer     = camp.signer === "bob" ? bob : charlie;
    const signerName = camp.signer;

    try {
      const nonce = await provider.getTransactionCount(signer.address);
      const data  = campIface.encodeFunctionData("setMetadata", [campId, bytes32]);
      await signer.sendTransaction({ to: campAddr, data, value: 0n, ...TX_OPTS });
      await waitNonce(provider, signer.address, nonce);
      ok++;
      console.log(`  [${camp.index}] OK   campaignId=${campId} (${signerName}) → ${metaCid}`);
    } catch (e) {
      failed++;
      console.log(`  [${camp.index}] FAIL campaignId=${campId}: ${String(e).slice(0, 120)}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Summary");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  SVG images uploaded:    ${imageCids.size}`);
  console.log(`  Metadata JSONs pinned:  ${metaCids.size}`);
  console.log(`  On-chain updates:       ${ok} OK, ${failed} failed`);
  console.log();
  console.log("  Campaign images summary:");
  for (const camp of CAMPAIGNS) {
    const label = camp.formats.length === 1
      ? camp.formats[0].padEnd(18)
      : `${camp.formats.length} formats`.padEnd(18);
    const cid = metaCids.get(camp.index) ?? "(none)";
    console.log(`    [${camp.index}] ${camp.article.padEnd(22)} ${label}  metadata → ${cid}`);
  }
  console.log();
  console.log("  Verify via local gateway:");
  for (const [idx, cid] of metaCids) {
    console.log(`    [${idx}] http://localhost:8080/ipfs/${cid}`);
  }
  console.log();
  console.log("  Public gateways (may take a few minutes to propagate):");
  for (const [, cid] of metaCids) {
    console.log(`    https://dweb.link/ipfs/${cid}`);
    break; // just show one example
  }
  console.log("  ...(see above for full list)\n");
}

main().catch(e => { console.error(e); process.exit(1); });
