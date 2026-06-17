// One-shot PAS sweep: drain git-burned old testnet accounts into the new
// deployer (Alice) so the redeploy has gas. Reads old keys from the gitignored
// rotation scratch map. Paseo-safe: pinned weight gas, nonce-polling (the
// eth-rpc receipt bug returns null for confirmed txs), value rounded to a clean
// 1e15-wei multiple. Burned accounts keep a ~520 PAS dust tail (testnet, abandoned).
//
//   node scripts/sweep-old-keys.mjs
import fs from "fs";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";

const RPC = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
const SCRATCH = ".key-rotation-2026-06-16.json";
const GAS = { gasLimit: 500_000_000n, gasPrice: 1_000_000_000_000n, type: 0 };
const BUFFER = 520n * 10n ** 18n;        // > max upfront fee reserve (~500 PAS)
const ROUND = 10n ** 15n;                // clean denomination multiple
const MIN_SWEEP = 10n ** 18n;            // skip if < 1 PAS left to send

async function waitForNonce(p, addr, prev, tries = 90) {
  for (let i = 0; i < tries; i++) {
    if ((await p.getTransactionCount(addr)) > prev) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("nonce did not advance after 180s");
}

async function main() {
  const s = JSON.parse(fs.readFileSync(SCRATCH, "utf8"));
  const p = new JsonRpcProvider(RPC);
  const dest = s.new.named.DEPLOYER.address;
  console.log(`Destination (new Alice): ${dest}\n`);

  const accts = [
    ...Object.entries(s.old.named).map(([n, v]) => [n, v.key, v.address]),
    ...s.old.testnetAccounts.map((v, i) => [`TA[${i}]`, v.key, v.address]),
  ];

  let swept = 0n;
  for (const [name, key, addr] of accts) {
    if (addr.toLowerCase() === dest.toLowerCase()) { console.log(`${name}: is dest, skip`); continue; }
    let bal;
    try { bal = await p.getBalance(addr); } catch (e) { console.log(`${name} ${addr}: balance err ${e.message}`); continue; }
    if (bal <= BUFFER + MIN_SWEEP) { console.log(`${name} ${addr}: ${formatEther(bal)} PAS — below buffer, skip`); continue; }
    let value = ((bal - BUFFER) / ROUND) * ROUND;
    if (value < MIN_SWEEP) { console.log(`${name}: nothing to sweep`); continue; }
    try {
      const w = new Wallet(key, p);
      const nonce = await p.getTransactionCount(addr);
      const tx = await w.sendTransaction({ to: dest, value, ...GAS });
      console.log(`${name} ${addr}: sweeping ${formatEther(value)} PAS  tx ${tx.hash}`);
      await waitForNonce(p, addr, nonce);
      swept += value;
    } catch (e) { console.log(`${name}: sweep FAILED — ${String(e).slice(0, 120)}`); }
  }

  const destBal = await p.getBalance(dest);
  console.log(`\nSwept ~${formatEther(swept)} PAS. New Alice balance: ${formatEther(destBal)} PAS`);
}
main().catch((e) => { console.error(e); process.exit(1); });
