// activate-pending.ts — One-shot recovery: activate all Pending campaigns via AdminGovernance
// Usage: npx hardhat run scripts/activate-pending.ts --network polkadotTestnet

import { JsonRpcProvider, Wallet, Interface } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { parseDOT, formatDOT } from "../test/helpers/dot";

const RPC_URL = "https://eth-rpc-testnet.polkadot.io/";

const ALICE_KEY = process.env.DEPLOYER_PRIVATE_KEY!;
if (!ALICE_KEY) { console.error("DEPLOYER_PRIVATE_KEY not set"); process.exit(1); }

const addrFile = path.join(__dirname, "../deployed-addresses.json");
const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));

const campaignsAbi = [
  "function getCampaignStatus(uint256) view returns (uint8)",
  "function nextCampaignId() view returns (uint256)",
];
const adminGovAbi = [
  "function activateCampaign(uint256 campaignId)",
];

async function sendRaw(
  wallet: Wallet, provider: JsonRpcProvider,
  to: string, data: string, value = 0n
) {
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 1_000_000n;
  const gasLimit = 300_000n;
  const tx = await wallet.sendTransaction({ to, data, value, nonce, gasPrice, gasLimit });
  // Nonce-poll for confirmation (Paseo receipt bug workaround)
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const cur = await provider.getTransactionCount(wallet.address, "latest");
    if (cur > nonce) return;
  }
  throw new Error(`TX timeout (nonce ${nonce})`);
}

async function readCall(provider: JsonRpcProvider, to: string, iface: Interface, fn: string, args: unknown[]) {
  const data = iface.encodeFunctionData(fn, args);
  return await provider.call({ to, data });
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const alice = new Wallet(ALICE_KEY, provider);
  console.log("Alice:", alice.address);

  const campIface = new Interface(campaignsAbi);
  const adminGovIface = new Interface(adminGovAbi);

  const adminGovAddr = addrs.adminGovernance;
  const campaignsAddr = addrs.campaigns;
  console.log("AdminGovernance:", adminGovAddr);
  console.log("Campaigns:", campaignsAddr);

  const nextIdRaw = await readCall(provider, campaignsAddr, campIface, "nextCampaignId", []);
  const nextId = Number(BigInt(nextIdRaw));
  console.log(`nextCampaignId: ${nextId} — scanning IDs 1..${nextId - 1}`);

  let activated = 0, skipped = 0, failed = 0;
  for (let id = 1; id < nextId; id++) {
    const statusRaw = await readCall(provider, campaignsAddr, campIface, "getCampaignStatus", [id]);
    const status = Number(BigInt(statusRaw));
    if (status !== 0) { // 0 = Pending
      if (id <= 10 || id % 10 === 0) console.log(`  ID ${id}: status ${status} (skip)`);
      skipped++;
      continue;
    }
    try {
      const data = adminGovIface.encodeFunctionData("activateCampaign", [id]);
      await sendRaw(alice, provider, adminGovAddr, data);
      activated++;
      if (id % 10 === 0) console.log(`  ID ${id}: activated (${activated} total)`);
    } catch (err) {
      console.log(`  ID ${id}: FAILED — ${String(err).slice(0, 80)}`);
      failed++;
    }
  }

  console.log(`\nDone: ${activated} activated, ${skipped} skipped, ${failed} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
