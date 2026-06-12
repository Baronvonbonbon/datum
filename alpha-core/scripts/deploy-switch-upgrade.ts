// deploy-switch-upgrade.ts — live upgrade that puts the emission + ERC-sidecar
// on/off switches into the settle path.
//
// Redeploy-migrate-rewire for two contracts that gained governance switches:
//   DatumMintCoordinator  (emissionEnabled)
//   DatumTokenRewardVault (tokenRewardsEnabled + per-token block)
//
// Preconditions verified on the live deploy (2026-06-12): deployer owns
// Settlement + both targets + is router.adminGovernor; Settlement.plumbingLocked
// is false (pointers re-pointable); the vault holds NO funds (tokenCount 0), so
// there is nothing to freeze-migrate-sweep. That makes this a clean surgical
// swap with no Timelock and no fund risk.
//
// Steps (idempotent / re-run safe):
//   1. deploy switch-enabled MintCoordinator + TokenRewardVault
//   2. wire the new instances (settlement, authority, engine, copied config,
//      ParameterGovernance, Council)
//   3. re-point Settlement.setMintCoordinator / setTokenRewardVault (owner,
//      plumbing unlocked)
//   4. router.upgradeContract for both names so resolution + the webapp follow
//   5. persist the new addresses to deployed-addresses.json (+ extension)
//
// Run:  npx hardhat run scripts/deploy-switch-upgrade.ts --network polkadotTestnet
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const ZERO = "0x" + "0".repeat(40);
const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_FILE = path.join(__dirname, "..", "extension", "deployed-addresses.json");
const STATE_FILE = path.join(__dirname, "..", "switch-upgrade-state.json");
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
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("Set DEPLOYER_PRIVATE_KEY in alpha-core/.env");
  const wallet = new Wallet(key, provider);
  const A = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));

  const callView = async (to: string, sig: string, name: string, args: any[] = []) => {
    const i = new ethers.Interface([`function ${sig}`]);
    const r = await provider.call({ to, data: i.encodeFunctionData(name, args) });
    return i.decodeFunctionResult(name, r)[0];
  };
  const send = async (to: string, frag: string, name: string, args: any[]) => {
    const i = new ethers.Interface([`function ${frag}`]);
    const nonce = await provider.getTransactionCount(wallet.address);
    await wallet.sendTransaction({ to, data: i.encodeFunctionData(name, args), gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE, type: 0, nonce });
    await waitForNonce(provider, wallet.address, nonce);
  };
  const hasFn = async (addr: string, sig: string, name: string) => {
    try { await callView(addr, sig, name); return true; } catch { return false; }
  };

  console.log(`Upgrade switches | deployer ${wallet.address} | router ${A.governanceRouter}`);

  // ── Already upgraded? (Settlement already points at switch-enabled instances) ──
  const liveCoord = await callView(A.settlement, "mintCoordinator() view returns(address)", "mintCoordinator");
  const liveVault = await callView(A.settlement, "tokenRewardVault() view returns(address)", "tokenRewardVault");
  const coordHasSwitch = await hasFn(liveCoord, "emissionEnabled() view returns(bool)", "emissionEnabled");
  const vaultHasSwitch = await hasFn(liveVault, "tokenRewardsEnabled() view returns(bool)", "tokenRewardsEnabled");
  if (coordHasSwitch && vaultHasSwitch) {
    console.log("Already upgraded — Settlement points at switch-enabled instances. Nothing to do.");
    return;
  }

  // ── Guards ──
  const owner = (s: string) => callView(s, "owner() view returns(address)", "owner");
  for (const [label, addr] of [["Settlement", A.settlement], ["MintCoordinator(old)", liveCoord], ["TokenRewardVault(old)", liveVault]] as const) {
    const o = (await owner(addr)).toLowerCase();
    if (o !== wallet.address.toLowerCase()) throw new Error(`${label} owner is ${o}, not deployer — cannot upgrade.`);
  }
  const adminGov = (await callView(A.governanceRouter, "adminGovernor() view returns(address)", "adminGovernor")).toLowerCase();
  if (adminGov !== wallet.address.toLowerCase()) throw new Error(`router.adminGovernor is ${adminGov}, not deployer.`);
  const plumbingLocked = await callView(A.settlement, "plumbingLocked() view returns(bool)", "plumbingLocked");
  if (plumbingLocked) throw new Error("Settlement.plumbingLocked is true — pointers frozen; a Settlement redeploy would be required.");

  // ── Reuse prior partial run if present, else deploy fresh ──
  const state: any = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  const deployRaw = async (name: string, args: any[]): Promise<string> => {
    const factory = (await ethers.getContractFactory(name)).connect(wallet);
    const txReq = await factory.getDeployTransaction(...args);
    const nonce = await provider.getTransactionCount(wallet.address);
    await wallet.sendTransaction({ ...txReq, nonce, gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE, type: 0 });
    await waitForNonce(provider, wallet.address, nonce);
    const addr = ethers.getCreateAddress({ from: wallet.address, nonce });
    if ((await provider.getCode(addr)) === "0x") throw new Error(`${name} has no code at ${addr}`);
    return addr;
  };
  const codeOk = async (a?: string) => !!a && (await provider.getCode(a)) !== "0x";

  let newCoord = state.mintCoordinator;
  if (!(await codeOk(newCoord))) {
    console.log("Deploying switch-enabled DatumMintCoordinator…");
    newCoord = await deployRaw("DatumMintCoordinator", []);
    state.mintCoordinator = newCoord; fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
  console.log(`  MintCoordinator(new) ${newCoord}`);

  let newVault = state.tokenRewardVault;
  if (!(await codeOk(newVault))) {
    console.log("Deploying switch-enabled DatumTokenRewardVault…");
    newVault = await deployRaw("DatumTokenRewardVault", [A.campaigns]);
    state.tokenRewardVault = newVault; fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
  console.log(`  TokenRewardVault(new) ${newVault}`);

  // ── Wire new MintCoordinator (copy config + authority from old) ──
  const ensureAddr = async (target: string, getter: string, setterFrag: string, setterName: string, desired: string) => {
    const cur = (await callView(target, `${getter}() view returns(address)`, getter)).toLowerCase();
    if (cur === desired.toLowerCase()) { console.log(`  OK ${setterName}=${desired}`); return; }
    if (cur !== ZERO) { console.log(`  SKIP ${setterName}: already ${cur}`); return; }
    await send(target, setterFrag, setterName, [desired]); console.log(`  SET ${setterName}=${desired}`);
  };

  const oldAuthority = await callView(liveCoord, "mintAuthority() view returns(address)", "mintAuthority");
  const oldEngine = await callView(liveCoord, "emissionEngine() view returns(address)", "emissionEngine");
  await ensureAddr(newCoord, "settlement", "setSettlement(address)", "setSettlement", A.settlement);
  if (oldAuthority !== ZERO) await ensureAddr(newCoord, "mintAuthority", "setMintAuthority(address)", "setMintAuthority", oldAuthority);
  if (oldEngine !== ZERO) await ensureAddr(newCoord, "emissionEngine", "setEmissionEngine(address)", "setEmissionEngine", oldEngine);
  // copy tunable config (auto-migrate via upgradeContract fails: old lacks new getters)
  const copyUint = async (getter: string, setterFrag: string, setterName: string) => {
    const oldV = await callView(liveCoord, `${getter}() view returns(uint256)`, getter);
    const newV = await callView(newCoord, `${getter}() view returns(uint256)`, getter);
    if (oldV.toString() === newV.toString()) { console.log(`  OK ${setterName}=${oldV}`); return; }
    await send(newCoord, setterFrag, setterName, [oldV]); console.log(`  SET ${setterName}=${oldV}`);
  };
  await copyUint("mintRatePerDot", "setMintRate(uint256)", "setMintRate");
  await copyUint("dustMintThreshold", "setDustMintThreshold(uint256)", "setDustMintThreshold");
  {
    const u = await callView(liveCoord, "datumRewardUserBps() view returns(uint16)", "datumRewardUserBps");
    const p = await callView(liveCoord, "datumRewardPublisherBps() view returns(uint16)", "datumRewardPublisherBps");
    const a = await callView(liveCoord, "datumRewardAdvertiserBps() view returns(uint16)", "datumRewardAdvertiserBps");
    const nu = await callView(newCoord, "datumRewardUserBps() view returns(uint16)", "datumRewardUserBps");
    if (u.toString() !== nu.toString()) { await send(newCoord, "setDatumRewardSplit(uint16,uint16,uint16)", "setDatumRewardSplit", [u, p, a]); console.log(`  SET split ${u}/${p}/${a}`); }
    else console.log(`  OK split ${u}/${p}/${a}`);
  }
  if (A.parameterGovernance) await ensureAddr(newCoord, "parameterGovernance", "setParameterGovernance(address)", "setParameterGovernance", A.parameterGovernance);
  if (A.council) await ensureAddr(newCoord, "council", "setCouncil(address)", "setCouncil", A.council);

  // ── Wire new TokenRewardVault ──
  await ensureAddr(newVault, "settlement", "setSettlement(address)", "setSettlement", A.settlement);
  if (A.parameterGovernance) await ensureAddr(newVault, "parameterGovernance", "setParameterGovernance(address)", "setParameterGovernance", A.parameterGovernance);
  if (A.council) await ensureAddr(newVault, "council", "setCouncil(address)", "setCouncil", A.council);

  // ── Re-point Settlement (owner=deployer, plumbing unlocked) ──
  if ((await callView(A.settlement, "mintCoordinator() view returns(address)", "mintCoordinator")).toLowerCase() !== newCoord.toLowerCase()) {
    await send(A.settlement, "setMintCoordinator(address)", "setMintCoordinator", [newCoord]); console.log(`  SET Settlement.mintCoordinator=${newCoord}`);
  }
  if ((await callView(A.settlement, "tokenRewardVault() view returns(address)", "tokenRewardVault")).toLowerCase() !== newVault.toLowerCase()) {
    await send(A.settlement, "setTokenRewardVault(address)", "setTokenRewardVault", [newVault]); console.log(`  SET Settlement.tokenRewardVault=${newVault}`);
  }

  // ── Router registry (resolution + webapp follow) ──
  const nameKey = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));
  for (const [n, addr] of [["mintCoordinator", newCoord], ["tokenRewardVault", newVault]] as const) {
    const cur = "0x" + (await provider.call({ to: A.governanceRouter, data: new ethers.Interface(["function currentAddrOf(bytes32) view returns(address)"]).encodeFunctionData("currentAddrOf", [nameKey(n)]) })).slice(-40);
    if (cur.toLowerCase() === addr.toLowerCase()) { console.log(`  OK router[${n}]=${addr}`); continue; }
    await send(A.governanceRouter, "upgradeContract(bytes32,address)", "upgradeContract", [nameKey(n), addr]);
    console.log(`  ROUTER upgradeContract(${n}) -> ${addr}`);
  }

  // ── Persist addresses ──
  A.mintCoordinator = newCoord; A.tokenRewardVault = newVault;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(A, null, 2) + "\n");
  if (fs.existsSync(EXT_ADDR_FILE)) {
    const E = JSON.parse(fs.readFileSync(EXT_ADDR_FILE, "utf8"));
    E.mintCoordinator = newCoord; E.tokenRewardVault = newVault;
    fs.writeFileSync(EXT_ADDR_FILE, JSON.stringify(E, null, 2) + "\n");
  }
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  console.log("\nUpgrade complete. Remember to re-sync web/src/shared/networks.ts");
  console.log("(mintCoordinator + tokenRewardVault) and bump DEPLOY_VERSION, then rebuild the extension.");
}

main().catch((e) => { console.error(e); process.exit(1); });
