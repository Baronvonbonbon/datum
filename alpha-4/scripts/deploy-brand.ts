// Standalone deploy script for the brand registry + curator.
//
// Doesn't touch the rest of the protocol — these are standalone contracts.
// Run after the main deploy: npx hardhat run scripts/deploy-brand.ts --network polkadotTestnet
//
// Wires:
//   - DatumBrandRegistry — deployed only, no wiring needed.
//   - DatumBrandCurator — deployed + setCouncil(council) pointed at the
//     existing DatumCouncil from deployed-addresses.json.
//
// Updates deployed-addresses.json and extension/deployed-addresses.json.

import "dotenv/config";
import { JsonRpcProvider, Wallet, ContractFactory, Contract, getCreateAddress, formatEther } from "ethers";
import { readFileSync, writeFileSync, copyFileSync } from "fs";
import { resolve } from "path";

const RPC = "https://eth-rpc-testnet.polkadot.io/";
const TX_OPTS = { gasLimit: 5_000_000n };
const ADDR_PATH = resolve(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_PATH = resolve(__dirname, "..", "extension", "deployed-addresses.json");

async function waitForCode(provider: JsonRpcProvider, addr: string, maxWait = 120) {
  for (let i = 0; i < maxWait; i++) {
    const code = await provider.getCode(addr);
    if (code && code !== "0x") return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting for code at ${addr.slice(0, 10)}… (${i}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for code at ${addr}`);
}

async function deployContract(
  factory: ContractFactory,
  signer: Wallet,
  provider: JsonRpcProvider,
  name: string,
  args: any[] = []
): Promise<string> {
  const deployTx = await factory.getDeployTransaction(...args);
  const nonce = await provider.getTransactionCount(signer.address);
  const tx = await signer.sendTransaction({ ...deployTx, nonce, ...TX_OPTS });
  console.log(`  ${name}: tx ${tx.hash}`);
  const addr = getCreateAddress({ from: signer.address, nonce });
  await waitForCode(provider, addr);
  console.log(`  ${name}: ${addr}`);
  return addr;
}

async function main() {
  const provider = new JsonRpcProvider(RPC);
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("DEPLOYER_PRIVATE_KEY not in env");
  const deployer = new Wallet(key, provider);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${formatEther(await provider.getBalance(deployer.address))} PAS`);

  const addrs = JSON.parse(readFileSync(ADDR_PATH, "utf8"));
  if (!addrs.council) throw new Error("council not in deployed-addresses.json — deploy main set first");

  // ── DatumBrandRegistry ──
  console.log("\n[1/2] Deploying DatumBrandRegistry...");
  const Registry = await (await import("hardhat")).ethers.getContractFactory("DatumBrandRegistry", deployer);
  const registryAddr = await deployContract(Registry, deployer, provider, "DatumBrandRegistry");

  // ── DatumBrandCurator ──
  console.log("\n[2/2] Deploying DatumBrandCurator...");
  const Curator = await (await import("hardhat")).ethers.getContractFactory("DatumBrandCurator", deployer);
  const curatorAddr = await deployContract(Curator, deployer, provider, "DatumBrandCurator");

  // ── Wire curator → council ──
  console.log("\nWiring DatumBrandCurator.setCouncil(" + addrs.council + ")...");
  const curator = new Contract(
    curatorAddr,
    ["function setCouncil(address) external", "function council() view returns (address)"],
    deployer
  );
  {
    const nonce = await provider.getTransactionCount(deployer.address);
    const tx = await curator.setCouncil(addrs.council, { ...TX_OPTS, nonce });
    console.log(`  setCouncil tx ${tx.hash}`);
    for (let i = 0; i < 90; i++) {
      const cur = await provider.getTransactionCount(deployer.address);
      if (cur > nonce) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    const live = await curator.council();
    if (String(live).toLowerCase() !== String(addrs.council).toLowerCase()) {
      throw new Error(`Council wiring failed — read back ${live}, expected ${addrs.council}`);
    }
    console.log(`  ✓ council wired`);
  }

  // ── Persist ──
  addrs.brandRegistry = registryAddr;
  addrs.brandCurator = curatorAddr;
  addrs.brandsDeployedAt = new Date().toISOString();
  writeFileSync(ADDR_PATH, JSON.stringify(addrs, null, 2) + "\n");
  copyFileSync(ADDR_PATH, EXT_ADDR_PATH);
  console.log(`\nWrote ${ADDR_PATH}`);
  console.log(`Wrote ${EXT_ADDR_PATH}`);

  console.log("\n=== Brand deploy complete ===");
  console.log(`  brandRegistry  ${registryAddr}`);
  console.log(`  brandCurator   ${curatorAddr}`);
  console.log(`  council        ${addrs.council}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
