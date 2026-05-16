// deploy.ts — Full 26-contract Alpha-4 deployment + wiring + ownership transfer
//
// Alpha-4 consolidation: 9 satellite contracts merged into parents (29 → 20):
//   GovernanceHelper + GovernanceSlash → GovernanceV2
//   CampaignValidator + TargetingRegistry + Reports → Campaigns
//   RateLimiter + NullifierRegistry + Reputation → Settlement
//   AdminGovernance → GovernanceRouter
//
// FP-1–FP-4 fraud prevention contracts:
//   - DatumPublisherStake       (FP-1+FP-4: publisher staking + bonding curve)
//   - DatumChallengeBonds       (FP-2: advertiser challenge bonds)
//   - DatumPublisherGovernance  (FP-3: conviction-weighted publisher fraud governance)
//
// Optimistic activation (Phase 1 + 2a + 2b, 2026-05-14):
//   - DatumActivationBonds      (creator bond + permissionless activate after
//                                timelock unless contested; commit-reveal vote
//                                on contested Pending; emergency mute bond on
//                                Active campaigns)
//
// Path A oracle (2026-05-14):
//   - DatumStakeRoot V1         (PRIMARY: owner-managed N-of-M reporter set;
//                                production oracle for current phase)
//   - DatumStakeRootV2          (SHADOW: permissionless bonded reporter set
//                                + phantom-leaf fraud proof; runs in parallel
//                                but NOT wired into ClaimValidator until
//                                STAKE_ROOT_V2_SHADOW_MODE is flipped to
//                                false. See stakeroot-shadow-mode.md.)
//
// Governance ladder (Phase 0 → 2):
//   - DatumGovernanceRouter     (stable proxy with inline admin functions)
//   - DatumCouncil              (Phase 1: N-of-M trusted council; Phase 2 uses GovernanceV2)
//
// CPC fraud prevention:
//   - DatumClickRegistry        (impression→click session tracking for cost-per-click)
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
const BASE_GRACE_BLOCKS = 10n;                       // testnet: ~1 min (prod: 14400n ~24h)
const GRACE_PER_QUORUM = 0n;                         // testnet: no per-quorum extension (prod: 14400n)
const MAX_GRACE_BLOCKS = 100800n;                    // ~7d cap on total grace period

// CampaignLifecycle — P20 inactivity timeout
const INACTIVITY_TIMEOUT_BLOCKS = 432000n;           // 30 days at 6s/block

// SM-6: PauseRegistry 2-of-3 guardian addresses (Alice, Bob, Charlie)
// On mainnet replace with Gnosis Safe addresses or hardware wallet EOAs.
const PAUSE_GUARDIAN_0 = "0x94CC36412EE0c099BfE7D61a35092e40342F62D7"; // Alice (deployer)
const PAUSE_GUARDIAN_1 = "0xfE091a42BCE57f3f9Acd92D21C8F9DbC4E5c7CE6"; // Bob
const PAUSE_GUARDIAN_2 = "0x09ce34740bCE52FB3cAa4A2D50cC2fbAD6F32C5b"; // Charlie

// ── File paths ───────────────────────────────────────────────────────────────

const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_FILE = path.join(__dirname, "..", "extension", "deployed-addresses.json");

// ── Required address keys (21 contracts) ─────────────────────────────────────
// Alpha-4 consolidation: 9 satellites merged into parents
//   GovernanceHelper + GovernanceSlash → GovernanceV2
//   CampaignValidator + TargetingRegistry + Reports → Campaigns
//   RateLimiter + NullifierRegistry + Reputation → Settlement
//   AdminGovernance → GovernanceRouter

const REQUIRED_KEYS = [
  "pauseRegistry", "timelock", "publishers", "campaigns",
  "budgetLedger", "paymentVault", "campaignLifecycle",
  "attestationVerifier", "governanceV2",
  "settlement", "relay", "zkVerifier",
  "claimValidator", "tokenRewardVault",
  // FP-1–FP-4 fraud prevention
  "publisherStake", "challengeBonds", "publisherGovernance",
  // T1-B: conviction-vote governance for FP system parameters
  "parameterGovernance",
  // Governance ladder (Phase 0 → 2)
  "governanceRouter", "council",
  // CPC (cost-per-click) fraud prevention
  "clickRegistry",
  // B2: Council-driven blocklist curator (audit pass 2)
  "blocklistCurator",
  // Optimistic activation gateway (Phases 1/2a/2b, 2026-05-14)
  "activationBonds",
  // Path A oracle — V1 (PRIMARY, owner-managed N-of-M reporter set)
  "stakeRoot",
  // Path A oracle — V2 (SHADOW, permissionless bonded reporter set, 2026-05-14)
  "stakeRootV2",
  // ZK identity verifier (enables balance-fraud challenges on V2)
  "identityVerifier",
  // Path H DATUM emission engine (TOKENOMICS §3.3 — daily cap + dynamic rate)
  "emissionEngine",
] as const;

// BM-5 rate limiter parameters (inline in Settlement)
const RATE_LIMITER_WINDOW_BLOCKS = 100n;              // ~10 minutes at 6s/block
const RATE_LIMITER_MAX_IMPRESSIONS = 500_000n;        // 500K impressions per publisher per window

// FP-5 nullifier window (inline in Settlement)
const NULLIFIER_WINDOW_BLOCKS = 14400n;              // ~24h at 6s/block (Polkadot Hub)

// FP-1+FP-4 publisher stake deployment parameters
const PUBLISHER_STAKE_BASE = parseDOT("1");           // 1 DOT minimum required stake
const PUBLISHER_STAKE_PER_IMP = 1_000n;              // 1000 planck per cumulative impression
const PUBLISHER_UNSTAKE_DELAY = 100_800n;             // ~7 days at 6s/block

// FP-3 publisher governance parameters
const PUB_GOV_QUORUM = parseDOT("100");              // 100 DOT conviction-weighted to uphold fraud
const PUB_GOV_SLASH_BPS = 5000n;                     // 50% slash of publisher stake on fraud upheld
const PUB_GOV_BOND_BONUS_BPS = 2000n;                // 20% of slash forwarded to ChallengeBonds pool
const PUB_GOV_GRACE_BLOCKS = 14400n;                 // ~24h grace period after first nay vote
const PUB_GOV_PROPOSE_BOND = parseDOT("1");          // 1 DOT bond to open a fraud proposal

// T1-B parameter governance deployment parameters
const PARAM_GOV_VOTING_PERIOD = 50400n;              // ~7d at 6s/block
const PARAM_GOV_TIMELOCK = 14400n;                   // ~24h at 6s/block
const PARAM_GOV_QUORUM = parseDOT("100");            // 100 DOT conviction-weighted
const PARAM_GOV_BOND = parseDOT("2");                // 2 DOT propose bond

// Governance ladder — DatumCouncil Phase 1 parameters
// Testnet: fast periods so proposals can be tested without waiting days.
// Mainnet: tune to longer blocks (e.g. 50400 voting, 14400 execution delay, 100800 veto).
const COUNCIL_VOTING_PERIOD = 100n;                  // testnet: ~10 min
const COUNCIL_EXECUTION_DELAY = 10n;                 // testnet: ~1 min
const COUNCIL_VETO_WINDOW = 200n;                    // testnet: ~20 min
const COUNCIL_MAX_EXECUTION_WINDOW = 100n;           // testnet: ~10 min
const COUNCIL_THRESHOLD = 1n;                        // 1-of-1 for testnet (deployer is sole member)

// Optimistic activation parameters
const ACTIVATION_MIN_BOND = parseDOT("0.1");         // 0.1 DOT floor for creator bond
const ACTIVATION_TIMELOCK_BLOCKS = 14400n;           // ~24h at 6s/block — challenge window
const ACTIVATION_WINNER_BONUS_BPS = 5000n;           // 50% of loser bond → winner bonus
const ACTIVATION_TREASURY_BPS = 0n;                  // 0% to treasury (start conservative; tunable)
// Mute defaults inside the contract: muteMinBond = 10× minBond,
// muteMaxBlocks = 14400. Override via setMuteMinBond/setMuteMaxBlocks below
// if a different mute economics is desired post-deploy.

