// toggle-stakeroot-mode.ts
//
// Runtime mode switch for the StakeRoot oracle wiring on ClaimValidator.
// Does NOT redeploy anything — just calls the owner setters on the live
// ClaimValidator. Reversible (until ClaimValidator.lockPlumbing is called).
//
// Modes:
//   shadow  — ClaimValidator.stakeRoot = V1, stakeRoot2 = address(0).
//             V2 still produces roots, but proofs against V2 roots are
//             rejected by claim validation. This is the default operating
//             posture during early mainnet.
//   dual    — ClaimValidator.stakeRoot = V1, stakeRoot2 = V2.
//             validateClaim accepts a recent root from EITHER oracle. V2
//             is now load-bearing. Promotion criteria: see
//             narrative-analysis/stakeroot-shadow-mode.md.
//   v2-sole — ClaimValidator.stakeRoot = V2, stakeRoot2 = address(0).
//             V1 retired. Long-term cypherpunk endgame; sets V1.deprecated
//             along the way as a soft signal.
//
// Usage:
//   MODE=dual npx hardhat run scripts/toggle-stakeroot-mode.ts --network polkadotTestnet
//
// Reads contract addresses from alpha-4/deployed-addresses.json.

import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

type Mode = "shadow" | "dual" | "v2-sole";

function parseMode(s: string | undefined): Mode {
  const v = (s ?? "").toLowerCase();
  if (v === "shadow" || v === "dual" || v === "v2-sole") return v;
  throw new Error(`Set MODE=shadow|dual|v2-sole (got '${s}')`);
}

interface Addresses {
  claimValidator: string;
  stakeRoot: string;       // V1
  stakeRootV2: string;
  [k: string]: string;
}

function loadAddresses(): Addresses {
  const p = path.join(__dirname, "..", "deployed-addresses.json");
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const k of ["claimValidator", "stakeRoot", "stakeRootV2"]) {
    if (!a[k]) throw new Error(`deployed-addresses.json missing '${k}'`);
  }
  return a;
}

async function main() {
  const mode: Mode = parseMode(process.env.MODE);
  const addrs = loadAddresses();

  const validator = await ethers.getContractAt("DatumClaimValidator", addrs.claimValidator);
  const cur1: string = await validator.stakeRoot();
  const cur2: string = await validator.stakeRoot2();
  console.log(`Current wiring:`);
  console.log(`  stakeRoot  = ${cur1}`);
  console.log(`  stakeRoot2 = ${cur2}`);
  console.log(`Target mode: ${mode}`);

  // Pre-flight: validator must not be plumbing-locked.
  try {
    const locked: boolean = await (validator as any).plumbingLocked();
    if (locked) {
      console.error("ABORT: ClaimValidator.plumbingLocked is true — wiring is frozen.");
      process.exit(1);
    }
  } catch { /* older deploy without the getter; setters will revert if locked anyway */ }

  let target1 = cur1;
  let target2 = cur2;
  if (mode === "shadow")  { target1 = addrs.stakeRoot;   target2 = ethers.ZeroAddress; }
  if (mode === "dual")    { target1 = addrs.stakeRoot;   target2 = addrs.stakeRootV2;  }
  if (mode === "v2-sole") { target1 = addrs.stakeRootV2; target2 = ethers.ZeroAddress; }

  const changes: string[] = [];
  if (target1.toLowerCase() !== cur1.toLowerCase()) {
    changes.push(`setStakeRoot(${target1})`);
    const tx = await validator.setStakeRoot(target1);
    await tx.wait();
    console.log(`  ✓ setStakeRoot(${target1})`);
  }
  if (target2.toLowerCase() !== cur2.toLowerCase()) {
    // setStakeRoot2 accepts address(0) — used to disable the secondary.
    changes.push(`setStakeRoot2(${target2})`);
    const tx = await validator.setStakeRoot2(target2);
    await tx.wait();
    console.log(`  ✓ setStakeRoot2(${target2})`);
  }

  // Soft-deprecate V1 when moving to v2-sole.
  if (mode === "v2-sole") {
    const v1 = await ethers.getContractAt("DatumStakeRoot", addrs.stakeRoot);
    const dep: boolean = await v1.deprecated();
    if (!dep) {
      changes.push(`V1.setDeprecated(true)`);
      const tx = await v1.setDeprecated(true);
      await tx.wait();
      console.log(`  ✓ V1.setDeprecated(true)`);
    }
  }
  // Re-arm V1 if we ever come back from v2-sole.
  if (mode === "shadow" || mode === "dual") {
    try {
      const v1 = await ethers.getContractAt("DatumStakeRoot", addrs.stakeRoot);
      const dep: boolean = await v1.deprecated();
      if (dep) {
        changes.push(`V1.setDeprecated(false)`);
        const tx = await v1.setDeprecated(false);
        await tx.wait();
        console.log(`  ✓ V1.setDeprecated(false)`);
      }
    } catch { /* ignore — non-owner caller can't flip it back, surfaces as a noop */ }
  }

  if (changes.length === 0) {
    console.log(`No changes — ClaimValidator already in '${mode}' mode.`);
  } else {
    console.log(`\nMode switched to '${mode}'. Applied:`);
    for (const c of changes) console.log(`  - ${c}`);
  }

  // Re-read for confirmation
  const after1: string = await validator.stakeRoot();
  const after2: string = await validator.stakeRoot2();
  console.log(`\nFinal wiring:`);
  console.log(`  stakeRoot  = ${after1}`);
  console.log(`  stakeRoot2 = ${after2}`);
}

main().catch(e => { console.error(e); process.exit(1); });
