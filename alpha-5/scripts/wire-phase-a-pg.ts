// Phase A wiring: set parameterGovernance on the freshly-deployed
// DatumCampaigns v2 + DatumCampaignLifecycle v2. Lock-once on the
// receiving side, so this is a one-shot operation.
//
// Run AFTER scripts/deploy.ts on Paseo. Idempotent: if the address is
// already set, the second call reverts "already set" and the script
// surfaces it as a no-op.

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf-8"));

  console.log(`Deployer: ${deployer.address}`);
  console.log(`ParameterGovernance: ${addrs.parameterGovernance}`);
  console.log(`DatumCampaigns:           ${addrs.campaigns}`);
  console.log(`DatumCampaignLifecycle:   ${addrs.campaignLifecycle}`);
  console.log();

  const campaigns = await ethers.getContractAt("DatumCampaigns", addrs.campaigns);
  const lifecycle = await ethers.getContractAt("DatumCampaignLifecycle", addrs.campaignLifecycle);

  // Campaigns
  const cPg = await campaigns.parameterGovernance();
  if (cPg !== ethers.ZeroAddress) {
    console.log(`Campaigns.parameterGovernance already set to ${cPg} — skipping`);
  } else {
    console.log(`Wiring Campaigns.parameterGovernance...`);
    const tx = await campaigns.setParameterGovernance(addrs.parameterGovernance);
    const r = await tx.wait();
    console.log(`  tx: ${tx.hash} block ${r?.blockNumber}`);
  }

  // Lifecycle
  const lPg = await lifecycle.parameterGovernance();
  if (lPg !== ethers.ZeroAddress) {
    console.log(`Lifecycle.parameterGovernance already set to ${lPg} — skipping`);
  } else {
    console.log(`Wiring Lifecycle.parameterGovernance...`);
    const tx = await lifecycle.setParameterGovernance(addrs.parameterGovernance);
    const r = await tx.wait();
    console.log(`  tx: ${tx.hash} block ${r?.blockNumber}`);
  }

  console.log();
  console.log(`Done. Phase A parameters are now retunable via:`);
  console.log(`  - Owner path (currently deployer; transitioning to Timelock)`);
  console.log(`  - ParameterGovernance bicameral retune flow`);
}

main().catch((e) => { console.error(e); process.exit(1); });
