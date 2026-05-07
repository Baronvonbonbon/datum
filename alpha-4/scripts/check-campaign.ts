import { JsonRpcProvider, Interface } from "ethers";
import * as fs from "fs";
import * as path from "path";

const rpcUrl = "https://eth-rpc-testnet.polkadot.io/";
const provider = new JsonRpcProvider(rpcUrl);
const CALL_OPTS = { gasLimit: 500_000_000n, type: 0 as 0, gasPrice: 1_000_000_000_000n };

const A = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../deployed-addresses.json"), "utf8"));

async function call(to: string, iface: Interface, fn: string, args: any[]) {
  const data = iface.encodeFunctionData(fn, args);
  const raw = await provider.call({ to, data, ...CALL_OPTS });
  return iface.decodeFunctionResult(fn, raw);
}

async function rawCall(to: string, data: string) {
  return provider.call({ to, data, ...CALL_OPTS });
}

async function main() {
  const campIface = new Interface([
    "function getCampaignPot(uint256 campaignId, uint8 actionType) view returns (tuple(uint8 actionType, uint256 budgetPlanck, uint256 dailyCapPlanck, uint256 ratePlanck, address actionVerifier))",
    "function getCampaignStatus(uint256) view returns (uint8)",
    "function nextCampaignId() view returns (uint256)",
    "function getCampaignPots(uint256 campaignId) view returns (tuple(uint8 actionType, uint256 budgetPlanck, uint256 dailyCapPlanck, uint256 ratePlanck, address actionVerifier)[])",
  ]);

  // Campaign 493 (ECO-$2DOT)
  const CID = 493n;
  
  const status = await call(A.campaigns, campIface, "getCampaignStatus", [CID]);
  console.log(`Campaign ${CID} status: ${status[0]} (1=Active)`);

  const pots = await call(A.campaigns, campIface, "getCampaignPots", [CID]).catch(e => null);
  console.log(`Campaign ${CID} getPots:`, pots);

  // Try raw getCampaignPot selector
  const rawSelector = "0x" + Buffer.from("getCampaignPot(uint256,uint8)").toString("hex");
  console.log(`getCampaignPot selector chars: ${rawSelector.slice(0, 20)}`);

  try {
    const pot = await call(A.campaigns, campIface, "getCampaignPot", [CID, 0]);
    console.log(`Campaign ${CID} pot[0]:`, pot);
  } catch (e: any) {
    console.log(`getCampaignPot FAILED: ${e.message?.slice(0, 150)}`);
  }

  // Also check the raw encoding
  const data = campIface.encodeFunctionData("getCampaignPot", [CID, 0]);
  console.log(`getCampaignPot raw calldata: ${data.slice(0, 20)}...`);
  try {
    const rawResult = await rawCall(A.campaigns, data);
    console.log(`getCampaignPot raw result length: ${(rawResult.length - 2) / 2} bytes`);
    console.log(`getCampaignPot raw result: ${rawResult.slice(0, 80)}`);
  } catch (e: any) {
    console.log(`rawCall FAILED: ${e.message?.slice(0, 150)}`);
  }
}
main().catch(console.error);
