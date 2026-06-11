// Option 2 — relinquish the admin root from the deployer to the Council.
//
// Background (see CONTROL-MATRIX-MEMO.md): the deploy transfers every contract's
// ownership TO the Timelock, but the Timelock's OWN owner stays the deployer EOA.
// Since timelock.propose/cancel are onlyOwner and the Timelock owns the router +
// all fund contracts, the deployer is the sole admin root in every phase. This
// script moves that root to the DatumCouncil (N-of-M), and points the router's
// adminGovernor (the upgrade/regression authority — separate from the campaign
// governor since the Stage-2 split) at the Council so upgrades survive the
// GovernanceV2/OpenGov end-state.
//
//   npx hardhat run scripts/transfer-timelock-to-council.ts --network polkadotTestnet
//
// DELIBERATE + IRREVERSIBLE-ish: once the Council owns the Timelock, every future
// admin change (including phase transitions via router.setGovernor) needs a
// Council vote + the 48h Timelock delay. Run only when the Council membership /
// threshold are final and you intend to leave Phase-0 single-key operation.
//
// The flow is 48h-timelocked and multi-party, so one invocation cannot complete
// it. The script does the deployer-side actions it can and prints a runbook for
// the Council-side steps it cannot perform.
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

const ZERO = "0x0000000000000000000000000000000000000000";
const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
// Fixed salt so re-runs map to the same Timelock proposalId (idempotent).
const SALT = ethers.keccak256(ethers.toUtf8Bytes("option2-setAdminGovernor-council"));

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

  const addresses = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));
  for (const k of ["timelock", "governanceRouter", "council"]) {
    if (!addresses[k] || addresses[k] === ZERO) throw new Error(`deployed-addresses.json missing ${k}`);
  }
  const { timelock: timelockAddr, governanceRouter: routerAddr, council: councilAddr } = addresses;

  const timelock = await ethers.getContractAt("DatumTimelock", timelockAddr, deployer);
  const router = await ethers.getContractAt("DatumGovernanceRouter", routerAddr, deployer);
  const council = await ethers.getContractAt("DatumCouncil", councilAddr, deployer);

  // ── Pre-flight: print current control state + validate the Council ──────────
  const tlOwner = await timelock.owner();
  const tlPending = await timelock.pendingOwner();
  const routerOwner = await router.owner();
  const adminGov = await router.adminGovernor();
  const campaignGov = await router.governor();
  const phase = await router.phase();

  console.log(`Deployer:          ${deployer.address}  chainId ${net.chainId}`);
  console.log(`Timelock:          ${timelockAddr}`);
  console.log(`  owner:           ${tlOwner}${tlOwner.toLowerCase() === deployer.address.toLowerCase() ? "  (deployer)" : ""}`);
  console.log(`  pendingOwner:    ${tlPending}`);
  console.log(`Router:            ${routerAddr}`);
  console.log(`  owner:           ${routerOwner}${routerOwner.toLowerCase() === timelockAddr.toLowerCase() ? "  (Timelock)" : ""}`);
  console.log(`  adminGovernor:   ${adminGov}`);
  console.log(`  governor (camp): ${campaignGov}`);
  console.log(`  phase:           ${phase}`);
  console.log(`Council:           ${councilAddr}`);

  // Council must be live before it can own the Timelock (otherwise the admin
  // root is bricked: no one could ever call acceptOwnership / propose).
  let memberCount = 0n;
  try { memberCount = await council.memberCount(); } catch { /* older ABI */ }
  if (memberCount === 0n) throw new Error("Council has 0 members — wire membership + threshold before relinquishing");
  console.log(`  memberCount:     ${memberCount}\n`);

  const alreadyAdminCouncil = adminGov.toLowerCase() === councilAddr.toLowerCase();

  // ── Step 1: point adminGovernor at the Council (via the Timelock) ──────────
  // setAdminGovernor is onlyOwner of the router; post-deploy the router is owned
  // by the Timelock, so this must be a Timelock proposal. The deployer owns the
  // Timelock (until Step 2 completes), so it can propose now.
  if (alreadyAdminCouncil) {
    console.log("Step 1 — adminGovernor already == Council. Skipping.");
  } else {
    const setAdminData = router.interface.encodeFunctionData("setAdminGovernor", [councilAddr]);
    const proposalId = await timelock.hashProposal(routerAddr, setAdminData, SALT);
    const prop = await timelock.proposals(proposalId);
    if (prop.timestamp === 0n) {
      console.log("Step 1 — proposing setAdminGovernor(Council) through the Timelock...");
      const data = timelock.interface.encodeFunctionData("propose", [routerAddr, setAdminData, SALT]);
      const nonce = await rawProvider.getTransactionCount(deployer.address);
      const tx = await deployer.sendTransaction({ to: timelockAddr, data, gasLimit: GAS_LIMIT, type: 0, gasPrice: GAS_PRICE });
      console.log(`  proposed: tx ${tx.hash}  proposalId ${proposalId}`);
      await waitForNonce(rawProvider, deployer.address, nonce);
      console.log(`  → re-run this script after the 48h Timelock delay to execute it.`);
    } else if (!prop.executed && !prop.cancelled) {
      const effective = prop.timestamp + 172800n; // TIMELOCK_DELAY
      const now = BigInt((await rawProvider.getBlock("latest"))!.timestamp);
      if (now >= effective) {
        console.log("Step 1 — executing the matured setAdminGovernor proposal...");
        const data = timelock.interface.encodeFunctionData("execute", [proposalId]);
        const nonce = await rawProvider.getTransactionCount(deployer.address);
        const tx = await deployer.sendTransaction({ to: timelockAddr, data, gasLimit: GAS_LIMIT, type: 0, gasPrice: GAS_PRICE });
        console.log(`  executed: tx ${tx.hash} → router.adminGovernor = Council`);
        await waitForNonce(rawProvider, deployer.address, nonce);
      } else {
        console.log(`Step 1 — proposal pending; executable at unix ${effective} (now ${now}). Re-run after the delay.`);
      }
    } else {
      console.log("Step 1 — prior proposal already executed/cancelled; check adminGovernor above.");
    }
  }

  // ── Step 2: hand the Timelock itself to the Council (two-step) ─────────────
  if (tlOwner.toLowerCase() === councilAddr.toLowerCase()) {
    console.log("Step 2 — Timelock already owned by the Council. Done.");
  } else if (tlPending.toLowerCase() === councilAddr.toLowerCase()) {
    console.log("Step 2 — transfer already pending; Council must call acceptOwnership (see runbook).");
  } else if (tlOwner.toLowerCase() === deployer.address.toLowerCase()) {
    console.log("Step 2 — transferring Timelock ownership to the Council (sets pendingOwner)...");
    const data = timelock.interface.encodeFunctionData("transferOwnership", [councilAddr]);
    const nonce = await rawProvider.getTransactionCount(deployer.address);
    const tx = await deployer.sendTransaction({ to: timelockAddr, data, gasLimit: GAS_LIMIT, type: 0, gasPrice: GAS_PRICE });
    console.log(`  transferOwnership: tx ${tx.hash}  pendingOwner → Council`);
    await waitForNonce(rawProvider, deployer.address, nonce);
  } else {
    console.log(`Step 2 — Timelock owner is neither deployer nor Council (${tlOwner}); cannot proceed.`);
  }

  // ── Runbook for the Council-side steps the deployer CANNOT perform ──────────
  console.log(`\n──────────────────────────────────────────────────────────────────`);
  console.log(`COUNCIL RUNBOOK (cannot be done by the deployer):`);
  console.log(`  1. Council accepts Timelock ownership — a Council proposal targeting:`);
  console.log(`       target   = ${timelockAddr}`);
  console.log(`       calldata = DatumTimelock.acceptOwnership()`);
  console.log(`     propose → reach threshold → (veto window) → execute.`);
  console.log(`     After this, timelock.owner() == Council and the deployer has no admin root.`);
  console.log(`  2. If Step 1 (adminGovernor) is still pending at hand-off, the Council`);
  console.log(`     drives it instead, now that it owns the Timelock:`);
  console.log(`       council.propose([timelock],[0],[timelock.propose(router, setAdminGovernor(council), salt)])`);
  console.log(`       → 48h → council executes timelock.execute(proposalId).`);
  console.log(`  3. Thereafter ALL admin ops (incl. router.setGovernor phase transitions)`);
  console.log(`     = Council proposal + 48h Timelock. Verify with: router.adminGovernor()`);
  console.log(`     == Council and timelock.owner() == Council.`);
  console.log(`──────────────────────────────────────────────────────────────────`);
}

main().catch((e) => { console.error(e); process.exit(1); });
