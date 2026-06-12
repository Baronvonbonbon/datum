// exercise-switches-paseo.ts — exercise the live emission + sidecar switches in
// every case against the post-upgrade topology, then restore both to ON.
//
// Topology after the emission-switch→engine fix:
//   Settlement.mintCoordinator = OLD coordinator (immutably-authorized minter)
//   oldCoordinator.emissionEngine = NEW engine  (emissionEnabled switch)
//   Settlement.tokenRewardVault = vault         (tokenRewardsEnabled + per-token)
//
// Cases: emission on/off, sidecar on/off, per-token block on/off, governance
// authorities wired, and the mint chain intact (so emission actually mints when
// on). Flips are real owner txs; reads via eth_call. Ends with both switches ON.
//
// Run:  npx hardhat run scripts/exercise-switches-paseo.ts --network polkadotTestnet
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const GAS_LIMIT = 500_000_000n;
const GAS_PRICE = 1_000_000_000_000n;

async function waitForNonce(p: JsonRpcProvider, a: string, prev: number, tries = 120) {
  for (let i = 0; i < tries; i++) { if ((await p.getTransactionCount(a)) > prev) return; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`nonce did not advance past ${prev}`);
}

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  (" + detail + ")" : ""}`); ok ? pass++ : fail++; };

async function main() {
  const rpc = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
  const provider = new JsonRpcProvider(rpc);
  const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  const A = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"));
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  const view = async (to: string, sig: string, name: string, args: any[] = []) => {
    const i = new ethers.Interface([`function ${sig}`]);
    return i.decodeFunctionResult(name, await provider.call({ to, data: i.encodeFunctionData(name, args) }))[0];
  };
  const flip = async (to: string, frag: string, name: string, args: any[]) => {
    const i = new ethers.Interface([`function ${frag}`]);
    const nonce = await provider.getTransactionCount(wallet.address);
    await wallet.sendTransaction({ to, data: i.encodeFunctionData(name, args), gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE, type: 0, nonce });
    await waitForNonce(provider, wallet.address, nonce);
  };

  const coord = "0x" + (await provider.call({ to: A.settlement, data: new ethers.Interface(["function mintCoordinator() view returns(address)"]).encodeFunctionData("mintCoordinator") })).slice(-40);
  const vault = "0x" + (await provider.call({ to: A.settlement, data: new ethers.Interface(["function tokenRewardVault() view returns(address)"]).encodeFunctionData("tokenRewardVault") })).slice(-40);
  const engine = await view(coord, "emissionEngine() view returns(address)", "emissionEngine");
  console.log(`Settlement ${A.settlement}\n  -> mintCoordinator ${coord}\n  -> emissionEngine  ${engine}\n  -> tokenRewardVault ${vault}\n`);

  // ── 1. Emission switch (engine) ──
  console.log("Emission switch (DatumEmissionEngine):");
  await flip(engine, "setEmissionEnabled(bool)", "setEmissionEnabled", [false]);
  check("emissionEnabled == false after OFF", (await view(engine, "emissionEnabled() view returns(bool)", "emissionEnabled")) === false);
  await flip(engine, "setEmissionEnabled(bool)", "setEmissionEnabled", [true]);
  check("emissionEnabled == true after ON", (await view(engine, "emissionEnabled() view returns(bool)", "emissionEnabled")) === true);

  // ── 2. Sidecar master switch (vault) ──
  console.log("Sidecar master switch (DatumTokenRewardVault):");
  await flip(vault, "setTokenRewardsEnabled(bool)", "setTokenRewardsEnabled", [false]);
  check("tokenRewardsEnabled == false after OFF", (await view(vault, "tokenRewardsEnabled() view returns(bool)", "tokenRewardsEnabled")) === false);
  await flip(vault, "setTokenRewardsEnabled(bool)", "setTokenRewardsEnabled", [true]);
  check("tokenRewardsEnabled == true after ON", (await view(vault, "tokenRewardsEnabled() view returns(bool)", "tokenRewardsEnabled")) === true);

  // ── 3. Per-token block ──
  console.log("Per-token block:");
  const token = A.wrapper || wallet.address;
  await flip(vault, "setTokenRewardBlocked(address,bool)", "setTokenRewardBlocked", [token, true]);
  check("tokenRewardBlocked == true", (await view(vault, "tokenRewardBlocked(address) view returns(bool)", "tokenRewardBlocked", [token])) === true);
  await flip(vault, "setTokenRewardBlocked(address,bool)", "setTokenRewardBlocked", [token, false]);
  check("tokenRewardBlocked == false", (await view(vault, "tokenRewardBlocked(address) view returns(bool)", "tokenRewardBlocked", [token])) === false);

  // ── 4. Governance authorities wired ──
  console.log("Authorities:");
  if (A.parameterGovernance) {
    check("engine.parameterGovernance == PG", eq(await view(engine, "parameterGovernance() view returns(address)", "parameterGovernance"), A.parameterGovernance));
    check("vault.parameterGovernance == PG", eq(await view(vault, "parameterGovernance() view returns(address)", "parameterGovernance"), A.parameterGovernance));
  }
  if (A.council) {
    check("engine.council == Council", eq(await view(engine, "council() view returns(address)", "council"), A.council));
    check("vault.council == Council", eq(await view(vault, "council() view returns(address)", "council"), A.council));
  }

  // ── 5. Mint chain intact (emission actually mints when on) ──
  console.log("Mint chain:");
  const authSettlement = await view(A.mintAuthority, "settlement() view returns(address)", "settlement");
  check("authority.settlement == live coordinator", eq(authSettlement, coord), "coordinator is the authorized minter");
  check("engine.settlement == live coordinator", eq(await view(engine, "settlement() view returns(address)", "settlement"), coord), "engine accepts the coordinator");
  check("engine has emissionEnabled switch", await (async () => { try { await view(engine, "emissionEnabled() view returns(bool)", "emissionEnabled"); return true; } catch { return false; } })());

  console.log(`\n${pass} passed, ${fail} failed. Switches left ON (normal operation).`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
