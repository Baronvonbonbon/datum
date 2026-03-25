import { ethers } from "hardhat";
import * as fs from "fs";

async function main() {
  // Load addresses from deploy output (falls back to hardcoded)
  let addrs: Record<string, string> = {
    campaigns: "0x82745827D0B8972eC0583B3100eCb30b81Db0072",
    governanceV2: "0xEC69d4f48f4f1740976968FAb9828d645Ad1d77f",
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

  const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];
  for (let i = 1n; i < nextId; i++) {
    const status = await campaigns.getCampaignStatus(i);
    console.log(`Campaign ${i}: status=${status.toString()} (${STATUS[Number(status)]})`);
  }

  const v2 = await ethers.getContractAt("DatumGovernanceV2", addrs.governanceV2);
  const quorum = await v2.quorumWeighted();
  const slashBps = await v2.slashBps();
  console.log("quorumWeighted:", quorum.toString());
  console.log("slashBps:", slashBps.toString());
}
main().catch(console.error);
