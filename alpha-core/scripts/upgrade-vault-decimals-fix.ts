// upgrade-vault-decimals-fix.ts — upgrade the production DatumTokenRewardVault
// to v2 (asset-gate ERC-20 probe hardened to not require decimals(), so native
// pallet_assets precompiles can be allowlisted).
//
// Clean migrate: the current vault (v1) exposes every getter the v2 _migrate
// reads, so router.upgradeContract carries the mode + allowlist (WDATUM/USDC/
// USDt) + token enumeration forward atomically. Verified no residual funds
// (vault balance 0), so no migrateFundsTo. Idempotent via version()==2.
//
// Run: npx hardhat run scripts/upgrade-vault-decimals-fix.ts --network polkadotTestnet
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const ZERO = "0x" + "0".repeat(40);
const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_FILE = path.join(__dirname, "..", "extension", "deployed-addresses.json");
const STATE_FILE = path.join(__dirname, "..", "vault-decimals-upgrade-state.json");
const GAS = { gasLimit: 500_000_000n, gasPrice: 1_000_000_000_000n, type: 0 as const };
// Compliant seed — fallback only (migrate should carry these already).
const SEED: Record<string, string | undefined> = {
  USDC: "0x0000053900000000000000000000000001200000",
  USDt: "0x000007C000000000000000000000000001200000",
};

async function waitForNonce(p: JsonRpcProvider, a: string, prev: number, tries = 120) {
  for (let i = 0; i < tries; i++) { if ((await p.getTransactionCount(a)) > prev) return; if (i % 10 === 0 && i > 0) console.log(`    ...awaiting (${i}s)`); await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`nonce stuck > ${prev}`);
}

async function main() {
  const provider = new JsonRpcProvider(process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/");
  const w = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  const A = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));

  const view = async (to: string, sig: string, n: string, args: any[] = []) => { const i = new ethers.Interface([`function ${sig}`]); return i.decodeFunctionResult(n, await provider.call({ to, data: i.encodeFunctionData(n, args) }))[0]; };
  const send = async (to: string, frag: string, n: string, args: any[]) => { const i = new ethers.Interface([`function ${frag}`]); const nonce = await provider.getTransactionCount(w.address); await w.sendTransaction({ to, data: i.encodeFunctionData(n, args), ...GAS, nonce }); await waitForNonce(provider, w.address, nonce); };
  const codeOk = async (a?: string) => !!a && (await provider.getCode(a)) !== "0x";
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  console.log(`Vault decimals-fix upgrade | deployer ${w.address}`);

  // Guards
  if ((await view(A.settlement, "owner() view returns(address)", "owner")).toLowerCase() !== w.address.toLowerCase()) throw new Error("Settlement not deployer-owned");
  if (await view(A.settlement, "plumbingLocked() view returns(bool)", "plumbingLocked")) throw new Error("Settlement plumbing locked");

  const oldVault = await view(A.settlement, "tokenRewardVault() view returns(address)", "tokenRewardVault");
  const liveVer = (await view(oldVault, "version() view returns(uint256)", "version")).toString();
  if (liveVer === "2") { console.log("Already upgraded — live vault is v2. Nothing to do."); return; }
  console.log(`  current vault ${oldVault} (v${liveVer})`);

  // Deploy v2 (reuse partial run)
  const state: any = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  let newVault = state.tokenRewardVault;
  if (!(await codeOk(newVault))) {
    console.log("Deploying v2 DatumTokenRewardVault…");
    const f = (await ethers.getContractFactory("DatumTokenRewardVault")).connect(w);
    const tx = await f.getDeployTransaction(A.campaigns);
    const nonce = await provider.getTransactionCount(w.address);
    await w.sendTransaction({ ...tx, ...GAS, nonce });
    await waitForNonce(provider, w.address, nonce);
    newVault = ethers.getCreateAddress({ from: w.address, nonce });
    if (!(await codeOk(newVault))) throw new Error("vault no code");
    state.tokenRewardVault = newVault; fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
  console.log(`  new vault ${newVault} (v${(await view(newVault, "version() view returns(uint256)", "version")).toString()})`);

  // settlement pointer (NOT carried by _migrate)
  if (eq(await view(newVault, "settlement() view returns(address)", "settlement"), ZERO)) { await send(newVault, "setSettlement(address)", "setSettlement", [A.settlement]); console.log("  SET new.settlement"); }

  // router upgradeContract → atomic freeze(old) + new.migrate(old) (carries mode + allowlist + enumeration)
  const nameKey = ethers.keccak256(ethers.toUtf8Bytes("tokenRewardVault"));
  const reg = "0x" + (await provider.call({ to: A.governanceRouter, data: new ethers.Interface(["function currentAddrOf(bytes32) view returns(address)"]).encodeFunctionData("currentAddrOf", [nameKey]) })).slice(-40);
  if (!eq(reg, newVault)) { await send(A.governanceRouter, "upgradeContract(bytes32,address)", "upgradeContract", [nameKey, newVault]); console.log("  ROUTER upgradeContract(tokenRewardVault) — migrated state, froze old"); }

  // verify migrate carried the allowlist; fallback-seed if not
  const carried = Number(await view(newVault, "allowedTokenCount() view returns(uint256)", "allowedTokenCount"));
  console.log(`  migrated allowedTokenCount=${carried}, assetAllowlistEnabled=${await view(newVault, "assetAllowlistEnabled() view returns(bool)", "assetAllowlistEnabled")}`);
  const seed: Record<string, string | undefined> = { WDATUM: A.wrapper, ...SEED };
  for (const [sym, addr] of Object.entries(seed)) {
    if (!addr) continue;
    if (await view(newVault, "assetAllowed(address) view returns(bool)", "assetAllowed", [addr])) { console.log(`  OK allowlisted ${sym}`); continue; }
    await send(newVault, "setAssetAllowed(address,bool)", "setAssetAllowed", [addr, true]); console.log(`  (fallback) ALLOWLIST ${sym}`);
  }

  // re-point Settlement
  if (!eq(await view(A.settlement, "tokenRewardVault() view returns(address)", "tokenRewardVault"), newVault)) { await send(A.settlement, "setTokenRewardVault(address)", "setTokenRewardVault", [newVault]); console.log("  SET Settlement.tokenRewardVault"); }

  // persist
  A.tokenRewardVault = newVault;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(A, null, 2) + "\n");
  if (fs.existsSync(EXT_ADDR_FILE)) { const E = JSON.parse(fs.readFileSync(EXT_ADDR_FILE, "utf8")); E.tokenRewardVault = newVault; fs.writeFileSync(EXT_ADDR_FILE, JSON.stringify(E, null, 2) + "\n"); }
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  console.log(`\nDone. Production vault → ${newVault} (v2, decimals-fix). Re-sync networks.ts + DEPLOY_VERSION; rebuild extension.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
