// deploy.ts — Full 19-contract Alpha-3 deployment + wiring + ownership transfer
//
// Deploys in dependency order, wires all cross-contract references,
// transfers ownership of Campaigns + Settlement to Timelock,
// validates all wiring, and writes deployed-addresses.json.
//
// Alpha-3 adds 6 satellite contracts:
//   - DatumTargetingRegistry  (TX-1: tag-based publisher targeting)
//   - DatumCampaignValidator  (SE-3: campaign creation validation)
//   - DatumClaimValidator     (SE-1: claim hash/chain validation)
//   - DatumGovernanceHelper   (SE-2: slash computation + dust guard)
//   - DatumReports            (community reporting — pages + ads)
//   - DatumSettlementRateLimiter (BM-5: per-publisher window rate limiter)
//
// Paseo eth-rpc workaround: getTransactionReceipt is broken for deploy txs.
// We use raw signed transactions + getCreateAddress(sender, nonce) to derive
// contract addresses, then verify with getCode().
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
import { JsonRpcProvider, Wallet } from "ethers";
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

// ── Required address keys (18 contracts) ─────────────────────────────────────

const REQUIRED_KEYS = [
  "pauseRegistry", "timelock", "publishers", "campaigns",
  "budgetLedger", "paymentVault", "campaignLifecycle",
  "attestationVerifier", "governanceV2", "governanceSlash",
  "settlement", "relay", "zkVerifier",
  // Alpha-3 satellites
  "targetingRegistry", "campaignValidator", "claimValidator", "governanceHelper",
  "reports", "rateLimiter",
] as const;

// BM-5 rate limiter deployment parameters
const RATE_LIMITER_WINDOW_BLOCKS = 100n;              // ~10 minutes at 6s/block
const RATE_LIMITER_MAX_IMPRESSIONS = 500_000n;        // 500K impressions per publisher per window

const TOTAL_STEPS = 26; // 19 deploy + 7 wiring/validation sections

// ── Paseo RPC workaround: receipt polling with nonce-based address derivation ──

