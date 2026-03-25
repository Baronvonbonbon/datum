// Developer CLI tool for IPFS campaign metadata.
//
// Two modes:
//   --file metadata/sample-crypto.json   Validate schema, print pinning instructions
//   --cid QmXyz... --campaign 1          Encode CID→bytes32, call setMetadata on-chain
//
// Usage:
//   npx hardhat run scripts/upload-metadata.ts -- --file metadata/sample-crypto.json
//   npx hardhat run scripts/upload-metadata.ts -- --cid QmXyz... --campaign 1

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { cidToBytes32, bytes32ToCid } from "./lib/ipfs";

const REQUIRED_FIELDS = ["title", "description", "category", "creative", "version"];
const REQUIRED_CREATIVE_FIELDS = ["type", "text", "cta", "ctaUrl"];

// Default address — override via environment or edit for your deployment
const CAMPAIGNS_ADDRESS = process.env.CAMPAIGNS_ADDRESS || "0x970951a12F975E6762482ACA81E57D5A2A4e73F4";

function parseArgs(): { file?: string; cid?: string; campaign?: number } {
  const args = process.argv.slice(2);
  const result: { file?: string; cid?: string; campaign?: number } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) result.file = args[++i];
    if (args[i] === "--cid" && args[i + 1]) result.cid = args[++i];
    if (args[i] === "--campaign" && args[i + 1]) result.campaign = Number(args[++i]);
  }
  return result;
}

function validateMetadata(data: any): string[] {
  const errors: string[] = [];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in data)) errors.push(`Missing required field: ${f}`);
  }
  if (data.creative) {
    for (const f of REQUIRED_CREATIVE_FIELDS) {
      if (!(f in data.creative)) errors.push(`Missing creative field: ${f}`);
    }
    if (data.creative.type && data.creative.type !== "text") {
      errors.push(`Unsupported creative type: ${data.creative.type} (only "text" supported)`);
    }
  }
  if (data.version !== undefined && data.version !== 1) {
    errors.push(`Unsupported version: ${data.version} (expected 1)`);
  }
  return errors;
}

async function handleFile(filePath: string) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("Invalid JSON");
    process.exitCode = 1;
    return;
  }

  console.log("=== Metadata Validation ===");
  console.log(`File: ${resolved}`);
  const errors = validateMetadata(data);
  if (errors.length > 0) {
    console.error("Validation FAILED:");
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
    return;
  }
  console.log("Schema: VALID");
  console.log(`Title:    ${data.title}`);
  console.log(`Category: ${data.category}`);
  console.log(`Creative: ${data.creative.type} — "${data.creative.text.slice(0, 60)}..."`);

  console.log("\n=== Next Steps ===");
  console.log("1. Pin this file to IPFS and note the CIDv0 (Qm...):");
  console.log(`     ipfs add ${resolved}`);
  console.log("   Or use a pinning service (Pinata, web3.storage, etc.)");
  console.log("\n2. Set the metadata on-chain:");
  console.log(`     npx hardhat run scripts/upload-metadata.ts -- --cid <CID> --campaign <ID>`);
}

async function handleCid(cid: string, campaignId: number) {
  console.log("=== Set Campaign Metadata ===");
  console.log(`CID:         ${cid}`);

  const hash = cidToBytes32(cid);
  console.log(`bytes32:     ${hash}`);

  // Round-trip verification
  const roundTrip = bytes32ToCid(hash);
  console.log(`Round-trip:  ${roundTrip}`);
  if (roundTrip !== cid) {
    console.error("Round-trip FAILED — CID mismatch");
    process.exitCode = 1;
    return;
  }
  console.log("Round-trip:  OK");

  console.log(`Campaign ID: ${campaignId}`);

  const [signer] = await ethers.getSigners();
  console.log(`Signer:      ${signer.address}`);

  const campaigns = await ethers.getContractAt("DatumCampaigns", CAMPAIGNS_ADDRESS);
  const tx = await campaigns.connect(signer).setMetadata(campaignId, hash);
  console.log(`TX hash:     ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt!.blockNumber}`);
  console.log("\nMetadata hash set on-chain successfully.");
}

async function main() {
  const args = parseArgs();

  if (args.file) {
    await handleFile(args.file);
  } else if (args.cid && args.campaign !== undefined) {
    await handleCid(args.cid, args.campaign);
  } else {
    console.log("Usage:");
    console.log("  --file <path>                 Validate metadata JSON, print pinning instructions");
    console.log("  --cid <CIDv0> --campaign <ID> Encode CID→bytes32 and call setMetadata on-chain");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
