import { ethers } from "hardhat";
async function main() {
  const campaigns = await ethers.getContractAt("DatumCampaigns", "0x970951a12F975E6762482ACA81E57D5A2A4e73F4");
  const govAddr = await campaigns.governanceContract();
  console.log("campaigns.governanceContract():", govAddr);

  const campaign = await campaigns.getCampaign(1n);
  const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated"];
  console.log("Campaign 1 status:", campaign.status.toString(), `(${STATUS[Number(campaign.status)]})`);

  const voting = await ethers.getContractAt("DatumGovernanceVoting", "0x3ed62137c5DB927cb137c26455969116BF0c23Cb");
  const cv = await voting.getCampaignVote(1n);
  const threshold = await voting.activationThreshold();
  const minStake = await voting.minReviewerStake();
  console.log("ayeTotal:", cv.ayeTotal.toString());
  console.log("activated:", cv.activated);
  console.log("activationThreshold:", threshold.toString());
  console.log("minReviewerStake:", minStake.toString());
}
main().catch(console.error);