// GovernanceV2 commit-reveal phases (default 14400/14400 set in constructor;
// re-applied here for clarity and to allow per-deploy overrides).
const GOV_COMMIT_BLOCKS = 14400n;                    // ~24h commit window
const GOV_REVEAL_BLOCKS = 14400n;                    // ~24h reveal window

// DatumStakeRoot — V1 (PRIMARY ORACLE in production). Owner-managed
// N-of-M reporter set. Simple, well-understood; matches the production
// oracle pattern (Chainlink/Pyth/etc.). Reporter set is bootstrapped
// in setup-testnet.ts; mainnet adds external parties before launch.
const SR_V1_THRESHOLD = 1n;  // testnet: 1-of-1 (deployer). Mainnet: 3-of-5.

// SHADOW MODE: when true, ClaimValidator.setStakeRoot2 is NOT wired,
// so V2-committed roots are NOT accepted by claim validation. V2 still
// runs in parallel for divergence monitoring + cypherpunk-runway
// preparation. Flip to false to promote V2 to dual-source.
// See narrative-analysis/stakeroot-shadow-mode.md.
const STAKE_ROOT_V2_SHADOW_MODE = true;

// DatumStakeRootV2 — permissionless bonded reporter set (Path A oracle).
// Off-chain tree builder commits roots; phantom-leaf fraud catchable by
// anyone via challengePhantomLeaf. See proposal-stakeroot-optimistic.md +
// task-stakeroot-v2-implementation.md.
const SR_V2_MIN_STAKE              = parseDOT("1");       // 1 DOT to become a reporter
const SR_V2_EXIT_DELAY             = 14400n;              // ~24h between exit proposal + claim
const SR_V2_APPROVAL_BPS           = 5100n;               // 51% of bonded stake to finalize
const SR_V2_CHALLENGE_WINDOW       = 14400n;              // ~24h challenge window
const SR_V2_PROPOSER_BOND          = parseDOT("0.1");
const SR_V2_CHALLENGER_BOND        = parseDOT("0.05");
const SR_V2_SLASHED_TO_CHAL_BPS    = 8000n;               // 80% of slashed total
const SR_V2_SLASH_APPROVER_BPS     = 1000n;               // 10% of approver's stake
const SR_V2_COMMITMENT_BOND        = parseDOT("0.01");
// For mainnet, set initial members to Gnosis Safe addresses of council members.
// Council members and threshold can be changed later via council self-governance proposals.

const TOTAL_STEPS = 27; // 22 deploy + 5 wiring/validation sections

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

