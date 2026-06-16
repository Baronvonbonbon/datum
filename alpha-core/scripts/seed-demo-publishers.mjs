// seed-demo-publishers.mjs — Stage 2 of the 5-publisher demo.
//
// ADDITIVE (does NOT terminate existing campaigns): creates a couple of activated
// campaigns for each non-Diana publisher (eve/frank/grace/heidi) so every publisher
// in the demo has its own servable campaign pool. Diana already has her campaigns
// from reseed-demo. Each campaign is created closed (publisher = that address) with
// EMPTY requiredTags (no on-chain tag dependency), an IPFS creative, and is
// activated via AdminGovernance (Phase 0, instant). Run AFTER
// register-demo-publishers.mjs (publishers must be registered + delegated).
//
//   node scripts/seed-demo-publishers.mjs
//
// Re-run safe-ish: it always appends new campaigns, so run once.

import { JsonRpcProvider, Wallet, Interface, parseEther, ZeroAddress, getBytes, decodeBase58, hexlify } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const A = JSON.parse(readFileSync(resolve(ROOT, "deployed-addresses.json"), "utf8"));
const RPC = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
const GAS = { gasLimit: 900_000_000n, gasPrice: 1_000_000_000_000n, type: 0 };
const IPFS_GATEWAY = "https://ipfs-datum.javcon.io/ipfs/";

const alice = new Wallet("0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8");
const bob   = new Wallet("0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52");

// Each non-Diana publisher + the creative topics to give it (2 campaigns each).
const PLAN = [
  { name: "FinanceDaily", addr: "0xD633C470d075Af508f4895e21A986183fEf35745", topics: ["Polkadot", "Renewables"] },
  { name: "TechBlog",     addr: "0x92622970Bd48dD26c53bCCd09Aa6a0245dbc7620", topics: ["Open Source", "Zero-Knowledge"] },
  { name: "SportZone",    addr: "0xa9e2bd7Bd5a14E8add0023B4Ab56ed27BeABC92F", topics: ["Mountaineering", "Astronomy"] },
  { name: "GamingWorld",  addr: "0x1563915e194D8CfBA1943570603F7606A3115508", topics: ["Jazz", "Coffee"] },
];

// Creative configs (subset of reseed-demo.mjs, keyed by topic).
const CREATIVE = {
  "Polkadot":       { category: "Technology",   c1: "#552bbf", c2: "#e6007a", accent: "#ff2d9b", title: "Polkadot",        text: "One network. Many chains. Explore the multichain protocol securing a shared future.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Polkadot_(blockchain_platform)" },
  "Zero-Knowledge": { category: "Cryptography", c1: "#0f2027", c2: "#2c5364", accent: "#00d1b2", title: "Zero-Knowledge",  text: "Prove you know a secret without revealing it. The math behind private verification.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Zero-knowledge_proof" },
  "Open Source":    { category: "Software",     c1: "#11998e", c2: "#38ef7d", accent: "#0b6e4f", title: "Open Source",     text: "Code anyone can read, change, and share. The movement that runs the modern internet.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Open-source_software" },
  "Renewables":     { category: "Energy",       c1: "#2193b0", c2: "#6dd5ed", accent: "#1c6b86", title: "Renewable Energy", text: "Sun, wind, and water. How the world is rebuilding its power grid for the next century.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Renewable_energy" },
  "Coffee":         { category: "Food & Drink", c1: "#6f4e37", c2: "#b9936c", accent: "#3d2b1f", title: "Coffee",          text: "From bean to cup — a global ritual, a billion-dollar trade, and a very good morning.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Coffee" },
  "Jazz":           { category: "Music",        c1: "#41295a", c2: "#2f0743", accent: "#ff6e7f", title: "Jazz",            text: "Swing, bebop, and improvisation. The American art form that taught the world to listen.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Jazz" },
  "Astronomy":      { category: "Science",      c1: "#0b0b2b", c2: "#1b2a4a", accent: "#ffd86b", title: "Astronomy",       text: "Galaxies, exoplanets, and deep time. The oldest science, still asking the biggest questions.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Astronomy" },
  "Mountaineering": { category: "Outdoors",     c1: "#134e5e", c2: "#71b280", accent: "#0c3a47", title: "Mountaineering",  text: "Ridges, ropes, and thin air. The history and craft of climbing the world's high places.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Mountaineering" },
};

