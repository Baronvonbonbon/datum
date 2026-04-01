// deploy.ts — Full 13-contract Alpha-2 deployment + wiring + ownership transfer
//
// Deploys in dependency order, wires all cross-contract references,
// transfers ownership of Campaigns + Settlement to Timelock,
// validates all wiring, and writes deployed-addresses.json.
//
// Re-run safe (B2): reads existing deployed-addresses.json and skips
// already-deployed contracts; checks wiring state before setting.
//
// Usage:
//   npx hardhat run scripts/deploy.ts --network substrate        # local devnet
//   npx hardhat run scripts/deploy.ts --network polkadotTestnet  # Paseo testnet
//
// Environment:
//   DEPLOYER_PRIVATE_KEY — required for testnet deploys

import { ethers, network } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import * as fs from "fs";
import * as path from "path";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── Deployment parameters ────────────────────────────────────────────────────
// All amounts in planck (1 DOT = 10^10 planck)
// Block times: Polkadot Hub = 6s/block, 14,400 blocks/day

const MIN_CPM_FLOOR = parseDOT("0.001");            // 0.001 DOT per 1000 impressions
const PENDING_TIMEOUT_BLOCKS = 100800n;              // ~7 days
const TAKE_RATE_UPDATE_DELAY = 14400n;               // ~24h

// Governance
const QUORUM_WEIGHTED = parseDOT("100");             // 100 DOT conviction-weighted total
const SLASH_BPS = 1000n;                             // 10% slash on losing side
const TERMINATION_QUORUM = parseDOT("100");          // 100 DOT nay-weighted minimum to terminate
const BASE_GRACE_BLOCKS = 14400n;                    // ~24h minimum cooldown before termination
const GRACE_PER_QUORUM = 14400n;                     // additional blocks per quorum-unit of total weight
const MAX_GRACE_BLOCKS = 100800n;                    // ~7d cap on total grace period

// CampaignLifecycle — P20 inactivity timeout
const INACTIVITY_TIMEOUT_BLOCKS = 432000n;           // 30 days at 6s/block

// ── File paths ───────────────────────────────────────────────────────────────

const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_FILE = path.join(__dirname, "..", "extension", "deployed-addresses.json");

// ── Required address keys ────────────────────────────────────────────────────

const REQUIRED_KEYS = [
  "pauseRegistry", "timelock", "publishers", "campaigns",
  "budgetLedger", "paymentVault", "campaignLifecycle",
  "attestationVerifier", "governanceV2", "governanceSlash",
  "settlement", "relay", "zkVerifier",
] as const;

