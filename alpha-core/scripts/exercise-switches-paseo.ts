// exercise-switches-paseo.ts — exercise the live emission + sidecar switches in
// every case, then restore the system to normal (both ON).
//
// Cases covered:
//   1. owner flips emissionEnabled OFF -> read -> ON -> read
//   2. owner flips tokenRewardsEnabled OFF -> read -> ON -> read
//   3. owner per-token block on/off -> read
//   4. authority: a non-authority key is REJECTED (eth_call, no tx)
//   5. wiring: ParameterGovernance + Council set; Settlement points at the
//      switch-enabled instances (so the switches sit in the settle path)
//
// Read-back uses eth_call; flips are real txs from the deployer (owner), with
// the Paseo nonce-poll confirmation. Ends with both switches ON.
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
  for (let i = 0; i < tries; i++) {
    if ((await p.getTransactionCount(a)) > prev) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`nonce did not advance past ${prev}`);
}

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  (" + detail + ")" : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  const rpc = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
  const provider = new JsonRpcProvider(rpc);
  const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  const stranger = process.env.BOB_PRIVATE_KEY ? new Wallet(process.env.BOB_PRIVATE_KEY, provider) : null;
  const A = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"));

  const coord = await (async () => "0x" + (await provider.call({ to: A.settlement, data: new ethers.Interface(["function mintCoordinator() view returns(address)"]).encodeFunctionData("mintCoordinator") })).slice(-40))();
  const vault = await (async () => "0x" + (await provider.call({ to: A.settlement, data: new ethers.Interface(["function tokenRewardVault() view returns(address)"]).encodeFunctionData("tokenRewardVault") })).slice(-40))();
  console.log(`Settlement ${A.settlement}\n  -> mintCoordinator  ${coord}\n  -> tokenRewardVault ${vault}\n`);

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
  const reverts = async (from: string, to: string, frag: string, name: string, args: any[]) => {
    const i = new ethers.Interface([`function ${frag}`]);
    try { await provider.call({ to, from, data: i.encodeFunctionData(name, args) }); return false; }
    catch { return true; }
  };

  // ── 1. emission switch ──
  console.log("Emission switch (DatumMintCoordinator):");
  await flip(coord, "setEmissionEnabled(bool)", "setEmissionEnabled", [false]);
  check("emissionEnabled == false after OFF", (await view(coord, "emissionEnabled() view returns(bool)", "emissionEnabled")) === false);
  await flip(coord, "setEmissionEnabled(bool)", "setEmissionEnabled", [true]);
  check("emissionEnabled == true after ON", (await view(coord, "emissionEnabled() view returns(bool)", "emissionEnabled")) === true);

  // ── 2. sidecar master switch ──
  console.log("Sidecar master switch (DatumTokenRewardVault):");
  await flip(vault, "setTokenRewardsEnabled(bool)", "setTokenRewardsEnabled", [false]);
  check("tokenRewardsEnabled == false after OFF", (await view(vault, "tokenRewardsEnabled() view returns(bool)", "tokenRewardsEnabled")) === false);
  await flip(vault, "setTokenRewardsEnabled(bool)", "setTokenRewardsEnabled", [true]);
  check("tokenRewardsEnabled == true after ON", (await view(vault, "tokenRewardsEnabled() view returns(bool)", "tokenRewardsEnabled")) === true);

  // ── 3. per-token block ──
  console.log("Per-token block:");
  const token = A.wrapper || wallet.address; // any non-zero address as a probe token
  await flip(vault, "setTokenRewardBlocked(address,bool)", "setTokenRewardBlocked", [token, true]);
  check(`tokenRewardBlocked[${token.slice(0,10)}] == true`, (await view(vault, "tokenRewardBlocked(address) view returns(bool)", "tokenRewardBlocked", [token])) === true);
  await flip(vault, "setTokenRewardBlocked(address,bool)", "setTokenRewardBlocked", [token, false]);
  check(`tokenRewardBlocked[${token.slice(0,10)}] == false`, (await view(vault, "tokenRewardBlocked(address) view returns(bool)", "tokenRewardBlocked", [token])) === false);

  // ── 4. authority: a non-authority key is rejected ──
  console.log("Authority (non-authority rejected):");
  if (stranger) {
    check("stranger setEmissionEnabled reverts", await reverts(stranger.address, coord, "setEmissionEnabled(bool)", "setEmissionEnabled", [false]));
    check("stranger setTokenRewardsEnabled reverts", await reverts(stranger.address, vault, "setTokenRewardsEnabled(bool)", "setTokenRewardsEnabled", [false]));
  } else {
    console.log("  SKIP — no BOB_PRIVATE_KEY in .env");
  }

  // ── 5. wiring ──
  console.log("Wiring (authorities + settle-path):");
  if (A.parameterGovernance) {
    check("coord.parameterGovernance == PG", (await view(coord, "parameterGovernance() view returns(address)", "parameterGovernance")).toLowerCase() === A.parameterGovernance.toLowerCase());
    check("vault.parameterGovernance == PG", (await view(vault, "parameterGovernance() view returns(address)", "parameterGovernance")).toLowerCase() === A.parameterGovernance.toLowerCase());
  }
  if (A.council) {
    check("coord.council == Council", (await view(coord, "council() view returns(address)", "council")).toLowerCase() === A.council.toLowerCase());
    check("vault.council == Council", (await view(vault, "council() view returns(address)", "council")).toLowerCase() === A.council.toLowerCase());
  }
  check("Settlement.mintCoordinator is switch-enabled", await (async () => { try { await view(coord, "emissionEnabled() view returns(bool)", "emissionEnabled"); return true; } catch { return false; } })());
  check("Settlement.tokenRewardVault is switch-enabled", await (async () => { try { await view(vault, "tokenRewardsEnabled() view returns(bool)", "tokenRewardsEnabled"); return true; } catch { return false; } })());

  console.log(`\n${pass} passed, ${fail} failed. Switches left ON (normal operation).`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
