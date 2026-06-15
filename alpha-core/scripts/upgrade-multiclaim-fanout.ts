// upgrade-multiclaim-fanout.ts — bring the LIVE Paseo deployment up to the #30
// multi-claim fan-out fix (commit 81218bd). Three contracts move together
// because the new DatumSettlementLogicB settle path calls BOTH the new
// DatumBudgetLedger.deduct/transferSettled AND DatumClaimValidator.validateBatch:
//
//   • DatumBudgetLedger    — funds-holder (holds live campaign escrow). Migrated
//                            via router.upgradeContract (freeze old + new.migrate)
//                            + migrateFundsTo to sweep the native PAS escrow.
//   • DatumClaimValidator  — NOT DatumUpgradable (no migrate()). Deployed fresh;
//                            every live config ref is mirrored onto the new one,
//                            then Settlement re-points to it (phase-conditional).
//   • DatumSettlementLogicB— stateless delegatecall logic. Deployed fresh, wired
//                            via Settlement.setLogic(logicA, newLogicB).
//
// Order is deliberate: deploy all three → migrate BudgetLedger (state+funds) →
// wire ClaimValidator → re-point Settlement/Campaigns → swap LogicB last (the
// new LogicB depends on the two upgraded peers, so it goes live only once they
// are in place). Settlement plumbingLocked / logicLocked MUST be false (Phase 0).
//
// Idempotent + crash-recoverable: a STATE_FILE records the freshly deployed
// addresses so a re-run reuses them; each on-chain step is guarded by an
// on-chain read so re-running after a partial failure resumes cleanly. Native
// PAS escrow is conserved to the wei or the script aborts.
//
// Run:  npx hardhat run scripts/upgrade-multiclaim-fanout.ts --network polkadotTestnet
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const ZERO = "0x" + "0".repeat(40);
const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_FILE = path.join(__dirname, "..", "extension", "deployed-addresses.json");
const STATE_FILE = path.join(__dirname, "..", "multiclaim-fanout-upgrade-state.json");
const GAS = { gasLimit: 500_000_000n, gasPrice: 1_000_000_000_000n, type: 0 as const };

let p: JsonRpcProvider, w: Wallet;

async function waitForNonce(prev: number, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if ((await p.getTransactionCount(w.address)) > prev) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...awaiting (${i}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`nonce stuck > ${prev}`);
}
const eq = (a: string, b: string) => (a || "").toLowerCase() === (b || "").toLowerCase();
const codeOk = async (a?: string) => !!a && a !== ZERO && (await p.getCode(a)) !== "0x";

async function view(to: string, sig: string, fn: string, args: any[] = []) {
  const i = new ethers.Interface([`function ${sig}`]);
  return i.decodeFunctionResult(fn, await p.call({ to, data: i.encodeFunctionData(fn, args) }))[0];
}
async function send(to: string, frag: string, fn: string, args: any[], value = 0n) {
  const i = new ethers.Interface([`function ${frag}`]);
  const nonce = await p.getTransactionCount(w.address);
  await w.sendTransaction({ to, data: i.encodeFunctionData(fn, args), value, ...GAS, nonce });
  await waitForNonce(nonce);
}
async function estGas(to: string, frag: string, fn: string, args: any[] = []) {
  const i = new ethers.Interface([`function ${frag}`]);
  try { return await p.estimateGas({ from: w.address, to, data: i.encodeFunctionData(fn, args) }); } catch { return 0n; }
}
async function deploy(name: string, args: any[], stateKey: string, state: any): Promise<string> {
  if (await codeOk(state[stateKey])) { console.log(`  reuse ${name} ${state[stateKey]}`); return state[stateKey]; }
  console.log(`  deploying ${name}…`);
  const f = (await ethers.getContractFactory(name)).connect(w);
  const tx = await f.getDeployTransaction(...args);
  const nonce = await p.getTransactionCount(w.address);
  await w.sendTransaction({ ...tx, ...GAS, nonce });
  await waitForNonce(nonce);
  const addr = ethers.getCreateAddress({ from: w.address, nonce });
  if (!(await codeOk(addr))) throw new Error(`${name}: no code at ${addr}`);
  state[stateKey] = addr; fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`    ${name} = ${addr}`);
  return addr;
}

