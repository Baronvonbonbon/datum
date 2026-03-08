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

  const QUORUM_WEIGHTED = parseDOT("100");            // 100 DOT conviction-weighted total
  const SLASH_BPS = 1000n;                            // 10% slash on losing side
  const BASE_LOCKUP_BLOCKS = 14400n;                  // ~24h base lockup at 6s/block
  const MAX_LOCKUP_BLOCKS = 5256000n;                 // ~365 days in blocks at 6s/block

  // 0. Deploy DatumPauseRegistry (global emergency pause)
  console.log("\n[0/8] Deploying DatumPauseRegistry...");
  const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
  const pauseRegistry = await PauseFactory.deploy();
  await pauseRegistry.waitForDeployment();
  const pauseRegistryAddr = await pauseRegistry.getAddress();
  console.log("  DatumPauseRegistry:", pauseRegistryAddr);

  // 0b. Deploy DatumTimelock (48h admin delay)
  console.log("[0b/8] Deploying DatumTimelock...");
  const TimelockFactory = await ethers.getContractFactory("DatumTimelock");
  const timelock = await TimelockFactory.deploy();
  await timelock.waitForDeployment();
  const timelockAddr = await timelock.getAddress();
  console.log("  DatumTimelock:", timelockAddr);

  // 1. Deploy DatumPublishers
  console.log("[1/8] Deploying DatumPublishers...");
  const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
  const publishers = await PublishersFactory.deploy(TAKE_RATE_UPDATE_DELAY);
  await publishers.waitForDeployment();
  const publishersAddr = await publishers.getAddress();
  console.log("  DatumPublishers:", publishersAddr);

  // 2. Deploy DatumCampaigns
  console.log("[2/8] Deploying DatumCampaigns...");
  const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
  const campaigns = await CampaignsFactory.deploy(
    MIN_CPM_FLOOR,
    PENDING_TIMEOUT_BLOCKS,
    publishersAddr,
    pauseRegistryAddr
  );
  await campaigns.waitForDeployment();
  const campaignsAddr = await campaigns.getAddress();
  console.log("  DatumCampaigns:", campaignsAddr);

  // 3. Deploy DatumGovernanceV2 (no pauseRegistry)
  console.log("[3/8] Deploying DatumGovernanceV2...");
  const V2Factory = await ethers.getContractFactory("DatumGovernanceV2");
  const governanceV2 = await V2Factory.deploy(
    campaignsAddr,
    QUORUM_WEIGHTED,
    SLASH_BPS,
    BASE_LOCKUP_BLOCKS,
    MAX_LOCKUP_BLOCKS
  );
  await governanceV2.waitForDeployment();
  const governanceV2Addr = await governanceV2.getAddress();
  console.log("  DatumGovernanceV2:", governanceV2Addr);

  // 4. Deploy DatumGovernanceSlash (no pauseRegistry)
  console.log("[4/8] Deploying DatumGovernanceSlash...");
  const SlashFactory = await ethers.getContractFactory("DatumGovernanceSlash");
  const slash = await SlashFactory.deploy(governanceV2Addr, campaignsAddr);
  await slash.waitForDeployment();
  const slashAddr = await slash.getAddress();
  console.log("  DatumGovernanceSlash:", slashAddr);

  // 5. Deploy DatumSettlement
  console.log("[5/8] Deploying DatumSettlement...");
  const SettleFactory = await ethers.getContractFactory("DatumSettlement");
  const settlement = await SettleFactory.deploy(campaignsAddr, pauseRegistryAddr);
  await settlement.waitForDeployment();
  const settlementAddr = await settlement.getAddress();
  console.log("  DatumSettlement:", settlementAddr);

  // 6. Deploy DatumRelay
  console.log("[6/8] Deploying DatumRelay...");
  const RelayFactory = await ethers.getContractFactory("DatumRelay");
  const relay = await RelayFactory.deploy(settlementAddr, campaignsAddr, pauseRegistryAddr);
  await relay.waitForDeployment();
  const relayAddr = await relay.getAddress();
  console.log("  DatumRelay:", relayAddr);

  // 7. Deploy DatumZKVerifier (stub)
  console.log("[7/8] Deploying DatumZKVerifier (stub)...");
  const ZKFactory = await ethers.getContractFactory("DatumZKVerifier");
  const zkVerifier = await ZKFactory.deploy();
  await zkVerifier.waitForDeployment();
  const zkVerifierAddr = await zkVerifier.getAddress();
  console.log("  DatumZKVerifier:", zkVerifierAddr);

  // 8. Wire contracts (immediate — deployer is owner)
  console.log("\nWiring contracts...");
  await governanceV2.setSlashContract(slashAddr);
  console.log("  Slash wired to GovernanceV2:", slashAddr);

  await campaigns.setGovernanceContract(governanceV2Addr);
  console.log("  GovernanceV2 wired to campaigns:", governanceV2Addr);

  await campaigns.setSettlementContract(settlementAddr);
  console.log("  Settlement wired to campaigns:", settlementAddr);

  await settlement.setRelayContract(relayAddr);
  console.log("  Relay wired to settlement:", relayAddr);

  await settlement.setZKVerifier(zkVerifierAddr);
  console.log("  ZKVerifier wired to settlement:", zkVerifierAddr);

  // 9. Transfer ownership of Campaigns and Settlement to Timelock
  console.log("\nTransferring ownership to timelock...");
  await campaigns.transferOwnership(timelockAddr);
  console.log("  DatumCampaigns ownership -> DatumTimelock");

  await settlement.transferOwnership(timelockAddr);
  console.log("  DatumSettlement ownership -> DatumTimelock");

  console.log("\n  Future admin changes go through:");
  console.log("    timelock.propose(target, abi.encodeCall(...)) -> 48h -> timelock.execute()");

  // Write deployed addresses to JSON for extension and scripts
  const addresses = {
    pauseRegistry: pauseRegistryAddr,
    timelock: timelockAddr,
    publishers: publishersAddr,
    campaigns: campaignsAddr,
    governanceV2: governanceV2Addr,
    governanceSlash: slashAddr,
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
