#!/usr/bin/env node
// sync-abis.mjs — regenerate web/src/shared/abis/*.json from the canonical
// alpha-5 Hardhat artifacts, so the web app's ABIs always match the deployed
// contracts. The web ABIs are stored as raw ABI arrays; artifacts are
// {abi, bytecode, ...} — we extract `.abi`.
//
// Root cause this addresses: there was no web-side ABI sync step, so the web
// ABIs silently lagged the contracts across the alpha-4 → alpha-5 carryover
// (missing the upgrade-ladder surface, and carrying the stranded selection-
// policy `policyId` envelope that alpha-5 never shipped). Re-run after any
// contract change + recompile:  node scripts/sync-abis.mjs
//
// Files in web abis that have NO matching artifact (token-plane contracts not
// compiled into alpha-core/artifacts/contracts/<Name>.sol/) are left untouched
// and reported, so nothing is dropped silently.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const webAbiDir = path.join(repoRoot, "web", "src", "shared", "abis");
const artDir = path.join(repoRoot, "alpha-core", "artifacts", "contracts");

let synced = 0;
const skipped = [];

for (const file of fs.readdirSync(webAbiDir).filter((f) => f.endsWith(".json"))) {
  const name = file.replace(/\.json$/, "");
  const artifact = path.join(artDir, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(artifact)) {
    skipped.push(name);
    continue;
  }
  const abi = JSON.parse(fs.readFileSync(artifact, "utf8")).abi;
  fs.writeFileSync(path.join(webAbiDir, file), JSON.stringify(abi, null, 2) + "\n");
  synced++;
}

console.log(`[sync-abis] regenerated ${synced} ABI(s) from alpha-core artifacts.`);
if (skipped.length) {
  console.log(`[sync-abis] no artifact found (left untouched): ${skipped.join(", ")}`);
}
