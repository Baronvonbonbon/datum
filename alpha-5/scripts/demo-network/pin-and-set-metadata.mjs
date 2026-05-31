// pin-and-set-metadata.mjs — pin the generated SVGs to the local Kubo node, build
// one CampaignMetadata JSON per assigned campaign (referencing the per-format SVG
// URLs), pin that JSON (CIDv0), and call DatumCampaignCreative.setMetadata as the
// campaign's owning advertiser so the extension renders real creatives.
//
//   node pin-and-set-metadata.mjs --pin-only   # pin + build JSON + write CIDs, NO chain tx
//   node pin-and-set-metadata.mjs              # the above + setMetadata on-chain
//   node pin-and-set-metadata.mjs --limit 4    # only the first 4 assignments (chain)
//
// CIDs are written back into manifest.json (creatives + campaignMetadata) so the
// page generator + README pick them up. Idempotent: pinning is content-addressed;
// re-running setMetadata may hit the on-chain cooldown (E22) and is skipped.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { JsonRpcProvider, Wallet, Contract, Interface, decodeBase58, getBytes, hexlify } from "ethers";

const DIR = dirname(fileURLToPath(import.meta.url));
const ALPHA5 = resolve(DIR, "..", "..");
config({ path: resolve(ALPHA5, ".env") });

const args = process.argv.slice(2);
const PIN_ONLY = args.includes("--pin-only");
const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;

const manifest = JSON.parse(readFileSync(resolve(DIR, "manifest.json"), "utf8"));
const ADDR = JSON.parse(readFileSync(resolve(ALPHA5, "deployed-addresses.json"), "utf8"));
const RPC = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io";
const TX_OPTS = { gasLimit: 500000000n, type: 0, gasPrice: 1000000000000n };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CIDv0 ("Qm...") → 0x bytes32 (strip the 0x1220 multihash prefix). Mirrors web/src/shared/ipfs.ts.
function cidToBytes32(cid) {
  if (!cid.startsWith("Qm")) throw new Error("expected CIDv0 (Qm...), got " + cid);
  const hex = decodeBase58(cid).toString(16).padStart(68, "0");
  const bytes = getBytes("0x" + hex);
  if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) throw new Error("invalid CIDv0");
  return hexlify(bytes.slice(2));
}

// Pin bytes to the local Kubo node, CIDv0 so the digest fits bytes32.
async function pin(bytes, name, contentType) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: contentType }), name);
  const res = await fetch(`${manifest.ipfsApi}/api/v0/add?pin=true&cid-version=0`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`IPFS add failed (${res.status}) for ${name}: ${await res.text()}`);
  const j = JSON.parse((await res.text()).trim().split("\n").pop());
  if (!j.Hash) throw new Error("no CID in IPFS response for " + name);
  return j.Hash;
}

const gw = (cid) => manifest.gateway.replace(/\/+$/, "") + "/" + cid;

