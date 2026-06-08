// Seed a few CLOSED campaigns under publisher Diana so the gasless relay can
// settle them (their snapshotted relaySigner == Diana == the relay key). The
// 100 open campaigns from setup-testnet stay (user-wallet settle path).
//
// Idempotent-ish: appends N new campaigns each run. Reads addresses from the
// canonical deployed-addresses.json. setup-testnet must have run first (it
// registers Diana + sets her relaySigner to herself).
//
//   node scripts/seed-diana-campaigns.mjs [count]
import { JsonRpcProvider, Wallet, Contract, Interface, parseEther, formatEther, ZeroAddress } from "ethers";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADDR = JSON.parse(readFileSync(resolve(ROOT, "deployed-addresses.json"), "utf8"));
const RPC = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
const GAS = { gasLimit: 500_000_000n, gasPrice: 1_000_000_000_000n, type: 0 };

// Same demo accounts setup-testnet uses.
const BOB = "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52";   // advertiser
const DIANA_ADDR = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";                    // publisher == relay
const COUNT = Number(process.argv[2] || 5);

const campAbi = [
  "function createCampaignWithActivation(address publisher, tuple(uint8 actionType,uint256 budgetWei,uint256 dailyCapWei,uint256 rateWei,address actionVerifier)[] pots, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount, uint256 activationBondAmount) payable returns (uint256)",
  "function nextCampaignId() view returns (uint256)",
  "function getCampaignStatus(uint256) view returns (uint8)",
  "function getCampaignStruct(uint256) view returns (tuple(address advertiser,address publisher,uint256 a,uint256 b,uint16 c,uint8 status,address relaySigner,bool d,address e,uint256 f,uint256 g))",
];
const pubAbi = ["function relaySigner(address) view returns (address)", "function isRegisteredWithRate(address) view returns (bool,uint16)"];
const actAbi = ["function activate(uint256)", "function minBond() view returns (uint256)", "function timelockBlocks() view returns (uint64)"];

const p = new JsonRpcProvider(RPC);
const bob = new Wallet(BOB, p);
const campRO = new Contract(ADDR.campaigns, campAbi, p);
const pub = new Contract(ADDR.publishers, pubAbi, p);
const act = new Contract(ADDR.activationBonds, actAbi, p);
const iCamp = new Interface(campAbi), iAct = new Interface(actAbi);

async function send(signer, to, iface, method, args, value = 0n) {
  const data = iface.encodeFunctionData(method, args);
  const nonce = await p.getTransactionCount(signer.address);
  await signer.sendTransaction({ to, data, value, ...GAS, nonce });
  for (let i = 0; i < 90; i++) { if (await p.getTransactionCount(signer.address) > nonce) return; await new Promise(r => setTimeout(r, 2000)); }
  throw new Error("nonce stuck");
}

async function main() {
  console.log(`Seeding ${COUNT} Diana-published campaigns on ${ADDR.campaigns}`);
  // preconditions
  const [reg] = await pub.isRegisteredWithRate(DIANA_ADDR);
  const rs = await pub.relaySigner(DIANA_ADDR);
  console.log(`  Diana registered=${reg} | relaySigner=${rs} ${rs.toLowerCase() === DIANA_ADDR.toLowerCase() ? "(== relay ✓)" : "(✗ run setup-testnet first)"}`);
  if (!reg || rs.toLowerCase() !== DIANA_ADDR.toLowerCase()) throw new Error("Diana not registered with relaySigner=self; run setup-testnet first");

  const bal = await p.getBalance(bob.address);
  console.log(`  advertiser Bob ${bob.address} balance ${formatEther(bal)} PAS`);
  const minBond = await act.minBond();
  const timelock = await act.timelockBlocks();
  console.log(`  activation minBond=${formatEther(minBond)} PAS, timelock=${timelock} blocks`);

  // All native amounts are 18-decimal wei (the pallet-revive EVM scale). CPM is
  // per 1000 events, so a 1-PAS CPM pays CPM/1000 = 0.001 PAS per impression (gross).
  const budget = parseEther("2"), dailyCap = parseEther("1"), cpm = parseEther("1");
  const pots = [{ actionType: 0, budgetWei: budget, dailyCapWei: dailyCap, rateWei: cpm, actionVerifier: ZeroAddress }];

  const created = [];
  let base = await campRO.nextCampaignId();
  for (let i = 0; i < COUNT; i++) {
    const id = base + BigInt(i);
    await send(bob, ADDR.campaigns, iCamp, "createCampaignWithActivation",
      [DIANA_ADDR, pots, [], false, ZeroAddress, 0n, 0n, minBond], budget + minBond);
    created.push(id);
    console.log(`  created campaign ${id} (Bob → Diana)`);
  }

  // wait the activation timelock, then permissionlessly activate
  const target = (await p.getBlockNumber()) + Number(timelock) + 1;
  process.stdout.write(`  waiting for activation timelock (block ${target})`);
  while (await p.getBlockNumber() < target) { process.stdout.write("."); await new Promise(r => setTimeout(r, 6000)); }
  console.log();

  for (const id of created) {
    try { await send(bob, ADDR.activationBonds, iAct, "activate", [id]); } catch (e) { console.log(`  activate ${id}: ${e.message.slice(0, 60)}`); }
  }

  console.log("\n=== verify ===");
  let ok = 0;
  for (const id of created) {
    const c = await campRO.getCampaignStruct(id);
    const good = Number(c.status) === 1 && c.relaySigner.toLowerCase() === DIANA_ADDR.toLowerCase();
    console.log(`  campaign ${id}: status=${["Pending","Active","Paused","Completed","Terminated","Expired"][Number(c.status)]} relaySigner=${c.relaySigner} ${good ? "✅ gasless-ready" : ""}`);
    if (good) ok++;
  }
  console.log(`\n${ok}/${created.length} Diana campaigns active + gasless-settleable (ids ${created[0]}..${created[created.length-1]})`);
}
main().catch(e => { console.error(e); process.exit(1); });
