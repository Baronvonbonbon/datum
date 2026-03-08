import { ethers } from "hardhat";
import { keccak256, toUtf8Bytes } from "ethers";
import * as fs from "fs";

async function main() {
  const [alith] = await ethers.getSigners();
  console.log("Using account:", alith.address);

  // Load addresses from deploy output (falls back to hardcoded)
  let addrs: Record<string, string> = {
    publishers: "0x294c664f6D63bd1521231a2EeFC26d805ce00a08",
    campaigns: "0x82745827D0B8972eC0583B3100eCb30b81Db0072",
    governanceV2: "0xEC69d4f48f4f1740976968FAb9828d645Ad1d77f",
  };
  const addrFile = __dirname + "/../deployed-addresses.json";
  if (fs.existsSync(addrFile)) {
    addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
    console.log("Loaded addresses from", addrFile);
  } else {
    console.log("No deployed-addresses.json found, using hardcoded addresses");
  }

  const publishers = await ethers.getContractAt("DatumPublishers", addrs.publishers);
  const campaigns  = await ethers.getContractAt("DatumCampaigns",  addrs.campaigns);
  const v2         = await ethers.getContractAt("DatumGovernanceV2", addrs.governanceV2);

  // Register Alith as publisher with 50% take rate (5000 bps) — skip if already registered
  console.log("Registering publisher...");
  const existing = await publishers.getPublisher(alith.address);
  if (existing.registered) {
    console.log("  Already registered:", alith.address);
  } else {
    await (await publishers.connect(alith).registerPublisher(5000)).wait();
    console.log("  Publisher registered:", alith.address);
  }

  // Create campaign: 10 DOT budget, daily cap = budget, 0.016 DOT bidCPM
  // signature: createCampaign(publisher, dailyCapPlanck, bidCpmPlanck, categoryId) payable
  // All amounts are multiples of 10^6 planck (required by eth-rpc denomination rounding)
  const BUDGET    = 100_000_000_000n; // 10 DOT in planck (msg.value = budget)
  const DAILY_CAP = 100_000_000_000n; // daily cap = budget (no sub-daily cap)
  const BID_CPM   =     160_000_000n; // 0.016 DOT per 1000 impressions
  const CATEGORY  = 1;                // 1 = crypto
  console.log("Creating campaign...");
  const tx = await campaigns.connect(alith).createCampaign(
    alith.address, DAILY_CAP, BID_CPM, CATEGORY,
    { value: BUDGET }
  );
  const receipt = await tx.wait();

  // Parse CampaignCreated event for campaign ID
  let campaignId: bigint | undefined;
  for (const log of receipt!.logs) {
    try {
      const parsed = campaigns.interface.parseLog(log);
      if (parsed?.name === "CampaignCreated") campaignId = parsed.args.campaignId;
    } catch { /* log from different contract */ }
  }
  if (campaignId === undefined) throw new Error("CampaignCreated event not found");
  console.log("  Campaign ID:", campaignId.toString());

  // Vote aye with conviction 0, enough to meet quorum, then evaluateCampaign to activate
  const signers = await ethers.getSigners();
  const baltathar = signers[1];
  const STAKE = 300_000_000_000n; // 30 DOT in planck
  console.log("Voting aye to activate...");
  const [alithDir] = await v2.getVote(campaignId, alith.address);
  const voter = alithDir === 0n ? alith : baltathar;
  console.log("  Voter:", voter.address);
  await (await v2.connect(voter).vote(campaignId, true, 0, { value: STAKE })).wait();
  console.log("  Vote cast");

  // Evaluate to activate
  await (await v2.evaluateCampaign(campaignId)).wait();
  console.log("  evaluateCampaign called");

  // Verify activation
  const status = await campaigns.getCampaignStatus(campaignId);
  const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated"];
  console.log("  Status:", status.toString(), `(${STATUS[Number(status)]})`);
  if (Number(status) !== 1) throw new Error("Campaign did not activate");

  // Set metadata hash so the extension's event query path is exercised
  // Uses a synthetic hash (won't resolve on IPFS but exercises the on-chain event flow)
  console.log("Setting metadata hash...");
  const syntheticHash = keccak256(toUtf8Bytes("test-metadata-" + campaignId.toString()));
  await (await campaigns.connect(alith).setMetadata(campaignId, syntheticHash)).wait();
  console.log("  Metadata hash:", syntheticHash);

  console.log("\n=== Setup Complete ===");
  console.log("Campaign ID :", campaignId.toString());
  console.log("Publisher   :", alith.address);
  console.log("Budget      : 10 DOT");
  console.log("Daily cap   : 10 DOT");
  console.log("Bid CPM     : 0.016 DOT");
  console.log("(Taxonomy matching is client-side in extension settings)");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
