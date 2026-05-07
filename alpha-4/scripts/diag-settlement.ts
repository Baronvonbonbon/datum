import { JsonRpcProvider, Wallet, Interface, ZeroHash, ZeroAddress, AbiCoder } from "ethers";
import * as fs from "fs";

const ACCOUNTS = {
  alice:   "0x4c95c114d75f5e06fd4236088bdd9576e14c0307c79766171f1e90ab60231a74",
  diana:   "0x94bef29d524e42df60227ca9b8a39aafe53da3e25c8d79b1dbe6cc44b2e3a7f2",
  grace:   "0xdfafb7d12292bad165e40ba13bd2254f91123b656f991e3f308e5ccbcfc6a235",
};

async function main() {
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const provider = new JsonRpcProvider(rpcUrl);
  const alice = new Wallet(ACCOUNTS.alice, provider);
  const grace = new Wallet(ACCOUNTS.grace, provider);
  const diana = new Wallet(ACCOUNTS.diana, provider);

  const A = JSON.parse(fs.readFileSync(__dirname + "/../deployed-addresses.json", "utf-8"));

  const CALL_OPTS = { gasLimit: 500_000_000n, type: 0, gasPrice: 1_000_000_000_000n };

  // 1. Check reentrancy guard storage - OZ 5.0 ERC-7201 namespaced slot
  const REENTRANCY_SLOT = "0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00";
  const reentrancyVal = await provider.getStorage(A.settlement, REENTRANCY_SLOT);
  console.log("ReentrancyGuard slot value:", reentrancyVal);
  // OZ 5.0: NOT_ENTERED = 1, ENTERED = 2. If stuck at 2, nonReentrant reverts.
  // Actually OZ 5.0 uses 0 for NOT_ENTERED (was 1 in v4). Let me check both.
  console.log("  (0 = NOT_ENTERED in OZ5, 2 = ENTERED/stuck)");

  // Also check slot 0 just in case
  const slot0 = await provider.getStorage(A.settlement, 0);
  console.log("Slot 0:", slot0);

  // 2. Check validateConfiguration
  const configIface = new Interface([
    "function validateConfiguration() view returns (bool valid, string missingField)",
  ]);
  const configResult = await provider.call({ to: A.settlement, data: configIface.encodeFunctionData("validateConfiguration", []), ...CALL_OPTS });
  const [valid, missingField] = configIface.decodeFunctionResult("validateConfiguration", configResult);
  console.log("\nvalidateConfiguration:", valid, missingField);

  // 3. Check settlement references
  const refIface = new Interface([
    "function owner() view returns (address)",
    "function relayContract() view returns (address)",
    "function claimValidator() view returns (address)",
    "function budgetLedger() view returns (address)",
    "function campaigns() view returns (address)",
    "function publishers() view returns (address)",
    "function attestationVerifier() view returns (address)",
  ]);

  for (const fn of ["owner", "relayContract", "claimValidator", "budgetLedger", "campaigns", "publishers", "attestationVerifier"]) {
    const result = await provider.call({ to: A.settlement, data: refIface.encodeFunctionData(fn, []), ...CALL_OPTS });
    console.log(`  ${fn}: ${refIface.decodeFunctionResult(fn, result)[0]}`);
  }
  console.log("  Alice:", alice.address);
  console.log("  Grace:", grace.address);
  console.log("  Diana:", diana.address);

  // 4. Check paused
  const pauseIface = new Interface(["function paused() view returns (bool)"]);
  const pauseResult = await provider.call({ to: A.pauseRegistry, data: pauseIface.encodeFunctionData("paused", []), ...CALL_OPTS });
  console.log("\npaused:", pauseIface.decodeFunctionResult("paused", pauseResult)[0]);

  // 5. Try eth_call with empty batches
  const CLAIM_T = "uint256 campaignId, address publisher, uint256 eventCount, uint256 ratePlanck, uint8 actionType, bytes32 clickSessionHash, uint256 nonce, bytes32 previousClaimHash, bytes32 claimHash, bytes32[8] zkProof, bytes32 nullifier, bytes32[3] actionSig";
  const settleIface = new Interface([
    `function settleClaims((address user, uint256 campaignId, (${CLAIM_T})[] claims)[] batches) returns (uint256 settledCount, uint256 rejectedCount, uint256 totalPaid)`,
  ]);

  console.log("\n--- eth_call: empty batches from grace ---");
  try {
    const emptyData = settleIface.encodeFunctionData("settleClaims", [[]]);
    const emptyResult = await provider.call({
      to: A.settlement,
      data: emptyData,
      from: grace.address,
      ...CALL_OPTS,
    });
    const decoded = settleIface.decodeFunctionResult("settleClaims", emptyResult);
    console.log("SUCCESS — empty batch returns:", decoded);
  } catch (e: any) {
    console.log("FAILED:", e.message?.slice(0, 500));
    // Try to get raw revert data
    if (e.data) console.log("Revert data:", e.data);
  }

  // 6. Check if settlement contract has code
  const code = await provider.getCode(A.settlement);
  console.log("\nSettlement contract code length:", code.length / 2 - 1, "bytes");

  // 7. Check budgetLedger contract has code
  const blCode = await provider.getCode(A.budgetLedger);
  console.log("BudgetLedger contract code length:", blCode.length / 2 - 1, "bytes");
}

main().catch(e => console.error(e));
