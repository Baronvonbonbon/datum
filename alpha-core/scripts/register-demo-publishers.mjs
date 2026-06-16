// register-demo-publishers.mjs — Stage 1 of the 5-publisher demo.
//
// Registers the four non-Diana demo publishers (eve/frank/grace/heidi) and
// delegates each one's on-chain relaySigner → Diana's address. The live relay
// (relay.javcon.io) signs publisher cosigs with Diana's key; DatumDualSigSettlement
// verifies that cosig against publishers.relaySigner(campaignPublisher) LIVE, so
// once these four delegate to Diana, the single Diana relay can settle claims for
// all five publishers. Idempotent: skips already-registered / already-delegated.
//
//   node scripts/register-demo-publishers.mjs

import { JsonRpcProvider, Wallet, Interface } from "ethers";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const A = JSON.parse(readFileSync(resolve(ROOT, "deployed-addresses.json"), "utf8"));
const RPC = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
const GAS = { gasLimit: 900_000_000n, gasPrice: 1_000_000_000_000n, type: 0 };

const DIANA = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
// Keys + take-rate bps mirror alpha-core/scripts/setup-demo.ts (Paseo test keys).
const PUBLISHERS = [
  { name: "FinanceDaily", key: "0x22adcf911646ca05279aa42b03dcabae2610417af459be43c2ba37f869c15914", takeBps: 4000 },
  { name: "TechBlog",     key: "0xd8947fdc847ae7e902cf126b449cb8d9e7a9becdd0816397eaeb3b046d77986c", takeBps: 4500 },
  { name: "SportZone",    key: "0xdfafb7d12292bad165e40ba13bd2254f91123b656f991e3f308e5ccbcfc6a235", takeBps: 4000 },
  { name: "GamingWorld",  key: "0x2222222222222222222222222222222222222222222222222222222222222222", takeBps: 3500 },
];

const p = new JsonRpcProvider(RPC);
const iPub = new Interface([
  "function registerPublisher(uint16 takeRateBps)",
  "function setRelaySigner(address signer)",
  "function relaySigner(address) view returns (address)",
  "function getPublisher(address) view returns (tuple(address addr,uint256 takeRateBps,bool registered))",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withRetry = async (fn, label, tries = 8) => {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { if (i === tries - 1) throw e; await sleep(1500); }
  }
};
const txCount = (addr) => withRetry(() => p.getTransactionCount(addr), "nonce");
async function read(to, fn, args) {
  const raw = await withRetry(() => p.call({ to, data: iPub.encodeFunctionData(fn, args) }), `call ${fn}`);
  return iPub.decodeFunctionResult(fn, raw);
}
// Paseo silently advances the nonce on revert and getTransactionReceipt is flaky,
// so we fire, poll the nonce, then verify resulting STATE (never retry-resubmit).
async function send(signer, fn, args) {
  const data = iPub.encodeFunctionData(fn, args);
  const nonce = await txCount(signer.address);
  try { await signer.sendTransaction({ to: A.publishers, data, ...GAS, nonce }); } catch { /* verify via nonce */ }
  for (let i = 0; i < 90; i++) { if (await txCount(signer.address) > nonce) return; await sleep(2000); }
  throw new Error("nonce stuck: " + fn);
}

async function main() {
  const net = await withRetry(() => p.getNetwork(), "net");
  console.log(`register-demo-publishers → ${RPC} (chain ${net.chainId})`);
  console.log(`  publishers=${A.publishers}  delegate relaySigner → Diana ${DIANA}\n`);

  // All four are already registered publishers; they only lack the relaySigner
  // delegation. (registerPublisher reverts "Already registered".) So just delegate.
  for (const { name, key } of PUBLISHERS) {
    const w = new Wallet(key, p);
    const addr = w.address;
    const cur = (await read(A.publishers, "relaySigner", [addr]))[0];
    if (cur.toLowerCase() === DIANA.toLowerCase()) {
      console.log(`  ${name.padEnd(13)} ${addr}  relaySigner already → Diana`);
      continue;
    }
    await send(w, "setRelaySigner", [DIANA]);
    const now = (await read(A.publishers, "relaySigner", [addr]))[0];
    console.log(`  ${name.padEnd(13)} ${addr}  relaySigner → ${now}  ${now.toLowerCase() === DIANA.toLowerCase() ? "✓" : "✗ FAILED"}`);
  }
  console.log(`\n=== done ===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
