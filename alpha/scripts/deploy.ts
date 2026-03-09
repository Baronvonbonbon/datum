import { ethers } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import * as fs from "fs";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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

  // Track deployed addresses for partial-failure recovery
  const addresses: Record<string, string> = {};
  let step = 0;
  const TOTAL_STEPS = 9;

  function logStep(label: string) {
    step++;
    console.log(`\n[${step}/${TOTAL_STEPS}] ${label}...`);
  }

  // -------------------------------------------------------------------
  // Deploy contracts (steps 1-7)
  // -------------------------------------------------------------------

  try {
    logStep("Deploying DatumPauseRegistry");
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    const pauseRegistry = await PauseFactory.deploy();
    await pauseRegistry.waitForDeployment();
    addresses.pauseRegistry = await pauseRegistry.getAddress();
    console.log("  DatumPauseRegistry:", addresses.pauseRegistry);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}/${TOTAL_STEPS}: DatumPauseRegistry deploy — ${err}`);
  }

  try {
    logStep("Deploying DatumTimelock");
    const TimelockFactory = await ethers.getContractFactory("DatumTimelock");
    const timelock = await TimelockFactory.deploy();
    await timelock.waitForDeployment();
    addresses.timelock = await timelock.getAddress();
    console.log("  DatumTimelock:", addresses.timelock);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}/${TOTAL_STEPS}: DatumTimelock deploy — ${err}`);
  }

  try {
    logStep("Deploying DatumPublishers");
    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    const publishers = await PublishersFactory.deploy(TAKE_RATE_UPDATE_DELAY);
    await publishers.waitForDeployment();
    addresses.publishers = await publishers.getAddress();
    console.log("  DatumPublishers:", addresses.publishers);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}/${TOTAL_STEPS}: DatumPublishers deploy — ${err}`);
  }

  try {
    logStep("Deploying DatumCampaigns");
    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    const campaigns = await CampaignsFactory.deploy(
      MIN_CPM_FLOOR,
      PENDING_TIMEOUT_BLOCKS,
      addresses.publishers,
      addresses.pauseRegistry
    );
    await campaigns.waitForDeployment();
    addresses.campaigns = await campaigns.getAddress();
    console.log("  DatumCampaigns:", addresses.campaigns);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}/${TOTAL_STEPS}: DatumCampaigns deploy — ${err}`);
  }

  try {
    logStep("Deploying DatumGovernanceV2");
    const V2Factory = await ethers.getContractFactory("DatumGovernanceV2");
    const governanceV2 = await V2Factory.deploy(
      addresses.campaigns,
      QUORUM_WEIGHTED,
      SLASH_BPS,
      BASE_LOCKUP_BLOCKS,
      MAX_LOCKUP_BLOCKS
    );
    await governanceV2.waitForDeployment();
    addresses.governanceV2 = await governanceV2.getAddress();
    console.log("  DatumGovernanceV2:", addresses.governanceV2);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}/${TOTAL_STEPS}: DatumGovernanceV2 deploy — ${err}`);
  }

  try {
    logStep("Deploying DatumGovernanceSlash");
    const SlashFactory = await ethers.getContractFactory("DatumGovernanceSlash");
    const slash = await SlashFactory.deploy(addresses.governanceV2, addresses.campaigns);
    await slash.waitForDeployment();
    addresses.governanceSlash = await slash.getAddress();
    console.log("  DatumGovernanceSlash:", addresses.governanceSlash);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}/${TOTAL_STEPS}: DatumGovernanceSlash deploy — ${err}`);
  }

  let settlement: Awaited<ReturnType<Awaited<ReturnType<typeof ethers.getContractFactory>>["deploy"]>>;

  try {
    logStep("Deploying DatumSettlement");
    const SettleFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettleFactory.deploy(addresses.campaigns, addresses.pauseRegistry);
    await settlement.waitForDeployment();
    addresses.settlement = await settlement.getAddress();
    console.log("  DatumSettlement:", addresses.settlement);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}/${TOTAL_STEPS}: DatumSettlement deploy — ${err}`);
  }

  try {
    // Continue step counter but this is deploy step for Relay
    logStep("Deploying DatumRelay");
    const RelayFactory = await ethers.getContractFactory("DatumRelay");
    const relay = await RelayFactory.deploy(addresses.settlement, addresses.campaigns, addresses.pauseRegistry);
    await relay.waitForDeployment();
    addresses.relay = await relay.getAddress();
    console.log("  DatumRelay:", addresses.relay);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}/${TOTAL_STEPS}: DatumRelay deploy — ${err}`);
  }

  try {
    logStep("Deploying DatumZKVerifier (stub)");
    const ZKFactory = await ethers.getContractFactory("DatumZKVerifier");
    const zkVerifier = await ZKFactory.deploy();
    await zkVerifier.waitForDeployment();
    addresses.zkVerifier = await zkVerifier.getAddress();
    console.log("  DatumZKVerifier:", addresses.zkVerifier);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}/${TOTAL_STEPS}: DatumZKVerifier deploy — ${err}`);
  }

  console.log("\n=== All 9 contracts deployed ===\n");

  // -------------------------------------------------------------------
  // Wire contracts with re-run safety
  // -------------------------------------------------------------------

  const governanceV2 = await ethers.getContractAt("DatumGovernanceV2", addresses.governanceV2);
  const campaigns = await ethers.getContractAt("DatumCampaigns", addresses.campaigns);
  const settlementContract = await ethers.getContractAt("DatumSettlement", addresses.settlement);

  console.log("Wiring contracts...");

  // Wire GovernanceV2 → Slash (one-time setter: check if already set)
  const currentSlash = await governanceV2.slashContract();
  if (currentSlash === ZERO_ADDRESS) {
    try {
      await (await governanceV2.setSlashContract(addresses.governanceSlash)).wait();
      console.log("  Slash wired to GovernanceV2");
    } catch (err) {
      throw new Error(`FAILED wiring: setSlashContract — ${err}`);
    }
  } else {
    console.log("  Slash already wired to GovernanceV2 (skipped)");
  }

  // Wire Campaigns → Governance
  const currentGov = await campaigns.governanceContract();
  if (currentGov === ZERO_ADDRESS) {
    try {
      await (await campaigns.setGovernanceContract(addresses.governanceV2)).wait();
      console.log("  GovernanceV2 wired to Campaigns");
    } catch (err) {
      throw new Error(`FAILED wiring: setGovernanceContract — ${err}`);
    }
  } else {
    console.log("  GovernanceV2 already wired to Campaigns (skipped)");
  }

  // Wire Campaigns → Settlement
  const currentSettlement = await campaigns.settlementContract();
  if (currentSettlement === ZERO_ADDRESS) {
    try {
      await (await campaigns.setSettlementContract(addresses.settlement)).wait();
      console.log("  Settlement wired to Campaigns");
    } catch (err) {
      throw new Error(`FAILED wiring: setSettlementContract — ${err}`);
    }
  } else {
    console.log("  Settlement already wired to Campaigns (skipped)");
  }

  // Wire Settlement → Relay
  const currentRelay = await settlementContract.relayContract();
  if (currentRelay === ZERO_ADDRESS) {
    try {
      await (await settlementContract.setRelayContract(addresses.relay)).wait();
      console.log("  Relay wired to Settlement");
    } catch (err) {
      throw new Error(`FAILED wiring: setRelayContract — ${err}`);
    }
  } else {
    console.log("  Relay already wired to Settlement (skipped)");
  }

  // Wire Settlement → ZKVerifier (can be re-set, not one-time)
  try {
    await (await settlementContract.setZKVerifier(addresses.zkVerifier)).wait();
    console.log("  ZKVerifier wired to Settlement");
  } catch (err) {
    // May fail if ownership already transferred — log and continue
    console.warn("  ZKVerifier wiring skipped (ownership may have transferred):", String(err).slice(0, 100));
  }

  // -------------------------------------------------------------------
  // Ownership transfer to Timelock
  // -------------------------------------------------------------------

  console.log("\nTransferring ownership to timelock...");

  const campaignsOwner = await campaigns.owner();
  if (campaignsOwner.toLowerCase() !== addresses.timelock.toLowerCase()) {
    try {
      await (await campaigns.transferOwnership(addresses.timelock)).wait();
      console.log("  DatumCampaigns ownership -> DatumTimelock");
    } catch (err) {
      // May fail if already transferred on a re-run
      console.warn("  DatumCampaigns ownership transfer skipped:", String(err).slice(0, 100));
    }
  } else {
    console.log("  DatumCampaigns ownership already with Timelock (skipped)");
  }

  const settlementOwner = await settlementContract.owner();
  if (settlementOwner.toLowerCase() !== addresses.timelock.toLowerCase()) {
    try {
      await (await settlementContract.transferOwnership(addresses.timelock)).wait();
      console.log("  DatumSettlement ownership -> DatumTimelock");
    } catch (err) {
      console.warn("  DatumSettlement ownership transfer skipped:", String(err).slice(0, 100));
    }
  } else {
    console.log("  DatumSettlement ownership already with Timelock (skipped)");
  }

  console.log("\n  Future admin changes go through:");
  console.log("    timelock.propose(target, abi.encodeCall(...)) -> 48h -> timelock.execute()");

  // -------------------------------------------------------------------
  // Post-deploy validation: read back all wiring and verify
  // -------------------------------------------------------------------

  console.log("\nValidating wiring...");
  let valid = true;

  async function check(label: string, actual: string, expected: string) {
    const match = actual.toLowerCase() === expected.toLowerCase();
    if (!match) {
      console.error(`  FAIL: ${label} — expected ${expected}, got ${actual}`);
      valid = false;
    } else {
      console.log(`  OK: ${label}`);
    }
  }

  const v2Final = await ethers.getContractAt("DatumGovernanceV2", addresses.governanceV2);
  const campFinal = await ethers.getContractAt("DatumCampaigns", addresses.campaigns);
  const settleFinal = await ethers.getContractAt("DatumSettlement", addresses.settlement);

  await check("GovernanceV2.slashContract", await v2Final.slashContract(), addresses.governanceSlash);
  await check("Campaigns.governanceContract", await campFinal.governanceContract(), addresses.governanceV2);
  await check("Campaigns.settlementContract", await campFinal.settlementContract(), addresses.settlement);
  await check("Settlement.relayContract", await settleFinal.relayContract(), addresses.relay);
  await check("Settlement.zkVerifier", await settleFinal.zkVerifier(), addresses.zkVerifier);
  await check("Campaigns.owner", await campFinal.owner(), addresses.timelock);
  await check("Settlement.owner", await settleFinal.owner(), addresses.timelock);

  if (!valid) {
    console.error("\n!!! WIRING VALIDATION FAILED — deployed-addresses.json NOT written !!!");
    console.error("Fix the failed wiring above and re-run the script.");
    process.exitCode = 1;
    return;
  }

  console.log("\nAll wiring validated.");

  // -------------------------------------------------------------------
  // Validate all 9 addresses present and non-zero
  // -------------------------------------------------------------------

  const REQUIRED_KEYS = [
    "pauseRegistry", "timelock", "publishers", "campaigns",
    "governanceV2", "governanceSlash", "settlement", "relay", "zkVerifier",
  ];

  for (const key of REQUIRED_KEYS) {
    if (!addresses[key] || addresses[key] === ZERO_ADDRESS) {
      console.error(`Missing or zero address for ${key}`);
      process.exitCode = 1;
      return;
    }
  }

  // -------------------------------------------------------------------
  // Write deployed-addresses.json (only after full validation)
  // -------------------------------------------------------------------

  const outPath = __dirname + "/../deployed-addresses.json";
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2) + "\n");
  console.log(`\nAddresses written to ${outPath}`);

  const extPath = __dirname + "/../../alpha-extension/deployed-addresses.json";
  try {
    fs.writeFileSync(extPath, JSON.stringify(addresses, null, 2) + "\n");
    console.log(`Addresses written to ${extPath}`);
  } catch {
    console.warn(`Could not write to ${extPath} (extension directory may not exist)`);
  }

  console.log("\n=== DATUM Deployment Complete ===");
  console.log(addresses);

  console.log("\nTo configure the extension, paste these addresses in Settings,");
  console.log("or they will auto-load on next extension reload.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
