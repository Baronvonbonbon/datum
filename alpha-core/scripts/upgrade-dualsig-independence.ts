// upgrade-dualsig-independence.ts — upgrade the live DatumDualSigSettlement to
// v2 (A1 independence guard: publisher-side & advertiser-side signatures must
// recover to DISTINCT keys; reverts E89 otherwise).
//
// Clean migrate: DualSig holds no funds and no replay state (lastNonce lives in
// Settlement), and its base _migrate is a no-op, so the new instance is wired
// fresh (router + settlement + pauseRegistry + publishers + campaigns) BEFORE
// router.upgradeContract atomically freezes the old and registers the new.
// Settlement is then re-pointed via setDualSig (allowed: plumbing unlocked in
// Phase 0). Idempotent via version()==2.
//
// Run: npx hardhat run scripts/upgrade-dualsig-independence.ts --network polkadotTestnet
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_FILE = path.join(__dirname, "..", "extension", "deployed-addresses.json");
const STATE_FILE = path.join(__dirname, "..", "dualsig-independence-upgrade-state.json");
const GAS = { gasLimit: 500_000_000n, gasPrice: 1_000_000_000_000n, type: 0 as const };

async function waitForNonce(p: JsonRpcProvider, a: string, prev: number, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if ((await p.getTransactionCount(a)) > prev) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...awaiting (${i}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`nonce stuck > ${prev}`);
}

