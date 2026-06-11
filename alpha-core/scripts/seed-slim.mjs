// Minimal slim-spine seed for the alpha-core Paseo launch.
//
// The full seed (setup-testnet.ts) requires the 28-contract deploy; reseed-demo.mjs
// pins campaigns to a registered publisher + writes creative via the deferred
// DatumCampaignCreative. Neither runs against the DATUM_MVP=1 slim spine.
//
// This creates N OPEN campaigns (publisher = address(0) — no publisher
// registration, no tags, no creative metadata, no bond) funded by the deployer,
// then activates each via DatumGovernanceRouter.adminActivateCampaign (Phase-0
// owner path). Zero dependency on any deferred contract.
//
//   CAMPAIGNS=6 node scripts/seed-slim.mjs   # against deployed-addresses.json
//
// Re-run safe: each create is a fresh campaign; activation is idempotent (already
// Active → status check passes). Uses the Paseo raw-provider + nonce-poll pattern
// (getTransactionReceipt returns null for confirmed txs on Paseo).
import "dotenv/config";
import { JsonRpcProvider, Wallet, Contract, Interface } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const RPC = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
const N = Number(process.env.CAMPAIGNS || 6);
const ZERO = "0x0000000000000000000000000000000000000000";

// 18-dec wei. Budget 1 PAS (> MINIMUM_BUDGET_WEI 1e17); CPM 0.5 PAS/1000 imps
// (> minimumCpmFloor 1e15); daily cap 0.5 PAS. All clean multiples of 1e6 to
// dodge the Paseo eth-rpc value-rounding reject (value % 1e6 >= 5e5).
const BUDGET = 10n ** 18n;
const DAILY_CAP = 5n * 10n ** 17n;
const RATE_CPM = 5n * 10n ** 17n;

const GAS = { gasLimit: 500_000_000n, gasPrice: 1_000_000_000_000n, type: 0 };

const campaignsAbi = [
  "function createCampaign(address publisher, tuple(uint8 actionType, uint256 budgetWei, uint256 dailyCapWei, uint256 rateWei, address actionVerifier)[] pots, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)",
  "function getCampaignStatus(uint256 campaignId) view returns (uint8)",
  "function nextCampaignId() view returns (uint256)",
];
const routerAbi = ["function adminActivateCampaign(uint256 campaignId)"];
const STATUS = ["Pending", "Active", "Paused", "Terminated", "Expired"];

async function waitNonce(provider, addr, prev, tries = 90) {
  for (let i = 0; i < tries; i++) {
    if ((await provider.getTransactionCount(addr)) > prev) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("nonce did not advance after 180s — check the explorer");
}

async function send(wallet, provider, to, data, value = 0n) {
  const nonce = await provider.getTransactionCount(wallet.address);
  const tx = await wallet.sendTransaction({ to, data, value, ...GAS });
  await waitNonce(provider, wallet.address, nonce);
  return tx.hash;
}

async function main() {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("set DEPLOYER_PRIVATE_KEY");
  const A = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));
  for (const k of ["campaigns", "governanceRouter"]) {
    if (!A[k] || A[k] === ZERO) throw new Error(`deployed-addresses.json missing ${k}`);
  }

  const provider = new JsonRpcProvider(RPC);
  const alice = new Wallet(key, provider); // deployer = Phase-0 owner + governor
  const iCamp = new Interface(campaignsAbi);
  const iRouter = new Interface(routerAbi);
  const campaigns = new Contract(A.campaigns, campaignsAbi, provider);

  console.log(`Seeding ${N} open campaigns on Paseo`);
  console.log(`  advertiser/owner: ${alice.address}`);
  console.log(`  campaigns: ${A.campaigns}  router: ${A.governanceRouter}`);
  const bal = await provider.getBalance(alice.address);
  console.log(`  balance: ${(Number(bal) / 1e18).toFixed(2)} PAS  (need ~${Number(BUDGET * BigInt(N)) / 1e18} PAS for budgets)\n`);

  const baseId = BigInt(await campaigns.nextCampaignId()); // first new campaign id
  const ids = [];

  // ── Create ────────────────────────────────────────────────────────────────
  for (let i = 0; i < N; i++) {
    const cid = baseId + BigInt(i);
    const data = iCamp.encodeFunctionData("createCampaign", [
      ZERO,
      [{ actionType: 0, budgetWei: BUDGET, dailyCapWei: DAILY_CAP, rateWei: RATE_CPM, actionVerifier: ZERO }],
      [],          // no required tags (no DatumTagSystem in slim)
      false,       // requireZkProof
      ZERO,        // rewardToken
      0n,          // rewardPerImpression
      0n,          // bondAmount (no DatumChallengeBonds in slim)
    ]);
    const hash = await send(alice, provider, A.campaigns, data, BUDGET);
    console.log(`  [create] campaign ${cid}  (budget 1 PAS, CPM 0.5 PAS)  tx ${hash}`);
    ids.push(cid);
  }

  // ── Activate (Phase-0 admin path) ───────────────────────────────────────────
  let active = 0;
  for (const cid of ids) {
    try {
      const hash = await send(alice, provider, A.governanceRouter, iRouter.encodeFunctionData("adminActivateCampaign", [cid]));
      const s = Number(await campaigns.getCampaignStatus(cid));
      if (s === 1) { active++; console.log(`  [activate] campaign ${cid} → Active  tx ${hash}`); }
      else console.log(`  [activate] campaign ${cid} → ${STATUS[s] ?? s} (WARNING)  tx ${hash}`);
    } catch (e) {
      console.log(`  [activate] campaign ${cid} FAILED: ${String(e).slice(0, 120)}`);
    }
  }

  console.log(`\n✅ Seed complete: ${active}/${N} campaigns Active (ids ${ids[0]}–${ids[ids.length - 1]}).`);
  if (active < N) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
