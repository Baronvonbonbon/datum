// set-relay-signers.mjs — point the demo publishers' on-chain relaySigner at the
// demo relay (Diana), so the single gasless relay can settle their campaigns via
// DatumDualSigSettlement.settleSignedClaims. This is the production mechanism by
// which a publisher authorizes a relay provider (DatumPublishers.setRelaySigner);
// the demo just has all its publishers appoint the one demo relay ("shared relay
// service" model). Idempotent: skips a publisher already pointing at Diana.
//
//   node set-relay-signers.mjs --dry   # preview, no txs
//   node set-relay-signers.mjs         # apply
//
// Diana (RELAY signer) keeps relaySigner = 0 (self) — the relay co-signs as her
// own publisher wallet for her own campaigns.
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const ALPHA5 = resolve(DIR, "..", "..");
config({ path: resolve(ALPHA5, ".env") });

const DRY = process.argv.includes("--dry");
const ADDR = JSON.parse(readFileSync(resolve(ALPHA5, "deployed-addresses.json"), "utf8"));
const RPC = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io";
const GAS_PRICE = 1_000_000_000_000n;
const GAS_CAP = 16_000_000n;

// Publishers to point at Diana. Diana herself stays self (she IS the relay).
const PUBLISHERS = ["EVE", "FRANK", "GRACE", "HANK", "IRIS"];

const provider = new JsonRpcProvider(RPC);
const diana = new Wallet(process.env.DIANA_PRIVATE_KEY).address;

const PUB_ABI = [
  "function relaySigner(address) view returns (address)",
  "function getPublisher(address) view returns (tuple(bool registered,uint16 takeRateBps,address relaySigner,bytes32 profileHash))",
  "function setRelaySigner(address signer)",
];
const iface = new Contract(ADDR.publishers, PUB_ABI, provider);

async function send(label, wallet, data) {
  if (DRY) { console.log(`  [dry] ${label}`); return; }
  const txReq = { to: ADDR.publishers, data, type: 0, gasPrice: GAS_PRICE };
  let gasLimit = GAS_CAP;
  try { const est = await wallet.estimateGas(txReq); gasLimit = est * 2n < GAS_CAP ? est * 2n : GAS_CAP; } catch {}
  const nonceBefore = await provider.getTransactionCount(wallet.address);
  await wallet.sendTransaction({ ...txReq, gasLimit });
  for (let i = 0; i < 60; i++) {
    if (await provider.getTransactionCount(wallet.address) > nonceBefore) { console.log(`  ✓ ${label}`); return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  ? ${label} (no nonce advance after 120s — check explorer)`);
}

console.log(`Relay (Diana): ${diana}`);
console.log(`Publishers contract: ${ADDR.publishers}`);
console.log(DRY ? "DRY RUN — no transactions\n" : "APPLYING\n");

for (const name of PUBLISHERS) {
  const key = process.env[`${name}_PRIVATE_KEY`];
  if (!key) { console.log(`${name}: no key in .env — skipped`); continue; }
  const wallet = new Wallet(key, provider);
  const p = await iface.getPublisher(wallet.address);
  if (!p.registered) { console.log(`${name} ${wallet.address}: NOT registered — skipped`); continue; }
  if (p.relaySigner.toLowerCase() === diana.toLowerCase()) { console.log(`${name} ${wallet.address}: already → Diana ✓`); continue; }
  console.log(`${name} ${wallet.address}: relaySigner ${p.relaySigner} → ${diana}`);
  await send(`${name} setRelaySigner(Diana)`, wallet, iface.interface.encodeFunctionData("setRelaySigner", [diana]));
}

console.log("\nDone. Verify with the read script or `relaySigner(addr)`.");