const TOTAL_STEPS = 20; // 13 deploy + 7 wiring/validation sections

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying DATUM Alpha-2 contracts with:", deployer.address);
  console.log("Network:", network.name);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", balance.toString(), "planck");

  // Load existing addresses for re-run safety (B2)
  let addresses: Record<string, string> = {};
  if (fs.existsSync(ADDR_FILE)) {
    try {
      addresses = JSON.parse(fs.readFileSync(ADDR_FILE, "utf-8"));
      console.log("Loaded existing deployed-addresses.json for re-run safety");
    } catch {
      console.warn("Could not parse existing deployed-addresses.json — starting fresh");
      addresses = {};
    }
  }

  let step = 0;
  function logStep(label: string) {
    step++;
    console.log(`\n[${step}/${TOTAL_STEPS}] ${label}...`);
  }

  // Helper: deploy if not already deployed, otherwise reuse
  async function deployOrReuse(
    key: string,
    contractName: string,
    args: any[] = [],
  ): Promise<string> {
    if (addresses[key] && addresses[key] !== ZERO_ADDRESS) {
      // Verify the address has code (contract still exists)
      const code = await ethers.provider.getCode(addresses[key]);
      if (code && code !== "0x") {
        console.log(`  ${contractName}: reusing ${addresses[key]} (already deployed)`);
        return addresses[key];
      }
      console.warn(`  ${contractName}: address ${addresses[key]} has no code — redeploying`);
    }

    const factory = await ethers.getContractFactory(contractName);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    addresses[key] = addr;
    console.log(`  ${contractName}: ${addr}`);
    return addr;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Deploy all 13 contracts in dependency order
  // ═══════════════════════════════════════════════════════════════════════════

  // --- Tier 0: No dependencies ---

  try {
    logStep("Deploying DatumPauseRegistry");
    await deployOrReuse("pauseRegistry", "DatumPauseRegistry");
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumPauseRegistry — ${err}`);
  }

  try {
    logStep("Deploying DatumTimelock");
    await deployOrReuse("timelock", "DatumTimelock");
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumTimelock — ${err}`);
  }

  try {
    logStep("Deploying DatumZKVerifier (stub)");
    await deployOrReuse("zkVerifier", "DatumZKVerifier");
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumZKVerifier — ${err}`);
  }

  // --- Tier 1: Depends on PauseRegistry ---

  try {
    logStep("Deploying DatumPublishers");
    await deployOrReuse("publishers", "DatumPublishers", [
      TAKE_RATE_UPDATE_DELAY,
      addresses.pauseRegistry,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumPublishers — ${err}`);
  }

  try {
    logStep("Deploying DatumBudgetLedger");
    await deployOrReuse("budgetLedger", "DatumBudgetLedger");
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumBudgetLedger — ${err}`);
  }

  try {
    logStep("Deploying DatumPaymentVault");
    await deployOrReuse("paymentVault", "DatumPaymentVault");
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumPaymentVault — ${err}`);
  }

  // --- Tier 2: Depends on Publishers + PauseRegistry ---

  try {
    logStep("Deploying DatumCampaigns");
    await deployOrReuse("campaigns", "DatumCampaigns", [
      MIN_CPM_FLOOR,
      PENDING_TIMEOUT_BLOCKS,
      addresses.publishers,
      addresses.pauseRegistry,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumCampaigns — ${err}`);
  }

  try {
    logStep("Deploying DatumCampaignLifecycle");
    await deployOrReuse("campaignLifecycle", "DatumCampaignLifecycle", [
      addresses.pauseRegistry,
      INACTIVITY_TIMEOUT_BLOCKS,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumCampaignLifecycle — ${err}`);
  }

  // --- Tier 3: Depends on Campaigns ---

  try {
    logStep("Deploying DatumSettlement");
    await deployOrReuse("settlement", "DatumSettlement", [
      addresses.campaigns,
      addresses.pauseRegistry,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumSettlement — ${err}`);
  }

  try {
    logStep("Deploying DatumGovernanceV2");
    await deployOrReuse("governanceV2", "DatumGovernanceV2", [
      addresses.campaigns,
      QUORUM_WEIGHTED,
      SLASH_BPS,
      TERMINATION_QUORUM,
      BASE_GRACE_BLOCKS,
      GRACE_PER_QUORUM,
      MAX_GRACE_BLOCKS,
      addresses.pauseRegistry,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumGovernanceV2 — ${err}`);
  }

  try {
    logStep("Deploying DatumGovernanceSlash");
    await deployOrReuse("governanceSlash", "DatumGovernanceSlash", [
      addresses.governanceV2,
      addresses.campaigns,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumGovernanceSlash — ${err}`);
  }

  // --- Tier 4: Depends on Settlement + Campaigns ---

  try {
    logStep("Deploying DatumRelay");
    await deployOrReuse("relay", "DatumRelay", [
      addresses.settlement,
      addresses.campaigns,
      addresses.pauseRegistry,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumRelay — ${err}`);
  }

  try {
    logStep("Deploying DatumAttestationVerifier");
    await deployOrReuse("attestationVerifier", "DatumAttestationVerifier", [
      addresses.settlement,
      addresses.campaigns,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumAttestationVerifier — ${err}`);
  }

  console.log("\n=== All 13 contracts deployed ===\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Wire cross-contract references (with re-run safety)
  // ═══════════════════════════════════════════════════════════════════════════

  logStep("Wiring cross-contract references");

  // Helper: read a public address getter; returns lowercase address
  async function readAddr(contractAddr: string, getter: string): Promise<string> {
    const iface = new ethers.Interface([`function ${getter}() view returns (address)`]);
    const data = iface.encodeFunctionData(getter);
    const result = await ethers.provider.call({ to: contractAddr, data });
    return ethers.AbiCoder.defaultAbiCoder().decode(["address"], result)[0].toLowerCase();
  }

  // Helper: call a setter only if the current value differs
  async function wireIfNeeded(
    label: string,
    contractName: string,
    contractAddr: string,
    getter: string,
    setter: string,
    targetAddr: string,
  ): Promise<void> {
    const current = await readAddr(contractAddr, getter);
    if (current === targetAddr.toLowerCase()) {
      console.log(`  OK (already set): ${label}`);
      return;
    }

    const contract = await ethers.getContractAt(contractName, contractAddr);
    try {
      await (await (contract as any)[setter](targetAddr)).wait();
      console.log(`  SET: ${label}`);
    } catch (err) {
      throw new Error(`FAILED wiring ${label}: ${err}`);
    }
  }

  // ── Settlement.configure(budgetLedger, paymentVault, lifecycle, relay, publishers) ──
  // configure() is a single 5-arg call — check if all are already set
  const settlement = await ethers.getContractAt("DatumSettlement", addresses.settlement);
  const sCurrentBL = (await settlement.budgetLedger()).toLowerCase();
  const sCurrentPV = (await settlement.paymentVault()).toLowerCase();
  const sCurrentLC = (await settlement.lifecycle()).toLowerCase();
  const sCurrentRL = (await settlement.relayContract()).toLowerCase();
  const sCurrentPB = (await settlement.publishers()).toLowerCase();

  const settlementConfigured =
    sCurrentBL === addresses.budgetLedger.toLowerCase() &&
    sCurrentPV === addresses.paymentVault.toLowerCase() &&
    sCurrentLC === addresses.campaignLifecycle.toLowerCase() &&
    sCurrentRL === addresses.relay.toLowerCase() &&
    sCurrentPB === addresses.publishers.toLowerCase();

  if (settlementConfigured) {
    console.log("  OK (already set): Settlement.configure(...)");
  } else {
    try {
      await (await settlement.configure(
        addresses.budgetLedger,
        addresses.paymentVault,
        addresses.campaignLifecycle,
        addresses.relay,
        addresses.publishers,
      )).wait();
      console.log("  SET: Settlement.configure(budgetLedger, paymentVault, lifecycle, relay, publishers)");
    } catch (err) {
      throw new Error(`FAILED wiring Settlement.configure: ${err}`);
    }
  }

  // ── Settlement.setAttestationVerifier(attestationVerifier) ──
  await wireIfNeeded(
    "Settlement.attestationVerifier",
    "DatumSettlement", addresses.settlement,
    "attestationVerifier", "setAttestationVerifier",
    addresses.attestationVerifier,
  );

  // ── Campaigns: setBudgetLedger, setLifecycleContract, setGovernanceContract, setSettlementContract ──
  await wireIfNeeded(
    "Campaigns.budgetLedger",
    "DatumCampaigns", addresses.campaigns,
    "budgetLedger", "setBudgetLedger",
    addresses.budgetLedger,
  );
  await wireIfNeeded(
    "Campaigns.lifecycleContract",
    "DatumCampaigns", addresses.campaigns,
    "lifecycleContract", "setLifecycleContract",
    addresses.campaignLifecycle,
  );
  await wireIfNeeded(
    "Campaigns.governanceContract",
    "DatumCampaigns", addresses.campaigns,
    "governanceContract", "setGovernanceContract",
    addresses.governanceV2,
  );
  await wireIfNeeded(
    "Campaigns.settlementContract",
    "DatumCampaigns", addresses.campaigns,
    "settlementContract", "setSettlementContract",
    addresses.settlement,
  );

  // ── BudgetLedger: setCampaigns, setSettlement, setLifecycle ──
  await wireIfNeeded(
    "BudgetLedger.campaigns",
    "DatumBudgetLedger", addresses.budgetLedger,
    "campaigns", "setCampaigns",
    addresses.campaigns,
  );
  await wireIfNeeded(
    "BudgetLedger.settlement",
    "DatumBudgetLedger", addresses.budgetLedger,
    "settlement", "setSettlement",
    addresses.settlement,
  );
  await wireIfNeeded(
    "BudgetLedger.lifecycle",
    "DatumBudgetLedger", addresses.budgetLedger,
    "lifecycle", "setLifecycle",
    addresses.campaignLifecycle,
  );

  // ── PaymentVault: setSettlement ──
  await wireIfNeeded(
    "PaymentVault.settlement",
    "DatumPaymentVault", addresses.paymentVault,
    "settlement", "setSettlement",
    addresses.settlement,
  );

  // ── CampaignLifecycle: setCampaigns, setBudgetLedger, setGovernanceContract, setSettlementContract ──
  await wireIfNeeded(
    "Lifecycle.campaigns",
    "DatumCampaignLifecycle", addresses.campaignLifecycle,
    "campaigns", "setCampaigns",
    addresses.campaigns,
  );
  await wireIfNeeded(
    "Lifecycle.budgetLedger",
    "DatumCampaignLifecycle", addresses.campaignLifecycle,
    "budgetLedger", "setBudgetLedger",
    addresses.budgetLedger,
  );
  await wireIfNeeded(
    "Lifecycle.governanceContract",
    "DatumCampaignLifecycle", addresses.campaignLifecycle,
    "governanceContract", "setGovernanceContract",
    addresses.governanceV2,
  );
  await wireIfNeeded(
    "Lifecycle.settlementContract",
    "DatumCampaignLifecycle", addresses.campaignLifecycle,
    "settlementContract", "setSettlementContract",
    addresses.settlement,
  );

  // ── GovernanceV2: setSlashContract (one-time), setLifecycle ──
  const v2 = await ethers.getContractAt("DatumGovernanceV2", addresses.governanceV2);
  const currentSlash = (await v2.slashContract()).toLowerCase();
  if (currentSlash === ZERO_ADDRESS) {
    try {
      await (await v2.setSlashContract(addresses.governanceSlash)).wait();
      console.log("  SET: GovernanceV2.slashContract");
    } catch (err) {
      throw new Error(`FAILED wiring GovernanceV2.setSlashContract: ${err}`);
    }
  } else if (currentSlash === addresses.governanceSlash.toLowerCase()) {
    console.log("  OK (already set): GovernanceV2.slashContract");
  } else {
    console.warn(`  WARNING: GovernanceV2.slashContract is ${currentSlash} (one-time setter, cannot change)`);
  }

  await wireIfNeeded(
    "GovernanceV2.lifecycle",
    "DatumGovernanceV2", addresses.governanceV2,
    "lifecycle", "setLifecycle",
    addresses.campaignLifecycle,
  );

  // GovernanceSlash has no post-deploy setters — voting + campaigns are set in constructor

  console.log("\n  All wiring complete.");

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Ownership transfer to Timelock
  // ═══════════════════════════════════════════════════════════════════════════

  logStep("Transferring ownership to Timelock");

  async function transferOwnershipIfNeeded(
    label: string,
    contractName: string,
    contractAddr: string,
  ): Promise<void> {
    const currentOwner = await readAddr(contractAddr, "owner");
    if (currentOwner === addresses.timelock.toLowerCase()) {
      console.log(`  OK (already transferred): ${label}`);
      return;
    }
    if (currentOwner !== deployer.address.toLowerCase()) {
      console.warn(`  WARNING: ${label} owned by ${currentOwner}, not deployer — cannot transfer`);
      return;
    }
    const contract = await ethers.getContractAt(contractName, contractAddr);
    try {
      await (await (contract as any).transferOwnership(addresses.timelock)).wait();
      console.log(`  TRANSFERRED: ${label} -> Timelock`);
    } catch (err) {
      console.warn(`  WARNING: ${label} ownership transfer failed: ${String(err).slice(0, 100)}`);
    }
  }

  // Transfer Campaigns + Settlement ownership to Timelock
  await transferOwnershipIfNeeded("Campaigns", "DatumCampaigns", addresses.campaigns);
  await transferOwnershipIfNeeded("Settlement", "DatumSettlement", addresses.settlement);

  console.log("\n  Future admin changes go through:");
  console.log("    timelock.propose(target, abi.encodeCall(...)) -> 48h -> timelock.execute()");

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4: Post-deploy validation
  // ═══════════════════════════════════════════════════════════════════════════

  logStep("Validating all wiring");
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

  // Settlement
  const sett = await ethers.getContractAt("DatumSettlement", addresses.settlement);
  await check("Settlement.budgetLedger", await sett.budgetLedger(), addresses.budgetLedger);
  await check("Settlement.paymentVault", await sett.paymentVault(), addresses.paymentVault);
  await check("Settlement.lifecycle", await sett.lifecycle(), addresses.campaignLifecycle);
  await check("Settlement.relayContract", await sett.relayContract(), addresses.relay);
  await check("Settlement.publishers", await sett.publishers(), addresses.publishers);
  await check("Settlement.attestationVerifier", await sett.attestationVerifier(), addresses.attestationVerifier);
  await check("Settlement.owner", await sett.owner(), addresses.timelock);

  // Campaigns
  const camp = await ethers.getContractAt("DatumCampaigns", addresses.campaigns);
  await check("Campaigns.budgetLedger", await camp.budgetLedger(), addresses.budgetLedger);
  await check("Campaigns.lifecycleContract", await camp.lifecycleContract(), addresses.campaignLifecycle);
  await check("Campaigns.governanceContract", await camp.governanceContract(), addresses.governanceV2);
  await check("Campaigns.settlementContract", await camp.settlementContract(), addresses.settlement);
  await check("Campaigns.owner", await camp.owner(), addresses.timelock);

  // BudgetLedger
  const bl = await ethers.getContractAt("DatumBudgetLedger", addresses.budgetLedger);
  await check("BudgetLedger.campaigns", await bl.campaigns(), addresses.campaigns);
  await check("BudgetLedger.settlement", await bl.settlement(), addresses.settlement);
  await check("BudgetLedger.lifecycle", await bl.lifecycle(), addresses.campaignLifecycle);

  // PaymentVault
  const pv = await ethers.getContractAt("DatumPaymentVault", addresses.paymentVault);
  await check("PaymentVault.settlement", await pv.settlement(), addresses.settlement);

  // CampaignLifecycle
  const lc = await ethers.getContractAt("DatumCampaignLifecycle", addresses.campaignLifecycle);
  await check("Lifecycle.campaigns", await lc.campaigns(), addresses.campaigns);
  await check("Lifecycle.budgetLedger", await lc.budgetLedger(), addresses.budgetLedger);
  await check("Lifecycle.governanceContract", await lc.governanceContract(), addresses.governanceV2);
  await check("Lifecycle.settlementContract", await lc.settlementContract(), addresses.settlement);

  // GovernanceV2
  const g2 = await ethers.getContractAt("DatumGovernanceV2", addresses.governanceV2);
  await check("GovernanceV2.slashContract", await g2.slashContract(), addresses.governanceSlash);
  await check("GovernanceV2.lifecycle", await g2.lifecycle(), addresses.campaignLifecycle);

  // ── Validate all 13 addresses present and non-zero ──
  logStep("Checking all addresses present");
  for (const key of REQUIRED_KEYS) {
    if (!addresses[key] || addresses[key] === ZERO_ADDRESS) {
      console.error(`  MISSING: ${key}`);
      valid = false;
    } else {
      console.log(`  OK: ${key} = ${addresses[key]}`);
    }
  }

  if (!valid) {
    console.error("\n!!! WIRING VALIDATION FAILED — deployed-addresses.json NOT written !!!");
    console.error("Fix the failed wiring above and re-run the script.");
    process.exitCode = 1;
    return;
  }

  console.log("\nAll wiring validated.");

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 5: Write deployed-addresses.json
  // ═══════════════════════════════════════════════════════════════════════════

  logStep("Writing deployed-addresses.json");

  // Add metadata
  addresses.network = network.name;
  addresses.deployedAt = new Date().toISOString();

  // Write to alpha-2/
  fs.writeFileSync(ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n");
  console.log(`  Written: ${ADDR_FILE}`);

  // Write to alpha-2/extension/
  try {
    fs.writeFileSync(EXT_ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n");
    console.log(`  Written: ${EXT_ADDR_FILE}`);
  } catch {
    console.warn(`  Could not write to ${EXT_ADDR_FILE} (extension directory may not exist)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n=== DATUM Alpha-2 Deployment Complete ===\n");
  console.log("13 contracts deployed and wired:\n");
  for (const key of REQUIRED_KEYS) {
    console.log(`  ${key.padEnd(24)} ${addresses[key]}`);
  }
  console.log(`\n  network                 ${addresses.network}`);
  console.log(`  deployedAt              ${addresses.deployedAt}`);
  console.log("\nOwnership transferred to Timelock:");
  console.log("  - DatumCampaigns");
  console.log("  - DatumSettlement");
  console.log("\nTo configure the extension, addresses auto-load from deployed-addresses.json.");
  console.log("To set up testnet: npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
