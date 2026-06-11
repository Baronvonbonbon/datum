// Phase-5 feature seed — adds campaigns that exercise the newly-layered feature
// modules, on top of the 6 open campaigns from seed-slim.mjs:
//   1. PUBLISHER-PINNED  — publisher = Diana (registered, relaySigner=self) →
//      exercises the registered-publisher path + take-rate snapshot.
//   2. TOKEN-REWARD      — rewardToken = WDATUM (wrapper), rewardPerImpression>0 →
//      exercises the token-plane reward config (crediting needs the vault funded;
//      that's a follow-up — see MAINNET-LAUNCH-PLAN token-plane deltas).
// Both activated via the Phase-0 admin path. Re-run safe (creates fresh ids).
//
//   node scripts/seed-features.mjs
import "dotenv/config";
import { JsonRpcProvider, Wallet, Contract, Interface } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"));
const RPC = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
const ZERO = "0x0000000000000000000000000000000000000000";
const DIANA = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
const BUDGET = 10n ** 18n, DAILY = 5n * 10n ** 17n, RATE = 5n * 10n ** 17n;
const GAS = { gasLimit: 500_000_000n, gasPrice: 1_000_000_000_000n, type: 0 };

const iCamp = new Interface([
  "function createCampaign(address publisher, tuple(uint8 actionType, uint256 budgetWei, uint256 dailyCapWei, uint256 rateWei, address actionVerifier)[] pots, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)",
  "function getCampaignStatus(uint256) view returns (uint8)",
  "function nextCampaignId() view returns (uint256)",
]);
const iRouter = new Interface(["function adminActivateCampaign(uint256)"]);
const STATUS = ["Pending", "Active", "Paused", "Terminated", "Expired"];

async function waitNonce(p, addr, prev, t = 90) { for (let i = 0; i < t; i++) { if ((await p.getTransactionCount(addr)) > prev) return; await new Promise(r => setTimeout(r, 2000)); } throw new Error("nonce stuck"); }
async function send(w, p, to, data, value = 0n) { const n = await p.getTransactionCount(w.address); const tx = await w.sendTransaction({ to, data, value, ...GAS }); await waitNonce(p, w.address, n); return tx.hash; }

async function main() {
  const p = new JsonRpcProvider(RPC);
  const alice = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, p);
  const campaigns = new Contract(A.campaigns, iCamp.fragments, p);
  const baseId = BigInt(await campaigns.nextCampaignId());
  console.log(`Feature seed — first new id ${baseId}, advertiser/owner ${alice.address}`);

  const pot = (verifier = ZERO) => [{ actionType: 0, budgetWei: BUDGET, dailyCapWei: DAILY, rateWei: RATE, actionVerifier: verifier }];
  const specs = [
    { label: "publisher-pinned (Diana)", args: [DIANA, pot(), [], false, ZERO, 0n, 0n] },
    { label: "token-reward (WDATUM)",    args: [ZERO,  pot(), [], false, A.wrapper, 10n ** 8n, 0n] },
  ];

  const ids = [];
  for (let i = 0; i < specs.length; i++) {
    const cid = baseId + BigInt(i);
    try {
      const hash = await send(alice, p, A.campaigns, iCamp.encodeFunctionData("createCampaign", specs[i].args), BUDGET);
      console.log(`  [create] ${cid} ${specs[i].label}  tx ${hash}`);
      ids.push(cid);
    } catch (e) { console.log(`  [create] ${specs[i].label} FAILED: ${String(e).slice(0, 140)}`); }
  }

  let active = 0;
  for (const cid of ids) {
    try {
      await send(alice, p, A.governanceRouter, iRouter.encodeFunctionData("adminActivateCampaign", [cid]));
      const s = Number(await campaigns.getCampaignStatus(cid));
      if (s === 1) { active++; console.log(`  [activate] ${cid} → Active`); } else console.log(`  [activate] ${cid} → ${STATUS[s] ?? s}`);
    } catch (e) { console.log(`  [activate] ${cid} FAILED: ${String(e).slice(0, 120)}`); }
  }
  console.log(`\n✅ Feature seed: ${active}/${ids.length} active (ids ${ids.join(", ")}).`);
}
main().catch((e) => { console.error("ERR", e.message || e); process.exit(1); });
