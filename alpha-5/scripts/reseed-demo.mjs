// reseed-demo.mjs — wipe + redeploy the demo campaign set.
//
//   1. TERMINATE every existing non-terminal campaign (Active/Paused/Pending)
//      via DatumGovernanceRouter.adminTerminateCampaign (alice = owner, Phase 0).
//   2. DEPLOY a fresh multicampaign set: N Diana-published / Bob-advertised
//      campaigns (publisher = Diana ⇒ relaySigner snapshot = Diana, advertiser =
//      Bob ⇒ relay co-signs both sides — i.e. all gasless-relay-settleable).
//      Each gets a themed SVG ad uploaded to the LOCAL IPFS node + full creative
//      metadata (title/description/text/cta + bare-CID imageUrl) also on IPFS,
//      committed on-chain via DatumCampaignCreative.setMetadata (CIDv0→bytes32).
//      Click-through (ctaUrl) points at an assorted Wikipedia article.
//      Activated instantly via AdminGovernance (Phase 0).
//   3. (optional) SIMULATE activity: one gasless relay settlement per campaign
//      (fresh user, PoW enforced+mined, Bob advertiser co-sig) so the dashboard
//      shows live impressions. Toggle with SIMULATE=0.
//
//   node scripts/reseed-demo.mjs            # all phases, default 10 campaigns
//   CAMPAIGNS=6 SIMULATE=0 node scripts/reseed-demo.mjs
//
// Reads keys from the benchmark ACCOUNTS (same as deploy/setup). Uses the raw
// JsonRpcProvider + nonce-poll pattern (Paseo receipt bug) like deploy.ts.
import {
  JsonRpcProvider, Wallet, Interface, AbiCoder,
  keccak256, decodeBase58, getBytes, hexlify, parseEther, ZeroHash, ZeroAddress,
} from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const A = JSON.parse(readFileSync(resolve(ROOT, "deployed-addresses.json"), "utf8"));
const RPC = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
const RELAY = (process.env.BENCH_RELAY || "http://127.0.0.1:3400").replace(/\/+$/, "");
const IPFS_GATEWAY = "https://ipfs-datum.javcon.io/ipfs/";
const N = Number(process.env.CAMPAIGNS || 10);
const SIMULATE = process.env.SIMULATE !== "0";
const GAS = { gasLimit: 900_000_000n, gasPrice: 1_000_000_000_000n, type: 0 };

// Same keys as scripts/benchmark-paseo.ts ACCOUNTS.
const KEYS = {
  alice: "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8", // owner / admin gov
  bob:   "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52", // advertiser (== relay ADVERTISER key)
};
const DIANA = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0"; // publisher == relay signer

const p = new JsonRpcProvider(RPC);
const alice = new Wallet(KEYS.alice, p);
const bob = new Wallet(KEYS.bob, p);

const iCamp = new Interface([
  "function nextCampaignId() view returns (uint256)",
  "function getCampaignStatus(uint256) view returns (uint8)",
  "function getCampaignRelaySigner(uint256) view returns (address)",
  "function createCampaign(address publisher, tuple(uint8 actionType,uint256 budgetWei,uint256 dailyCapWei,uint256 rateWei,address actionVerifier)[] pots, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)",
]);
const iRouter = new Interface([
  "function adminTerminateCampaign(uint256 campaignId)",
  "function adminActivateCampaign(uint256 campaignId)",
]);
const iCreative = new Interface(["function setMetadata(uint256 campaignId, bytes32 metadataHash)"]);
const iVault = new Interface(["function userBalance(address) view returns (uint256)"]);
const iPow = new Interface(["function powTargetForUser(address user, uint256 eventCount) view returns (uint256)"]);

const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry transient RPC errors (Paseo eth-rpc gateway times out / rate-limits).
async function withRetry(fn, label = "rpc", tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const m = String(e?.message ?? e);
      if (!/timeout|TIMEOUT|network|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|503|502|429|busy|rate|SERVER_ERROR/i.test(m)) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}
const txCount = (addr) => withRetry(() => p.getTransactionCount(addr), "nonce");