async function verifyCode(provider: any, addr: string, maxWait = 60): Promise<boolean> {
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

  console.log("Deploying DATUM Alpha-4 contracts with:", deployer.address);
  console.log("Network:", network.name);
  console.log("RPC:", rpcUrl);

  const balance = await rawProvider.getBalance(deployer.address);
  console.log("Deployer balance:", balance.toString(), "planck");

  // Paseo's eth-rpc uses pallet-revive weight units, so deploy.ts pins very
  // high gasLimit/gasPrice values to make sure any tx fits. On a plain EVM
  // node (hardhat local) those numbers trip the per-tx gas cap, so dial
  // them back when off Paseo.
  const isPaseo = network.name === "polkadotTestnet";
  const TX_GAS_LIMIT = isPaseo ? 500000000n : 15000000n;
  const TX_GAS_PRICE = isPaseo ? 1000000000000n : 1000000000n;

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

    // Get bytecode from hardhat artifacts
    const factory = await ethers.getContractFactory(contractName);
    const deployTx = await factory.getDeployTransaction(...args);
    const nonce = await rawProvider.getTransactionCount(deployer.address);

    // Compute expected contract address from CREATE
    const expectedAddr = ethers.getCreateAddress({ from: deployer.address, nonce });

    // Send via raw provider (bypasses hardhat-polkadot receipt wait)
    const tx = await deployer.sendTransaction({
      data: deployTx.data,
      gasLimit: TX_GAS_LIMIT,
      type: 0,
      gasPrice: TX_GAS_PRICE,
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
      gasLimit: TX_GAS_LIMIT,
      type: 0,
      gasPrice: TX_GAS_PRICE,
      nonce,                  // pin nonce so signer can't cache stale value
    });
    await waitForNonce(rawProvider, deployer.address, nonce);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Deploy all 21 contracts in dependency order
  // ═══════════════════════════════════════════════════════════════════════════

  // --- Tier 0: No dependencies ---

  try {
    logStep("Deploying DatumPauseRegistry");
    await deployOrReuse("pauseRegistry", "DatumPauseRegistry", [
      PAUSE_GUARDIAN_0, PAUSE_GUARDIAN_1, PAUSE_GUARDIAN_2,
    ]);
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
    logStep("Deploying DatumZKVerifier (Groth16 / BN254)");
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
    // Alpha-4: TargetingRegistry + CampaignValidator merged into Campaigns

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

  // Alpha-4: GovernanceHelper + GovernanceSlash merged into GovernanceV2

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

  // Alpha-4: Reports, RateLimiter, Reputation merged into Campaigns/Settlement

  try {
    logStep("Deploying DatumTokenRewardVault");
    await deployOrReuse("tokenRewardVault", "DatumTokenRewardVault", [addresses.campaigns]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumTokenRewardVault — ${err}`);
  }

  try {
    logStep("Deploying DatumPublisherStake (FP-1+FP-4)");
    await deployOrReuse("publisherStake", "DatumPublisherStake", [
      PUBLISHER_STAKE_BASE,
      PUBLISHER_STAKE_PER_IMP,
      PUBLISHER_UNSTAKE_DELAY,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumPublisherStake — ${err}`);
  }

  try {
    logStep("Deploying DatumChallengeBonds (FP-2)");
    await deployOrReuse("challengeBonds", "DatumChallengeBonds", []);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumChallengeBonds — ${err}`);
  }

  try {
    logStep("Deploying DatumPublisherGovernance (FP-3)");
    await deployOrReuse("publisherGovernance", "DatumPublisherGovernance", [
      addresses.publisherStake,
      addresses.challengeBonds,
      addresses.pauseRegistry,
      PUB_GOV_QUORUM,
      PUB_GOV_SLASH_BPS,
      PUB_GOV_BOND_BONUS_BPS,
      PUB_GOV_GRACE_BLOCKS,
      PUB_GOV_PROPOSE_BOND,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumPublisherGovernance — ${err}`);
  }

  // Alpha-4: NullifierRegistry merged into Settlement

  try {
    logStep("Deploying DatumParameterGovernance (T1-B)");
    await deployOrReuse("parameterGovernance", "DatumParameterGovernance", [
      addresses.pauseRegistry,
      PARAM_GOV_VOTING_PERIOD,
      PARAM_GOV_TIMELOCK,
      PARAM_GOV_QUORUM,
      PARAM_GOV_BOND,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumParameterGovernance — ${err}`);
  }

  // --- Governance ladder ---
  // Alpha-4: AdminGovernance merged inline into GovernanceRouter.
  // Deployer starts as governor (Phase 0 = Admin). Phase transitions go through Timelock.

  try {
    logStep("Deploying DatumGovernanceRouter (governance ladder stable proxy + inline admin)");
    await deployOrReuse("governanceRouter", "DatumGovernanceRouter", [
      addresses.campaigns,
      addresses.campaignLifecycle,
      deployer.address,              // Phase 0 governor (deployer = admin)
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumGovernanceRouter — ${err}`);
  }

  try {
    logStep("Deploying DatumCouncil (Phase 1: N-of-M trusted council)");
    // Council enforces ≥3 distinct members, threshold ≥2, guardian must
    // not be a member. For local hardhat runs, use the next-three hardhat
    // default accounts as members + a fourth as guardian; for Paseo, use
    // the deployer + 2 deterministic placeholders to satisfy the floor
    // until real Gnosis Safe / hardware wallet addresses are wired in.
    const councilMembers: string[] = isPaseo
      ? [
          deployer.address,
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222",
        ]
      : [
          // hardhat node accounts 1–3 (well-known mnemonic)
          "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
          "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
        ];
    const councilGuardian = isPaseo
      ? "0x3333333333333333333333333333333333333333"
      : "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // hardhat account 4
    await deployOrReuse("council", "DatumCouncil", [
      councilMembers,
      2n,                             // threshold = 2-of-3 (MIN_THRESHOLD)
      councilGuardian,
      COUNCIL_VOTING_PERIOD,
      COUNCIL_EXECUTION_DELAY,
      COUNCIL_VETO_WINDOW,
      COUNCIL_MAX_EXECUTION_WINDOW,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumCouncil — ${err}`);
  }

  // --- Tier 5: CPC click tracking (depends on Relay + Settlement) ---

  try {
    logStep("Deploying DatumClickRegistry (CPC fraud prevention)");
    await deployOrReuse("clickRegistry", "DatumClickRegistry", []);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumClickRegistry — ${err}`);
  }

  // --- B2: Council-driven blocklist curator ---
  try {
    logStep("Deploying DatumCouncilBlocklistCurator (B2)");
    await deployOrReuse("blocklistCurator", "DatumCouncilBlocklistCurator", []);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumCouncilBlocklistCurator — ${err}`);
  }

  // --- Optimistic activation: 22nd contract (Phases 1/2a/2b) ---
  // Treasury recipient: deployer (Alice) for testnet. Mainnet should redirect
  // to a governance-controlled treasury contract before flipping treasuryBps
  // non-zero.
  try {
    logStep("Deploying DatumActivationBonds (optimistic activation + emergency mute)");
    await deployOrReuse("activationBonds", "DatumActivationBonds", [
      ACTIVATION_MIN_BOND,
      ACTIVATION_TIMELOCK_BLOCKS,
      ACTIVATION_WINNER_BONUS_BPS,
      ACTIVATION_TREASURY_BPS,
      deployer.address,
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumActivationBonds — ${err}`);
  }

  // --- DatumStakeRoot V1: PRIMARY Path A oracle (owner-managed N-of-M) ---
  // Production oracle for current deployment phase. Simpler, smaller code
  // surface, matches mainstream oracle topology. Reporter set bootstrapped
  // in setup-testnet.ts.
  try {
    logStep("Deploying DatumStakeRoot V1 (primary Path A oracle, owner-managed reporter set)");
    await deployOrReuse("stakeRoot", "DatumStakeRoot", []);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumStakeRoot — ${err}`);
  }

  // --- DatumStakeRootV2: 24th contract (Path A oracle, permissionless) ---
  // datumToken is wired as address(0) for testnet — no DATUM ERC20 deployed
  // on testnet yet. Balance-fraud challenges revert E00 until the token is
  // wired post-deploy via a redeploy with the real address.
  // TODO mainnet: pass real DATUM address before deploy.
  try {
    logStep("Deploying DatumStakeRootV2 (permissionless bonded reporter set)");
    await deployOrReuse("stakeRootV2", "DatumStakeRootV2", [
      deployer.address,                  // treasury (testnet); rotate before mainnet
      SR_V2_MIN_STAKE,
      SR_V2_EXIT_DELAY,
      SR_V2_APPROVAL_BPS,
      SR_V2_CHALLENGE_WINDOW,
      SR_V2_PROPOSER_BOND,
      SR_V2_CHALLENGER_BOND,
      SR_V2_SLASHED_TO_CHAL_BPS,
      SR_V2_SLASH_APPROVER_BPS,
      SR_V2_COMMITMENT_BOND,
      ethers.ZeroAddress,                // datumToken — wire to real DATUM for mainnet
    ]);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumStakeRootV2 — ${err}`);
  }

  // --- DatumIdentityVerifier: 25th contract (ZK identity proofs) ---
  // Empty constructor; VK is set below via setVerifyingKey if the
  // identity-setVK-calldata.json artifact from setup-zk-identity.mjs exists.
  try {
    logStep("Deploying DatumIdentityVerifier (ZK identity proof verifier)");
    await deployOrReuse("identityVerifier", "DatumIdentityVerifier", []);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumIdentityVerifier — ${err}`);
  }

  // --- DatumEmissionEngine: Path H emission curve (TOKENOMICS §3.3) ---
  // No constructor args; epoch 0 starts at deploy timestamp.
  try {
    logStep("Deploying DatumEmissionEngine (Path H — daily cap + dynamic rate)");
    await deployOrReuse("emissionEngine", "DatumEmissionEngine", []);
  } catch (err) {
    throw new Error(`FAILED AT STEP ${step}: DatumEmissionEngine — ${err}`);
  }

  console.log("\n=== All 27 contracts deployed ===\n");

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

  // (LOCK-ONCE: Settlement.configure(budgetLedger, paymentVault, lifecycle,
  //  relay) moved to STAGE 3. It's the foundational lock-once that holds
  //  Settlement's view of its supporting plumbing; fire it last with the
  //  rest of the Settlement lock-onces.)

  // ── Relay: setSettlement, setCampaigns (mutable; update when they're redeployed) ──
  await wireIfNeeded(
    "Relay.settlement",
    "DatumRelay", addresses.relay,
    "settlement", "setSettlement",
    addresses.settlement,
  );
  await wireIfNeeded(
    "Relay.campaigns",
    "DatumRelay", addresses.relay,
    "campaigns", "setCampaigns",
    addresses.campaigns,
  );

  // (LOCK-ONCE: Settlement.setClaimValidator / setAttestationVerifier /
  //  setPublishers / setTokenRewardVault / setCampaigns / setPublisherStake /
  //  setClickRegistry / TokenRewardVault.setSettlement moved to STAGE 3
  //  below. These setters cannot be re-pointed once written, so they're
  //  fired LAST in the wiring phase after all soft wiring is verified.)

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
    addresses.governanceRouter,      // stable Router — never changes even across phases
  );
  await wireIfNeeded(
    "Campaigns.settlementContract",
    "DatumCampaigns", addresses.campaigns,
    "settlementContract", "setSettlementContract",
    addresses.settlement,
  );

  // (LOCK-ONCE: BudgetLedger.setCampaigns / setSettlement / setLifecycle and
  //  PaymentVault.setSettlement moved to STAGE 3 below.)

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
    addresses.governanceRouter,      // stable Router — slash ETH goes to Router.receive()
  );
  await wireIfNeeded(
    "Lifecycle.settlementContract",
    "DatumCampaignLifecycle", addresses.campaignLifecycle,
    "settlementContract", "setSettlementContract",
    addresses.settlement,
  );

  // Alpha-4: CampaignValidator + TargetingRegistry merged into Campaigns (no separate wiring needed)

  // ── ClaimValidator: setCampaigns, setPublishers (needed when they're redeployed) ──
  await wireIfNeeded(
    "ClaimValidator.campaigns",
    "DatumClaimValidator", addresses.claimValidator,
    "campaigns", "setCampaigns",
    addresses.campaigns,
  );
  await wireIfNeeded(
    "ClaimValidator.publishers",
    "DatumClaimValidator", addresses.claimValidator,
    "publishers", "setPublishers",
    addresses.publishers,
  );

  // ── ClaimValidator: setZKVerifier(zkVerifier) ──
  await wireIfNeeded(
    "ClaimValidator.zkVerifier",
    "DatumClaimValidator", addresses.claimValidator,
    "zkVerifier", "setZKVerifier",
    addresses.zkVerifier,
  );

  // ── ClaimValidator.setStakeRoot(stakeRoot) — V1 PRIMARY oracle ──
  // Settable by owner pre-plumbing-lock; production oracle for the
  // current deployment phase.
  await wireIfNeeded(
    "ClaimValidator.stakeRoot",
    "DatumClaimValidator", addresses.claimValidator,
    "stakeRoot", "setStakeRoot",
    addresses.stakeRoot,
  );

  // ── ClaimValidator.setStakeRoot2(stakeRootV2) — V2 SECONDARY oracle ──
  // Wired only when STAKE_ROOT_V2_SHADOW_MODE is false (V2 promoted to
  // dual-source). In shadow mode, V2 still produces roots but proofs
  // against V2 roots are NOT accepted by claim validation — V2 runs
  // for divergence monitoring only. See stakeroot-shadow-mode.md.
  if (!STAKE_ROOT_V2_SHADOW_MODE) {
    await wireIfNeeded(
      "ClaimValidator.stakeRoot2",
      "DatumClaimValidator", addresses.claimValidator,
      "stakeRoot2", "setStakeRoot2",
      addresses.stakeRootV2,
    );
  } else {
    console.log("  SKIP: ClaimValidator.stakeRoot2 wiring — V2 is in SHADOW MODE");
    console.log("        Flip STAKE_ROOT_V2_SHADOW_MODE = false in deploy.ts to promote.");
  }

  // ── V1 StakeRoot reporter bootstrap ──
  // For testnet: deployer is the sole reporter, threshold = 1. Mainnet
  // adds external parties via addReporter before launch, then setThreshold
  // to a real N-of-M (e.g., 3-of-5).
  {
    const v1Iface = new ethers.Interface([
      "function isReporter(address) view returns (bool)",
      "function threshold() view returns (uint256)",
      "function addReporter(address)",
      "function setThreshold(uint256)",
    ]);
    const alreadyReporter = ethers.AbiCoder.defaultAbiCoder().decode(["bool"],
      await rawProvider.call({ to: addresses.stakeRoot, data: v1Iface.encodeFunctionData("isReporter", [deployer.address]) })
    )[0];
    if (alreadyReporter) {
      console.log(`  OK (already set): StakeRoot.isReporter[deployer]`);
    } else {
      await sendCall(addresses.stakeRoot, ["function addReporter(address)"], "addReporter", [deployer.address]);
      console.log(`  SET: StakeRoot.addReporter(${deployer.address})`);
    }
    const curThreshold = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"],
      await rawProvider.call({ to: addresses.stakeRoot, data: v1Iface.encodeFunctionData("threshold") })
    )[0] as bigint;
    if (curThreshold === SR_V1_THRESHOLD) {
      console.log(`  OK (already set): StakeRoot.threshold = ${SR_V1_THRESHOLD}`);
    } else {
      await sendCall(addresses.stakeRoot, ["function setThreshold(uint256)"], "setThreshold", [SR_V1_THRESHOLD]);
      console.log(`  SET: StakeRoot.setThreshold(${SR_V1_THRESHOLD})`);
    }
  }

  // ── StakeRootV2.setIdentityVerifier(identityVerifier) ──
  // Plumbing-gated (StakeRootV2.lockPlumbing finalises). Allows operator
  // to swap a buggy verifier before locking.
  await wireIfNeeded(
    "StakeRootV2.identityVerifier",
    "DatumStakeRootV2", addresses.stakeRootV2,
    "identityVerifier", "setIdentityVerifier",
    addresses.identityVerifier,
  );

  // ── DatumIdentityVerifier.setVerifyingKey from trusted setup output ──
  // Reads circuits/identity-setVK-calldata.json produced by
  // scripts/setup-zk-identity.mjs. Skips with WARNING if absent or if VK
  // already set (lock-once).
  {
    const vkCalldataPath = path.join(__dirname, "..", "circuits", "identity-setVK-calldata.json");
    const idIface = new ethers.Interface([
      "function vkSet() view returns (bool)",
      "function setVerifyingKey(uint256[2] alpha1, uint256[4] beta2, uint256[4] gamma2, uint256[4] delta2, uint256[2] IC0, uint256[2] IC1)",
    ]);
    const vkSetData = idIface.encodeFunctionData("vkSet");
    const vkSetRaw = await rawProvider.call({ to: addresses.identityVerifier, data: vkSetData });
    const alreadySet = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], vkSetRaw)[0];
    if (alreadySet) {
      console.log("  OK (already set): IdentityVerifier.vk");
    } else if (!fs.existsSync(vkCalldataPath)) {
      console.warn("  SKIP: IdentityVerifier.setVerifyingKey — circuits/identity-setVK-calldata.json not found");
      console.warn("        Run `node scripts/setup-zk-identity.mjs` to generate it, then re-run deploy.ts.");
    } else {
      const vkCalldata = JSON.parse(fs.readFileSync(vkCalldataPath, "utf-8"));
      await sendCall(
        addresses.identityVerifier,
        ["function setVerifyingKey(uint256[2] alpha1, uint256[4] beta2, uint256[4] gamma2, uint256[4] delta2, uint256[2] IC0, uint256[2] IC1)"],
        "setVerifyingKey",
        [vkCalldata.alpha1, vkCalldata.beta2, vkCalldata.gamma2, vkCalldata.delta2, vkCalldata.IC0, vkCalldata.IC1],
      );
      console.log("  SET: IdentityVerifier.vk (Groth16, 1 public input: commitment)");
    }
  }

  // ── ZKVerifier: setVerifyingKey (Groth16 VK from trusted setup) ──
  // Reads circuits/setVK-calldata.json produced by `node scripts/setup-zk.mjs`.
  // Skips if vkSet is already true (idempotent) or if calldata file is absent.
  {
    const vkCalldataPath = path.join(__dirname, "..", "circuits", "setVK-calldata.json");
    const zkIface = new ethers.Interface([
      "function vkSet() view returns (bool)",
      "function setVerifyingKey(uint256[2] alpha1, uint256[4] beta2, uint256[4] gamma2, uint256[4] delta2, uint256[2] IC0, uint256[2] IC1, uint256[2] IC2, uint256[2] IC3)",
    ]);

    const vkSetData = zkIface.encodeFunctionData("vkSet");
    const vkSetRaw  = await rawProvider.call({ to: addresses.zkVerifier, data: vkSetData });
    const alreadySet = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], vkSetRaw)[0];

    if (alreadySet) {
      console.log("  OK (already set): ZKVerifier.vk");
    } else if (!fs.existsSync(vkCalldataPath)) {
      console.warn("  SKIP: ZKVerifier.setVerifyingKey — circuits/setVK-calldata.json not found");
      console.warn("        Run `node scripts/setup-zk.mjs` to generate it, then re-run deploy.ts.");
    } else {
      const vkCalldata = JSON.parse(fs.readFileSync(vkCalldataPath, "utf-8"));
      if (!vkCalldata.IC3) {
        console.warn("  SKIP: ZKVerifier.setVerifyingKey — calldata missing IC3 (re-run setup-zk.mjs after circuit update)");
      } else {
        await sendCall(
          addresses.zkVerifier,
          ["function setVerifyingKey(uint256[2] alpha1, uint256[4] beta2, uint256[4] gamma2, uint256[4] delta2, uint256[2] IC0, uint256[2] IC1, uint256[2] IC2, uint256[2] IC3)"],
          "setVerifyingKey",
          [vkCalldata.alpha1, vkCalldata.beta2, vkCalldata.gamma2, vkCalldata.delta2, vkCalldata.IC0, vkCalldata.IC1, vkCalldata.IC2, vkCalldata.IC3],
        );
        console.log("  SET: ZKVerifier.vk (Groth16 verifying key, 3 public inputs: claimHash, nullifier, impressions)");
      }
    }
  }

  // (LOCK-ONCE: GovernanceV2.setLifecycle moved to STAGE 3.)

  // ── GovernanceRouter: update campaigns + lifecycle when redeployed ──
  await wireIfNeeded(
    "GovernanceRouter.campaigns",
    "DatumGovernanceRouter", addresses.governanceRouter,
    "campaigns", "setCampaigns",
    addresses.campaigns,
  );
  await wireIfNeeded(
    "GovernanceRouter.lifecycle",
    "DatumGovernanceRouter", addresses.governanceRouter,
    "lifecycle", "setLifecycle",
    addresses.campaignLifecycle,
  );

  // Alpha-4: AdminGovernance merged into GovernanceRouter.
  // Governor is set at deploy time (deployer = Phase 0 Admin).
  // Phase transitions go through Timelock after ownership transfer.

  // (LOCK-ONCE: PublisherStake / ChallengeBonds / Campaigns.challengeBonds /
  //  Settlement.publisherStake / ActivationBonds wiring moved to STAGE 3.
  //  Lifecycle.setChallengeBonds and ClaimValidator.setActivationBonds are
  //  plumbingLocked-gated rather than per-call lock-once, but they're moved
  //  to STAGE 3 alongside their lock-once counterparts so the whole bond/
  //  activation wiring fires atomically as the last block.)

  // Re-apply commit-reveal phases. The GovernanceV2 constructor already sets
  // 14400/14400; this call is a no-op when the on-chain values already match
  // but lets per-deploy tuning happen here without rewriting the constructor.
  {
    const govIface = new ethers.Interface([
      "function commitBlocks() view returns (uint64)",
      "function revealBlocks() view returns (uint64)",
      "function setCommitRevealPhases(uint64,uint64)",
    ]);
    const curCommit = ethers.AbiCoder.defaultAbiCoder().decode(["uint64"],
      await rawProvider.call({ to: addresses.governanceV2, data: govIface.encodeFunctionData("commitBlocks") })
    )[0] as bigint;
    const curReveal = ethers.AbiCoder.defaultAbiCoder().decode(["uint64"],
      await rawProvider.call({ to: addresses.governanceV2, data: govIface.encodeFunctionData("revealBlocks") })
    )[0] as bigint;
    if (curCommit === GOV_COMMIT_BLOCKS && curReveal === GOV_REVEAL_BLOCKS) {
      console.log("  OK (already set): GovernanceV2.commitRevealPhases " + curCommit + "/" + curReveal);
    } else {
      await sendCall(
        addresses.governanceV2,
        ["function setCommitRevealPhases(uint64,uint64)"],
        "setCommitRevealPhases",
        [GOV_COMMIT_BLOCKS, GOV_REVEAL_BLOCKS],
      );
      console.log("  SET: GovernanceV2.setCommitRevealPhases(" + GOV_COMMIT_BLOCKS + ", " + GOV_REVEAL_BLOCKS + ")");
    }
  }

  // ── ClickRegistry: setRelay, setSettlement (Settlement.setClickRegistry moves to STAGE 3) ──
  await wireIfNeeded(
    "ClickRegistry.relay",
    "DatumClickRegistry", addresses.clickRegistry,
    "relay", "setRelay",
    addresses.relay,
  );
  await wireIfNeeded(
    "ClickRegistry.settlement",
    "DatumClickRegistry", addresses.clickRegistry,
    "settlement", "setSettlement",
    addresses.settlement,
  );

  // ── Alpha-4 inline: Settlement rate limiter + nullifier window ──
  // These are now inline in Settlement (no separate contracts).
  // setRateLimits and setNullifierWindowBlocks are owner-only.
  {
    const settleIface = new ethers.Interface([
      "function rlWindowBlocks() view returns (uint256)",
      "function nullifierWindowBlocks() view returns (uint256)",
      "function setRateLimits(uint256,uint256)",
      "function setNullifierWindowBlocks(uint256)",
    ]);

    // Rate limiter
    const rlData = settleIface.encodeFunctionData("rlWindowBlocks");
    const rlRaw = await rawProvider.call({ to: addresses.settlement, data: rlData });
    const currentRlWindow = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], rlRaw)[0];
    if (currentRlWindow === RATE_LIMITER_WINDOW_BLOCKS) {
      console.log("  OK (already set): Settlement.setRateLimits");
    } else {
      await sendCall(
        addresses.settlement,
        ["function setRateLimits(uint256,uint256)"],
        "setRateLimits",
        [RATE_LIMITER_WINDOW_BLOCKS, RATE_LIMITER_MAX_IMPRESSIONS],
      );
      console.log("  SET: Settlement.setRateLimits(" + RATE_LIMITER_WINDOW_BLOCKS + ", " + RATE_LIMITER_MAX_IMPRESSIONS + ")");
    }

    // Nullifier window
    const nwData = settleIface.encodeFunctionData("nullifierWindowBlocks");
    const nwRaw = await rawProvider.call({ to: addresses.settlement, data: nwData });
    const currentNullifierWindow = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], nwRaw)[0];
    if (currentNullifierWindow === NULLIFIER_WINDOW_BLOCKS) {
      console.log("  OK (already set): Settlement.setNullifierWindowBlocks");
    } else {
      await sendCall(
        addresses.settlement,
        ["function setNullifierWindowBlocks(uint256)"],
        "setNullifierWindowBlocks",
        [NULLIFIER_WINDOW_BLOCKS],
      );
      console.log("  SET: Settlement.setNullifierWindowBlocks(" + NULLIFIER_WINDOW_BLOCKS + ")");
    }
  }

  // Alpha-4: Reputation is inline in Settlement (auto-accumulated, no separate wiring needed)

  // ── DatumEmissionEngine ↔ Settlement bidirectional wiring (lock-once both ways) ──
  await wireIfNeeded(
    "EmissionEngine.settlement",
    "DatumEmissionEngine", addresses.emissionEngine,
    "settlement", "setSettlement",
    addresses.settlement,
  );
  await wireIfNeeded(
    "Settlement.emissionEngine",
    "DatumSettlement", addresses.settlement,
    "emissionEngine", "setEmissionEngine",
    addresses.emissionEngine,
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Audit pass 2 wiring (2026-05-12)
  // ──────────────────────────────────────────────────────────────────────────

  // (LOCK-ONCE: ClaimValidator.setSettlement + PublisherGovernance.setCouncilArbiter
  //  moved to STAGE 3. Publishers.setBlocklistCurator and BlocklistCurator.setCouncil
  //  are not lock-once — they stay here.)
  await wireIfNeeded(
    "Publishers.blocklistCurator",
    "DatumPublishers", addresses.publishers,
    "blocklistCurator", "setBlocklistCurator",
    addresses.blocklistCurator,
  );
  await wireIfNeeded(
    "BlocklistCurator.council",
    "DatumCouncilBlocklistCurator", addresses.blocklistCurator,
    "council", "setCouncil",
    addresses.council,
  );

  // #3: PublisherGovernance.advertiserClaimBond — 1 DOT default (10^10 planck).
  //     Governance can re-tune later. 0 = track disabled.
  {
    const govIface = new ethers.Interface([
      "function advertiserClaimBond() view returns (uint256)",
      "function setAdvertiserClaimBond(uint256)",
    ]);
    const cur = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"],
      await rawProvider.call({ to: addresses.publisherGovernance, data: govIface.encodeFunctionData("advertiserClaimBond") })
    )[0];
    const DEFAULT_ADV_BOND = 10_000_000_000n; // 1 DOT
    if (cur === DEFAULT_ADV_BOND) {
      console.log("  OK (already set): PublisherGovernance.advertiserClaimBond");
    } else {
      await sendCall(
        addresses.publisherGovernance,
        ["function setAdvertiserClaimBond(uint256)"],
        "setAdvertiserClaimBond",
        [DEFAULT_ADV_BOND],
      );
      console.log("  SET: PublisherGovernance.setAdvertiserClaimBond(" + DEFAULT_ADV_BOND + ")");
    }
  }

  // #5: Flip enforcePow ON at deploy. Defaults are sane (256 hashes @ easy band).
  {
    const settleIface = new ethers.Interface([
      "function enforcePow() view returns (bool)",
      "function setEnforcePow(bool)",
    ]);
    const cur = ethers.AbiCoder.defaultAbiCoder().decode(["bool"],
      await rawProvider.call({ to: addresses.settlement, data: settleIface.encodeFunctionData("enforcePow") })
    )[0];
    if (cur) {
      console.log("  OK (already set): Settlement.enforcePow = true");
    } else {
      await sendCall(
        addresses.settlement,
        ["function setEnforcePow(bool)"],
        "setEnforcePow",
        [true],
      );
      console.log("  SET: Settlement.setEnforcePow(true)");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 3 — LOCK-ONCE COMMITS
  //
  // Every wireIfNeeded() below is a one-shot vow. The target contract reverts
  // any subsequent attempt to change the reference. Grouped at the end of
  // wiring so a deploy failure before STAGE 3 leaves all earlier wiring
  // recoverable (parameters tunable, soft refs swappable).
  //
  // Re-run safe: each call's getter is checked first; if already correctly
  // set the call is skipped.
  //
  // Pre-flight verification: before committing the lock-onces, log every
  // upstream contract address being wired so the operator can sanity-check
  // against deployed-addresses.json before the writes go out.
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n  ── STAGE 3 PRE-FLIGHT: addresses about to be locked-in ──");
  console.log("    campaigns        =", addresses.campaigns);
  console.log("    settlement       =", addresses.settlement);
  console.log("    claimValidator   =", addresses.claimValidator);
  console.log("    attestationVer.  =", addresses.attestationVerifier);
  console.log("    publishers       =", addresses.publishers);
  console.log("    tokenRewardVault =", addresses.tokenRewardVault);
  console.log("    budgetLedger     =", addresses.budgetLedger);
  console.log("    paymentVault     =", addresses.paymentVault);
  console.log("    campaignLifecycle=", addresses.campaignLifecycle);
  console.log("    governanceV2     =", addresses.governanceV2);
  console.log("    publisherStake   =", addresses.publisherStake);
  console.log("    publisherGov     =", addresses.publisherGovernance);
  console.log("    challengeBonds   =", addresses.challengeBonds);
  console.log("    activationBonds  =", addresses.activationBonds);
  console.log("    clickRegistry    =", addresses.clickRegistry);
  console.log("    council          =", addresses.council);
  console.log("  ───────────────────────────────────────────────────────────\n");

  // ── Settlement.configure: foundational lock-once tying Settlement to its
  //    BudgetLedger, PaymentVault, Lifecycle, and Relay refs. Must precede
  //    every other Settlement lock-once below. ──
  {
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
  }

  // ── Settlement protocol-ref lock-onces ──
  await wireIfNeeded(
    "Settlement.claimValidator",
    "DatumSettlement", addresses.settlement,
    "claimValidator", "setClaimValidator",
    addresses.claimValidator,
  );
  await wireIfNeeded(
    "Settlement.attestationVerifier",
    "DatumSettlement", addresses.settlement,
    "attestationVerifier", "setAttestationVerifier",
    addresses.attestationVerifier,
  );
  await wireIfNeeded(
    "Settlement.publishers",
    "DatumSettlement", addresses.settlement,
    "publishers", "setPublishers",
    addresses.publishers,
  );
  await wireIfNeeded(
    "Settlement.tokenRewardVault",
    "DatumSettlement", addresses.settlement,
    "tokenRewardVault", "setTokenRewardVault",
    addresses.tokenRewardVault,
  );
  await wireIfNeeded(
    "Settlement.campaigns",
    "DatumSettlement", addresses.settlement,
    "campaigns", "setCampaigns",
    addresses.campaigns,
  );
  await wireIfNeeded(
    "Settlement.clickRegistry",
    "DatumSettlement", addresses.settlement,
    "clickRegistry", "setClickRegistry",
    addresses.clickRegistry,
  );

  // ── TokenRewardVault back-reference ──
  await wireIfNeeded(
    "TokenRewardVault.settlement",
    "DatumTokenRewardVault", addresses.tokenRewardVault,
    "settlement", "setSettlement",
    addresses.settlement,
  );

  // ── BudgetLedger / PaymentVault lock-onces ──
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
  await wireIfNeeded(
    "PaymentVault.settlement",
    "DatumPaymentVault", addresses.paymentVault,
    "settlement", "setSettlement",
    addresses.settlement,
  );

  // ── GovernanceV2 lock-once refs ──
  await wireIfNeeded(
    "GovernanceV2.lifecycle",
    "DatumGovernanceV2", addresses.governanceV2,
    "lifecycle", "setLifecycle",
    addresses.campaignLifecycle,
  );

  // ── FP-1+FP-4: PublisherStake bidirectional wiring (lock-once both sides) ──
  await wireIfNeeded(
    "PublisherStake.settlementContract",
    "DatumPublisherStake", addresses.publisherStake,
    "settlementContract", "setSettlementContract",
    addresses.settlement,
  );
  await wireIfNeeded(
    "PublisherStake.slashContract",
    "DatumPublisherStake", addresses.publisherStake,
    "slashContract", "setSlashContract",
    addresses.publisherGovernance,
  );
  await wireIfNeeded(
    "Settlement.publisherStake",
    "DatumSettlement", addresses.settlement,
    "publisherStake", "setPublisherStake",
    addresses.publisherStake,
  );

  // ── FP-2: ChallengeBonds wiring (all three setters lock-once) ──
  await wireIfNeeded(
    "ChallengeBonds.campaignsContract",
    "DatumChallengeBonds", addresses.challengeBonds,
    "campaignsContract", "setCampaignsContract",
    addresses.campaigns,
  );
  await wireIfNeeded(
    "ChallengeBonds.lifecycleContract",
    "DatumChallengeBonds", addresses.challengeBonds,
    "lifecycleContract", "setLifecycleContract",
    addresses.campaignLifecycle,
  );
  await wireIfNeeded(
    "ChallengeBonds.governanceContract",
    "DatumChallengeBonds", addresses.challengeBonds,
    "governanceContract", "setGovernanceContract",
    addresses.publisherGovernance,
  );
  // Campaigns calls lockBond() when advertisers include a bond at creation.
  await wireIfNeeded(
    "Campaigns.challengeBonds",
    "DatumCampaigns", addresses.campaigns,
    "challengeBonds", "setChallengeBonds",
    addresses.challengeBonds,
  );
  // Lifecycle.setChallengeBonds is plumbingLocked-gated, not per-call
  // lock-once. Co-located here so all bond wiring fires atomically.
  await wireIfNeeded(
    "Lifecycle.challengeBonds",
    "DatumCampaignLifecycle", addresses.campaignLifecycle,
    "challengeBonds", "setChallengeBonds",
    addresses.challengeBonds,
  );

  // ── Optimistic activation (Phases 1/2a/2b) — all lock-once ──
  await wireIfNeeded(
    "ActivationBonds.campaignsContract",
    "DatumActivationBonds", addresses.activationBonds,
    "campaignsContract", "setCampaignsContract",
    addresses.campaigns,
  );
  await wireIfNeeded(
    "Campaigns.activationBonds",
    "DatumCampaigns", addresses.campaigns,
    "activationBonds", "setActivationBonds",
    addresses.activationBonds,
  );
  await wireIfNeeded(
    "GovernanceV2.activationBonds",
    "DatumGovernanceV2", addresses.governanceV2,
    "activationBonds", "setActivationBonds",
    addresses.activationBonds,
  );
  // ClaimValidator.setActivationBonds is plumbingLocked-gated (not
  // per-call lock-once). MUST run before lockPlumbing below.
  await wireIfNeeded(
    "ClaimValidator.activationBonds",
    "DatumClaimValidator", addresses.claimValidator,
    "activationBonds", "setActivationBonds",
    addresses.activationBonds,
  );

  // ── #5: ClaimValidator → Settlement (lock-once on first non-zero set) ──
  await wireIfNeeded(
    "ClaimValidator.settlement",
    "DatumClaimValidator", addresses.claimValidator,
    "settlement", "setSettlement",
    addresses.settlement,
  );

  // ── #3: PublisherGovernance.councilArbiter (lock-once) ──
  await wireIfNeeded(
    "PublisherGovernance.councilArbiter",
    "DatumPublisherGovernance", addresses.publisherGovernance,
    "councilArbiter", "setCouncilArbiter",
    addresses.council,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 4 — IRREVOCABLE FLAGS
  // After this, no setter on the locked plumbing contracts works again,
  // and Campaigns.setSettlementContract etc. enter post-bootstrap staging mode.
  // ═══════════════════════════════════════════════════════════════════════════

  // A5/B8: lockBootstrap on Campaigns once governance/lifecycle/settlement/
  //        budgetLedger refs are wired. Idempotent — re-runs are no-ops.
  {
    const iface = new ethers.Interface([
      "function bootstrapped() view returns (bool)",
      "function lockBootstrap()",
    ]);
    const cur = ethers.AbiCoder.defaultAbiCoder().decode(["bool"],
      await rawProvider.call({ to: addresses.campaigns, data: iface.encodeFunctionData("bootstrapped") })
    )[0];
    if (cur) {
      console.log("  OK (already locked): Campaigns.bootstrapped = true");
    } else {
      await sendCall(addresses.campaigns, ["function lockBootstrap()"], "lockBootstrap", []);
      console.log("  SET: Campaigns.lockBootstrap()");
    }
  }

  // A7: PaymentVault — keep feeShareRecipient mutable for now (token integration
  //     wires it). lockFeeShareRecipient is a manual post-deploy step.

  // B1/B7: DatumRelay liveness threshold is already on by default (constructor sets
  //        14400 blocks). lockRelayerOpen is a manual post-deploy step.

  // D1a (audit pass 3.6): lockPlumbing() on every plumbing contract. After this
  //     call every protocol-ref setter on the contract reverts forever. Every
  //     plumbing contract validates required refs are non-zero at lock time, so
  //     this MUST run after all wireIfNeeded() calls above. Idempotent — the
  //     `plumbingLocked()` read short-circuits re-runs. Must also run BEFORE
  //     ownership transfer to Timelock (deployer is still the owner here).
  async function lockPlumbingIfNeeded(label: string, addr: string): Promise<void> {
    const iface = new ethers.Interface([
      "function plumbingLocked() view returns (bool)",
      "function lockPlumbing()",
    ]);
    const cur = ethers.AbiCoder.defaultAbiCoder().decode(["bool"],
      await rawProvider.call({ to: addr, data: iface.encodeFunctionData("plumbingLocked") })
    )[0];
    if (cur) {
      console.log(`  OK (already locked): ${label}.plumbingLocked`);
      return;
    }
    await sendCall(addr, ["function lockPlumbing()"], "lockPlumbing", []);
    console.log(`  SET: ${label}.lockPlumbing()`);
  }

  await lockPlumbingIfNeeded("ClaimValidator",   addresses.claimValidator);
  await lockPlumbingIfNeeded("Lifecycle",        addresses.campaignLifecycle);
  await lockPlumbingIfNeeded("ClickRegistry",    addresses.clickRegistry);
  await lockPlumbingIfNeeded("Relay",            addresses.relay);
  await lockPlumbingIfNeeded("GovernanceRouter", addresses.governanceRouter);

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
    // All three contracts (Campaigns, Settlement, Publishers) use 2-step ownership.
    // transferOwnership() sets pendingOwner; acceptOwnership() must be called by Timelock.
    // Check if transfer is already pending before re-sending.
    try {
      const pending = await readAddr(contractAddr, "pendingOwner");
      if (pending === addresses.timelock.toLowerCase()) {
        console.log(`  OK (transfer pending — Timelock must call acceptOwnership): ${label}`);
        return;
      }
    } catch { /* pendingOwner may not exist on all contracts */ }
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
      console.log(`  TRANSFERRED: ${label} -> Timelock (pendingOwner set; Timelock must call acceptOwnership)`);
    } catch (err) {
      console.warn(`  WARNING: ${label} ownership transfer failed: ${String(err).slice(0, 100)}`);
    }
  }

  await transferOwnershipIfNeeded("Campaigns", "DatumCampaigns", addresses.campaigns);
  await transferOwnershipIfNeeded("Settlement", "DatumSettlement", addresses.settlement);
  // S12: Blocklist admin (blockAddress/unblockAddress) must go through 48h timelock for mainnet transparency
  await transferOwnershipIfNeeded("Publishers", "DatumPublishers", addresses.publishers);
  // Governance ladder: phase transitions (setGovernor) must go through 48h timelock
  await transferOwnershipIfNeeded("GovernanceRouter", "DatumGovernanceRouter", addresses.governanceRouter);

  console.log("\n  Future admin changes go through:");
  console.log("    timelock.propose(target, abi.encodeCall(...)) -> 48h -> timelock.execute()");
  console.log("  Phase transitions:");
  console.log("    Phase 0→1: timelock → router.setGovernor(Council, councilAddr)");
  console.log("    Phase 1→2: timelock → router.setGovernor(OpenGov, governanceV2Addr)");
  console.log("               + govV2.setCampaigns(router) + govV2.setLifecycle(router)");

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3b: ParameterGovernance — whitelist + ownership migration
  // ═══════════════════════════════════════════════════════════════════════════

  logStep("Wiring ParameterGovernance whitelist + ownership for FP contracts");

  // Catalog of governable parameter setters. Keep this in sync with the
  // webapp's parameterCatalog.ts so the UI can render structured propose forms.
  // Each entry whitelists (target, selector) on ParameterGovernance and
  // (eventually) lets a passed proposal call it via PG.execute().
  interface GovernableSetter { contractKey: keyof typeof addresses; sig: string; }
  // IMPORTANT: parameterGovernance MUST be last. Once PG bootstraps ownership of
  // itself the deployer is no longer PG's owner, so any later
  // bootstrapAcceptOwnership(*) call would revert with E18.
  const PARAM_SETTERS: GovernableSetter[] = [
    // PublisherStake — base/perImp/delay + max-required cap
    { contractKey: "publisherStake",       sig: "setParams(uint256,uint256,uint256)" },
    { contractKey: "publisherStake",       sig: "setMaxRequiredStake(uint256)" },
    // PublisherGovernance — fraud governance tunables
    { contractKey: "publisherGovernance",  sig: "setParams(uint256,uint256,uint256,uint256)" },
    { contractKey: "publisherGovernance",  sig: "setProposeBond(uint256)" },
    // DatumEmissionEngine — Path H adjustment cadence (within baked [1d, 90d] bounds)
    { contractKey: "emissionEngine",       sig: "setAdjustmentPeriod(uint64)" },
    // ParameterGovernance self-governance — voting/timelock/quorum/bond. KEEP LAST.
    { contractKey: "parameterGovernance",  sig: "setParams(uint256,uint256,uint256,uint256)" },
  ];

  // Group target addresses we need to whitelist + transfer
  const PG_TARGETS = Array.from(new Set(PARAM_SETTERS.map((s) => s.contractKey)));

  function selectorOf(sig: string): string {
    return ethers.id(sig).slice(0, 10);
  }

  // Helper: call a setter on ParameterGovernance only when the desired state differs
  async function pgSetWhitelistTarget(targetAddr: string, allowed: boolean) {
    const iface = new ethers.Interface(["function whitelistedTargets(address) view returns (bool)"]);
    const data = iface.encodeFunctionData("whitelistedTargets", [targetAddr]);
    const result = await rawProvider.call({ to: addresses.parameterGovernance, data });
    const current = Boolean(ethers.AbiCoder.defaultAbiCoder().decode(["bool"], result)[0]);
    if (current === allowed) {
      console.log(`  OK (already): ParameterGovernance.whitelist[${targetAddr}] = ${allowed}`);
      return;
    }
    await sendCall(addresses.parameterGovernance,
      ["function setWhitelistedTarget(address,bool)"], "setWhitelistedTarget", [targetAddr, allowed]);
    console.log(`  SET: ParameterGovernance.whitelist[${targetAddr}] = ${allowed}`);
  }

  async function pgSetSelector(targetAddr: string, selector: string, allowed: boolean) {
    const iface = new ethers.Interface(["function permittedSelectors(address,bytes4) view returns (bool)"]);
    const data = iface.encodeFunctionData("permittedSelectors", [targetAddr, selector]);
    const result = await rawProvider.call({ to: addresses.parameterGovernance, data });
    const current = Boolean(ethers.AbiCoder.defaultAbiCoder().decode(["bool"], result)[0]);
    if (current === allowed) {
      console.log(`  OK (already): selector ${selector} on ${targetAddr} = ${allowed}`);
      return;
    }
    await sendCall(addresses.parameterGovernance,
      ["function setPermittedSelector(address,bytes4,bool)"], "setPermittedSelector", [targetAddr, selector, allowed]);
    console.log(`  SET: selector ${selector} on ${targetAddr} = ${allowed}`);
  }

  // 3b.1: Whitelist all governable (target, selector) tuples on ParameterGovernance.
  for (const targetKey of PG_TARGETS) {
    await pgSetWhitelistTarget(addresses[targetKey], true);
  }
  for (const setter of PARAM_SETTERS) {
    await pgSetSelector(addresses[setter.contractKey], selectorOf(setter.sig), true);
  }

  // 3b.2: Transfer ownership of each governed contract (and PG itself) → PG.
  //       Then bootstrap-accept on PG to finish the 2-step migration.
  for (const targetKey of PG_TARGETS) {
    const targetAddr = addresses[targetKey];
    const owner = await readAddr(targetAddr, "owner");
    if (owner === addresses.parameterGovernance.toLowerCase()) {
      console.log(`  OK (already PG-owned): ${targetKey}`);
      continue;
    }
    if (owner !== deployer.address.toLowerCase()) {
      console.warn(`  WARNING: ${targetKey} owned by ${owner}, not deployer — skipping ownership migration`);
      continue;
    }
    let pendingOwner = "";
    try { pendingOwner = await readAddr(targetAddr, "pendingOwner"); } catch { /* */ }
    if (pendingOwner !== addresses.parameterGovernance.toLowerCase()) {
      await sendCall(targetAddr, ["function transferOwnership(address)"], "transferOwnership", [addresses.parameterGovernance]);
      console.log(`  TRANSFERRED: ${targetKey} -> ParameterGovernance (pendingOwner set)`);
    } else {
      console.log(`  OK (transfer pending): ${targetKey} pendingOwner already PG`);
    }
    // bootstrapAcceptOwnership is owner-only on PG (deployer at this point)
    await sendCall(addresses.parameterGovernance,
      ["function bootstrapAcceptOwnership(address)"], "bootstrapAcceptOwnership", [targetAddr]);
    console.log(`  ACCEPTED: ParameterGovernance now owns ${targetKey}`);
  }

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

  // D1a (audit pass 3.6): verify every plumbing contract is locked.
  async function checkBool(label: string, contractAddr: string, getter: string, expected: boolean) {
    const iface = new ethers.Interface([`function ${getter}() view returns (bool)`]);
    const result = await rawProvider.call({ to: contractAddr, data: iface.encodeFunctionData(getter) });
    const actual = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], result)[0];
    if (actual !== expected) {
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
  await check("Settlement.publishers", await readAddr(addresses.settlement, "publishers"), addresses.publishers);
  // 2-step ownership: transferOwnership sets pendingOwner; Timelock calls acceptOwnership to finalize.
  await check("Settlement.pendingOwner", await readAddr(addresses.settlement, "pendingOwner"), addresses.timelock);

  // Campaigns
  await check("Campaigns.budgetLedger", await readAddr(addresses.campaigns, "budgetLedger"), addresses.budgetLedger);
  await check("Campaigns.lifecycleContract", await readAddr(addresses.campaigns, "lifecycleContract"), addresses.campaignLifecycle);
  await check("Campaigns.governanceContract", await readAddr(addresses.campaigns, "governanceContract"), addresses.governanceRouter);
  await check("Campaigns.settlementContract", await readAddr(addresses.campaigns, "settlementContract"), addresses.settlement);
  // Alpha-4: campaignValidator merged into Campaigns (no separate contract)
  // 2-step ownership: transferOwnership sets pendingOwner; Timelock calls acceptOwnership to finalize.
  await check("Campaigns.pendingOwner", await readAddr(addresses.campaigns, "pendingOwner"), addresses.timelock);
  // S12: Publishers must be timelock-owned so blockAddress/unblockAddress require 48h delay
  await check("Publishers.pendingOwner", await readAddr(addresses.publishers, "pendingOwner"), addresses.timelock);

  // BudgetLedger
  await check("BudgetLedger.campaigns", await readAddr(addresses.budgetLedger, "campaigns"), addresses.campaigns);
  await check("BudgetLedger.settlement", await readAddr(addresses.budgetLedger, "settlement"), addresses.settlement);
  await check("BudgetLedger.lifecycle", await readAddr(addresses.budgetLedger, "lifecycle"), addresses.campaignLifecycle);

  // PaymentVault
  await check("PaymentVault.settlement", await readAddr(addresses.paymentVault, "settlement"), addresses.settlement);

  // CampaignLifecycle
  await check("Lifecycle.campaigns", await readAddr(addresses.campaignLifecycle, "campaigns"), addresses.campaigns);
  await check("Lifecycle.budgetLedger", await readAddr(addresses.campaignLifecycle, "budgetLedger"), addresses.budgetLedger);
  await check("Lifecycle.governanceContract", await readAddr(addresses.campaignLifecycle, "governanceContract"), addresses.governanceRouter);
  await check("Lifecycle.settlementContract", await readAddr(addresses.campaignLifecycle, "settlementContract"), addresses.settlement);

  // GovernanceV2 (GovernanceHelper + GovernanceSlash merged inline in alpha-4)
  await check("GovernanceV2.lifecycle", await readAddr(addresses.governanceV2, "lifecycle"), addresses.campaignLifecycle);

  // GovernanceRouter (Phase 0 — admin functions inline, deployer is initial governor)
  await check("GovernanceRouter.campaigns", await readAddr(addresses.governanceRouter, "campaigns"), addresses.campaigns);
  await check("GovernanceRouter.lifecycle", await readAddr(addresses.governanceRouter, "lifecycle"), addresses.campaignLifecycle);
  await check("GovernanceRouter.governor", await readAddr(addresses.governanceRouter, "governor"), deployer.address);
  await check("GovernanceRouter.pendingOwner", await readAddr(addresses.governanceRouter, "pendingOwner"), addresses.timelock);

  // ClaimValidator
  await check("ClaimValidator.campaigns", await readAddr(addresses.claimValidator, "campaigns"), addresses.campaigns);
  await check("ClaimValidator.publishers", await readAddr(addresses.claimValidator, "publishers"), addresses.publishers);
  await check("ClaimValidator.zkVerifier", await readAddr(addresses.claimValidator, "zkVerifier"), addresses.zkVerifier);

  // TokenRewardVault
  await check("Settlement.tokenRewardVault", await readAddr(addresses.settlement, "tokenRewardVault"), addresses.tokenRewardVault);
  await check("Settlement.campaigns", await readAddr(addresses.settlement, "campaigns"), addresses.campaigns);
  await check("TokenRewardVault.settlement", await readAddr(addresses.tokenRewardVault, "settlement"), addresses.settlement);

  // FP-1+FP-4: PublisherStake
  await check("PublisherStake.settlementContract", await readAddr(addresses.publisherStake, "settlementContract"), addresses.settlement);
  await check("PublisherStake.slashContract", await readAddr(addresses.publisherStake, "slashContract"), addresses.publisherGovernance);
  await check("Settlement.publisherStake", await readAddr(addresses.settlement, "publisherStake"), addresses.publisherStake);

  // FP-2: ChallengeBonds
  await check("ChallengeBonds.campaignsContract", await readAddr(addresses.challengeBonds, "campaignsContract"), addresses.campaigns);
  await check("ChallengeBonds.lifecycleContract", await readAddr(addresses.challengeBonds, "lifecycleContract"), addresses.campaignLifecycle);
  await check("ChallengeBonds.governanceContract", await readAddr(addresses.challengeBonds, "governanceContract"), addresses.publisherGovernance);
  await check("Campaigns.challengeBonds", await readAddr(addresses.campaigns, "challengeBonds"), addresses.challengeBonds);
  await check("Lifecycle.challengeBonds", await readAddr(addresses.campaignLifecycle, "challengeBonds"), addresses.challengeBonds);

  // ClickRegistry (CPC fraud prevention)
  await check("ClickRegistry.relay", await readAddr(addresses.clickRegistry, "relay"), addresses.relay);
  await check("ClickRegistry.settlement", await readAddr(addresses.clickRegistry, "settlement"), addresses.settlement);
  await check("Settlement.clickRegistry", await readAddr(addresses.settlement, "clickRegistry"), addresses.clickRegistry);

  // Alpha-4: NullifierRegistry + Reputation merged into Settlement (no separate checks needed)

  // D1a (audit pass 3.6): every plumbing contract must be committed via lockPlumbing().
  await checkBool("ClaimValidator.plumbingLocked",   addresses.claimValidator,    "plumbingLocked", true);
  await checkBool("Lifecycle.plumbingLocked",        addresses.campaignLifecycle, "plumbingLocked", true);
  await checkBool("ClickRegistry.plumbingLocked",    addresses.clickRegistry,     "plumbingLocked", true);
  await checkBool("Relay.plumbingLocked",            addresses.relay,             "plumbingLocked", true);
  await checkBool("GovernanceRouter.plumbingLocked", addresses.governanceRouter,  "plumbingLocked", true);

  // T1-B: ParameterGovernance — standalone, no cross-contract wiring needed at deploy time
  // (ownership transfer to ParameterGovernance happens per-contract via governance proposals)

  // ── Validate all 21 addresses present and non-zero ──
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

  console.log("\n=== DATUM Alpha-4 Deployment Complete ===\n");
  console.log("21 contracts deployed and wired:\n");
  for (const key of REQUIRED_KEYS) {
    console.log(`  ${key.padEnd(24)} ${addresses[key]}`);
  }
  console.log(`\n  network                 ${addresses.network}`);
  console.log(`  deployedAt              ${addresses.deployedAt}`);
  console.log("\nOwnership transferred to Timelock:");
  console.log("  - DatumCampaigns");
  console.log("  - DatumSettlement");
  console.log("  - DatumPublishers (S12: blocklist admin gated)");
  console.log("  - DatumGovernanceRouter (phase transitions gated)");
  console.log("\nTo configure the extension, addresses auto-load from deployed-addresses.json.");
  console.log("To set up testnet: npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
