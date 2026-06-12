// upgrade-emission-switch-to-engine.ts — move the emission on/off switch onto a
// new DatumEmissionEngine and restore the authorized mint path.
//
// Background: the prior switch upgrade re-pointed Settlement at a NEW
// MintCoordinator, but the WDATUM mint chain is immutably anchored to the
// ORIGINAL coordinator (wrapper.mintAuthority immutable; authority.settlement
// lock-once = old coordinator). So the new coordinator can never mint. This
// fix routes Settlement back through the old (authorized) coordinator and puts
// the emission switch on the engine downstream of it — OFF => engine returns 0
// => no mint, mint chain untouched.
//
// End state:
//   Settlement.mintCoordinator   = OLD coordinator (authorized minter)
//   oldCoordinator.emissionEngine = NEW engine (emissionEnabled switch)
//   NEW engine.settlement         = OLD coordinator
//   Settlement.tokenRewardVault   = unchanged (switch-enabled vault)
//
// Idempotent / re-run safe. Run:
//   npx hardhat run scripts/upgrade-emission-switch-to-engine.ts --network polkadotTestnet
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const ZERO = "0x" + "0".repeat(40);
const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_FILE = path.join(__dirname, "..", "extension", "deployed-addresses.json");
const STATE_FILE = path.join(__dirname, "..", "engine-upgrade-state.json");
const OLD_COORD = "0x561E47cEB7F3D42a96D468b94F6e3F2B25eA07cC"; // the immutably-authorized minter
const GAS_LIMIT = 500_000_000n;
const GAS_PRICE = 1_000_000_000_000n;

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
  const addrEq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  console.log(`Emission-switch→engine upgrade | deployer ${wallet.address}`);

  // ── Guards ──
  const settlementOwner = (await view(A.settlement, "owner() view returns(address)", "owner")).toLowerCase();
  if (settlementOwner !== wallet.address.toLowerCase()) throw new Error(`Settlement owner ${settlementOwner} != deployer`);
  if (await view(A.settlement, "plumbingLocked() view returns(bool)", "plumbingLocked")) throw new Error("Settlement plumbing locked");
  const oldCoordOwner = (await view(OLD_COORD, "owner() view returns(address)", "owner")).toLowerCase();
  if (oldCoordOwner !== wallet.address.toLowerCase()) throw new Error(`Old coordinator owner ${oldCoordOwner} != deployer`);
  // sanity: old coordinator really is the authorized minter
  const authSettlement = await view(A.mintAuthority, "settlement() view returns(address)", "settlement");
  if (!addrEq(authSettlement, OLD_COORD)) throw new Error(`authority.settlement ${authSettlement} != old coordinator — abort`);

  // ── Already done? ──
  const liveCoord = await view(A.settlement, "mintCoordinator() view returns(address)", "mintCoordinator");
  const liveEngineOnCoord = await view(OLD_COORD, "emissionEngine() view returns(address)", "emissionEngine");
  if (addrEq(liveCoord, OLD_COORD) && (await hasFn(liveEngineOnCoord, "emissionEnabled() view returns(bool)", "emissionEnabled"))) {
    console.log("Already upgraded — Settlement uses old coordinator + switch-enabled engine. Nothing to do.");
    return;
  }

  // ── Deploy new engine (reuse partial run if present) ──
  const state: any = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  let newEngine = state.emissionEngine;
  if (!(await codeOk(newEngine))) {
    console.log("Deploying switch-enabled DatumEmissionEngine…");
    const factory = (await ethers.getContractFactory("DatumEmissionEngine")).connect(wallet);
    const txReq = await factory.getDeployTransaction();
    const nonce = await provider.getTransactionCount(wallet.address);
    await wallet.sendTransaction({ ...txReq, nonce, gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE, type: 0 });
    await waitForNonce(provider, wallet.address, nonce);
    newEngine = ethers.getCreateAddress({ from: wallet.address, nonce });
    if (!(await codeOk(newEngine))) throw new Error("engine has no code");
    state.emissionEngine = newEngine; fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
  console.log(`  EmissionEngine(new) ${newEngine}`);

  // ── Wire new engine (settlement = old coordinator; toggle authorities) ──
  const ensure = async (target: string, getter: string, frag: string, name: string, desired: string) => {
    const cur = (await view(target, `${getter}() view returns(address)`, getter)).toLowerCase();
    if (cur === desired.toLowerCase()) { console.log(`  OK ${name}=${desired}`); return; }
    if (cur !== ZERO) { console.log(`  SKIP ${name}: already ${cur}`); return; }
    await send(target, frag, name, [desired]); console.log(`  SET ${name}=${desired}`);
  };
  await ensure(newEngine, "settlement", "setSettlement(address)", "setSettlement", OLD_COORD);
  if (A.parameterGovernance) await ensure(newEngine, "parameterGovernance", "setParameterGovernance(address)", "setParameterGovernance", A.parameterGovernance);
  if (A.council) await ensure(newEngine, "council", "setCouncil(address)", "setCouncil", A.council);

  // ── Migrate emission-curve state + flip the router registry (freezes old engine) ──
  const nameKey = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));
  const regEngine = "0x" + (await provider.call({ to: A.governanceRouter, data: new ethers.Interface(["function currentAddrOf(bytes32) view returns(address)"]).encodeFunctionData("currentAddrOf", [nameKey("emissionEngine")]) })).slice(-40);
  if (!addrEq(regEngine, newEngine)) {
    await send(A.governanceRouter, "upgradeContract(bytes32,address)", "upgradeContract", [nameKey("emissionEngine"), newEngine]);
    console.log(`  ROUTER upgradeContract(emissionEngine) -> ${newEngine} (migrates curve state, freezes old engine)`);
  } else console.log(`  OK router[emissionEngine]=${newEngine}`);

  // ── Re-point old coordinator's engine to the new engine ──
  if (!addrEq(await view(OLD_COORD, "emissionEngine() view returns(address)", "emissionEngine"), newEngine)) {
    await send(OLD_COORD, "setEmissionEngine(address)", "setEmissionEngine", [newEngine]);
    console.log(`  SET oldCoordinator.emissionEngine=${newEngine}`);
  }

  // ── Re-point Settlement back to the authorized old coordinator ──
  if (!addrEq(await view(A.settlement, "mintCoordinator() view returns(address)", "mintCoordinator"), OLD_COORD)) {
    await send(A.settlement, "setMintCoordinator(address)", "setMintCoordinator", [OLD_COORD]);
    console.log(`  SET Settlement.mintCoordinator=${OLD_COORD}`);
  }

  // ── Point the router's mintCoordinator registry back at the live coordinator ──
  const regCoord = "0x" + (await provider.call({ to: A.governanceRouter, data: new ethers.Interface(["function currentAddrOf(bytes32) view returns(address)"]).encodeFunctionData("currentAddrOf", [nameKey("mintCoordinator")]) })).slice(-40);
  if (!addrEq(regCoord, OLD_COORD)) {
    await send(A.governanceRouter, "upgradeContract(bytes32,address)", "upgradeContract", [nameKey("mintCoordinator"), OLD_COORD]);
    console.log(`  ROUTER upgradeContract(mintCoordinator) -> ${OLD_COORD} (registry now matches Settlement)`);
  }

  // ── Persist ──
  A.emissionEngine = newEngine; A.mintCoordinator = OLD_COORD;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(A, null, 2) + "\n");
  if (fs.existsSync(EXT_ADDR_FILE)) {
    const E = JSON.parse(fs.readFileSync(EXT_ADDR_FILE, "utf8"));
    E.emissionEngine = newEngine; E.mintCoordinator = OLD_COORD;
    fs.writeFileSync(EXT_ADDR_FILE, JSON.stringify(E, null, 2) + "\n");
  }
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  console.log("\nDone. Mint path: Settlement -> old coordinator -> new engine (switch) -> authority -> wrapper.");
  console.log("Re-sync web/src/shared/networks.ts (mintCoordinator + emissionEngine) + bump DEPLOY_VERSION; rebuild extension.");
}

main().catch((e) => { console.error(e); process.exit(1); });
