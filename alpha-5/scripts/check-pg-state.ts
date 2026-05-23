import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf-8"));
  const pg = await ethers.getContractAt("DatumParameterGovernance", addrs.parameterGovernance);
  const owner = await pg.owner();
  let pending = "";
  try { pending = await (pg as any).pendingOwner(); } catch { /* */ }
  const locked = await pg.whitelistLocked();

  console.log(`ParameterGovernance @ ${addrs.parameterGovernance}`);
  console.log(`  owner          = ${owner}`);
  console.log(`  pendingOwner   = ${pending || "(no getter)"}`);
  console.log(`  whitelistLocked= ${locked}`);

  // Check current whitelist status for our targets and a few existing selectors
  const campaignsTarget = await pg.whitelistedTargets(addrs.campaigns);
  const lifecycleTarget = await pg.whitelistedTargets(addrs.campaignLifecycle);
  const psTarget = await pg.whitelistedTargets(addrs.publisherStake);
  console.log();
  console.log(`Whitelisted targets:`);
  console.log(`  DatumCampaigns (Phase A)         = ${campaignsTarget}`);
  console.log(`  DatumCampaignLifecycle (Phase A) = ${lifecycleTarget}`);
  console.log(`  DatumPublisherStake (existing)   = ${psTarget}`);

  // Check known-existing selectors
  const setMinimumCpmFloorSel = ethers.id("setMinimumCpmFloor(uint256)").slice(0, 10);
  const setPendingTimeoutSel  = ethers.id("setPendingTimeoutBlocks(uint256)").slice(0, 10);
  const setInactivitySel      = ethers.id("setInactivityTimeoutBlocks(uint256)").slice(0, 10);
  const psSetParamsSel        = ethers.id("setParams(uint256,uint256,uint256)").slice(0, 10);

  console.log();
  console.log(`Permitted selectors on each target:`);
  console.log(`  Campaigns.setMinimumCpmFloor              ${setMinimumCpmFloorSel} = ${await pg.permittedSelectors(addrs.campaigns, setMinimumCpmFloorSel)}`);
  console.log(`  Campaigns.setPendingTimeoutBlocks         ${setPendingTimeoutSel}  = ${await pg.permittedSelectors(addrs.campaigns, setPendingTimeoutSel)}`);
  console.log(`  Lifecycle.setInactivityTimeoutBlocks      ${setInactivitySel}      = ${await pg.permittedSelectors(addrs.campaignLifecycle, setInactivitySel)}`);
  console.log(`  PublisherStake.setParams(u256,u256,u256)  ${psSetParamsSel}        = ${await pg.permittedSelectors(addrs.publisherStake, psSetParamsSel)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
