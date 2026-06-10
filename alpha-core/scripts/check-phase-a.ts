import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf-8"));
  const campaigns = await ethers.getContractAt("DatumCampaigns", addrs.campaigns);
  const lifecycle = await ethers.getContractAt("DatumCampaignLifecycle", addrs.campaignLifecycle);

  const cVer = await campaigns.version();
  const lVer = await lifecycle.version();
  const minCpm = await campaigns.minimumCpmFloor();
  const pending = await campaigns.pendingTimeoutBlocks();
  const inactivity = await lifecycle.inactivityTimeoutBlocks();
  const cLocked = await campaigns.minimumCpmFloorLocked();
  const lLocked = await lifecycle.inactivityTimeoutBlocksLocked();
  const cOwner = await campaigns.owner();
  const lOwner = await lifecycle.owner();

  console.log(`DatumCampaigns @ ${addrs.campaigns}`);
  console.log(`  version()                 = ${cVer}`);
  console.log(`  minimumCpmFloor           = ${minCpm} planck`);
  console.log(`  pendingTimeoutBlocks      = ${pending}`);
  console.log(`  minimumCpmFloorLocked     = ${cLocked}`);
  console.log(`  owner()                   = ${cOwner}`);
  console.log();
  console.log(`DatumCampaignLifecycle @ ${addrs.campaignLifecycle}`);
  console.log(`  version()                       = ${lVer}`);
  console.log(`  inactivityTimeoutBlocks         = ${inactivity}`);
  console.log(`  inactivityTimeoutBlocksLocked   = ${lLocked}`);
  console.log(`  owner()                         = ${lOwner}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
