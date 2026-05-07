// activate-pending.ts — One-shot recovery: activates all Pending campaigns via AdminGovernance
//
// Used after setup-testnet.ts when Paseo RPC 521 errors cause partial activation.
// Re-run safe: skips campaigns that are already Active.
//
// Usage:
//   npx hardhat run scripts/activate-pending.ts --network polkadotTestnet

import { network } from "hardhat";
import { JsonRpcProvider, Wallet, Interface } from "ethers";
import * as fs from "fs";

const TX_OPTS = {
  gasLimit: 500000000n,
  type: 0,
  gasPrice: 1000000000000n,
};

const ALICE_KEY = "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8";
const STATUS_NAMES = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];

async function waitForNonce(
  provider: JsonRpcProvider,
  address: string,
  targetNonce: number,
  maxWait = 120,
): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const current = await provider.getTransactionCount(address);
    if (current > targetNonce) return;
    if (i % 10 === 0 && i > 0) console.log(`  ...waiting for tx confirmation (${i}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

async function main() {
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const rawProvider = new JsonRpcProvider(rpcUrl);
  const alice = new Wallet(ALICE_KEY, rawProvider);

  const addrFile = __dirname + "/../deployed-addresses.json";
  if (!fs.existsSync(addrFile)) {
    console.error("No deployed-addresses.json found. Run deploy.ts first.");
    process.exitCode = 1;
    return;
  }
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));

  const campIface = new Interface([
    "function getCampaignStatus(uint256) view returns (uint8)",
    "function nextCampaignId() view returns (uint256)",
  ]);
  const routerIface = new Interface([
    "function adminActivateCampaign(uint256 campaignId)",
  ]);

  // Find total campaigns
  const nextIdRaw = await rawProvider.call({ to: addrs.campaigns, data: campIface.encodeFunctionData("nextCampaignId", []) });
  const nextId = Number(campIface.decodeFunctionResult("nextCampaignId", nextIdRaw)[0]);
  console.log(`Total campaigns: ${nextId - 1} (IDs 1..${nextId - 1})`);

  // Check which are Pending (status 0)
  const pending: number[] = [];
  for (let id = 1; id < nextId; id++) {
    const raw = await rawProvider.call({ to: addrs.campaigns, data: campIface.encodeFunctionData("getCampaignStatus", [id]) });
    const status = Number(campIface.decodeFunctionResult("getCampaignStatus", raw)[0]);
    if (status === 0) pending.push(id);
  }

  if (pending.length === 0) {
    console.log("All campaigns are already active. Nothing to do.");
    return;
  }

  console.log(`Found ${pending.length} Pending campaigns: ${pending.join(", ")}`);
  console.log(`Activating via GovernanceRouter.adminActivateCampaign()...`);

  let ok = 0;
  for (let i = 0; i < pending.length; i++) {
    const cid = pending[i];
    try {
      const data = routerIface.encodeFunctionData("adminActivateCampaign", [cid]);
      const nonce = await rawProvider.getTransactionCount(alice.address);
      await alice.sendTransaction({ to: addrs.governanceRouter, data, ...TX_OPTS });
      await waitForNonce(rawProvider, alice.address, nonce);

      // Verify
      const statusRaw = await rawProvider.call({ to: addrs.campaigns, data: campIface.encodeFunctionData("getCampaignStatus", [cid]) });
      const s = Number(campIface.decodeFunctionResult("getCampaignStatus", statusRaw)[0]);
      if (s === 1) {
        ok++;
      } else {
        console.log(`  WARNING: ID ${cid} status ${STATUS_NAMES[s]} after activate`);
      }
      if ((i + 1) % 10 === 0) console.log(`  activated ${i + 1}/${pending.length}...`);
    } catch (err) {
      console.log(`  FAILED ID ${cid}: ${String(err).slice(0, 120)}`);
    }
  }

  console.log(`\nActivated ${ok}/${pending.length} campaigns.`);
  if (ok === pending.length) {
    console.log("All campaigns now Active.");
  } else {
    console.log(`${pending.length - ok} still pending — re-run this script.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
