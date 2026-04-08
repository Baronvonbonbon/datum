/**
 * redeploy-token-vault.ts — Redeploy DatumTokenRewardVault and rewire
 *
 * Needed when the vault contract is updated (e.g., adding withdrawTo)
 * and the existing deployed address is stale.
 *
 * Steps:
 *   1. Deploy new DatumTokenRewardVault(campaigns)
 *   2. Call newVault.setSettlement(settlement)
 *   3. Call settlement.setTokenRewardVault(newVault)
 *   4. Update deployed-addresses.json
 *
 * Usage:
 *   npx hardhat run scripts/redeploy-token-vault.ts --network polkadotTestnet
 */

import { ethers, network } from "hardhat";
import { JsonRpcProvider, Wallet, Interface, AbiCoder } from "ethers";
import * as fs from "fs";
import * as path from "path";

const TX_OPTS = { gasLimit: 500_000_000n, type: 0, gasPrice: 1_000_000_000_000n };

const DEPLOYER_KEY = "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8"; // alice

async function waitForNonce(provider: JsonRpcProvider, address: string, targetNonce: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await provider.getTransactionCount(address) > targetNonce) return;
    if (i % 15 === 0 && i > 0) process.stdout.write(`    ...waiting (${i}s)\n`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

async function main() {
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const provider = new JsonRpcProvider(rpcUrl);
  const deployer = new Wallet(DEPLOYER_KEY, provider);

  const addrFile = path.resolve(__dirname, "../deployed-addresses.json");
  const A = JSON.parse(fs.readFileSync(addrFile, "utf-8"));

  console.log("Redeploying DatumTokenRewardVault");
  console.log("  Deployer:", deployer.address);
  console.log("  campaigns:", A.campaigns);
  console.log("  settlement:", A.settlement);
  console.log("  Old vault:", A.tokenRewardVault);

  // 1. Deploy new vault
  const artifact = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "../artifacts/contracts/DatumTokenRewardVault.sol/DatumTokenRewardVault.json"),
    "utf-8",
  ));
  const constructorArgs = AbiCoder.defaultAbiCoder().encode(["address"], [A.campaigns]).slice(2);
  const deployData = artifact.bytecode + constructorArgs;

  const deployNonce = await provider.getTransactionCount(deployer.address);
  console.log("\n[1/3] Deploying DatumTokenRewardVault...");
  await deployer.sendTransaction({ data: deployData, value: 0n, ...TX_OPTS });
  await waitForNonce(provider, deployer.address, deployNonce);
  const newVault = ethers.getCreateAddress({ from: deployer.address, nonce: deployNonce });
  const code = await provider.getCode(newVault);
  if (code === "0x" || code.length < 4) throw new Error(`Deploy failed: no code at ${newVault}`);
  console.log("  New vault:", newVault);

  // 2. setSettlement on new vault
  const vaultIface = new Interface([
    "function setSettlement(address addr)",
    "function settlement() view returns (address)",
  ]);
  const settlementIface = new Interface([
    "function setTokenRewardVault(address addr)",
    "function tokenRewardVault() view returns (address)",
  ]);

  console.log("\n[2/3] newVault.setSettlement(settlement)...");
  const n2 = await provider.getTransactionCount(deployer.address);
  await deployer.sendTransaction({
    to: newVault,
    data: vaultIface.encodeFunctionData("setSettlement", [A.settlement]),
    value: 0n,
    ...TX_OPTS,
  });
  await waitForNonce(provider, deployer.address, n2);
  const vaultSettlement = (await provider.call({
    to: newVault,
    data: vaultIface.encodeFunctionData("settlement", []),
  }));
  const decodedSettlement = vaultIface.decodeFunctionResult("settlement", vaultSettlement)[0];
  console.log("  vault.settlement =", decodedSettlement);

  // 3. settlement.setTokenRewardVault(newVault)
  console.log("\n[3/3] settlement.setTokenRewardVault(newVault)...");
  const n3 = await provider.getTransactionCount(deployer.address);
  await deployer.sendTransaction({
    to: A.settlement,
    data: settlementIface.encodeFunctionData("setTokenRewardVault", [newVault]),
    value: 0n,
    ...TX_OPTS,
  });
  await waitForNonce(provider, deployer.address, n3);
  const settlementVault = (await provider.call({
    to: A.settlement,
    data: settlementIface.encodeFunctionData("tokenRewardVault", []),
  }));
  const decodedVault = settlementIface.decodeFunctionResult("tokenRewardVault", settlementVault)[0];
  console.log("  settlement.tokenRewardVault =", decodedVault);

  // 4. Update deployed-addresses.json
  A.tokenRewardVault = newVault;
  fs.writeFileSync(addrFile, JSON.stringify(A, null, 2));
  console.log("\ndeployed-addresses.json updated.");
  console.log("New tokenRewardVault:", newVault);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