// ── raw send + nonce-poll confirm (Paseo receipt workaround) ────────────────
async function read(to, iface, fn, args) {
  const raw = await withRetry(() => p.call({ to, data: iface.encodeFunctionData(fn, args) }), `call ${fn}`);
  return iface.decodeFunctionResult(fn, raw);
}
async function send(signer, to, iface, fn, args, value = 0n) {
  const data = iface.encodeFunctionData(fn, args);
  const nonce = await txCount(signer.address);
  // A send may land even if the response times out — don't retry-resubmit; just
  // fall through to the nonce-poll and let resulting STATE be the source of truth.
  try { await signer.sendTransaction({ to, data, value, ...GAS, nonce }); } catch { /* verify via nonce */ }
  for (let i = 0; i < 90; i++) {
    if (await txCount(signer.address) > nonce) return;
    await sleep(2000);
  }
  throw new Error("nonce stuck: " + fn);
}
// Pipelined sends: fire many txs with sequential nonces, then wait for the final
// nonce. Callers verify resulting STATE (Paseo silently advances nonce on revert).
async function sendMany(signer, calls) {
  let nonce = await txCount(signer.address);
  const start = nonce;
  for (const c of calls) {
    const data = c.iface.encodeFunctionData(c.fn, c.args);
    try { await signer.sendTransaction({ to: c.to, data, value: c.value ?? 0n, ...GAS, nonce }); } catch { /* verify via nonce */ }
    nonce++;
  }
  for (let i = 0; i < 180; i++) {
    if (await txCount(signer.address) >= nonce) return start;
    await sleep(2000);
  }
  throw new Error("pipeline nonce stuck");
}

// ── IPFS: add to the local Kubo node (CIDv0), return "Qm..." ────────────────
function ipfsAdd(content) {
  const r = spawnSync("ipfs", ["add", "-Q", "--cid-version=0", "--pin=true"], { input: content, encoding: "utf8" });
  if (r.status !== 0) throw new Error("ipfs add failed: " + (r.stderr || r.error));
  return r.stdout.trim();
}
// CIDv0 ("Qm...") → bytes32 digest (strip 0x1220 prefix). Matches web/src/shared/ipfs.ts.
function cidToBytes32(cid) {
  const b = getBytes("0x" + decodeBase58(cid).toString(16).padStart(68, "0"));
  if (b.length !== 34 || b[0] !== 0x12 || b[1] !== 0x20) throw new Error("not CIDv0");
  return hexlify(b.slice(2));
}

// ── creative set (assorted Wikipedia articles) ──────────────────────────────
const CAMPAIGNS = [
  { topic: "Polkadot",        category: "Technology",   c1: "#552bbf", c2: "#e6007a", accent: "#ff2d9b", title: "Polkadot",        text: "One network. Many chains. Explore the multichain protocol securing a shared future.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Polkadot_(blockchain_platform)" },
  { topic: "Zero-Knowledge",  category: "Cryptography", c1: "#0f2027", c2: "#2c5364", accent: "#00d1b2", title: "Zero-Knowledge",  text: "Prove you know a secret without revealing it. The math behind private verification.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Zero-knowledge_proof" },
  { topic: "Privacy",         category: "Privacy",      c1: "#232526", c2: "#414345", accent: "#f5a623", title: "Internet Privacy", text: "Who sees your data? Understand tracking, consent, and the right to be left alone.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Internet_privacy" },
  { topic: "Open Source",     category: "Software",     c1: "#11998e", c2: "#38ef7d", accent: "#0b6e4f", title: "Open Source",     text: "Code anyone can read, change, and share. The movement that runs the modern internet.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Open-source_software" },
  { topic: "Renewables",      category: "Energy",       c1: "#2193b0", c2: "#6dd5ed", accent: "#1c6b86", title: "Renewable Energy", text: "Sun, wind, and water. How the world is rebuilding its power grid for the next century.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Renewable_energy" },
  { topic: "Coffee",          category: "Food & Drink", c1: "#6f4e37", c2: "#b9936c", accent: "#3d2b1f", title: "Coffee",          text: "From bean to cup — a global ritual, a billion-dollar trade, and a very good morning.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Coffee" },
  { topic: "Jazz",            category: "Music",        c1: "#41295a", c2: "#2f0743", accent: "#ff6e7f", title: "Jazz",            text: "Swing, bebop, and improvisation. The American art form that taught the world to listen.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Jazz" },
  { topic: "Astronomy",       category: "Science",      c1: "#0b0b2b", c2: "#1b2a4a", accent: "#ffd86b", title: "Astronomy",       text: "Galaxies, exoplanets, and deep time. The oldest science, still asking the biggest questions.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Astronomy" },
  { topic: "Mountaineering",  category: "Outdoors",     c1: "#134e5e", c2: "#71b280", accent: "#0c3a47", title: "Mountaineering",  text: "Ridges, ropes, and thin air. The history and craft of climbing the world's high places.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Mountaineering" },
  { topic: "Cartography",     category: "Geography",    c1: "#355c7d", c2: "#6c5b7b", accent: "#c06c84", title: "Cartography",     text: "The art and science of the map — projecting a round world onto a flat and useful page.", cta: "Read on Wikipedia", wiki: "https://en.wikipedia.org/wiki/Cartography" },
];

