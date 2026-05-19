import { JsonRpcProvider, Interface, ZeroAddress, ZeroHash, parseUnits } from "ethers";
import * as fs from "fs";
import * as path from "path";

const RPC = "https://eth-rpc-testnet.polkadot.io/";
const provider = new JsonRpcProvider(RPC);
const A = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../deployed-addresses.json"), "utf8"));

const CALL_OPTS = { gasLimit: 500_000_000n, type: 0 as 0, gasPrice: 1_000_000_000_000n };

async function readAddr(contractAddr: string, getter: string): Promise<string> {
  const iface = new Interface([`function ${getter}() view returns (address)`]);
  const data = iface.encodeFunctionData(getter, []);
  try {
    const raw = await provider.call({ to: contractAddr, data, ...CALL_OPTS });
    return iface.decodeFunctionResult(getter, raw)[0] as string;
  } catch(e: any) {
    return `ERROR: ${e.message?.slice(0,100)}`;
  }
}

const campAbi = [
  "function nextCampaignId() view returns (uint256)",
  "function budgetLedger() view returns (address)",
  "function campaignValidator() view returns (address)",
  "function challengeBonds() view returns (address)",
  "function lifecycleContract() view returns (address)",
  "function pauseRegistry() view returns (address)",
  "function createCampaign(address publisher, (uint8 actionType, uint256 budgetPlanck, uint256 dailyCapPlanck, uint256 ratePlanck, address actionVerifier)[] pots, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)",
];

const campIface = new Interface(campAbi);

async function main() {
  console.log("=== Campaigns contract wiring ===");
  console.log("campaigns addr:", A.campaigns);
  console.log("budgetLedger:", await readAddr(A.campaigns, "budgetLedger"));
  console.log("campaignValidator:", await readAddr(A.campaigns, "campaignValidator"));
  console.log("lifecycleContract:", await readAddr(A.campaigns, "lifecycleContract"));
  console.log("challengeBonds:", await readAddr(A.campaigns, "challengeBonds"));
  console.log("pauseRegistry:", await readAddr(A.campaigns, "pauseRegistry"));
  
  const nextRaw = await provider.call({
    to: A.campaigns,
    data: campIface.encodeFunctionData("nextCampaignId", []),
    ...CALL_OPTS,
  });
  const nextCid = campIface.decodeFunctionResult("nextCampaignId", nextRaw)[0];
  console.log("nextCampaignId:", nextCid.toString());

  console.log("\n=== BudgetLedger.campaigns check ===");
  const blCampaigns = await readAddr(A.budgetLedger, "campaigns");
  console.log("BudgetLedger.campaigns:", blCampaigns);
  console.log("Expected:", A.campaigns.toLowerCase());
  console.log("Match:", blCampaigns.toLowerCase() === A.campaigns.toLowerCase());

  console.log("\n=== eth_call createCampaign (expect revert reason) ===");
  const { Wallet } = await import("ethers");
  const bob   = new Wallet("0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52", provider);
  const diana = new Wallet("0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0", provider);
  const BUDGET = 200_000_000_000n; // 20 DOT
  const CPM = 2_000_000_000n; // 0.2 DOT CPM
  const pot = { actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: BUDGET, ratePlanck: CPM, actionVerifier: ZeroAddress };
  const calldata = campIface.encodeFunctionData("createCampaign", [
    diana.address, [pot], [], false, ZeroAddress, 0, 0,
  ]);
  try {
    const result = await provider.call({
      to: A.campaigns, data: calldata, value: BUDGET,
      from: bob.address, ...CALL_OPTS,
    });
    console.log("eth_call SUCCESS:", result.slice(0, 80));
  } catch(e: any) {
    console.log("eth_call revert data:", e.data || "(none)");
    console.log("eth_call message:", e.message?.slice(0, 300));
  }

  console.log("\n=== AdminGovernance.activateCampaign eth_call ===");
  const alice = new Wallet("0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8", provider);
  const adminGovIface = new Interface([
    "function activateCampaign(uint256 campaignId) external",
    "function campaigns() view returns (address)",
    "function router() view returns (address)",
  ]);
  console.log("AdminGovernance.campaigns:", await readAddr(A.adminGovernance, "campaigns"));
  console.log("AdminGovernance.router:", await readAddr(A.adminGovernance, "router"));

  const govRouterIface = new Interface([
    "function campaigns() view returns (address)",
    "function lifecycle() view returns (address)",
    "function governor() view returns (address)",
  ]);
  console.log("\n=== GovernanceRouter wiring ===");
  const grCampaigns = await readAddr(A.governanceRouter, "campaigns");
  const grLifecycle = await readAddr(A.governanceRouter, "lifecycle");
  const grGovernor  = await readAddr(A.governanceRouter, "governor");
  console.log("GovernanceRouter.campaigns:", grCampaigns);
  console.log("GovernanceRouter.lifecycle:", grLifecycle);
  console.log("GovernanceRouter.governor:", grGovernor);
  console.log("Expected campaigns:", A.campaigns.toLowerCase());
  console.log("Match:", grCampaigns.toLowerCase() === A.campaigns.toLowerCase());

  try {
    const agCalldata = adminGovIface.encodeFunctionData("activateCampaign", [1]);
    const agResult = await provider.call({
      to: A.adminGovernance, data: agCalldata,
      from: alice.address, ...CALL_OPTS,
    });
    console.log("\nactivateCampaign(1) eth_call SUCCESS:", agResult.slice(0, 80));
  } catch(e: any) {
    console.log("\nactivateCampaign(1) revert data:", e.data || "(none)");
    console.log("activateCampaign(1) message:", e.message?.slice(0, 300));
  }
}

main().catch(console.error);
