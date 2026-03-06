import { ethers } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import * as fs from "fs";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying DATUM contracts with:", deployer.address);

  // Deployment parameters
  // All amounts in planck (1 DOT = 10^10 planck)
  // Block times: Polkadot Hub = 6s/block
  const MIN_CPM_FLOOR = parseDOT("0.001");           // 0.001 DOT per 1000 impressions
  const PENDING_TIMEOUT_BLOCKS = 100800n;             // ~7 days at 6s/block
  const TAKE_RATE_UPDATE_DELAY = 14400n;              // ~24h at 6s/block

  const ACTIVATION_THRESHOLD = parseDOT("100");       // 100 DOT weighted aye
  const TERMINATION_THRESHOLD = parseDOT("50");       // 50 DOT weighted nay
  const MIN_REVIEWER_STAKE = parseDOT("10");          // 10 DOT min reviewer
  const BASE_LOCKUP_BLOCKS = 14400n;                  // ~24h base lockup at 6s/block
  const MAX_LOCKUP_DURATION = 5256000n;               // ~365 days in blocks at 6s/block

  // 1. Deploy DatumPublishers
  console.log("\n[1/6] Deploying DatumPublishers...");
  const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
  const publishers = await PublishersFactory.deploy(TAKE_RATE_UPDATE_DELAY);
  await publishers.waitForDeployment();
  const publishersAddr = await publishers.getAddress();
  console.log("  DatumPublishers:", publishersAddr);

  // 2. Deploy DatumCampaigns
  console.log("[2/6] Deploying DatumCampaigns...");
  const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
  const campaigns = await CampaignsFactory.deploy(
    MIN_CPM_FLOOR,
    PENDING_TIMEOUT_BLOCKS,
    publishersAddr
  );
  await campaigns.waitForDeployment();
  const campaignsAddr = await campaigns.getAddress();
  console.log("  DatumCampaigns:", campaignsAddr);

  // 3. Deploy DatumGovernanceVoting
  console.log("[3/6] Deploying DatumGovernanceVoting...");
  const VotingFactory = await ethers.getContractFactory("DatumGovernanceVoting");
  const voting = await VotingFactory.deploy(
    campaignsAddr,
    ACTIVATION_THRESHOLD,
    TERMINATION_THRESHOLD,
    MIN_REVIEWER_STAKE,
    BASE_LOCKUP_BLOCKS,
    MAX_LOCKUP_DURATION
  );
  await voting.waitForDeployment();
  const votingAddr = await voting.getAddress();
  console.log("  DatumGovernanceVoting:", votingAddr);

  // 4. Deploy DatumGovernanceRewards
  console.log("[4/6] Deploying DatumGovernanceRewards...");
  const RewardsFactory = await ethers.getContractFactory("DatumGovernanceRewards");
  const rewards = await RewardsFactory.deploy(votingAddr, campaignsAddr);
  await rewards.waitForDeployment();
  const rewardsAddr = await rewards.getAddress();
  console.log("  DatumGovernanceRewards:", rewardsAddr);

  // 5. Deploy DatumSettlement
  console.log("[5/6] Deploying DatumSettlement...");
  const SettleFactory = await ethers.getContractFactory("DatumSettlement");
  const settlement = await SettleFactory.deploy(campaignsAddr);
  await settlement.waitForDeployment();
  const settlementAddr = await settlement.getAddress();
  console.log("  DatumSettlement:", settlementAddr);

  // 6. Deploy DatumRelay
  console.log("[6/7] Deploying DatumRelay...");
  const RelayFactory = await ethers.getContractFactory("DatumRelay");
  const relay = await RelayFactory.deploy(settlementAddr, campaignsAddr);
  await relay.waitForDeployment();
  const relayAddr = await relay.getAddress();
  console.log("  DatumRelay:", relayAddr);

  // 7. Deploy DatumZKVerifier (stub)
  console.log("[7/7] Deploying DatumZKVerifier (stub)...");
  const ZKFactory = await ethers.getContractFactory("DatumZKVerifier");
  const zkVerifier = await ZKFactory.deploy();
  await zkVerifier.waitForDeployment();
  const zkVerifierAddr = await zkVerifier.getAddress();
  console.log("  DatumZKVerifier:", zkVerifierAddr);

  // 8. Wire contracts
  console.log("\nWiring contracts...");
  await voting.setRewardsContract(rewardsAddr);
  console.log("  Rewards wired to voting:", rewardsAddr);

  await campaigns.setGovernanceContract(votingAddr);
  await campaigns.setSettlementContract(settlementAddr);
  console.log("  Voting (governance) wired to campaigns:", votingAddr);
  console.log("  Settlement wired to campaigns:", settlementAddr);

  await settlement.setRelayContract(relayAddr);
  console.log("  Relay wired to settlement:", relayAddr);

  await settlement.setZKVerifier(zkVerifierAddr);
  console.log("  ZK verifier wired to settlement:", zkVerifierAddr);

  // Write deployed addresses to JSON for extension and scripts
  const addresses = {
    publishers: publishersAddr,
    campaigns: campaignsAddr,
    governanceVoting: votingAddr,
    governanceRewards: rewardsAddr,
    settlement: settlementAddr,
    relay: relayAddr,
    zkVerifier: zkVerifierAddr,
  };

  const outPath = __dirname + "/../deployed-addresses.json";
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2) + "\n");
  console.log(`\nAddresses written to ${outPath}`);

  // Also write to the extension's artifacts directory for easy loading
  const extPath = __dirname + "/../../extension/deployed-addresses.json";
  fs.writeFileSync(extPath, JSON.stringify(addresses, null, 2) + "\n");
  console.log(`Addresses written to ${extPath}`);

  console.log("\n=== DATUM Deployment Complete ===");
  console.log(addresses);

  console.log("\nTo configure the extension, paste these addresses in Settings,");
  console.log("or they will auto-load on next extension reload.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