const p = new JsonRpcProvider(RPC);
const aliceS = alice.connect(p);
const bobS = bob.connect(p);
const iCamp = new Interface([
  "function nextCampaignId() view returns (uint256)",
  "function getCampaignStatus(uint256) view returns (uint8)",
  "function getCampaignRelaySigner(uint256) view returns (address)",
  "function createCampaign(address publisher, tuple(uint8 actionType,uint256 budgetWei,uint256 dailyCapWei,uint256 rateWei,address actionVerifier)[] pots, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)",
]);
const iRouter = new Interface(["function adminActivateCampaign(uint256 campaignId)"]);
const iCreative = new Interface(["function setMetadata(uint256 campaignId, bytes32 metadataHash)"]);
const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withRetry = async (fn, label, tries = 8) => { for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { if (i === tries - 1) throw e; await sleep(1500); } } };
const txCount = (addr) => withRetry(() => p.getTransactionCount(addr), "nonce");
async function call(to, iface, fn, args) { const raw = await withRetry(() => p.call({ to, data: iface.encodeFunctionData(fn, args) }), `call ${fn}`); return iface.decodeFunctionResult(fn, raw); }
async function send(signer, to, iface, fn, args, value = 0n) {
  const data = iface.encodeFunctionData(fn, args);
  const nonce = await txCount(signer.address);
  try { await signer.sendTransaction({ to, data, value, ...GAS, nonce }); } catch { /* verify via nonce */ }
  for (let i = 0; i < 90; i++) { if (await txCount(signer.address) > nonce) return; await sleep(2000); }
  throw new Error("nonce stuck: " + fn);
}
function ipfsAdd(content) {
  const r = spawnSync("ipfs", ["add", "-Q", "--cid-version=0", "--pin=true"], { input: content, encoding: "utf8" });
  if (r.status !== 0) throw new Error("ipfs add failed: " + (r.stderr || r.error));
  return r.stdout.trim();
}
function cidToBytes32(cid) {
  const b = getBytes("0x" + decodeBase58(cid).toString(16).padStart(68, "0"));
  if (b.length !== 34 || b[0] !== 0x12 || b[1] !== 0x20) throw new Error("not CIDv0");
  return hexlify(b.slice(2));
}
function svgFor(cfg) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const words = cfg.text.split(" ");
  const lines = []; let cur = "";
  for (const w of words) { if ((cur + " " + w).trim().length > 34) { lines.push(cur.trim()); cur = w; } else cur += " " + w; if (lines.length === 3) break; }
  if (cur.trim() && lines.length < 3) lines.push(cur.trim());
  const body = lines.map((l, i) => `<text x="22" y="${150 + i * 19}" font-size="12.5" fill="#ffffff" opacity="0.92">${esc(l)}</text>`).join("");
  const ctaW = Math.min(220, 30 + cfg.cta.length * 7.2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="250" viewBox="0 0 300 250" font-family="Segoe UI, Helvetica, Arial, sans-serif"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${cfg.c1}"/><stop offset="100%" stop-color="${cfg.c2}"/></linearGradient></defs><rect width="300" height="250" rx="14" fill="url(#bg)"/><circle cx="262" cy="44" r="70" fill="#ffffff" opacity="0.07"/><circle cx="40" cy="230" r="50" fill="#ffffff" opacity="0.05"/><text x="22" y="44" font-size="11" fill="#ffffff" opacity="0.7" letter-spacing="3">${esc(cfg.category.toUpperCase())}</text><text x="21" y="98" font-size="30" font-weight="700" fill="#ffffff">${esc(cfg.title)}</text>${body}<rect x="22" y="208" width="${ctaW.toFixed(0)}" height="30" rx="15" fill="${cfg.accent}"/><text x="${(22 + ctaW / 2).toFixed(0)}" y="227" font-size="12.5" font-weight="600" fill="#ffffff" text-anchor="middle">${esc(cfg.cta)} ↗</text><text x="278" y="244" font-size="9" fill="#ffffff" opacity="0.55" text-anchor="end">sponsored · DATUM</text></svg>`;
}

async function main() {
  const net = await withRetry(() => p.getNetwork(), "net");
  console.log(`seed-demo-publishers → ${RPC} (chain ${net.chainId})`);
  console.log(`  campaigns=${A.campaigns}  creative=${A.campaignCreative}  advertiser Bob ${bob.address}\n`);
  const cpm = parseEther("1");      // 1 PAS CPM → 0.001 PAS / impression
  const budget = parseEther("1");   // 1 PAS escrow per campaign
  const created = [];

  for (const pub of PLAN) {
    console.log(`[${pub.name}] ${pub.addr}`);
    for (const topic of pub.topics) {
      const cfg = CREATIVE[topic];
      const svgCid = ipfsAdd(svgFor(cfg));
      const cid = Number((await call(A.campaigns, iCamp, "nextCampaignId", []))[0]);
      const pot = { actionType: 0, budgetWei: budget, dailyCapWei: budget, rateWei: cpm, actionVerifier: ZeroAddress };
      await send(bobS, A.campaigns, iCamp, "createCampaign", [pub.addr, [pot], [], false, ZeroAddress, 0n, 0n], budget);
      const meta = { title: cfg.title, description: cfg.text, category: cfg.category, version: 1, creative: { type: "text", text: cfg.text, cta: cfg.cta, ctaUrl: cfg.wiki, imageUrl: svgCid } };
      const metaCid = ipfsAdd(JSON.stringify(meta));
      await send(bobS, A.campaignCreative, iCreative, "setMetadata", [cid, cidToBytes32(metaCid)]);
      await send(aliceS, A.governanceRouter, iRouter, "adminActivateCampaign", [cid]);
      const st = Number((await call(A.campaigns, iCamp, "getCampaignStatus", [cid]))[0]);
      const rs = (await call(A.campaigns, iCamp, "getCampaignRelaySigner", [cid]))[0];
      const ok = rs.toLowerCase() === "0xca5668fb864acab0ac7f4cfa73949174720b58d0";
      console.log(`    #${cid} ${cfg.title.padEnd(16)} ${STATUS[st]} relaySigner=${rs.slice(0, 8)}${ok ? "✓" : "✗"} meta=${metaCid.slice(0, 12)}`);
      created.push({ cid, publisher: pub.name, publisherAddr: pub.addr, topic, status: STATUS[st], relaySigner: rs, svgCid, metaCid });
    }
  }

  // Append to a sidecar manifest (does not touch reseed-demo's deployed-demo.json).
  const manifestPath = resolve(ROOT, "deployed-demo-publishers.json");
  const prev = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).campaigns ?? [] : [];
  writeFileSync(manifestPath, JSON.stringify({ at: new Date().toISOString(), gateway: IPFS_GATEWAY, campaigns: [...prev, ...created] }, null, 2));
  console.log(`\n=== done: ${created.length} campaigns created across ${PLAN.length} publishers ===`);
  console.log(`manifest → deployed-demo-publishers.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