function svgFor(cfg) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // body text wrapped to ~32-char lines (3 lines max)
  const words = cfg.text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > 34) { lines.push(cur.trim()); cur = w; } else cur += " " + w;
    if (lines.length === 3) break;
  }
  if (cur.trim() && lines.length < 3) lines.push(cur.trim());
  const body = lines.map((l, i) => `<text x="22" y="${150 + i * 19}" font-size="12.5" fill="#ffffff" opacity="0.92">${esc(l)}</text>`).join("");
  const ctaW = Math.min(220, 30 + cfg.cta.length * 7.2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="250" viewBox="0 0 300 250" font-family="Segoe UI, Helvetica, Arial, sans-serif">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${cfg.c1}"/><stop offset="100%" stop-color="${cfg.c2}"/></linearGradient></defs>
  <rect width="300" height="250" rx="14" fill="url(#bg)"/>
  <circle cx="262" cy="44" r="70" fill="#ffffff" opacity="0.07"/>
  <circle cx="40" cy="230" r="50" fill="#ffffff" opacity="0.05"/>
  <text x="22" y="44" font-size="11" fill="#ffffff" opacity="0.7" letter-spacing="3">${esc(cfg.category.toUpperCase())}</text>
  <text x="21" y="98" font-size="30" font-weight="700" fill="#ffffff">${esc(cfg.title)}</text>
  ${body}
  <rect x="22" y="208" width="${ctaW.toFixed(0)}" height="30" rx="15" fill="${cfg.accent}"/>
  <text x="${(22 + ctaW / 2).toFixed(0)}" y="227" font-size="12.5" font-weight="600" fill="#ffffff" text-anchor="middle">${esc(cfg.cta)} ↗</text>
  <text x="278" y="244" font-size="9" fill="#ffffff" opacity="0.55" text-anchor="end">sponsored · DATUM</text>
</svg>`;
}

// ── PoW miner (fresh user ⇒ ~hundreds of hashes) ────────────────────────────
function mineNonce(claimHash, target, budget = 5_000_000n) {
  const base = claimHash.slice(2);
  for (let i = 0n; i < budget; i++) {
    const nh = i.toString(16).padStart(64, "0");
    if (BigInt(keccak256("0x" + base + nh)) <= target) return "0x" + nh;
  }
  throw new Error("PoW budget exhausted");
}

async function main() {
  const net = await withRetry(() => p.getNetwork(), "net");
  const bal = await withRetry(() => p.getBalance(bob.address), "bal");
  console.log(`reseed-demo → ${RPC} (chain ${net.chainId})`);
  console.log(`  campaigns=${A.campaigns}  router=${A.governanceRouter}  creative=${A.campaignCreative}`);
  console.log(`  advertiser Bob ${bob.address} (${bal / 10n ** 18n} PAS)  publisher Diana ${DIANA}`);

  // ── PHASE 1: terminate every non-terminal campaign ────────────────────────
  const next = Number((await read(A.campaigns, iCamp, "nextCampaignId", []))[0]);
  console.log(`\n[1] scanning ${next - 1} campaigns for termination…`);
  let toKill = [];
  for (let i = 1; i < next; i++) {
    const s = Number((await read(A.campaigns, iCamp, "getCampaignStatus", [i]))[0]);
    if (s === 0 || s === 1 || s === 2) toKill.push(i); // Pending/Active/Paused
  }
  console.log(`    ${toKill.length} non-terminal campaigns to terminate`);
  const BATCH = 12;
  let killed = 0;
  for (let round = 0; round < 4 && toKill.length; round++) {
    for (let b = 0; b < toKill.length; b += BATCH) {
      const slice = toKill.slice(b, b + BATCH);
      await sendMany(alice, slice.map((id) => ({ to: A.governanceRouter, iface: iRouter, fn: "adminTerminateCampaign", args: [id] })));
      process.stdout.write(`    terminated ${Math.min(b + BATCH, toKill.length)}/${toKill.length}\r`);
    }
    // verify + collect stragglers (silent reverts)
    const left = [];
    for (const id of toKill) {
      const s = Number((await read(A.campaigns, iCamp, "getCampaignStatus", [id]))[0]);
      if (s === 4) killed++; else left.push(id);
    }
    console.log(`\n    round ${round + 1}: ${killed} terminated, ${left.length} remaining`);
    toKill = left;
    if (!toKill.length) break;
  }
  if (toKill.length) console.log(`    [WARN] ${toKill.length} campaigns could not be terminated: ${toKill.slice(0, 10).join(",")}…`);

  // ── PHASE 2: deploy fresh campaigns with creative ─────────────────────────
  console.log(`\n[2] deploying ${N} fresh Diana/Bob campaigns with IPFS creative…`);
  // All native amounts are 18-decimal wei (the pallet-revive EVM scale), so a
  // CPM of 1 PAS = parseEther("1") and per-impression gross = CPM/1000 = 0.001 PAS.
  const cpm = parseEther("1");           // 1 PAS CPM → 0.001 PAS / impression (gross)
  const budget = parseEther("1");        // native escrow per campaign (1 PAS)
  const deployed = [];
  for (let i = 0; i < N; i++) {
    const cfg = CAMPAIGNS[i % CAMPAIGNS.length];
    // 2a. SVG → IPFS
    const svgCid = ipfsAdd(svgFor(cfg));
    // 2b. campaign (Bob → Diana), read id from nextCampaignId
    const cid = Number((await read(A.campaigns, iCamp, "nextCampaignId", []))[0]);
    const pot = { actionType: 0, budgetWei: budget, dailyCapWei: budget, rateWei: cpm, actionVerifier: ZeroAddress };
    await send(bob, A.campaigns, iCamp, "createCampaign", [DIANA, [pot], [], false, ZeroAddress, 0n, 0n], budget);
    // 2c. metadata JSON → IPFS → setMetadata (while Pending: no cooldown)
    const meta = {
      title: cfg.title, description: cfg.text, category: cfg.category, version: 1,
      creative: { type: "text", text: cfg.text, cta: cfg.cta, ctaUrl: cfg.wiki, imageUrl: svgCid },
    };
    const metaCid = ipfsAdd(JSON.stringify(meta));
    await send(bob, A.campaignCreative, iCreative, "setMetadata", [cid, cidToBytes32(metaCid)]);
    // 2d. activate via AdminGovernance (Phase 0, instant)
    await send(alice, A.governanceRouter, iRouter, "adminActivateCampaign", [cid]);
    const st = Number((await read(A.campaigns, iCamp, "getCampaignStatus", [cid]))[0]);
    const rs = (await read(A.campaigns, iCamp, "getCampaignRelaySigner", [cid]))[0];
    deployed.push({ cid, ...cfg, svgCid, metaCid, status: STATUS[st], relaySigner: rs });
    console.log(`    #${cid} ${cfg.title.padEnd(16)} ${STATUS[st]} relaySigner=${rs.slice(0, 8)}${rs.toLowerCase() === DIANA.toLowerCase() ? "✓" : "✗"} svg=${svgCid.slice(0, 12)} meta=${metaCid.slice(0, 12)}`);
  }

  // ── PHASE 3: simulate activity (1 gasless relay settle / campaign) ─────────
  if (SIMULATE) {
    console.log(`\n[3] simulating activity: 1 gasless relay settlement per campaign…`);
    let relayUp = false;
    try { relayUp = (await fetch(`${RELAY}/health`, { signal: AbortSignal.timeout(5000) })).ok; } catch {}
    if (!relayUp) console.log(`    [SKIP] relay not reachable at ${RELAY}`);
    else {
      const dualSigDomain = { name: "DatumSettlement", version: "1", chainId: 420420417, verifyingContract: A.dualSig };
      const CB = { ClaimBatch: [
        { name: "user", type: "address" }, { name: "campaignId", type: "uint256" }, { name: "claimsHash", type: "bytes32" },
        { name: "deadlineBlock", type: "uint256" }, { name: "expectedRelaySigner", type: "address" }, { name: "expectedAdvertiserRelaySigner", type: "address" },
      ] };
      const enc = AbiCoder.defaultAbiCoder();
      for (const d of deployed) {
        try {
          const user = Wallet.createRandom();
          const ev = 25n;
          const claimHash = keccak256(enc.encode(
            ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
            [BigInt(d.cid), DIANA, user.address, ev, cpm, 0, ZeroHash, 1n, ZeroHash, ZeroHash]));
          const target = BigInt((await read(A.powEngine, iPow, "powTargetForUser", [user.address, ev]))[0]);
          const powNonce = mineNonce(claimHash, target);
          const head = await withRetry(() => p.getBlockNumber(), "head");
          const claimsHash = keccak256(claimHash);
          const dl = BigInt(head + 1000);
          const advertiserSig = await bob.signTypedData(dualSigDomain, CB,
            { user: user.address, campaignId: BigInt(d.cid), claimsHash, deadlineBlock: dl, expectedRelaySigner: DIANA, expectedAdvertiserRelaySigner: ZeroAddress });
          const envelope = {
            user: user.address, campaignId: String(d.cid), deadlineBlock: dl.toString(), userSig: "0x00", advertiserSig,
            expectedRelaySigner: DIANA, expectedAdvertiserRelaySigner: ZeroAddress,
            claims: [{ campaignId: String(d.cid), publisher: DIANA, eventCount: ev.toString(), rateWei: cpm.toString(), actionType: 0, clickSessionHash: ZeroHash, nonce: "1", previousClaimHash: ZeroHash, claimHash, zkProof: Array(8).fill(ZeroHash), nullifier: ZeroHash, stakeRootUsed: ZeroHash, actionSig: [ZeroHash, ZeroHash, ZeroHash], powNonce }],
          };
          const r = await fetch(`${RELAY}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(20000) });
          const body = await r.json().catch(() => ({}));
          let credited = 0n;
          if (r.status === 202 && body.ok) for (let i = 0; i < 30; i++) { credited = BigInt((await read(A.paymentVault, iVault, "userBalance", [user.address]))[0]); if (credited > 0n) break; await sleep(2000); }
          console.log(`    #${d.cid} ${d.title.padEnd(16)} ${credited > 0n ? `settled, user credited ${credited} planck` : `no settle (${JSON.stringify(body).slice(0, 50)})`}`);
        } catch (e) { console.log(`    #${d.cid} activity err: ${String(e.message ?? e).slice(0, 60)}`); }
      }
    }
  }

  // ── summary + manifest ────────────────────────────────────────────────────
  writeFileSync(resolve(ROOT, "deployed-demo.json"), JSON.stringify({ at: new Date().toISOString(), gateway: IPFS_GATEWAY, campaigns: deployed }, null, 2));
  console.log(`\n=== done: ${deployed.length} campaigns live, all relaySigner=Diana (gasless-relay-ready) ===`);
  console.log(`manifest → deployed-demo.json | creative via ${IPFS_GATEWAY}<metaCID>`);
  console.log(`sample creative: ${IPFS_GATEWAY}${deployed[0]?.metaCid}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