async function main() {
  // sanity: IPFS reachable
  const idr = await fetch(`${manifest.ipfsApi}/api/v0/id`, { method: "POST" }).catch(() => null);
  if (!idr || !idr.ok) throw new Error(`Kubo not reachable at ${manifest.ipfsApi} — start the daemon (ipfs-node/).`);

  // ── 1. Pin every SVG ────────────────────────────────────────────────────────
  manifest.creatives = manifest.creatives || {};
  let nsvg = 0;
  for (const b of manifest.brands) {
    manifest.creatives[b.id] = manifest.creatives[b.id] || {};
    for (const fmt of manifest.formats) {
      const svg = readFileSync(resolve(DIR, "creatives", b.id, `${fmt}.svg`));
      const cid = await pin(svg, `${b.id}-${fmt}.svg`, "image/svg+xml");
      manifest.creatives[b.id][fmt] = { cid, url: gw(cid) };
      nsvg++;
    }
    console.log(`  pinned ${manifest.formats.length} SVGs for ${b.id}`);
  }
  console.log(`✓ pinned ${nsvg} SVGs to ${manifest.ipfsApi}`);

  // ── 2. Build + pin per-campaign metadata JSON ───────────────────────────────
  const brandById = Object.fromEntries(manifest.brands.map((b) => [b.id, b]));
  manifest.campaignMetadata = manifest.campaignMetadata || {};
  const assignments = manifest.campaignAssignments.slice(0, LIMIT === Infinity ? undefined : LIMIT);

  for (const a of assignments) {
    const b = brandById[a.brand];
    const images = manifest.formats.map((f) => ({ format: f, url: manifest.creatives[b.id][f].url }));
    const meta = {
      title: b.name,
      description: b.text,
      category: `topic:${b.category}`,
      creative: {
        type: "text",
        text: b.text,
        cta: b.cta,
        ctaUrl: b.ctaUrl,
        imageUrl: manifest.creatives[b.id]["medium-rectangle"].url,
        images,
      },
      version: 1,
    };
    const cid = await pin(Buffer.from(JSON.stringify(meta)), `campaign-${a.campaignId}.json`, "application/json");
    const hash = cidToBytes32(cid);
    manifest.campaignMetadata[a.campaignId] = { brand: a.brand, advertiser: a.advertiser, cid, hash };
    console.log(`  campaign ${a.campaignId} (${a.brand}) → ${cid}`);
  }
  writeFileSync(resolve(DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`✓ pinned ${assignments.length} metadata JSONs; manifest updated`);

  if (PIN_ONLY) {
    console.log("\n--pin-only: skipping on-chain setMetadata.");
    return;
  }

  // ── 3. setMetadata on-chain as the owning advertiser ────────────────────────
  const provider = new JsonRpcProvider(RPC);
  const wallets = {}; // address(lower) → Wallet
  for (const adv of manifest.advertisers) {
    const key = process.env[`${adv.account}_PRIVATE_KEY`];
    if (key) wallets[adv.address.toLowerCase()] = new Wallet(key, provider);
  }
  const campaigns = new Contract(ADDR.campaigns, ["function getCampaignAdvertiser(uint256) view returns (address)"], provider);
  const ccIface = new Interface(["function setMetadata(uint256 campaignId, bytes32 metadataHash)"]);

  let ok = 0, skip = 0;
  for (const a of assignments) {
    const onchainAdv = (await campaigns.getCampaignAdvertiser(a.campaignId)).toLowerCase();
    const w = wallets[onchainAdv];
    if (!w) { console.warn(`  ⚠ campaign ${a.campaignId}: on-chain advertiser ${onchainAdv.slice(0, 10)} key not held — skip`); skip++; continue; }
    const hash = manifest.campaignMetadata[a.campaignId].hash;
    const data = ccIface.encodeFunctionData("setMetadata", [BigInt(a.campaignId), hash]);
    try {
      const nonce = await provider.getTransactionCount(w.address, "latest");
      const tx = await w.sendTransaction({ to: ADDR.campaignCreative, data, value: 0n, ...TX_OPTS });
      // Paseo: receipt may be null though mined → confirm via nonce advance.
      const deadline = Date.now() + 90000;
      let confirmed = false;
      while (Date.now() < deadline) {
        const r = await provider.getTransactionReceipt(tx.hash).catch(() => null);
        if (r) { if (Number(r.status) === 0) throw new Error("reverted"); confirmed = true; break; }
        if ((await provider.getTransactionCount(w.address, "latest")) > nonce) { confirmed = true; break; }
        await sleep(2500);
      }
      console.log(`  ✓ campaign ${a.campaignId} setMetadata (${a.brand}) ${confirmed ? "" : "(submitted)"} ${tx.hash}`);
      ok++;
    } catch (e) {
      const m = String(e?.message ?? e);
      console.warn(`  ⚠ campaign ${a.campaignId} setMetadata failed (${m.slice(0, 80)}) — likely cooldown/owner; skip`);
      skip++;
    }
  }
  console.log(`\n✓ setMetadata: ${ok} ok, ${skip} skipped. Gateway: ${manifest.gateway}`);
}

main().catch((e) => { console.error("\nFAILED:", e.message || e); process.exit(1); });
