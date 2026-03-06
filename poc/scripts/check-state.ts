import { ethers } from "hardhat";
import * as fs from "fs";

async function main() {
  // Load addresses from deploy output (falls back to hardcoded)
  let addrs: Record<string, string> = {
    campaigns: "0x82745827D0B8972eC0583B3100eCb30b81Db0072",
    governanceVoting: "0xEC69d4f48f4f1740976968FAb9828d645Ad1d77f",
  };
  const addrFile = __dirname + "/../deployed-addresses.json";
  if (fs.existsSync(addrFile)) {
    addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
    console.log("Loaded addresses from", addrFile);
  }

  const campaigns = await ethers.getContractAt("DatumCampaigns", addrs.campaigns);
  const nextId = await campaigns.nextCampaignId();
  console.log("nextCampaignId:", nextId.toString());

  const govAddr = await campaigns.governanceContract();
  console.log("campaigns.governanceContract():", govAddr);

  const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated"];
  for (let i = 1n; i < nextId; i++) {
    const campaign = await campaigns.getCampaign(i);
    console.log(`Campaign ${i}: status=${campaign.status?.toString() ?? campaign[12]?.toString()} (${STATUS[Number(campaign.status ?? campaign[12])]})`);
  }

  const voting = await ethers.getContractAt("DatumGovernanceVoting", addrs.governanceVoting);
  const threshold = await voting.activationThreshold();
  const minStake = await voting.minReviewerStake();
  console.log("activationThreshold:", threshold.toString());
  console.log("minReviewerStake:", minStake.toString());
}
main().catch(console.error);
