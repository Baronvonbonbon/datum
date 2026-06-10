// Batch contract upgrade — DatumAdvertiserRegistry (new) + DatumPaymentVault
// (gasless-withdrawal + migration-capable) in ONE coordinated run.
//
// Run:  npx hardhat run scripts/deploy-batch-upgrade.ts --network polkadotTestnet
//   • dry/stage by default — deploys + wires the new contracts, runs NO
//     destructive freeze/migrate unless MIGRATE_VAULT=1 is set.
//   • MIGRATE_VAULT=1 additionally freezes the OLD vault and runs the
//     freeze → migrate → fund-sweep, but ONLY if the old vault is itself
//     migration-capable (has the enumeration added in this upgrade). The
//     currently-deployed vault predates that machinery, so the first run
//     will REFUSE to migrate and print the coexist+drain path instead.
//
// ── Why these two ride together, and the (now-resolved) lock-once cascade ─
// The registry is a PURE ADDITION (no migration, effective immediately).
//
// The vault USED to be impossible to swap surgically: DatumSettlement's
// structural refs were unconditional lock-once (configure() reverted AlreadySet
// on a second call), so re-pointing the vault forced a full Settlement redeploy.
// That over-commitment was the cypherpunk regression — now fixed: Settlement's
// refs are PHASE-CONDITIONAL lock-once (governance-re-pointable until OpenGov
// fires lockPlumbing()). So a vault swap is just:
//     settlement.configure(ledger, NEW_VAULT, lifecycle, relay)   // re-point
// …no redeploy. BUT the currently-DEPLOYED Settlement predates the fix and is
// still frozen-at-deploy, so this script detects capability:
//   - If the live Settlement exposes `plumbingLocked()` (carries the fix) and is
//     unlocked → it LIVE re-points to the new vault (overwrites `paymentVault`).
//   - Otherwise (old frozen Settlement) → it stages the new vault as
//     `paymentVaultNext` and prints the one-last-redeploy guidance. After that
//     redeploy, Settlement carries the fix and every future vault swap is a
//     surgical re-point + clean freeze→migrate→sweep.
//
// Re-run safe: reuses contracts that already have code; skips lock-once
// setRouter when already wired. Paseo raw-provider + nonce-poll pattern
// (getTransactionReceipt returns null for confirmed txs).
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
  const MIGRATE_VAULT = process.env.MIGRATE_VAULT === "1";

  const addresses = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));
  for (const k of ["pauseRegistry", "governanceRouter", "paymentVault", "settlement"]) {
    if (!addresses[k]) throw new Error(`deployed-addresses.json missing ${k}`);
  }
  const save = () => {
    fs.writeFileSync(ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n");
    try { fs.writeFileSync(EXT_ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n"); } catch { /* optional */ }
  };

  // Deploy a contract via the Paseo-safe raw-provider path; returns its address.
  async function deployRaw(name: string, args: any[] = []): Promise<string> {
    const factory = await ethers.getContractFactory(name);
    const deployTx = await factory.getDeployTransaction(...args);
    const nonce = await rawProvider.getTransactionCount(deployer.address);
    const addr = ethers.getCreateAddress({ from: deployer.address, nonce });
    const tx = await deployer.sendTransaction({ data: deployTx.data, gasLimit: GAS_LIMIT, type: 0, gasPrice: GAS_PRICE });
    console.log(`  ${name}: tx ${tx.hash} (nonce ${nonce}) → ${addr}`);
    await waitForNonce(rawProvider, deployer.address, nonce);
    if ((await rawProvider.getCode(addr)) === "0x") throw new Error(`no code at ${addr}`);
    return addr;
  }

  // Send a wired call via the raw-provider path (waits on the nonce).
  async function sendRaw(to: string, data: string) {
    const nonce = await rawProvider.getTransactionCount(deployer.address);
    let gas = GAS_LIMIT;
    try { gas = (await deployer.estimateGas({ to, data })) * 2n; } catch { /* fall back */ }
    const tx = await deployer.sendTransaction({ to, data, gasLimit: gas, type: 0, gasPrice: GAS_PRICE });
    console.log(`    tx ${tx.hash}`);
    await waitForNonce(rawProvider, deployer.address, nonce);
  }

  // Lock-once setRouter helper (skips if already wired).
  async function wireRouter(name: string, addr: string) {
    const c = await ethers.getContractAt(name, addr, deployer);
    if ((await c.router()) === ZERO) {
      console.log(`  setRouter(${addresses.governanceRouter}) on ${name}`);
      await sendRaw(addr, c.interface.encodeFunctionData("setRouter", [addresses.governanceRouter]));
    } else {
      console.log(`  ${name}.router already wired`);
    }
  }

  console.log(`Deployer: ${deployer.address}  chainId: ${net.chainId}  MIGRATE_VAULT=${MIGRATE_VAULT}`);

  // ── STAGE 1: DatumAdvertiserRegistry (pure addition) ───────────────────
  console.log(`\n[1/2] DatumAdvertiserRegistry (pure addition — effective immediately)`);
  let registryAddr: string = addresses.advertiserRegistry;
  if (registryAddr && registryAddr !== ZERO && (await rawProvider.getCode(registryAddr)) !== "0x") {
    console.log(`  reusing ${registryAddr}`);
  } else {
    registryAddr = await deployRaw("DatumAdvertiserRegistry", [addresses.pauseRegistry]);
    addresses.advertiserRegistry = registryAddr;
    save();
  }
  await wireRouter("DatumAdvertiserRegistry", registryAddr);

  // ── STAGE 2: DatumPaymentVault (migration-capable + gasless withdrawal) ──
  // Staged into `paymentVaultNext`, NOT swapped live (Settlement._paymentVault
  // is lock-once — see header). The next full redeploy makes it the live vault
  // alongside a fresh Settlement.
  console.log(`\n[2/2] DatumPaymentVault (staged → paymentVaultNext)`);
  let nextVault: string = addresses.paymentVaultNext;
  if (nextVault && nextVault !== ZERO && (await rawProvider.getCode(nextVault)) !== "0x") {
    console.log(`  reusing ${nextVault}`);
  } else {
    nextVault = await deployRaw("DatumPaymentVault");
    addresses.paymentVaultNext = nextVault;
    save();
  }
  await wireRouter("DatumPaymentVault", nextVault);
  // Point the new vault at the CURRENT settlement so a coexisting deploy can
  // credit it if desired; the live swap still needs a fresh Settlement.
  {
    const v = await ethers.getContractAt("DatumPaymentVault", nextVault, deployer);
    if ((await v.settlement()) === ZERO) {
      console.log(`  setSettlement(${addresses.settlement}) on new vault`);
      await sendRaw(nextVault, v.interface.encodeFunctionData("setSettlement", [addresses.settlement]));
    } else {
      console.log(`  new vault.settlement already set`);
    }
  }

  // ── Optional: migrate the OLD vault's balances + funds into the new one ──
  // Only meaningful when the OLD vault is itself migration-capable. The
  // currently-deployed vault predates the enumeration, so this guards out.
  if (MIGRATE_VAULT) {
    console.log(`\n[migrate] attempting vault freeze → migrate → fund-sweep`);
    const oldVault = addresses.paymentVault;
    const oldC = await ethers.getContractAt("DatumPaymentVault", oldVault, deployer);
    let capable = true;
    try { await oldC.holderCount(); } catch { capable = false; }
    if (!capable) {
      console.log(`  ✗ OLD vault ${oldVault} is NOT migration-capable (no holderCount).`);
      console.log(`    → Cannot pull its balances/funds on-chain. Use the COEXIST path:`);
      console.log(`      keep the old vault live (do NOT freeze) so users withdraw existing`);
      console.log(`      balances; route NEW settlement credits to the new vault via a fresh`);
      console.log(`      Settlement in the next full deploy.ts run.`);
    } else {
      const govC = await ethers.getContractAt("DatumGovernanceRouter", addresses.governanceRouter, deployer);
      const governor = await govC.governor();
      if (governor.toLowerCase() !== deployer.address.toLowerCase()) {
        console.log(`  ✗ governor is ${governor}, not the deployer — freeze/migrate must be`);
        console.log(`    fired by the current governor (Council/OpenGov). Skipping.`);
      } else {
        if (!(await oldC.frozen())) { console.log(`  freeze(old)`); await sendRaw(oldVault, oldC.interface.encodeFunctionData("freeze", [])); }
        const newC = await ethers.getContractAt("DatumPaymentVault", nextVault, deployer);
        if (!(await newC.migrated())) { console.log(`  new.migrate(old)`); await sendRaw(nextVault, newC.interface.encodeFunctionData("migrate", [oldVault])); }
        if (!(await oldC.fundsMigratedOut())) { console.log(`  old.migrateFundsTo(new)`); await sendRaw(oldVault, oldC.interface.encodeFunctionData("migrateFundsTo", [nextVault])); }
        console.log(`  ✓ balances + funds migrated old → new`);
      }
    }
  }

  // ── STAGE 3: live re-point IF the deployed Settlement carries the fix ───
  // Post-cypherpunk-fix, Settlement.configure is re-callable while plumbing is
  // unlocked, so the vault swap needs no redeploy. The currently-deployed
  // Settlement may still be the old frozen-at-deploy build; detect + branch.
  console.log(`\n[3] vault live re-point (if Settlement carries the phase-conditional fix)`);
  const settle = await ethers.getContractAt("DatumSettlement", addresses.settlement, deployer);
  let repointed = false;
  try {
    const locked = await settle.plumbingLocked(); // reverts on the old build (no such fn)
    if (locked) {
      console.log(`  ✗ Settlement plumbing already LOCKED (OpenGov end-state) — vault is frozen; cannot re-point.`);
    } else {
      const ledger = await settle.budgetLedger();
      const lifecycle = await settle.lifecycle();
      const relay = await settle.relayContract();
      console.log(`  re-pointing Settlement.paymentVault → ${nextVault}`);
      await sendRaw(addresses.settlement, settle.interface.encodeFunctionData("configure", [ledger, nextVault, lifecycle, relay]));
      // Point the new vault's crediter at this Settlement (already done above) and go live.
      addresses.paymentVault = nextVault;
      delete addresses.paymentVaultNext;
      save();
      repointed = true;
      console.log(`  ✓ live swap complete — paymentVault is now ${nextVault} (no redeploy needed)`);
    }
  } catch {
    console.log(`  ✗ deployed Settlement predates the fix (no plumbingLocked()) — cannot live re-point.`);
    console.log(`    One last full redeploy (deploy.ts) bakes the fix into Settlement; after that every`);
    console.log(`    vault swap is a surgical configure() re-point.`);
  }

  console.log(`\n✅ Batch ${repointed ? "applied LIVE" : "staged"}.`);
  console.log(`   advertiserRegistry: ${addresses.advertiserRegistry}  (LIVE)`);
  if (repointed) {
    console.log(`   paymentVault:       ${addresses.paymentVault}  (LIVE — re-pointed)`);
  } else {
    console.log(`   paymentVaultNext:   ${addresses.paymentVaultNext}  (STAGED — live on next full redeploy)`);
  }
  console.log(`\nNEXT:`);
  console.log(`  • Relay: set ADVERTISER_REGISTRY=${addresses.advertiserRegistry} (retire the static ADVERTISER_COSIGNERS map).`);
  if (repointed) {
    console.log(`  • Re-copy deployed-addresses.json into web/public + extension (paymentVault changed).`);
  } else {
    console.log(`  • Full redeploy (deploy.ts) to bake the cypherpunk fix into Settlement + make the new vault live,`);
    console.log(`    then re-copy deployed-addresses.json into web/public + extension.`);
  }
  console.log(`  • See alpha-core/UPGRADE-BATCH-RUNBOOK.md for the cypherpunk-fix + risk notes.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
