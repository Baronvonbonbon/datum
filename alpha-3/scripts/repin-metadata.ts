// repin-metadata.ts — Re-pin all 100 seeded campaign metadata JSONs to an IPFS node.
//
// Uses the same deterministic buildMetadata() logic as setup-testnet.ts, so the
// generated content is identical and produces the same CIDs.
//
// Usage:
//   npx ts-node scripts/repin-metadata.ts                           → Kubo at localhost:5001
//   npx ts-node scripts/repin-metadata.ts http://localhost:5001     → Kubo at custom URL
//   npx ts-node scripts/repin-metadata.ts selfhosted <api-key>      → ipfs-datum.javcon.io
//
// Kubo mode: multipart POST to /api/v0/add (requires CORS headers set on the daemon).
// Selfhosted mode: JSON POST to https://ipfs-datum.javcon.io/add with Bearer auth.
//   Get your API key from: Settings → IPFS → Upload API key field.
//
// After pinning in selfhosted mode, warms the gateway cache for all 100 CIDs so
// remote devices can fetch metadata immediately.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── LCG (must match setup-testnet.ts exactly) ────────────────────────────────

let _lcgState = 0xdeadbeef;
function lcg(): number { _lcgState = ((_lcgState * 1664525 + 1013904223) >>> 0); return _lcgState; }
function randFloat(): number { return lcg() / 0x100000000; }
function randInt(max: number): number { return Math.floor(randFloat() * max); }

// ── Topic taxonomy (must match setup-testnet.ts exactly) ─────────────────────

const TOPICS = [
  "topic:arts-entertainment", "topic:autos-vehicles", "topic:beauty-fitness",
  "topic:books-literature", "topic:business-industrial", "topic:computers-electronics",
  "topic:finance", "topic:food-drink", "topic:gaming", "topic:health",
  "topic:hobbies-leisure", "topic:home-garden", "topic:internet-telecom",
  "topic:jobs-education", "topic:law-government", "topic:news",
  "topic:online-communities", "topic:people-society", "topic:pets-animals",
  "topic:real-estate", "topic:reference", "topic:science", "topic:shopping",
  "topic:sports", "topic:travel", "topic:crypto-web3", "topic:defi",
  "topic:nfts", "topic:polkadot", "topic:daos-governance",
];

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

// ── Campaign specs (must match setup-testnet.ts exactly) ─────────────────────

const NUM_CAMPAIGNS = 100;
const CPM_MIN = 3_000_000_000n;   // parseDOT("0.3")
const CPM_RANGE = 4_000_000_000n; // parseDOT("0.4")

interface CampaignSpec { topicIndices: number[]; hasSidecar: boolean; wikiArticle: string; }

const CAMPAIGN_SPECS: CampaignSpec[] = [];
for (let i = 0; i < NUM_CAMPAIGNS; i++) {
  const _bidCpm = CPM_MIN + BigInt(Math.floor(randFloat() * Number(CPM_RANGE)));
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
  const hasSidecar = randFloat() < 0.20;
  const primaryIdx = topicIndices.length > 0 ? topicIndices[0] : randInt(TOPICS.length);
  const wikiList = TOPIC_WIKI[TOPICS[primaryIdx]];
  const wikiArticle = wikiList[randInt(wikiList.length)];
  CAMPAIGN_SPECS.push({ topicIndices, hasSidecar, wikiArticle });
}

// ── Metadata builder (must match setup-testnet.ts exactly) ───────────────────

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

// ── Kubo pin ─────────────────────────────────────────────────────────────────

