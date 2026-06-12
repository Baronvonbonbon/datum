// register-registry-backfill.ts — one-shot backfill of the DatumGovernanceRouter
// registry for an ALREADY-deployed stack.
//
// The base deploy.ts only registered the upgrade-laddered contracts. This script
// adds the registry-only set (token plane, advertiser-fraud track, stateless
// verifiers, relay-gov lane) plus the separately-deployed brand layer, so the
// webapp can resolve *every* user-facing contract through router.currentAddrOf()
// — making the router address the single thing that must stay fresh on the
// client across redeploys.
//
// Safe to re-run: register() is onlyOwner and reverts if a name is already set,
// so we read currentAddrOf first and skip anything already pointing at the right
// address (and refuse to clobber a different one — use governance upgradeContract
// for that). Uses the same raw-provider + nonce-polling workaround as deploy.ts
// for Paseo's null-receipt quirk.
//
// Run: npx hardhat run scripts/register-registry-backfill.ts --network polkadotTestnet
import { ethers } from "ethers";
import { Wallet, JsonRpcProvider } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const ZERO = "0x" + "0".repeat(40);

// Brand layer is a separate deploy and is NOT in deployed-addresses.json.
// Keep these in sync with web/src/shared/networks.ts (the 2026-05-26 brand deploy).
const BRAND_ADDRESSES: Record<string, string> = {
  brandRegistry: "0x1d1370E261dca558962b176FaD5851E0d5Ef388e",
  brandCurator:  "0x8E7F392aB97D2D9c099820aa0aB2c6255d0d307B",
};

// Names to backfill. Must mirror REGISTRY_ONLY_KEYS in deploy.ts plus the brand
// layer. Each is registered under its own name (keccak256 of the string below).
const KEYS = [
  "attestationVerifier",
  "advertiserStake",
  "advertiserGovernance",
  "interestCommitments",
  "tagCurator",
  "relayStake",
  "relayGovernance",
  "wrapper",
  "mintAuthority",
  "vesting",
  "feeShare",
  "brandRegistry",
  "brandCurator",
];

const nameKey = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name));

async function waitForNonce(provider: JsonRpcProvider, address: string, targetNonce: number, maxWait = 120) {
  for (let i = 0; i < maxWait; i++) {
    if ((await provider.getTransactionCount(address)) > targetNonce) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting for confirmation (${i}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

async function main() {
  const rpcUrl = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
  const provider = new JsonRpcProvider(rpcUrl);
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("Set DEPLOYER_PRIVATE_KEY in alpha-core/.env");
  const wallet = new Wallet(key, provider);

  const addrPath = path.join(__dirname, "..", "deployed-addresses.json");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8")) as Record<string, string>;
  const router = addresses.governanceRouter;
  if (!router) throw new Error("governanceRouter missing from deployed-addresses.json");

  const merged: Record<string, string> = { ...addresses, ...BRAND_ADDRESSES };

  console.log(`Router:   ${router}`);
  console.log(`Deployer: ${wallet.address}`);

  // Refuse to run unless the deployer still owns the router (register is onlyOwner).
  const ownerIface = new ethers.Interface(["function owner() view returns (address)"]);
  const ownerRet = await provider.call({ to: router, data: ownerIface.encodeFunctionData("owner") });
  const owner = "0x" + ownerRet.slice(-40);
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`Router owner is ${owner}, not the deployer ${wallet.address}. ` +
      `register() is onlyOwner — backfill must be run by the owner (or via governance).`);
  }

  const readIface = new ethers.Interface(["function currentAddrOf(bytes32) view returns (address)"]);
  const regIface = new ethers.Interface(["function register(bytes32 name, address addr) external"]);
  const TX_GAS_LIMIT = 500000000n;
  const TX_GAS_PRICE = 1000000000000n;

  let registered = 0, skipped = 0, conflicts = 0;
  for (const name of KEYS) {
    const target = merged[name];
    if (!target || target === ZERO) { console.log(`  SKIP ${name}: no address`); skipped++; continue; }

    const cur = "0x" + (await provider.call({ to: router, data: readIface.encodeFunctionData("currentAddrOf", [nameKey(name)]) })).slice(-40);
    if (cur.toLowerCase() === target.toLowerCase()) { console.log(`  OK   ${name}: already registered`); skipped++; continue; }
    if (cur !== ZERO) { console.warn(`  CONFLICT ${name}: registered at ${cur}, not ${target} — use upgradeContract`); conflicts++; continue; }

    const nonce = await provider.getTransactionCount(wallet.address);
    await wallet.sendTransaction({
      to: router,
      data: regIface.encodeFunctionData("register", [nameKey(name), target]),
      gasLimit: TX_GAS_LIMIT, gasPrice: TX_GAS_PRICE, type: 0, nonce,
    });
    await waitForNonce(provider, wallet.address, nonce);

    const after = "0x" + (await provider.call({ to: router, data: readIface.encodeFunctionData("currentAddrOf", [nameKey(name)]) })).slice(-40);
    if (after.toLowerCase() === target.toLowerCase()) { console.log(`  REGISTERED ${name} -> ${target}`); registered++; }
    else { console.error(`  FAILED ${name}: still ${after} after tx`); conflicts++; }
  }

  console.log(`\nDone. registered=${registered} skipped=${skipped} conflicts=${conflicts}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
