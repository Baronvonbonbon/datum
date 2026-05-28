// Redeploy DatumClaimValidator with forceKeccak for EVM benchmarking
// Usage: DATUM_EVM=1 npx hardhat --config hardhat.config.evm.ts run scripts/redeploy-claim-validator-evm.ts --network paseoEvm

import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet, getCreateAddress, Interface } from "ethers";
import * as fs from "fs";
import * as path from "path";

const addrFile = path.join(__dirname, "..", "deployed-addresses-evm.json");
const A = JSON.parse(fs.readFileSync(addrFile, "utf-8"));

async function main() {
  const rpc = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
  const rawProvider = new JsonRpcProvider(rpc);
  const deployer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, rawProvider);
  console.log("Deployer:", deployer.address);

  // Deploy new ClaimValidator
  const CVFactory = await ethers.getContractFactory("DatumClaimValidator");
  const deployTx = await CVFactory.getDeployTransaction(A.campaigns, A.publishers, A.pauseRegistry);
  const nonce = await rawProvider.getTransactionCount(deployer.address, "pending");
  const predictedAddr = getCreateAddress({ from: deployer.address, nonce });
  console.log("Deploying DatumClaimValidator at predicted:", predictedAddr, "(nonce", nonce, ")");

  const tx = await deployer.sendTransaction({
    data: deployTx.data,
    gasLimit: 20_000_000n,
  });
  console.log("  TX:", tx.hash);

  // Wait for nonce to increment
  for (let i = 0; i < 60; i++) {
    const cur = await rawProvider.getTransactionCount(deployer.address, "pending");
    if (cur > nonce) break;
    await new Promise(r => setTimeout(r, 6000));
  }
  // Verify code
  const code = await rawProvider.getCode(predictedAddr);
  if (!code || code === "0x") throw new Error("Deploy failed — no code at " + predictedAddr);
  console.log("  DatumClaimValidator deployed:", predictedAddr, "(" + (code.length / 2 - 1) + " bytes)");

  const cvIface = new Interface([
    "function setZKVerifier(address)",
    "function setCampaignValidator(address)",
    "function setForceKeccak(bool)",
    "function forceKeccak() view returns (bool)",
  ]);

  const settleIface = new Interface([
    "function setClaimValidator(address)",
    "function claimValidator() view returns (address)",
  ]);

  // Helper to send tx
  async function send(wallet: Wallet, to: string, iface: Interface, fn: string, args: any[]) {
    const data = iface.encodeFunctionData(fn, args);
    const n = await rawProvider.getTransactionCount(wallet.address, "pending");
    const tx = await wallet.sendTransaction({ to, data, gasLimit: 5_000_000n });
    console.log(`  ${fn}: TX ${tx.hash}`);
    for (let i = 0; i < 60; i++) {
      const cur = await rawProvider.getTransactionCount(wallet.address, "pending");
      if (cur > n) break;
      await new Promise(r => setTimeout(r, 6000));
    }
  }

  // Wire ClaimValidator
  console.log("\nWiring new ClaimValidator...");

  // 1. Set zkVerifier on new CV
  await send(deployer, predictedAddr, cvIface, "setZKVerifier", [A.zkVerifier]);
  console.log("  zkVerifier set to", A.zkVerifier);

  // 2. Set campaignValidator on new CV
  await send(deployer, predictedAddr, cvIface, "setCampaignValidator", [A.campaignValidator]);
  console.log("  campaignValidator set to", A.campaignValidator);

  // 3. Set forceKeccak(true)
  await send(deployer, predictedAddr, cvIface, "setForceKeccak", [true]);
  console.log("  forceKeccak set to true");

  // 4. Point Settlement to new ClaimValidator
  // Need to check if deployer owns Settlement or if Timelock does
  const settleOwnerSel = "0x8da5cb5b"; // owner()
  const ownerResult = await rawProvider.call({ to: A.settlement, data: settleOwnerSel });
  const settleOwner = "0x" + ownerResult.slice(26);
  console.log("  Settlement owner:", settleOwner);

  if (settleOwner.toLowerCase() === deployer.address.toLowerCase()) {
    await send(deployer, A.settlement, settleIface, "setClaimValidator", [predictedAddr]);
    console.log("  Settlement.claimValidator updated to", predictedAddr);
  } else {
    console.log("  WARNING: Settlement owned by", settleOwner, "— cannot update claimValidator directly");
    console.log("  You need to call Settlement.setClaimValidator(" + predictedAddr + ") via Timelock");
  }

  // Verify
  const cvResult = await rawProvider.call({ to: A.settlement, data: settleIface.encodeFunctionData("claimValidator", []).slice(0, 10) + "0".repeat(56) });
  // Actually, claimValidator() has no args
  const cvCheck = await rawProvider.call({ to: A.settlement, data: "0x" + require("ethers").keccak256(new TextEncoder().encode("claimValidator()")).slice(2, 10) });
  console.log("  Settlement.claimValidator now:", "0x" + cvCheck.slice(26));

  const fkResult = await rawProvider.call({ to: predictedAddr, data: cvIface.encodeFunctionData("forceKeccak", []) });
  console.log("  forceKeccak:", fkResult);

  // Update deployed-addresses-evm.json
  A.claimValidator = predictedAddr;
  A.deployedAt = new Date().toISOString();
  fs.writeFileSync(addrFile, JSON.stringify(A, null, 2) + "\n");
  console.log("\nUpdated deployed-addresses-evm.json");
  console.log("Done! Re-run benchmarks now.");
}

main().catch(console.error);
