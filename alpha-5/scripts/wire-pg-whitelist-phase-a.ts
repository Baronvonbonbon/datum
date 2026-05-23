// Whitelist the Phase A setters in DatumParameterGovernance so PG.execute()
// can actually route a proposal through to setMinimumCpmFloor /
// setPendingTimeoutBlocks (DatumCampaigns) and setInactivityTimeoutBlocks
// (DatumCampaignLifecycle).
//
// PG enforces TWO gates at execute() time:
//   - whitelistedTargets[p.target]       → "E75" if not in
//   - permittedSelectors[p.target][sel]  → "E76" if not in
//
// Run AFTER deploy.ts + wire-phase-a-pg.ts. Idempotent: re-running sets
// already-allowed flags to true again, which is a no-op.

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

interface Entry {
  target: string;       // contract address
  contractName: string; // "DatumCampaigns" / "DatumCampaignLifecycle"
  selectors: string[];  // function signatures, e.g. "setMinimumCpmFloor(uint256)"
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf-8"));

  console.log(`Deployer: ${deployer.address}`);
  console.log(`ParameterGovernance: ${addrs.parameterGovernance}`);
  console.log();

  const pg = await ethers.getContractAt("DatumParameterGovernance", addrs.parameterGovernance);

  const owner = await pg.owner();
  console.log(`PG owner: ${owner}`);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.warn(`  WARNING: deployer is not PG owner. The setWhitelistedTarget / setPermittedSelector calls will revert.`);
    console.warn(`  Run this from the owner account, or transfer ownership back to deployer first.`);
  }

  const locked = await pg.whitelistLocked();
  if (locked) {
    console.error(`PG.whitelistLocked = true. Cannot add new entries. Aborting.`);
    process.exit(1);
  }

  const entries: Entry[] = [
    {
      target: addrs.campaigns,
      contractName: "DatumCampaigns",
      selectors: ["setMinimumCpmFloor(uint256)", "setPendingTimeoutBlocks(uint256)"],
    },
    {
      target: addrs.campaignLifecycle,
      contractName: "DatumCampaignLifecycle",
      selectors: ["setInactivityTimeoutBlocks(uint256)"],
    },
  ];

  // ── Step 1: whitelist targets ───────────────────────────────────────────
  for (const e of entries) {
    const before = await pg.whitelistedTargets(e.target);
    if (before) {
      console.log(`[skip] target ${e.contractName} (${e.target}) already whitelisted`);
      continue;
    }
    console.log(`[wire] target ${e.contractName} (${e.target})`);
    const tx = await pg.setWhitelistedTarget(e.target, true);
    const r = await tx.wait();
    console.log(`         tx: ${tx.hash} block ${r?.blockNumber}`);
  }

  // ── Step 2: whitelist selectors ─────────────────────────────────────────
  for (const e of entries) {
    for (const sig of e.selectors) {
      const sel = ethers.id(sig).slice(0, 10); // first 4 bytes = 8 hex chars + "0x"
      const before = await pg.permittedSelectors(e.target, sel);
      if (before) {
        console.log(`[skip] selector ${e.contractName}.${sig} (${sel}) already permitted`);
        continue;
      }
      console.log(`[wire] selector ${e.contractName}.${sig} (${sel})`);
      const tx = await pg.setPermittedSelector(e.target, sel, true);
      const r = await tx.wait();
      console.log(`         tx: ${tx.hash} block ${r?.blockNumber}`);
    }
  }

  // ── Verification ────────────────────────────────────────────────────────
  console.log();
  console.log(`── Final state ──`);
  for (const e of entries) {
    const t = await pg.whitelistedTargets(e.target);
    console.log(`  ${e.contractName.padEnd(24)} target whitelisted: ${t}`);
    for (const sig of e.selectors) {
      const sel = ethers.id(sig).slice(0, 10);
      const ok = await pg.permittedSelectors(e.target, sel);
      console.log(`    ${sig.padEnd(36)} selector permitted: ${ok}`);
    }
  }

  console.log();
  console.log(`Phase A setters are now reachable via PG.propose() → vote → execute().`);
  console.log(`Lock-down step (post-OpenGov): call pg.lockWhitelist() under Phase 2.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
