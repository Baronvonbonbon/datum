#!/usr/bin/env node
// Copies ABI arrays from alpha/artifacts into extension/src/shared/abis/
const fs = require("fs");
const path = require("path");

const contracts = [
  "DatumCampaigns",
  "DatumPublishers",
  "DatumGovernanceV2",
  "DatumGovernanceSlash",
  "DatumSettlement",
  "DatumRelay",
  "DatumPauseRegistry",
  "DatumTimelock",
  "DatumZKVerifier",
];

const srcDir = path.resolve(__dirname, "../../alpha/artifacts/contracts");
const destDir = path.resolve(__dirname, "../src/shared/abis");
fs.mkdirSync(destDir, { recursive: true });

for (const name of contracts) {
  const src = path.join(srcDir, `${name}.sol`, `${name}.json`);
  const artifact = JSON.parse(fs.readFileSync(src, "utf8"));
  const dest = path.join(destDir, `${name}.json`);
  fs.writeFileSync(dest, JSON.stringify({ abi: artifact.abi }, null, 2));
  console.log(`Copied ${name}.json (${artifact.abi.length} entries)`);
}
