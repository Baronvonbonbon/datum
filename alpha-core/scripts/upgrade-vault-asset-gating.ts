// upgrade-vault-asset-gating.ts — redeploy DatumTokenRewardVault with the asset
// allowlist gate and seed the compliant initial allowlist.
//
// End state: switch-enabled + allowlist-gated vault, mode = Allowlist
// (compliant start), seeded with WDATUM + USDC + USDt (the live, ERC-20-valid
// trust-backed asset precompiles on Paseo). Settlement re-pointed at it.
//
// Preconditions (verified): deployer owns Settlement + old vault + is
// router.adminGovernor; Settlement.plumbingLocked false; old vault holds no
// funds (tokenCount 0) → clean migrate. Idempotent / re-run safe.
//
// Run: npx hardhat run scripts/upgrade-vault-asset-gating.ts --network polkadotTestnet
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const ZERO = "0x" + "0".repeat(40);
const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_FILE = path.join(__dirname, "..", "extension", "deployed-addresses.json");
const STATE_FILE = path.join(__dirname, "..", "vault-gating-upgrade-state.json");
const GAS_LIMIT = 500_000_000n;
const GAS_PRICE = 1_000_000_000_000n;

// Compliant initial allowlist (Paseo). WDATUM resolved from deployed-addresses;
// the natives are live trust-backed asset ERC-20 precompiles (verified
// decimals()+totalSupply() respond). STINK responds too but is left for
// governance to add (non-stablecoin meme token).
const NATIVE_SEED: Record<string, string> = {
  USDC: "0x0000053900000000000000000000000001200000",
  USDt: "0x000007C000000000000000000000000001200000",
};

async function waitForNonce(p: JsonRpcProvider, a: string, prev: number, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if ((await p.getTransactionCount(a)) > prev) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...awaiting confirmation (${i}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`nonce did not advance past ${prev}`);
}