async function pinToKubo(content: string, apiBase: string): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append("file", new Blob([content], { type: "application/json" }), "metadata.json");
    const resp = await fetch(`${apiBase}/api/v0/add?pin=true&cid-version=0`, {
      method: "POST",
      body: formData,
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`    Kubo error ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const json = await resp.json() as { Hash: string };
    return json.Hash;
  } catch (err) {
    console.error(`    fetch failed: ${String(err).slice(0, 150)}`);
    return null;
  }
}

// ── Selfhosted pin (ipfs-datum.javcon.io custom JSON proxy) ───────────────────

const SELFHOSTED_UPLOAD_URL = "https://ipfs-datum.javcon.io/add";
const SELFHOSTED_GATEWAY_URL = "https://ipfs-datum.javcon.io/ipfs/";

async function pinToSelfhosted(content: string, apiKey: string): Promise<string | null> {
  try {
    const resp = await fetch(SELFHOSTED_UPLOAD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: content,
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`    selfhosted error ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json() as Record<string, unknown>;
    const cid = (data.IpfsHash ?? data.cid ?? data.Hash ?? data.hash) as string | undefined;
    if (!cid) {
      console.error(`    selfhosted returned no CID: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    return cid;
  } catch (err) {
    console.error(`    fetch failed: ${String(err).slice(0, 150)}`);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Usage:
  //   npx ts-node scripts/repin-metadata.ts                           → Kubo at localhost:5001
  //   npx ts-node scripts/repin-metadata.ts http://localhost:5001     → Kubo at custom URL
  //   npx ts-node scripts/repin-metadata.ts selfhosted <api-key>      → ipfs-datum.javcon.io
  const arg1 = process.argv[2]?.trim() ?? "";
  const isSelfhosted = arg1 === "selfhosted";
  const selfhostedKey = isSelfhosted ? (process.argv[3]?.trim() ?? "") : "";

  if (isSelfhosted && !selfhostedKey) {
    console.error("Usage: npx ts-node scripts/repin-metadata.ts selfhosted <api-key>");
    process.exitCode = 1;
    return;
  }

  const apiBase = isSelfhosted ? SELFHOSTED_UPLOAD_URL : (arg1 || "http://localhost:5001");
  console.log(`\nRepin metadata — ${isSelfhosted ? `selfhosted (${SELFHOSTED_UPLOAD_URL})` : `Kubo API: ${apiBase}`}`);
  console.log(`Campaigns: ${NUM_CAMPAIGNS}\n`);

  // Load existing CID reference for verification
  const cidsFile = path.join(__dirname, "metadata-cids.json");
  const existing: Array<{ campaignIndex: number; wikiArticle: string; bytes32: string; cid: string | null }> =
    fs.existsSync(cidsFile) ? JSON.parse(fs.readFileSync(cidsFile, "utf-8")) : [];
  const existingByIndex = new Map(existing.map(r => [r.campaignIndex, r]));

  const results: typeof existing = [];
  let pinOk = 0;
  let pinFail = 0;
  let cidMismatch = 0;
  let bytes32Mismatch = 0;

  for (let i = 0; i < CAMPAIGN_SPECS.length; i++) {
    const spec = CAMPAIGN_SPECS[i];
    const primaryIdx = spec.topicIndices.length > 0 ? spec.topicIndices[0] : i % TOPICS.length;
    const primaryTopic = TOPICS[primaryIdx];
    const content = buildMetadata(primaryTopic, spec.wikiArticle, i);
    const bytes32 = contentToBytes32(content);

    // Verify bytes32 matches what was stored on-chain
    const ref = existingByIndex.get(i);
    if (ref && ref.bytes32 !== bytes32) {
      console.warn(`[${i}] bytes32 MISMATCH — expected ${ref.bytes32.slice(0, 10)}… got ${bytes32.slice(0, 10)}… (article: ${spec.wikiArticle})`);
      bytes32Mismatch++;
    }

    process.stdout.write(`[${String(i + 1).padStart(3)}/${NUM_CAMPAIGNS}] ${spec.wikiArticle.padEnd(36)} `);
    const cid = isSelfhosted ? await pinToSelfhosted(content, selfhostedKey) : await pinToKubo(content, apiBase);

    if (cid) {
      pinOk++;
      // Verify CID matches reference
      if (ref?.cid && ref.cid !== cid) {
        console.warn(`CID MISMATCH — ref=${ref.cid} got=${cid}`);
        cidMismatch++;
      } else {
        process.stdout.write(`→ ${cid}\n`);
      }
    } else {
      pinFail++;
      process.stdout.write(`→ FAILED\n`);
    }

    results.push({ campaignIndex: i, wikiArticle: spec.wikiArticle, bytes32, cid });
  }

  // Overwrite cids file with fresh results (updates null → real CID for newly pinned items)
  fs.writeFileSync(cidsFile, JSON.stringify(results, null, 2));
  console.log(`\nUpdated ${cidsFile}`);

  console.log(`\n─── Summary ───────────────────────────────────`);
  console.log(`  Pinned:          ${pinOk}/${NUM_CAMPAIGNS}`);
  console.log(`  Failed:          ${pinFail}`);
  console.log(`  bytes32 mismatches: ${bytes32Mismatch} (0 = ✓ content is identical)`);
  console.log(`  CID mismatches:  ${cidMismatch} (0 = ✓ same content as before)`);

  if (pinOk > 0) {
    const pinnedCids = results.filter(r => r.cid).map(r => r.cid!);

    if (isSelfhosted) {
      // Warm the selfhosted gateway cache for all 100 CIDs — these are already pinned
      // on the node so HEAD requests will resolve immediately.
      console.log(`\nWarming selfhosted gateway cache for all ${pinnedCids.length} CIDs...`);
      let warmed = 0;
      for (const cid of pinnedCids) {
        fetch(`${SELFHOSTED_GATEWAY_URL}${cid}`, { method: "HEAD" }).then(() => { warmed++; }).catch(() => {/* best-effort */});
      }
      // Give the fire-and-forgets a moment to fire before the process exits
      await new Promise(res => setTimeout(res, 1500));
      console.log(`  Sent HEAD requests for ${pinnedCids.length} CIDs to ${SELFHOSTED_GATEWAY_URL}`);
      console.log(`  Remote devices can now fetch metadata via ${SELFHOSTED_GATEWAY_URL}<cid>`);
    } else {
      // Seed public gateway caches so remote devices can fetch via DHT
      console.log(`\nSeeding public gateway caches (fire-and-forget)...`);
      const PUBLIC_GATEWAYS = ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/", "https://dweb.link/ipfs/"];
      const sampleCids = [
        pinnedCids[0],
        pinnedCids[Math.floor(pinnedCids.length / 2)],
        pinnedCids[pinnedCids.length - 1],
      ].filter(Boolean);
      for (const cid of sampleCids) {
        for (const gw of PUBLIC_GATEWAYS) {
          fetch(`${gw}${cid}`, { method: "HEAD" }).catch(() => {/* best-effort */});
        }
      }
      console.log(`  Seeded ${sampleCids.length} sample CIDs across ${PUBLIC_GATEWAYS.length} gateways`);
      console.log(`\nIf your node is publicly reachable (port 4001 open), gateways will`);
      console.log(`find the rest of the content via DHT within a few minutes.`);
    }
  }

  if (pinFail > 0) {
    console.log(`\nTroubleshooting:`);
    if (isSelfhosted) {
      console.log(`  - Check API key is correct (Settings → IPFS Upload API key)`);
      console.log(`  - Check node is up:     curl -I https://ipfs-datum.javcon.io/ipfs/`);
    } else {
      console.log(`  - Is Kubo running?      ipfs daemon`);
      console.log(`  - CORS enabled?         ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'`);
      console.log(`  - Custom endpoint?      npx ts-node scripts/repin-metadata.ts http://localhost:5001`);
      console.log(`  - Pin to selfhosted?    npx ts-node scripts/repin-metadata.ts selfhosted <api-key>`);
    }
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
