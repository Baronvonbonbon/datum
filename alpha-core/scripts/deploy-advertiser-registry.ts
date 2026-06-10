// Deploy + wire DatumAdvertiserRegistry — STAGED for the queued contract upgrade.
//
// This is a PURE ADDITION under the DatumUpgradable redeploy-migrate-rewire model:
// deploy → setRouter → record the address → swap the relay from its interim
// ADVERTISER_COSIGNERS static map to on-chain profileHash discovery. There is NO
// state migration (it's a brand-new contract), so it's the lowest-risk upgrade step.
//
//   npx hardhat run scripts/deploy-advertiser-registry.ts --network polkadotTestnet
//
// Re-run safe: reuses an existing advertiserRegistry (with code) and skips the
// lock-once setRouter if already wired. Uses the raw-provider + nonce-poll pattern
// from deploy.ts (Paseo getTransactionReceipt returns null for confirmed txs).
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

const ZERO = "0x0000000000000000000000000000000000000000";
const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_FILE = path.join(__dirname, "..", "extension", "deployed-addresses.json");

async function waitForNonce(provider: JsonRpcProvider, addr: string, prevNonce: number, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if ((await provider.getTransactionCount(addr)) > prevNonce) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("nonce did not advance after 120s — check the explorer");
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const isPaseo = net.chainId === 420420417n;
  const rpcUrl = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io";
  const rawProvider = new JsonRpcProvider(rpcUrl);
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("set DEPLOYER_PRIVATE_KEY");
  const deployer = new Wallet(key, rawProvider);
  const GAS_LIMIT = isPaseo ? 500_000_000n : 15_000_000n;
  const GAS_PRICE = isPaseo ? 1_000_000_000_000n : 1_000_000_000n;

  const addresses = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));
  if (!addresses.pauseRegistry) throw new Error("deployed-addresses.json missing pauseRegistry");
  if (!addresses.governanceRouter) throw new Error("deployed-addresses.json missing governanceRouter");

  console.log(`Deployer: ${deployer.address}  chainId: ${net.chainId}`);

  // 1. Deploy (reuse if present + has code).
  let registryAddr: string = addresses.advertiserRegistry;
  if (registryAddr && registryAddr !== ZERO && (await rawProvider.getCode(registryAddr)) !== "0x") {
    console.log(`DatumAdvertiserRegistry: reusing ${registryAddr}`);
  } else {
    const factory = await ethers.getContractFactory("DatumAdvertiserRegistry");
    const deployTx = await factory.getDeployTransaction(addresses.pauseRegistry);
    const nonce = await rawProvider.getTransactionCount(deployer.address);
    registryAddr = ethers.getCreateAddress({ from: deployer.address, nonce });
    const tx = await deployer.sendTransaction({ data: deployTx.data, gasLimit: GAS_LIMIT, type: 0, gasPrice: GAS_PRICE });
    console.log(`DatumAdvertiserRegistry: tx ${tx.hash} (nonce ${nonce}) → ${registryAddr}`);
    await waitForNonce(rawProvider, deployer.address, nonce);
    if ((await rawProvider.getCode(registryAddr)) === "0x") throw new Error(`no code at ${registryAddr}`);
    addresses.advertiserRegistry = registryAddr;
    fs.writeFileSync(ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n");
  }

  // 2. Wire the governance router (setRouter is lock-once — skip if already set).
  const reg = await ethers.getContractAt("DatumAdvertiserRegistry", registryAddr, deployer);
  const currentRouter: string = await reg.router();
  if (currentRouter === ZERO) {
    const data = reg.interface.encodeFunctionData("setRouter", [addresses.governanceRouter]);
    const nonce = await rawProvider.getTransactionCount(deployer.address);
    let gas = GAS_LIMIT;
    try { gas = (await deployer.estimateGas({ to: registryAddr, data })) * 2n; } catch { /* fall back to GAS_LIMIT */ }
    const tx = await deployer.sendTransaction({ to: registryAddr, data, gasLimit: gas, type: 0, gasPrice: GAS_PRICE });
    console.log(`setRouter(${addresses.governanceRouter}): tx ${tx.hash}`);
    await waitForNonce(rawProvider, deployer.address, nonce);
  } else {
    console.log(`router already wired: ${currentRouter}`);
  }

  // 3. Mirror addresses into the extension bundle (demo/extension read advertiserRegistry).
  try { fs.writeFileSync(EXT_ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n"); } catch { /* optional */ }

  console.log(`\n✅ DatumAdvertiserRegistry deployed + wired: ${registryAddr}`);
  console.log(`\nNEXT — relay config swap (datum-labs/relay):`);
  console.log(`  • Set ADVERTISER_REGISTRY=${registryAddr}; relay resolves`);
  console.log(`    getCampaignAdvertiser → registry.getAdvertiserProfileHash → metadata → cosigner URL,`);
  console.log(`    retiring the interim ADVERTISER_COSIGNERS static map.`);
  console.log(`  • Advertisers publish endpoints: setAdvertiserProfile(<ipfs cid>) (metadata carries { cosignerUrl }).`);
  console.log(`  • Later (stateful Settlement upgrade): point DatumDualSigSettlement at the registry`);
  console.log(`    for advertiserRelaySigner reads, in place of DatumCampaigns.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