async function main() {
  const rpc = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
  const provider = new JsonRpcProvider(rpc);
  const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  const A = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));

  const view = async (to: string, sig: string, name: string, args: any[] = []) => {
    const i = new ethers.Interface([`function ${sig}`]);
    return i.decodeFunctionResult(name, await provider.call({ to, data: i.encodeFunctionData(name, args) }))[0];
  };
  const send = async (to: string, frag: string, name: string, args: any[]) => {
    const i = new ethers.Interface([`function ${frag}`]);
    const nonce = await provider.getTransactionCount(wallet.address);
    await wallet.sendTransaction({ to, data: i.encodeFunctionData(name, args), gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE, type: 0, nonce });
    await waitForNonce(provider, wallet.address, nonce);
  };
  const hasFn = async (addr: string, sig: string, name: string) => {
    try { await view(addr, sig, name); return true; } catch { return false; }
  };
  const codeOk = async (a?: string) => !!a && (await provider.getCode(a)) !== "0x";
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  console.log(`Vault asset-gating upgrade | deployer ${wallet.address}`);

  // Guards
  if ((await view(A.settlement, "owner() view returns(address)", "owner")).toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Settlement not deployer-owned");
  if (await view(A.settlement, "plumbingLocked() view returns(bool)", "plumbingLocked")) throw new Error("Settlement plumbing locked");

  // Already upgraded?
  const liveVault = await view(A.settlement, "tokenRewardVault() view returns(address)", "tokenRewardVault");
  if (await hasFn(liveVault, "assetAllowlistEnabled() view returns(bool)", "assetAllowlistEnabled")) {
    console.log("Already upgraded — Settlement points at an asset-gated vault. Nothing to do.");
    return;
  }

  // Deploy (reuse partial run)
  const state: any = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  let newVault = state.tokenRewardVault;
  if (!(await codeOk(newVault))) {
    console.log("Deploying asset-gated DatumTokenRewardVault…");
    const factory = (await ethers.getContractFactory("DatumTokenRewardVault")).connect(wallet);
    const txReq = await factory.getDeployTransaction(A.campaigns);
    const nonce = await provider.getTransactionCount(wallet.address);
    await wallet.sendTransaction({ ...txReq, nonce, gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE, type: 0 });
    await waitForNonce(provider, wallet.address, nonce);
    newVault = ethers.getCreateAddress({ from: wallet.address, nonce });
    if (!(await codeOk(newVault))) throw new Error("vault has no code");
    state.tokenRewardVault = newVault; fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
  console.log(`  TokenRewardVault(new) ${newVault}`);

  // Wire (auto-migrate fails benignly: old vault lacks the new getters)
  const ensure = async (getter: string, frag: string, name: string, desired: string) => {
    const cur = (await view(newVault, `${getter}() view returns(address)`, getter)).toLowerCase();
    if (cur === desired.toLowerCase()) { console.log(`  OK ${name}=${desired}`); return; }
    if (cur !== ZERO) { console.log(`  SKIP ${name}: already ${cur}`); return; }
    await send(newVault, frag, name, [desired]); console.log(`  SET ${name}=${desired}`);
  };
  await ensure("settlement", "setSettlement(address)", "setSettlement", A.settlement);
  if (A.parameterGovernance) await ensure("parameterGovernance", "setParameterGovernance(address)", "setParameterGovernance", A.parameterGovernance);
  if (A.council) await ensure("council", "setCouncil(address)", "setCouncil", A.council);

  // Seed compliant allowlist (mode defaults to Allowlist=true)
  const seed: Record<string, string> = { WDATUM: A.wrapper, ...NATIVE_SEED };
  for (const [sym, addr] of Object.entries(seed)) {
    if (!addr) { console.log(`  SKIP seed ${sym}: no address`); continue; }
    if (await view(newVault, "assetAllowed(address) view returns(bool)", "assetAllowed", [addr])) { console.log(`  OK allowlisted ${sym}`); continue; }
    await send(newVault, "setAssetAllowed(address,bool)", "setAssetAllowed", [addr, true]);
    console.log(`  ALLOWLIST ${sym} ${addr}`);
  }
  console.log(`  assetAllowlistEnabled = ${await view(newVault, "assetAllowlistEnabled() view returns(bool)", "assetAllowlistEnabled")} (compliant)`);

  // Router registry (freezes old vault) + re-point Settlement
  const nameKey = ethers.keccak256(ethers.toUtf8Bytes("tokenRewardVault"));
  const reg = "0x" + (await provider.call({ to: A.governanceRouter, data: new ethers.Interface(["function currentAddrOf(bytes32) view returns(address)"]).encodeFunctionData("currentAddrOf", [nameKey]) })).slice(-40);
  if (!eq(reg, newVault)) { await send(A.governanceRouter, "upgradeContract(bytes32,address)", "upgradeContract", [nameKey, newVault]); console.log(`  ROUTER upgradeContract(tokenRewardVault) -> ${newVault}`); }
  if (!eq(await view(A.settlement, "tokenRewardVault() view returns(address)", "tokenRewardVault"), newVault)) {
    await send(A.settlement, "setTokenRewardVault(address)", "setTokenRewardVault", [newVault]); console.log(`  SET Settlement.tokenRewardVault=${newVault}`);
  }

  // Persist
  A.tokenRewardVault = newVault;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(A, null, 2) + "\n");
  if (fs.existsSync(EXT_ADDR_FILE)) { const E = JSON.parse(fs.readFileSync(EXT_ADDR_FILE, "utf8")); E.tokenRewardVault = newVault; fs.writeFileSync(EXT_ADDR_FILE, JSON.stringify(E, null, 2) + "\n"); }
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  console.log("\nDone. Sidecar gated in Allowlist mode (WDATUM + USDC + USDt). Re-sync networks.ts (tokenRewardVault) + DEPLOY_VERSION; rebuild extension.");
}

main().catch((e) => { console.error(e); process.exit(1); });
