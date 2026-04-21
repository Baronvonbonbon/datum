// check-testnet.ts — Quick diagnostic to verify on-chain campaign state
// Usage: npx hardhat run scripts/check-testnet.ts --network polkadotTestnet

import { network } from "hardhat";
import { JsonRpcProvider, Interface, Wallet, keccak256, toUtf8Bytes, ethers } from "ethers";
import { parseDOT, formatDOT } from "../test/helpers/dot";
import * as fs from "fs";

const ACCOUNTS = {
  alice:   "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8",
  bob:     "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52",
  diana:   "0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0",
};

async function main() {
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const rawProvider = new JsonRpcProvider(rpcUrl);

  const addrFile = __dirname + "/../deployed-addresses.json";
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));

  const campIface = new Interface([
    "function nextCampaignId() view returns (uint256)",
    "function getCampaignForSettlement(uint256 id) view returns (uint8 status, address publisher, uint256 bidCpmPlanck, uint16 snapshotTakeRateBps)",
    "function createCampaign(address publisher, uint256 dailyCap, uint256 bidCpm, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)",
    "function minimumCpmFloor() view returns (uint256)",
    "function MINIMUM_BUDGET_PLANCK() view returns (uint256)",
  ]);

  const pauseIface = new Interface([
    "function paused() view returns (bool)",
  ]);

  const pubIface = new Interface([
    "function getPublisher(address) view returns (bool registered, uint16 takeRateBps)",
    "function isBlocked(address) view returns (bool)",
  ]);

  const validatorIface = new Interface([
    "function validateCreation(address advertiser, address publisher, bytes32[] requiredTags) view returns (bool, uint16, address, bytes32[], bool)",
    "function campaigns() view returns (address)",
    "function targetingRegistry() view returns (address)",
  ]);

  const ledgerIface = new Interface([
    "function getRemainingBudget(uint256 campaignId) view returns (uint256)",
    "function getDailyCap(uint256 campaignId) view returns (uint256)",
    "function campaigns() view returns (address)",
    "function settlement() view returns (address)",
  ]);

  const govIface = new Interface([
    "function baseGraceBlocks() view returns (uint256)",
    "function gracePerQuorum() view returns (uint256)",
    "function maxGraceBlocks() view returns (uint256)",
    "function quorumWeighted() view returns (uint256)",
  ]);

  async function call(to: string, iface: Interface, fn: string, args: any[] = []): Promise<any> {
    try {
      const data = iface.encodeFunctionData(fn, args);
      const raw = await rawProvider.call({ to, data });
      return iface.decodeFunctionResult(fn, raw);
    } catch (e) {
      return `ERROR: ${String(e).slice(0, 100)}`;
    }
  }

  const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];

  console.log("=== Datum Testnet Diagnostic ===");
  console.log(`RPC: ${rpcUrl}`);

  // ─── Pause state ────────────────────────────────────────────────────────────
  console.log("\n--- Pause Registry ---");
  const pauseResult = await call(addrs.pauseRegistry, pauseIface, "paused");
  console.log(`paused: ${pauseResult}`);

  // ─── Campaign contract state ─────────────────────────────────────────────────
  console.log("\n--- Campaigns Contract ---");
  const nextId = await call(addrs.campaigns, campIface, "nextCampaignId");
  console.log(`nextCampaignId: ${nextId}`);

  const minFloor = await call(addrs.campaigns, campIface, "minimumCpmFloor");
  console.log(`minimumCpmFloor: ${minFloor} planck = ${formatDOT(minFloor?.[0] ?? 0n)} DOT`);

  const minBudget = await call(addrs.campaigns, campIface, "MINIMUM_BUDGET_PLANCK");
  console.log(`MINIMUM_BUDGET_PLANCK: ${minBudget}`);

  // ─── Publisher state ─────────────────────────────────────────────────────────
  const bob = new Wallet(ACCOUNTS.bob, rawProvider);
  console.log("\n--- Publisher State ---");
  console.log(`Bob address: ${bob.address}`);
  const bobBlocked = await call(addrs.publishers, pubIface, "isBlocked", [bob.address]);
  console.log(`Bob isBlocked: ${bobBlocked}`);
  const bobPub = await call(addrs.publishers, pubIface, "getPublisher", [bob.address]);
  console.log(`Bob registered: ${bobPub?.[0]}, takeRate: ${bobPub?.[1]}`);

  // ─── CampaignValidator state ─────────────────────────────────────────────────
  console.log("\n--- CampaignValidator ---");
  const valCampaigns = await call(addrs.campaignValidator, validatorIface, "campaigns");
  console.log(`validator.campaigns: ${valCampaigns}`);
  const valTargeting = await call(addrs.campaignValidator, validatorIface, "targetingRegistry");
  console.log(`validator.targetingRegistry: ${valTargeting}`);

  // Simulate validateCreation for open campaign with no tags (simplest case)
  // Try both 4-return (pre-audit) and 5-return (post-audit) ABIs
  console.log("\nSimulating validateCreation(bob, address(0), [])...");
  const validResult = await call(addrs.campaignValidator, validatorIface, "validateCreation", [
    bob.address, ethers.ZeroAddress, []
  ]);
  console.log(`validateCreation result (5-return): valid=${validResult?.[0]}, takeRate=${validResult?.[1]}`);

  // Also try with 4-return interface
  const validatorIface4 = new Interface([
    "function validateCreation(address advertiser, address publisher, bytes32[] requiredTags) view returns (bool, uint16, address, bytes32[])",
  ]);
  const validResult4 = await call(addrs.campaignValidator, validatorIface4, "validateCreation", [
    bob.address, ethers.ZeroAddress, []
  ]);
  console.log(`validateCreation result (4-return): valid=${validResult4?.[0]}, takeRate=${validResult4?.[1]}`);

  // ─── Simulate createCampaign eth_call ────────────────────────────────────────
  console.log("\n--- Simulating createCampaign via eth_call ---");
  const CPM_MIN = parseDOT("0.3");
  const BUDGET = parseDOT("1");
  try {
    const data = campIface.encodeFunctionData("createCampaign", [
      ethers.ZeroAddress, // publisher (open)
      BUDGET,             // dailyCap
      CPM_MIN,            // bidCpm
      [],                 // requiredTags
      false,              // requireZkProof
      ethers.ZeroAddress, // rewardToken
      0n,                 // rewardPerImpression
      0n,                 // bondAmount
    ]);
    const result = await rawProvider.call({
      to: addrs.campaigns,
      from: bob.address,
      data,
      value: BUDGET,
    });
    const decoded = campIface.decodeFunctionResult("createCampaign", result);
    console.log(`✓ createCampaign eth_call SUCCEEDED — campaignId: ${decoded[0]}`);
  } catch (e: any) {
    console.log(`✗ createCampaign eth_call FAILED`);
    console.log(`  Error: ${String(e).slice(0, 300)}`);
    // Try to decode revert reason
    const errStr = String(e);
    const hexMatch = errStr.match(/0x[0-9a-fA-F]{8,}/);
    if (hexMatch) {
      try {
        const errIface = new Interface(["error Error(string)"]);
        const decoded = errIface.parseError(hexMatch[0]);
        console.log(`  Revert reason: ${decoded?.args?.[0]}`);
      } catch {
        console.log(`  Raw revert data: ${hexMatch[0]}`);
      }
    }
  }

  // ─── BudgetLedger stale state check ─────────────────────────────────────────
  console.log("\n--- BudgetLedger State ---");
  const ledgerCampaigns = await call(addrs.budgetLedger, ledgerIface, "campaigns");
  console.log(`budgetLedger.campaigns: ${ledgerCampaigns}`);
  console.log(`expected campaigns:      ${addrs.campaigns}`);
  console.log(`match: ${String(ledgerCampaigns?.[0]).toLowerCase() === addrs.campaigns.toLowerCase()}`);
  for (let id = 0; id <= 5; id++) {
    const rem = await call(addrs.budgetLedger, ledgerIface, "getRemainingBudget", [id]);
    const cap = await call(addrs.budgetLedger, ledgerIface, "getDailyCap", [id]);
    if (rem?.[0] !== 0n || cap?.[0] !== 0n) {
      console.log(`  campaign ${id}: remaining=${rem?.[0]}, dailyCap=${cap?.[0]} ← STALE BUDGET`);
    } else {
      console.log(`  campaign ${id}: empty (ok)`);
    }
  }

  // ─── Existing campaign 0 state ───────────────────────────────────────────────
  console.log("\n--- Campaign 0 State (if exists) ---");
  const camp0 = await call(addrs.campaigns, campIface, "getCampaignForSettlement", [0n]);
  console.log(`campaign 0: status=${STATUS[Number(camp0?.[0] ?? 99)] ?? camp0?.[0]}, publisher=${camp0?.[1]}, bidCpm=${camp0?.[2]}`);

  // ─── Governance grace period ─────────────────────────────────────────────────
  console.log("\n--- Governance ---");
  const base = await call(addrs.governanceV2, govIface, "baseGraceBlocks");
  const perQ = await call(addrs.governanceV2, govIface, "gracePerQuorum");
  const maxG = await call(addrs.governanceV2, govIface, "maxGraceBlocks");
  const quorum = await call(addrs.governanceV2, govIface, "quorumWeighted");
  console.log(`baseGraceBlocks: ${base} (~${Number(base?.[0] ?? 0n) * 6 / 3600}h at 6s/block)`);
  console.log(`gracePerQuorum: ${perQ}`);
  console.log(`maxGraceBlocks: ${maxG}`);
  console.log(`quorumWeighted: ${formatDOT(quorum?.[0] ?? 0n)} PAS`);

  console.log("\n=== Done ===");
}

main().catch(console.error);
