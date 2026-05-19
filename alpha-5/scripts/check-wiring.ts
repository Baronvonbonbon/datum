import { JsonRpcProvider, Interface } from "ethers";
import * as fs from "fs";
import * as path from "path";

const rpcUrl = "https://eth-rpc-testnet.polkadot.io/";
const provider = new JsonRpcProvider(rpcUrl);

const A = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../deployed-addresses.json"), "utf8"));

async function readSlot(addr: string, iface: Interface, fn: string, args: any[] = []) {
  const data = iface.encodeFunctionData(fn, args);
  const raw = await provider.call({ to: addr, data, gasLimit: 500_000_000n, type: 0, gasPrice: 1_000_000_000_000n });
  return iface.decodeFunctionResult(fn, raw)[0] as string;
}

async function main() {
  const budgetIface = new Interface(["function settlement() view returns (address)"]);
  const settlIface  = new Interface(["function budgetLedger() view returns (address)", "function claimValidator() view returns (address)"]);
  const claimIface  = new Interface(["function campaigns() view returns (address)"]);
  const campIface   = new Interface(["function campaignValidator() view returns (address)"]);

  const budgetSettlement   = await readSlot(A.budgetLedger,   budgetIface, "settlement");
  const settlBudget        = await readSlot(A.settlement,     settlIface,  "budgetLedger");
  const settlClaimVal      = await readSlot(A.settlement,     settlIface,  "claimValidator");
  const claimValCampaigns  = await readSlot(A.claimValidator, claimIface,  "campaigns");
  const campValidator      = await readSlot(A.campaigns,      campIface,   "campaignValidator");

  console.log("=== Contract Wiring Check ===");
  console.log(`BudgetLedger.settlement:  ${budgetSettlement}`);
  console.log(`  Expected:               ${A.settlement}`);
  console.log(`  MATCH: ${budgetSettlement.toLowerCase() === A.settlement.toLowerCase()}`);
  console.log();
  console.log(`Settlement.budgetLedger:  ${settlBudget}`);
  console.log(`  Expected:               ${A.budgetLedger}`);
  console.log(`  MATCH: ${settlBudget.toLowerCase() === A.budgetLedger.toLowerCase()}`);
  console.log();
  console.log(`Settlement.claimValidator: ${settlClaimVal}`);
  console.log(`  Expected:               ${A.claimValidator}`);
  console.log(`  MATCH: ${settlClaimVal.toLowerCase() === A.claimValidator.toLowerCase()}`);
  console.log();
  console.log(`ClaimValidator.campaigns: ${claimValCampaigns}`);
  console.log(`  Expected:               ${A.campaigns}`);
  console.log(`  MATCH: ${claimValCampaigns.toLowerCase() === A.campaigns.toLowerCase()}`);
  console.log();
  console.log(`Campaigns.campaignValidator: ${campValidator}`);
  console.log(`  Expected:               ${A.campaignValidator}`);
  console.log(`  MATCH: ${campValidator.toLowerCase() === A.campaignValidator.toLowerCase()}`);
}

main().catch(console.error);
// Also check payment vault and other settlement wiring
async function extended() {
  const settlIface2 = new Interface([
    "function paymentVault() view returns (address)",
    "function publishers() view returns (address)",
    "function rateLimiter() view returns (address)",
    "function publisherStake() view returns (address)",
    "function nullifierRegistry() view returns (address)",
  ]);
  const pvaultIface = new Interface(["function settlement() view returns (address)"]);

  const settlPaymentVault = await readSlot(A.settlement, settlIface2, "paymentVault").catch(() => "ERROR");
  const settlPublishers    = await readSlot(A.settlement, settlIface2, "publishers").catch(() => "ERROR");
  const settlRateLimiter  = await readSlot(A.settlement, settlIface2, "rateLimiter").catch(() => "ERROR");
  const settlStake        = await readSlot(A.settlement, settlIface2, "publisherStake").catch(() => "ERROR");
  const settlNullifier    = await readSlot(A.settlement, settlIface2, "nullifierRegistry").catch(() => "ERROR");

  console.log(`\n=== Extended Settlement Wiring ===`);
  console.log(`Settlement.paymentVault:  ${settlPaymentVault}`);
  console.log(`  Expected:               ${A.paymentVault}`);
  console.log(`  MATCH: ${settlPaymentVault?.toLowerCase() === A.paymentVault?.toLowerCase()}`);
  console.log(`Settlement.publishers:    ${settlPublishers}`);
  console.log(`Settlement.rateLimiter:   ${settlRateLimiter}`);
  console.log(`Settlement.publisherStake:${settlStake}`);
  console.log(`Settlement.nullifier:     ${settlNullifier}`);

  // Check PaymentVault.settlement pointer
  const pvSettlement = await readSlot(A.paymentVault, pvaultIface, "settlement").catch(() => "ERROR");
  console.log(`\nPaymentVault.settlement:  ${pvSettlement}`);
  console.log(`  Expected (v8):          ${A.settlement}`);
  console.log(`  MATCH: ${pvSettlement?.toLowerCase() === A.settlement?.toLowerCase()}`);

  // Check paymentVault balance
  const pvBalance = await provider.getBalance(A.paymentVault);
  console.log(`\nPaymentVault balance: ${pvBalance} planck`);
  const budgetBalance = await provider.getBalance(A.budgetLedger);
  console.log(`BudgetLedger balance: ${budgetBalance} planck`);

  // Check if a freshly deployed benchmark campaign has budget
  // Try to find the budget for campaign 493 (ECO-$2DOT)
  const budgetIface2 = new Interface(["function getRemainingBudget(uint256,uint8) view returns (uint256)"]);
  try {
    const remaining493 = await readSlot(A.budgetLedger, budgetIface2, "getRemainingBudget", [493, 0]);
    console.log(`\nCampaign 493 (ECO-$2DOT) actionType=0 remaining: ${remaining493} planck`);
  } catch(e) { console.log("getRemainingBudget failed:", e); }
}
extended().catch(console.error);