async function main() {
  p = new JsonRpcProvider(process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/");
  w = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, p);
  const A = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));
  const state: any = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  console.log(`Multi-claim fan-out upgrade (#30) | deployer ${w.address}\n`);

  // ── Phase 0: guards ─────────────────────────────────────────────────────
  console.log("Phase 0 — guards");
  if (!eq(await view(A.settlement, "owner() view returns(address)", "owner"), w.address)) throw new Error("Settlement not deployer-owned");
  if (await view(A.settlement, "plumbingLocked() view returns(bool)", "plumbingLocked")) throw new Error("Settlement plumbing LOCKED — cannot re-point");
  if (await view(A.settlement, "logicLocked() view returns(bool)", "logicLocked")) throw new Error("Settlement logic LOCKED — cannot setLogic");
  if (!eq(await view(A.governanceRouter, "governor() view returns(address)", "governor"), w.address)) throw new Error("router.governor != deployer");
  const liveLogicA = await view(A.settlement, "logicA() view returns(address)", "logicA");
  if (!eq(liveLogicA, A.settlementLogicA)) throw new Error(`live logicA ${liveLogicA} != file ${A.settlementLogicA}`);
  console.log("  ✓ owner=deployer, plumbing+logic unlocked, router.governor=deployer, logicA matches\n");

  // ── Phase 1: deploy the three v2 contracts ──────────────────────────────
  console.log("Phase 1 — deploy v2 contracts");
  const newBudgetLedger = await deploy("DatumBudgetLedger", [], "budgetLedger", state);
  const newClaimValidator = await deploy("DatumClaimValidator", [A.campaigns, A.publishers, A.pauseRegistry], "claimValidator", state);
  const newLogicB = await deploy("DatumSettlementLogicB", [], "settlementLogicB", state);
  console.log("");

  // ── Phase 2: migrate BudgetLedger (state + the 102.99 PAS escrow) ────────
  // We migrate DIRECTLY from the real escrow holder (A.budgetLedger) via
  // governor-called freeze + migrate, rather than router.upgradeContract. The
  // registry `currentAddrOf` may already have advanced to a stale instance
  // from a prior partial run; driving migrate off the registry would copy the
  // wrong (empty) source. The router registry is reconciled at the end so the
  // upgrade ladder still ends pointing at the live successor.
  console.log("Phase 2 — migrate BudgetLedger (escrow funds-holder)");
  const blKey = ethers.keccak256(ethers.toUtf8Bytes("budgetLedger"));
  const alreadyMigrated = await view(newBudgetLedger, "migrated() view returns(bool)", "migrated").catch(() => false);
  if (alreadyMigrated) {
    console.log("  new BudgetLedger already migrated — verifying funds");
  } else {
    // new build must be a strict version bump (migrate guards old < new)
    const oldVer = await view(A.budgetLedger, "version() view returns(uint256)", "version");
    const newVer = await view(newBudgetLedger, "version() view returns(uint256)", "version");
    if (!(newVer > oldVer)) throw new Error(`version not bumped: old=${oldVer} new=${newVer} (need new>old)`);
    // pointers NOT carried by _migrate; router must be set so the migrate() is accepted
    if (eq(await view(newBudgetLedger, "router() view returns(address)", "router"), ZERO)) await send(newBudgetLedger, "setRouter(address)", "setRouter", [A.governanceRouter]);
    if (eq(await view(newBudgetLedger, "campaigns() view returns(address)", "campaigns"), ZERO)) await send(newBudgetLedger, "setCampaigns(address)", "setCampaigns", [A.campaigns]);
    if (eq(await view(newBudgetLedger, "settlement() view returns(address)", "settlement"), ZERO)) await send(newBudgetLedger, "setSettlement(address)", "setSettlement", [A.settlement]);
    console.log(`  new BudgetLedger wired (router/campaigns/settlement); v${oldVer}→v${newVer}`);

    const oldBal = await p.getBalance(A.budgetLedger);
    const oldCount = await view(A.budgetLedger, "budgetCampaignCount() view returns(uint256)", "budgetCampaignCount");
    console.log(`  pre-migrate: old escrow=${ethers.formatEther(oldBal)} PAS, budgetCampaignCount=${oldCount}`);

    // freeze the real old (migrate requires a frozen source)
    if (!(await view(A.budgetLedger, "frozen() view returns(bool)", "frozen"))) { await send(A.budgetLedger, "freeze()", "freeze", []); console.log("  froze old BudgetLedger"); }

    // Probe the largest batch that fits Paseo's per-tx proof-size ceiling
    // (~5 cross-contract reads/campaign). estimateGas reverts (→0) over the
    // ceiling; pick the biggest size that estimates cleanly.
    let safeBatch = 0;
    for (const b of [10, 8, 6, 5, 4, 3, 2, 1]) {
      await send(newBudgetLedger, "setMigrationBatchSize(uint256)", "setMigrationBatchSize", [b]);
      const g = await estGas(newBudgetLedger, "migrate(address)", "migrate", [A.budgetLedger]);
      if (g > 0n) { safeBatch = b; console.log(`  probe batch=${b}: estimate ${g} wt — OK`); break; }
      console.log(`  probe batch=${b}: over ceiling (reverts)`);
    }
    if (safeBatch === 0) throw new Error("even batch=1 reverts — migrate path broken");

    // U3 paginated migrate: call repeatedly until migrated() flips. Self-healing:
    // if a tx reverts on-chain (cursor stalls — pallet-revive advances the nonce
    // on revert so `send` can't see it), shrink the batch and retry.
    let batch = 0, lastCursor = -1n;
    while (!(await view(newBudgetLedger, "migrated() view returns(bool)", "migrated"))) {
      const gMigrate = await estGas(newBudgetLedger, "migrate(address)", "migrate", [A.budgetLedger]);
      await send(newBudgetLedger, "migrate(address)", "migrate", [A.budgetLedger]);
      const cursor: bigint = await view(newBudgetLedger, "migrationCursor() view returns(uint256)", "migrationCursor");
      if (cursor === lastCursor) {
        const cur = Number(await view(newBudgetLedger, "migrationBatchSize() view returns(uint256)", "migrationBatchSize"));
        if (cur <= 1) throw new Error("migrate reverts at batch=1 — aborting");
        const reduced = Math.max(1, Math.floor(cur / 2));
        await send(newBudgetLedger, "setMigrationBatchSize(uint256)", "setMigrationBatchSize", [reduced]);
        console.log(`    batch stalled at cursor=${cursor} — shrinking batch ${cur}→${reduced}`);
        continue;
      }
      lastCursor = cursor;
      console.log(`    migrate batch ${++batch}: cursor=${cursor}/${oldCount}  [≈${gMigrate} wt]`);
      if (batch > 100) throw new Error("migrate not converging — aborting");
    }
    // verify migrate carried state BEFORE sweeping funds
    const newCount = await view(newBudgetLedger, "budgetCampaignCount() view returns(uint256)", "budgetCampaignCount");
    if (newCount.toString() !== oldCount.toString()) throw new Error(`migrate state mismatch: new count ${newCount} != old ${oldCount}`);
    console.log(`  ✓ paginated migrate complete (${batch} batches, budgetCampaignCount=${newCount})`);

    // sweep native escrow
    await send(A.budgetLedger, "migrateFundsTo(address)", "migrateFundsTo", [newBudgetLedger]);
    const newBal = await p.getBalance(newBudgetLedger), oldLeft = await p.getBalance(A.budgetLedger);
    if (newBal !== oldBal || oldLeft !== 0n) throw new Error(`ESCROW NOT CONSERVED: new=${ethers.formatEther(newBal)} oldLeft=${ethers.formatEther(oldLeft)} (expected new=${ethers.formatEther(oldBal)} oldLeft=0)`);
    console.log(`  ✓ migrateFundsTo swept ${ethers.formatEther(newBal)} PAS — escrow conserved to the wei`);
  }
  // reconcile the router registry to the live successor (best-effort hooks
  // revert harmlessly: already-frozen / already-migrated)
  const regBL = await view(A.governanceRouter, "currentAddrOf(bytes32) view returns(address)", "currentAddrOf", [blKey]);
  if (!eq(regBL, newBudgetLedger)) { await send(A.governanceRouter, "upgradeContract(bytes32,address)", "upgradeContract", [blKey, newBudgetLedger]); console.log("  router registry reconciled → new BudgetLedger"); }
  console.log("");

  // ── Phase 3: mirror ClaimValidator config onto the fresh instance ────────
  console.log("Phase 3 — mirror ClaimValidator config (no migrate; replicate refs)");
  // addr refs (constructor already set campaigns/publishers/pauseRegistry); only mirror non-zero live values
  const refMirror: [string, string, string][] = [
    ["settlement", "setSettlement(address)", "setSettlement"],
    ["zkVerifier", "setZKVerifier(address)", "setZKVerifier"],
    ["clickRegistry", "setClickRegistry(address)", "setClickRegistry"],
    ["powEngine", "setPowEngine(address)", "setPowEngine"],
    ["campaignAllowlist", "setCampaignAllowlist(address)", "setCampaignAllowlist"],
    ["stakeRoot", "setStakeRoot(address)", "setStakeRoot"],
    ["stakeRoot2", "setStakeRoot2(address)", "setStakeRoot2"],
    ["interestCommitments", "setInterestCommitments(address)", "setInterestCommitments"],
    ["activationBonds", "setActivationBonds(address)", "setActivationBonds"],
    ["parameterGovernance", "setParameterGovernance(address)", "setParameterGovernance"],
  ];
  for (const [getter, frag, fn] of refMirror) {
    const live = await view(A.claimValidator, `${getter}() view returns(address)`, getter);
    if (eq(live, ZERO)) continue;
    const cur = await view(newClaimValidator, `${getter}() view returns(address)`, getter);
    if (eq(cur, live)) continue;
    await send(newClaimValidator, frag, fn, [live]);
    console.log(`  set ${getter} = ${live}`);
  }
  // scalar config (mirror only if it diverges from the contract default)
  const liveMax = await view(A.claimValidator, "maxClaimEvents() view returns(uint256)", "maxClaimEvents");
  if (liveMax.toString() !== (await view(newClaimValidator, "maxClaimEvents() view returns(uint256)", "maxClaimEvents")).toString()) { await send(newClaimValidator, "setMaxClaimEvents(uint256)", "setMaxClaimEvents", [liveMax]); console.log(`  set maxClaimEvents = ${liveMax}`); }
  const liveMin = await view(A.claimValidator, "minInterestAgeBlocks() view returns(uint256)", "minInterestAgeBlocks");
  if (liveMin.toString() !== (await view(newClaimValidator, "minInterestAgeBlocks() view returns(uint256)", "minInterestAgeBlocks")).toString()) { await send(newClaimValidator, "setMinInterestAgeBlocks(uint256)", "setMinInterestAgeBlocks", [liveMin]); console.log(`  set minInterestAgeBlocks = ${liveMin}`); }
  console.log("  ✓ ClaimValidator config mirrored\n");

  // ── Phase 4: re-point Settlement + Campaigns to the new peers ────────────
  console.log("Phase 4 — re-point Settlement + Campaigns");
  if (!eq(await view(A.campaigns, "budgetLedger() view returns(address)", "budgetLedger"), newBudgetLedger)) { await send(A.campaigns, "setBudgetLedger(address)", "setBudgetLedger", [newBudgetLedger]); console.log("  campaigns.setBudgetLedger(new)"); }
  // re-point Settlement plumbing (budgetLedger lives in configure; keep vault/lifecycle/relay)
  await send(A.settlement, "configure(address,address,address,address)", "configure", [newBudgetLedger, A.paymentVault, A.campaignLifecycle, A.relay]);
  console.log("  settlement.configure(newBudgetLedger, vault, lifecycle, relay)");
  if (!eq(await view(A.settlement, "claimValidator() view returns(address)", "claimValidator").catch(() => ZERO), newClaimValidator)) { await send(A.settlement, "setClaimValidator(address)", "setClaimValidator", [newClaimValidator]); console.log("  settlement.setClaimValidator(new)"); }
  console.log("");

  // ── Phase 5: swap LogicB last (depends on the two upgraded peers) ────────
  console.log("Phase 5 — swap SettlementLogicB");
  if (!eq(await view(A.settlement, "logicB() view returns(address)", "logicB"), newLogicB)) { await send(A.settlement, "setLogic(address,address)", "setLogic", [liveLogicA, newLogicB]); console.log(`  settlement.setLogic(${liveLogicA}, ${newLogicB})`); }
  console.log("");

  // ── Phase 6: verify ──────────────────────────────────────────────────────
  console.log("Phase 6 — verify on-chain");
  const checks: [string, boolean][] = [
    ["settlement.logicB == new", eq(await view(A.settlement, "logicB() view returns(address)", "logicB"), newLogicB)],
    ["settlement.logicA unchanged", eq(await view(A.settlement, "logicA() view returns(address)", "logicA"), liveLogicA)],
    ["campaigns.budgetLedger == new", eq(await view(A.campaigns, "budgetLedger() view returns(address)", "budgetLedger"), newBudgetLedger)],
    ["new BudgetLedger v2", (await view(newBudgetLedger, "version() view returns(uint256)", "version")) > 1n],
    ["new BudgetLedger holds escrow", (await p.getBalance(newBudgetLedger)) > 0n],
    ["old BudgetLedger drained", (await p.getBalance(A.budgetLedger)) === 0n],
    ["new ClaimValidator settlement wired", eq(await view(newClaimValidator, "settlement() view returns(address)", "settlement"), A.settlement)],
  ];
  let allOk = true;
  for (const [label, ok] of checks) { console.log(`  ${ok ? "✓" : "✗"} ${label}`); allOk = allOk && ok; }
  if (!allOk) throw new Error("post-upgrade verification FAILED — see ✗ above");

  // ── Phase 7: persist new addresses ───────────────────────────────────────
  A.budgetLedger = newBudgetLedger;
  A.claimValidator = newClaimValidator;
  A.settlementLogicB = newLogicB;
  A.deployedAt = new Date().toISOString();
  fs.writeFileSync(ADDR_FILE, JSON.stringify(A, null, 2) + "\n");
  if (fs.existsSync(path.dirname(EXT_ADDR_FILE))) fs.writeFileSync(EXT_ADDR_FILE, JSON.stringify(A, null, 2) + "\n");
  console.log(`\n  deployed-addresses.json updated (budgetLedger / claimValidator / settlementLogicB)`);

  console.log("\n==================== MULTI-CLAIM FAN-OUT UPGRADE LIVE ====================");
  console.log(`  budgetLedger    ${newBudgetLedger}  (escrow migrated)`);
  console.log(`  claimValidator  ${newClaimValidator}`);
  console.log(`  settlementLogicB ${newLogicB}`);
  console.log("=========================================================================");
}

main().catch((e) => { console.error("\nUPGRADE ABORTED:", e.message || e); process.exit(1); });