async function main() {
  const provider = new JsonRpcProvider(process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/");
  const w = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  const A = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));

  const view = async (to: string, sig: string, n: string, args: any[] = []) => {
    const i = new ethers.Interface([`function ${sig}`]);
    return i.decodeFunctionResult(n, await provider.call({ to, data: i.encodeFunctionData(n, args) }))[0];
  };
  const send = async (to: string, frag: string, n: string, args: any[]) => {
    const i = new ethers.Interface([`function ${frag}`]);
    const nonce = await provider.getTransactionCount(w.address);
    await w.sendTransaction({ to, data: i.encodeFunctionData(n, args), ...GAS, nonce });
    await waitForNonce(provider, w.address, nonce);
  };
  const codeOk = async (a?: string) => !!a && (await provider.getCode(a)) !== "0x";
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  console.log(`DualSig independence (v2) upgrade | deployer ${w.address}`);

  // ── Guards ───────────────────────────────────────────────────────────────
  const oldDual = A.dualSig;
  if (!(await codeOk(oldDual))) throw new Error(`current dualSig ${oldDual} has no code`);
  const liveVer = (await view(oldDual, "version() view returns(uint256)", "version")).toString();
  if (liveVer === "2") { console.log("Already upgraded — live dualSig is v2. Nothing to do."); return; }
  if (!eq(await view(A.settlement, "owner() view returns(address)", "owner"), w.address)) throw new Error("Settlement not deployer-owned");
  if (await view(A.settlement, "plumbingLocked() view returns(bool)", "plumbingLocked")) throw new Error("Settlement plumbing locked — setDualSig blocked");
  if (!eq(await view(A.governanceRouter, "governor() view returns(address)", "governor"), w.address)) throw new Error("deployer is not router governor");
  console.log(`  current dualSig ${oldDual} (v${liveVer}), frozen=${await view(oldDual, "frozen() view returns(bool)", "frozen")}`);

  // ── Deploy v2 (resume-safe) ────────────────────────────────────────────────
  const state: any = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  let newDual = state.dualSig;
  if (!(await codeOk(newDual))) {
    console.log("Deploying v2 DatumDualSigSettlement…");
    const f = (await ethers.getContractFactory("DatumDualSigSettlement")).connect(w as any);
    const tx = await f.getDeployTransaction();
    const nonce = await provider.getTransactionCount(w.address);
    await w.sendTransaction({ ...tx, ...GAS, nonce });
    await waitForNonce(provider, w.address, nonce);
    newDual = ethers.getCreateAddress({ from: w.address, nonce });
    if (!(await codeOk(newDual))) throw new Error("new dualSig no code");
    state.dualSig = newDual; fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
  console.log(`  new dualSig ${newDual} (v${(await view(newDual, "version() view returns(uint256)", "version")).toString()})`);

  // ── Wire the new instance BEFORE upgradeContract ──────────────────────────
  // CRUCIAL: router must be set first — router-fired migrate() is
  // onlyGovernanceOrRouter. Base _migrate is a no-op, so every pointer is set
  // manually (none are carried forward).
  const ensure = async (getter: string, frag: string, name: string, desired: string) => {
    const cur = await view(newDual, `${getter}() view returns(address)`, getter);
    if (!eq(cur, desired)) { await send(newDual, frag, name, [desired]); console.log(`  SET new.${getter} = ${desired}`); }
    else console.log(`  ok new.${getter}`);
  };
  await ensure("router", "setRouter(address)", "setRouter", A.governanceRouter);
  await ensure("settlement", "setSettlement(address)", "setSettlement", A.settlement);
  await ensure("pauseRegistry", "setPauseRegistry(address)", "setPauseRegistry", A.pauseRegistry);
  await ensure("publishers", "setPublishers(address)", "setPublishers", A.publishers);
  await ensure("campaigns", "setCampaigns(address)", "setCampaigns", A.campaigns);

  // ── Router upgrade: atomic freeze(old) + new.migrate(old) + registry repoint ─
  const nameKey = ethers.keccak256(ethers.toUtf8Bytes("dualSig"));
  const reg = await view(A.governanceRouter, "currentAddrOf(bytes32) view returns(address)", "currentAddrOf", [nameKey]);
  if (!eq(reg, newDual)) {
    await send(A.governanceRouter, "upgradeContract(bytes32,address)", "upgradeContract", [nameKey, newDual]);
    console.log("  ROUTER upgradeContract(dualSig) — froze old, registered + migrated new");
  } else console.log("  ok registry already points to new");

  // ── Re-point Settlement's dual-sig gate (plumbing unlocked) ────────────────
  if (!eq(await view(A.settlement, "dualSig() view returns(address)", "dualSig"), newDual)) {
    await send(A.settlement, "setDualSig(address)", "setDualSig", [newDual]);
    console.log("  SET Settlement.dualSig = new");
  } else console.log("  ok Settlement.dualSig already new");

  // ── Verify ─────────────────────────────────────────────────────────────────
  const checks: [string, boolean][] = [
    [`registry[dualSig]==new`, eq(await view(A.governanceRouter, "currentAddrOf(bytes32) view returns(address)", "currentAddrOf", [nameKey]), newDual)],
    [`new.version()==2`, (await view(newDual, "version() view returns(uint256)", "version")).toString() === "2"],
    [`Settlement.dualSig()==new`, eq(await view(A.settlement, "dualSig() view returns(address)", "dualSig"), newDual)],
    [`old.frozen()==true`, (await view(oldDual, "frozen() view returns(bool)", "frozen")) === true],
    [`new.settlement wired`, eq(await view(newDual, "settlement() view returns(address)", "settlement"), A.settlement)],
    [`new.campaigns wired`, eq(await view(newDual, "campaigns() view returns(address)", "campaigns"), A.campaigns)],
  ];
  console.log("\nVerification:");
  let allOk = true;
  for (const [name, ok] of checks) { console.log(`  ${ok ? "✓" : "✗"} ${name}`); allOk = allOk && ok; }
  if (!allOk) throw new Error("post-upgrade verification FAILED — do not trust this deploy");

  // ── Persist ─────────────────────────────────────────────────────────────────
  A.dualSig = newDual;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(A, null, 2) + "\n");
  if (fs.existsSync(EXT_ADDR_FILE)) {
    const E = JSON.parse(fs.readFileSync(EXT_ADDR_FILE, "utf8"));
    E.dualSig = newDual; fs.writeFileSync(EXT_ADDR_FILE, JSON.stringify(E, null, 2) + "\n");
  }
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  console.log(`\nDone. Live dualSig → ${newDual} (v2, A1 independence guard / E89).`);
  console.log("Off-chain tools resolving via the router pick this up on restart; restart the relay/cosigner to re-init.");
}

main().catch((e) => { console.error(e); process.exit(1); });