async function waitForNonce(
  provider: any,
  address: string,
  targetNonce: number,
  maxWait = 120,
): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const current = await provider.getTransactionCount(address);
    if (current > targetNonce) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting for tx confirmation (${i}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

async function verifyCode(provider: any, addr: string, maxWait = 30): Promise<boolean> {
  for (let i = 0; i < maxWait; i++) {
    const code = await provider.getCode(addr);
    if (code && code !== "0x" && code.length > 2) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // Use raw ethers provider to bypass hardhat-polkadot plugin receipt waiting bug
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const rawProvider = new JsonRpcProvider(rpcUrl);
  const accounts = (network.config as any).accounts || [];
  const deployerKey = accounts[0] || process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("No deployer key — set DEPLOYER_PRIVATE_KEY");
  const deployer = new Wallet(deployerKey, rawProvider);

  console.log("Deploying DATUM Alpha-3 contracts with:", deployer.address);
  console.log("Network:", network.name);
  console.log("RPC:", rpcUrl);

  const balance = await rawProvider.getBalance(deployer.address);
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

  // Helper: deploy using raw signed tx + nonce-derived address (Paseo workaround)
  async function deployOrReuse(
    key: string,
    contractName: string,
    args: any[] = [],
  ): Promise<string> {
    if (addresses[key] && addresses[key] !== ZERO_ADDRESS) {
      const code = await rawProvider.getCode(addresses[key]);
      if (code && code !== "0x" && code.length > 2) {
        console.log(`  ${contractName}: reusing ${addresses[key]} (already deployed)`);
        return addresses[key];
      }
      console.warn(`  ${contractName}: address ${addresses[key]} has no code — redeploying`);
    }

    // Get PVM bytecode from hardhat artifacts
    const factory = await ethers.getContractFactory(contractName);
    const deployTx = await factory.getDeployTransaction(...args);
    const nonce = await rawProvider.getTransactionCount(deployer.address);

    // Compute expected contract address from CREATE
    const expectedAddr = ethers.getCreateAddress({ from: deployer.address, nonce });

    // Send via raw provider (bypasses hardhat-polkadot receipt wait)
    const tx = await deployer.sendTransaction({
      data: deployTx.data,
      gasLimit: 500000000n,
      type: 0,
      gasPrice: 1000000000000n,
    });
    console.log(`  ${contractName}: tx ${tx.hash} (nonce ${nonce})`);

    // Wait for nonce to advance (confirms tx was included)
    await waitForNonce(rawProvider, deployer.address, nonce);

    // Verify contract code exists
    const hasCode = await verifyCode(rawProvider, expectedAddr);
    if (!hasCode) {
      throw new Error(`${contractName}: no code at expected address ${expectedAddr}`);
    }

    addresses[key] = expectedAddr;
    console.log(`  ${contractName}: ${expectedAddr}`);

    // Save after each deploy for crash recovery
    fs.writeFileSync(ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n");

    return expectedAddr;
  }

  // Helper: encode and send a wiring call via raw provider
  async function sendCall(
    contractAddr: string,
    abi: string[],
    method: string,
    args: any[],
  ): Promise<void> {
    const iface = new ethers.Interface(abi);
    const data = iface.encodeFunctionData(method, args);
    const nonce = await rawProvider.getTransactionCount(deployer.address);
    const tx = await deployer.sendTransaction({
      to: contractAddr,
      data,
      gasLimit: 500000000n,
      type: 0,
      gasPrice: 1000000000000n,
    });
    await waitForNonce(rawProvider, deployer.address, nonce);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Deploy all 17 contracts in dependency order
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

  // --- Tier 1.5: Alpha-3 satellites (depends on Publishers + PauseRegistry) ---

  try {
    logStep("Deploying DatumTargetingRegistry (TX-1)");
    await deployOrReuse("targetingRegistry", "DatumTargetingRegistry", [
      addresses.publishers,
      addresses.pauseRegistry,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumTargetingRegistry — ${err}`);
  }

  try {
    logStep("Deploying DatumCampaignValidator (SE-3)");
    await deployOrReuse("campaignValidator", "DatumCampaignValidator", [
      addresses.publishers,
      addresses.targetingRegistry,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumCampaignValidator — ${err}`);
  }

  // --- Tier 2: Depends on CampaignValidator + PauseRegistry ---

  try {
    logStep("Deploying DatumCampaigns");
    await deployOrReuse("campaigns", "DatumCampaigns", [
      MIN_CPM_FLOOR,
      PENDING_TIMEOUT_BLOCKS,
      addresses.campaignValidator,
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

  // --- Tier 3: Depends on PauseRegistry (Settlement) / Campaigns (others) ---

  try {
    logStep("Deploying DatumSettlement");
    await deployOrReuse("settlement", "DatumSettlement", [
      addresses.pauseRegistry,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumSettlement — ${err}`);
  }

  try {
    logStep("Deploying DatumClaimValidator (SE-1)");
    await deployOrReuse("claimValidator", "DatumClaimValidator", [
      addresses.campaigns,
      addresses.publishers,
      addresses.pauseRegistry,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumClaimValidator — ${err}`);
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
    logStep("Deploying DatumGovernanceHelper (SE-2)");
    await deployOrReuse("governanceHelper", "DatumGovernanceHelper", [
      addresses.campaigns,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumGovernanceHelper — ${err}`);
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
      addresses.pauseRegistry,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumAttestationVerifier — ${err}`);
  }

  try {
    logStep("Deploying DatumReports");
    await deployOrReuse("reports", "DatumReports", [
      addresses.campaigns,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumReports — ${err}`);
  }

  try {
    logStep("Deploying DatumSettlementRateLimiter (BM-5)");
    await deployOrReuse("rateLimiter", "DatumSettlementRateLimiter", [
      RATE_LIMITER_WINDOW_BLOCKS,
      RATE_LIMITER_MAX_IMPRESSIONS,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumSettlementRateLimiter — ${err}`);
  }

  console.log("\n=== All 19 contracts deployed ===\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Wire cross-contract references (with re-run safety)
  // ═══════════════════════════════════════════════════════════════════════════

  logStep("Wiring cross-contract references");

  // Helper: read a public address getter; returns lowercase address
  async function readAddr(contractAddr: string, getter: string): Promise<string> {
    const iface = new ethers.Interface([`function ${getter}() view returns (address)`]);
    const data = iface.encodeFunctionData(getter);
    const result = await rawProvider.call({ to: contractAddr, data });
    return ethers.AbiCoder.defaultAbiCoder().decode(["address"], result)[0].toLowerCase();
  }

  // Helper: call a setter only if the current value differs
  async function wireIfNeeded(
    label: string,
    _contractName: string,
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

    await sendCall(
      contractAddr,
      [`function ${setter}(address)`],
      setter,
      [targetAddr],
    );
    console.log(`  SET: ${label}`);
  }

  // ── Settlement.configure(budgetLedger, paymentVault, lifecycle, relay) ──
  const sCurrentBL = await readAddr(addresses.settlement, "budgetLedger");
  const sCurrentPV = await readAddr(addresses.settlement, "paymentVault");
  const sCurrentLC = await readAddr(addresses.settlement, "lifecycle");
  const sCurrentRL = await readAddr(addresses.settlement, "relayContract");

  const settlementConfigured =
    sCurrentBL === addresses.budgetLedger.toLowerCase() &&
    sCurrentPV === addresses.paymentVault.toLowerCase() &&
    sCurrentLC === addresses.campaignLifecycle.toLowerCase() &&
    sCurrentRL === addresses.relay.toLowerCase();

  if (settlementConfigured) {
    console.log("  OK (already set): Settlement.configure(...)");
  } else {
    await sendCall(
      addresses.settlement,
      ["function configure(address,address,address,address)"],
      "configure",
      [addresses.budgetLedger, addresses.paymentVault, addresses.campaignLifecycle, addresses.relay],
    );
    console.log("  SET: Settlement.configure(budgetLedger, paymentVault, lifecycle, relay)");
  }

  // ── Settlement.setClaimValidator(claimValidator) ──
  await wireIfNeeded(
    "Settlement.claimValidator",
    "DatumSettlement", addresses.settlement,
    "claimValidator", "setClaimValidator",
    addresses.claimValidator,
  );

  // ── Settlement.setAttestationVerifier(attestationVerifier) ──
  await wireIfNeeded(
    "Settlement.attestationVerifier",
    "DatumSettlement", addresses.settlement,
    "attestationVerifier", "setAttestationVerifier",
    addresses.attestationVerifier,
  );

  // ── Settlement.setRateLimiter(rateLimiter) — BM-5 ──
  await wireIfNeeded(
    "Settlement.rateLimiter",
    "DatumSettlement", addresses.settlement,
    "rateLimiter", "setRateLimiter",
    addresses.rateLimiter,
  );

  // ── Settlement.setPublishers(publishers) — S12 settlement-level blocklist ──
  await wireIfNeeded(
    "Settlement.publishers",
    "DatumSettlement", addresses.settlement,
    "publishers", "setPublishers",
    addresses.publishers,
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

  // ── ClaimValidator: setCampaigns (needed when Campaigns is redeployed) ──
  await wireIfNeeded(
    "ClaimValidator.campaigns",
    "DatumClaimValidator", addresses.claimValidator,
    "campaigns", "setCampaigns",
    addresses.campaigns,
  );

  // ── ClaimValidator: setZKVerifier(zkVerifier) ──
  await wireIfNeeded(
    "ClaimValidator.zkVerifier",
    "DatumClaimValidator", addresses.claimValidator,
    "zkVerifier", "setZKVerifier",
    addresses.zkVerifier,
  );

  // ── GovernanceV2: setSlashContract, setLifecycle, setHelper ──
  await wireIfNeeded(
    "GovernanceV2.slashContract",
    "DatumGovernanceV2", addresses.governanceV2,
    "slashContract", "setSlashContract",
    addresses.governanceSlash,
  );
  await wireIfNeeded(
    "GovernanceV2.lifecycle",
    "DatumGovernanceV2", addresses.governanceV2,
    "lifecycle", "setLifecycle",
    addresses.campaignLifecycle,
  );
  await wireIfNeeded(
    "GovernanceV2.helper",
    "DatumGovernanceV2", addresses.governanceV2,
    "helper", "setHelper",
    addresses.governanceHelper,
  );

  console.log("\n  All wiring complete.");

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Ownership transfer to Timelock
  // ═══════════════════════════════════════════════════════════════════════════

  logStep("Transferring ownership to Timelock");

  async function transferOwnershipIfNeeded(
    label: string,
    _contractName: string,
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
    try {
      await sendCall(
        contractAddr,
        ["function transferOwnership(address)"],
        "transferOwnership",
        [addresses.timelock],
      );
      console.log(`  TRANSFERRED: ${label} -> Timelock`);
    } catch (err) {
      console.warn(`  WARNING: ${label} ownership transfer failed: ${String(err).slice(0, 100)}`);
    }
  }

  await transferOwnershipIfNeeded("Campaigns", "DatumCampaigns", addresses.campaigns);
  await transferOwnershipIfNeeded("Settlement", "DatumSettlement", addresses.settlement);
  // S12: Blocklist admin (blockAddress/unblockAddress) must go through 48h timelock for mainnet transparency
  await transferOwnershipIfNeeded("Publishers", "DatumPublishers", addresses.publishers);

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
  await check("Settlement.budgetLedger", await readAddr(addresses.settlement, "budgetLedger"), addresses.budgetLedger);
  await check("Settlement.paymentVault", await readAddr(addresses.settlement, "paymentVault"), addresses.paymentVault);
  await check("Settlement.lifecycle", await readAddr(addresses.settlement, "lifecycle"), addresses.campaignLifecycle);
  await check("Settlement.relayContract", await readAddr(addresses.settlement, "relayContract"), addresses.relay);
  await check("Settlement.claimValidator", await readAddr(addresses.settlement, "claimValidator"), addresses.claimValidator);
  await check("Settlement.attestationVerifier", await readAddr(addresses.settlement, "attestationVerifier"), addresses.attestationVerifier);
  await check("Settlement.rateLimiter", await readAddr(addresses.settlement, "rateLimiter"), addresses.rateLimiter);
  await check("Settlement.publishers", await readAddr(addresses.settlement, "publishers"), addresses.publishers);
  await check("Settlement.owner", await readAddr(addresses.settlement, "owner"), addresses.timelock);

  // Campaigns
  await check("Campaigns.budgetLedger", await readAddr(addresses.campaigns, "budgetLedger"), addresses.budgetLedger);
  await check("Campaigns.lifecycleContract", await readAddr(addresses.campaigns, "lifecycleContract"), addresses.campaignLifecycle);
  await check("Campaigns.governanceContract", await readAddr(addresses.campaigns, "governanceContract"), addresses.governanceV2);
  await check("Campaigns.settlementContract", await readAddr(addresses.campaigns, "settlementContract"), addresses.settlement);
  await check("Campaigns.campaignValidator", await readAddr(addresses.campaigns, "campaignValidator"), addresses.campaignValidator);
  await check("Campaigns.owner", await readAddr(addresses.campaigns, "owner"), addresses.timelock);
  // S12: Publishers must be timelock-owned so blockAddress/unblockAddress require 48h delay
  await check("Publishers.owner", await readAddr(addresses.publishers, "owner"), addresses.timelock);

  // BudgetLedger
  await check("BudgetLedger.campaigns", await readAddr(addresses.budgetLedger, "campaigns"), addresses.campaigns);
  await check("BudgetLedger.settlement", await readAddr(addresses.budgetLedger, "settlement"), addresses.settlement);
  await check("BudgetLedger.lifecycle", await readAddr(addresses.budgetLedger, "lifecycle"), addresses.campaignLifecycle);

  // PaymentVault
  await check("PaymentVault.settlement", await readAddr(addresses.paymentVault, "settlement"), addresses.settlement);

  // CampaignLifecycle
  await check("Lifecycle.campaigns", await readAddr(addresses.campaignLifecycle, "campaigns"), addresses.campaigns);
  await check("Lifecycle.budgetLedger", await readAddr(addresses.campaignLifecycle, "budgetLedger"), addresses.budgetLedger);
  await check("Lifecycle.governanceContract", await readAddr(addresses.campaignLifecycle, "governanceContract"), addresses.governanceV2);
  await check("Lifecycle.settlementContract", await readAddr(addresses.campaignLifecycle, "settlementContract"), addresses.settlement);

  // GovernanceV2
  await check("GovernanceV2.slashContract", await readAddr(addresses.governanceV2, "slashContract"), addresses.governanceSlash);
  await check("GovernanceV2.lifecycle", await readAddr(addresses.governanceV2, "lifecycle"), addresses.campaignLifecycle);
  await check("GovernanceV2.helper", await readAddr(addresses.governanceV2, "helper"), addresses.governanceHelper);

  // ClaimValidator
  await check("ClaimValidator.campaigns", await readAddr(addresses.claimValidator, "campaigns"), addresses.campaigns);
  await check("ClaimValidator.publishers", await readAddr(addresses.claimValidator, "publishers"), addresses.publishers);
  await check("ClaimValidator.zkVerifier", await readAddr(addresses.claimValidator, "zkVerifier"), addresses.zkVerifier);

  // CampaignValidator
  await check("CampaignValidator.publishers", await readAddr(addresses.campaignValidator, "publishers"), addresses.publishers);
  await check("CampaignValidator.targetingRegistry", await readAddr(addresses.campaignValidator, "targetingRegistry"), addresses.targetingRegistry);

  // ── Validate all 17 addresses present and non-zero ──
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

  addresses.network = network.name;
  addresses.deployedAt = new Date().toISOString();

  fs.writeFileSync(ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n");
  console.log(`  Written: ${ADDR_FILE}`);

  try {
    fs.writeFileSync(EXT_ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n");
    console.log(`  Written: ${EXT_ADDR_FILE}`);
  } catch {
    console.warn(`  Could not write to ${EXT_ADDR_FILE} (extension directory may not exist)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n=== DATUM Alpha-3 Deployment Complete ===\n");
  console.log("19 contracts deployed and wired:\n");
  for (const key of REQUIRED_KEYS) {
    console.log(`  ${key.padEnd(24)} ${addresses[key]}`);
  }
  console.log(`\n  network                 ${addresses.network}`);
  console.log(`  deployedAt              ${addresses.deployedAt}`);
  console.log("\nOwnership transferred to Timelock:");
  console.log("  - DatumCampaigns");
  console.log("  - DatumSettlement");
  console.log("  - DatumPublishers (S12: blocklist admin gated)");
  console.log("\nTo configure the extension, addresses auto-load from deployed-addresses.json.");
  console.log("To set up testnet: npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
