#!/usr/bin/env node
// Refreshes the extension's bundled ABIs from the compiled Hardhat artifacts.
//
// The set of contracts to sync is derived from whatever JSON files already live
// in src/shared/abis/ — so adding a new contract is just `touch`-ing its ABI
// file once (or copying any artifact) and re-running this; you never have to
// keep a hardcoded list in sync. Run `npx hardhat compile` in alpha-5 first.
const fs = require("fs");
const path = require("path");

// alpha-core/artifacts/contracts (Hardhat `paths.artifacts = ./artifacts`)
const srcDir = path.resolve(__dirname, "../../artifacts/contracts");
const destDir = path.resolve(__dirname, "../src/shared/abis");
fs.mkdirSync(destDir, { recursive: true });

if (!fs.existsSync(srcDir)) {
  console.error(
    `[copy-abis] artifacts not found at ${srcDir}\n` +
      `  Run \`npx hardhat compile\` in alpha-5 before refreshing ABIs.`,
  );
  process.exit(1);
}

const names = fs
  .readdirSync(destDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

// Artifacts mirror the contracts/ tree, so a contract may live in a subdir
// (e.g. contracts/token/DatumWrapper.sol). Resolve `${name}.sol/${name}.json`
// anywhere under srcDir.
function findArtifact(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === `${name}.sol`) {
      const candidate = path.join(full, `${name}.json`);
      if (fs.existsSync(candidate)) return candidate;
    }
    const nested = findArtifact(full, name);
    if (nested) return nested;
  }
  return null;
}

let updated = 0;
const missing = [];
for (const name of names) {
  const src = findArtifact(srcDir, name);
  if (!src) {
    missing.push(name);
    continue;
  }
  const artifact = JSON.parse(fs.readFileSync(src, "utf8"));
  const dest = path.join(destDir, `${name}.json`);
  // Write the bare ABI array — the extension's committed convention (the
  // `abi()` normalizer in contracts.ts accepts both, but bare-array keeps
  // these files consistent with the rest of src/shared/abis/).
  fs.writeFileSync(dest, JSON.stringify(artifact.abi, null, 2));
  console.log(`Copied ${name}.json (${artifact.abi.length} entries)`);
  updated++;
}

console.log(`\n[copy-abis] refreshed ${updated}/${names.length} ABIs`);
if (missing.length) {
  console.warn(
    `[copy-abis] no artifact found for: ${missing.join(", ")}\n` +
      `  (interface-only or renamed contracts — left untouched)`,
  );
}
