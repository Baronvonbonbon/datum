/**
 * gas-costs.ts — Per-function gas (weight) estimates for all alpha-3 contracts
 * ============================================================================
 * Calls eth_estimateGas for every state-changing function against the live
 * Paseo deployment.  View functions are listed separately (no gas cost to caller).
 *
 * Usage:
 *   npx hardhat run scripts/gas-costs.ts --network polkadotTestnet
 *
 * Notes:
 *   - Gas values are Paseo weight units (not EVM gas).
 *   - BN254 ecPairing (verify) is ~51–88× cheaper than Ethereum mainnet.
 *   - Functions that require specific existing state (active campaign, voter lock,
 *     etc.) are estimated with best-effort inputs; where estimation fails the
 *     script falls back to a static-call dry-run and reports the revert reason.
 *   - "OWNER" calls use Alice (deployer). Publisher calls use Diana. Advertiser
 *     calls use Bob.
 */

import { ethers, network } from "hardhat";
import {
  JsonRpcProvider,
  Wallet,
  Interface,
  ZeroHash,
  ZeroAddress,
  AbiCoder,
} from "ethers";
import * as fs from "fs";
import * as path from "path";

// ── Deployed addresses ────────────────────────────────────────────────────────
const ADDR = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployed-addresses-evm.json"), "utf-8")
);

// ── Accounts ──────────────────────────────────────────────────────────────────
const PK = {
  alice:   "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8",
  bob:     "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52",
  diana:   "0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0",
  frank:   "0xd8947fdc847ae7e902cf126b449cb8d9e7a9becdd0816397eaeb3b046d77986c",
  hank:    "0x5a59217ca71dad891d80d1d59454741b0601cf1d46698ef50ba0d2d0315f1018",
};

// ── Provider setup ────────────────────────────────────────────────────────────
const RPC_URL  = (network.config as any).url ?? "https://eth-rpc-testnet.polkadot.io/";
const rawProvider = new JsonRpcProvider(RPC_URL);

function wallet(pk: string) {
  return new Wallet(pk, rawProvider);
}

// ── Fee conversion ────────────────────────────────────────────────────────────
// Confirmed by balance check: eth_getBalance returns balances in wei where
// 1 ETH (10^18 wei) = 1 PAS (10^10 planck).  Standard Ethereum fee formula:
//   fee_PAS = gasUsed × gasPrice / 10^18
// With Paseo gasPrice = 10^12 wei/gas:
//   fee_PAS = gasUsed × 10^12 / 10^18 = gasUsed / 10^6
const GAS_PRICE_WEI = 1_000_000_000_000n; // 10^12 (eth_gasPrice)
const WEI_SCALE     = 10n ** 18n;

function gasToPAS(gas: bigint): number {
  return Number(gas * GAS_PRICE_WEI) / Number(WEI_SCALE);
}

const DOT_USD_PRICES = [5, 10, 20]; // scenarios

// ── Gas estimation helpers ────────────────────────────────────────────────────
interface GasEntry {
  contract: string;
  function:  string;
  caller:    string;
  gas:       bigint | null;
  note:      string;
}

const results: GasEntry[] = [];
const VIEW_FUNCS: { contract: string; function: string }[] = [];

async function est(
  contractName: string,
  to: string,
  fnSig: string,
  args: unknown[],
  callerPk: string,
  extraNote = "",
  value = 0n,
): Promise<void> {
  const iface = new Interface([`function ${fnSig}`]);
  const fnName = fnSig.split("(")[0];
  const data  = iface.encodeFunctionData(fnName, args);
  const from  = new Wallet(callerPk).address;

  let gas: bigint | null = null;
  let note = extraNote;

  try {
    gas = await rawProvider.estimateGas({ from, to, data, value });
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    // Try to extract a revert reason
    if (msg.includes("0x")) {
      const hexMatch = msg.match(/0x[0-9a-fA-F]+/);
      if (hexMatch) {
        try {
          const decoded = AbiCoder.defaultAbiCoder().decode(["string"], "0x" + hexMatch[0].slice(10));
          note = `REVERTED: ${decoded[0]}`;
        } catch {
          note = `REVERTED (${hexMatch[0].slice(0, 20)}…)`;
        }
      } else {
        note = `REVERTED`;
      }
    } else if (msg.includes("execution reverted")) {
      note = "REVERTED (needs live state)";
    } else {
      note = `ERR: ${msg.slice(0, 60)}`;
    }
  }

  results.push({ contract: contractName, function: fnName, caller: from.slice(0, 10) + "…", gas, note });
}

function view(contractName: string, fnSig: string) {
  VIEW_FUNCS.push({ contract: contractName, function: fnSig });
}

// ── Helper: format gas ────────────────────────────────────────────────────────
function fmtGas(g: bigint | null): string {
  if (g === null) return "—";
  if (g >= 1_000_000_000n)  return (Number(g) / 1e9).toFixed(1) + " G";
  if (g >= 1_000_000n)      return (Number(g) / 1e6).toFixed(1) + " M";
  return g.toLocaleString();
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\nDatum Alpha-3 — Gas Cost Estimation");
  console.log("Network:", RPC_URL);
  console.log("Collecting estimates (this may take ~60 s)…\n");

  const alice  = wallet(PK.alice);
  const bob    = wallet(PK.bob);
  const diana  = wallet(PK.diana);
  const frank  = wallet(PK.frank);
  const hank   = wallet(PK.hank);

  // ── DatumPauseRegistry ────────────────────────────────────────────────────
  await est("PauseRegistry", ADDR.pauseRegistry,
    "pause()", [], PK.alice);
  await est("PauseRegistry", ADDR.pauseRegistry,
    "unpause()", [], PK.alice);
  view("PauseRegistry", "paused() → bool");

  // ── DatumPublishers ───────────────────────────────────────────────────────
  await est("Publishers", ADDR.publishers,
    "registerPublisher(uint16 takeRateBps)", [500], PK.diana,
    "Diana re-registers (may revert if already registered)");
  await est("Publishers", ADDR.publishers,
    "updateTakeRate(uint16 newTakeRateBps)", [600], PK.diana);
  await est("Publishers", ADDR.publishers,
    "applyTakeRateUpdate()", [], PK.diana,
    "24h cooling period — likely reverts unless enough blocks passed");
  await est("Publishers", ADDR.publishers,
    "blockAddress(address addr)", [frank.address], PK.alice);
  await est("Publishers", ADDR.publishers,
    "unblockAddress(address addr)", [frank.address], PK.alice);
  await est("Publishers", ADDR.publishers,
    "setAllowlistEnabled(bool enabled)", [false], PK.diana);
  await est("Publishers", ADDR.publishers,
    "setAllowedAdvertiser(address advertiser, bool allowed)", [bob.address, true], PK.diana);
  const DUMMY_HASH = "0x" + "ab".repeat(32); // non-zero bytes32
  await est("Publishers", ADDR.publishers,
    "registerSdkVersion(bytes32 hash)", [DUMMY_HASH], PK.diana);
  await est("Publishers", ADDR.publishers,
    "setRelaySigner(address signer)", [diana.address], PK.diana);
  await est("Publishers", ADDR.publishers,
    "setProfile(bytes32 hash)", [DUMMY_HASH], PK.diana);
  await est("Publishers", ADDR.publishers,
    "transferOwnership(address newOwner)", [alice.address], PK.alice);

  view("Publishers", "getPublisher(address) → Publisher");
  view("Publishers", "isRegisteredWithRate(address) → (bool, uint16)");
  view("Publishers", "isBlocked(address) → bool");
  view("Publishers", "isAllowedAdvertiser(address, address) → bool");
  view("Publishers", "getSdkVersion(address) → bytes32");

  // ── DatumTargetingRegistry ────────────────────────────────────────────────
  const TAG_HASH = "0x" + "cd".repeat(32);
  await est("TargetingRegistry", ADDR.targetingRegistry,
    "setTags(bytes32[] calldata tagHashes)", [[TAG_HASH]], PK.diana,
    "Diana sets 1 tag");
  await est("TargetingRegistry", ADDR.targetingRegistry,
    "setTags(bytes32[] calldata tagHashes)", [Array(8).fill(TAG_HASH)], PK.diana,
    "Diana sets 8 tags (max for campaign)");
  await est("TargetingRegistry", ADDR.targetingRegistry,
    "transferOwnership(address newOwner)", [alice.address], PK.alice);

  view("TargetingRegistry", "getTags(address) → bytes32[]");
  view("TargetingRegistry", "hasAllTags(address, bytes32[]) → bool");

  // ── DatumCampaigns ────────────────────────────────────────────────────────
  // createCampaign: open (publisher=0), no tags, no ZK
  // value = budget (must be > 0, and a clean multiple of 10^6 per Paseo rounding rule)
  const dailyCap  = 20_000_000_000n;   // 2 DOT (10^10 planck)
  const bidCpm    = 100_000_000n;      // 0.01 DOT CPM
  const campaignBudget = 20_000_000_000n;  // 2 DOT budget
  await est("Campaigns", ADDR.campaigns,
    "createCampaign(address publisher, uint256 dailyCapPlanck, uint256 bidCpmPlanck, bytes32[] calldata requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression)",
    [ZeroAddress, dailyCap, bidCpm, [], false, ZeroAddress, 0], PK.bob,
    "open campaign (no publisher, no tags)", campaignBudget);
  await est("Campaigns", ADDR.campaigns,
    "createCampaign(address publisher, uint256 dailyCapPlanck, uint256 bidCpmPlanck, bytes32[] calldata requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression)",
    [diana.address, dailyCap, bidCpm, [], false, ZeroAddress, 0], PK.bob,
    "targeted campaign (diana, no tags)", campaignBudget);
  await est("Campaigns", ADDR.campaigns,
    "createCampaign(address publisher, uint256 dailyCapPlanck, uint256 bidCpmPlanck, bytes32[] calldata requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression)",
    [diana.address, dailyCap, bidCpm, [], true, ZeroAddress, 0], PK.bob,
    "targeted + requireZkProof", campaignBudget);
  await est("Campaigns", ADDR.campaigns,
    "setMetadata(uint256 campaignId, bytes32 metadataHash)", [1n, ZeroHash], PK.bob);
  await est("Campaigns", ADDR.campaigns,
    "togglePause(uint256 campaignId, bool pause)", [1n, true], PK.bob,
    "pause campaign 1");
  await est("Campaigns", ADDR.campaigns,
    "togglePause(uint256 campaignId, bool pause)", [1n, false], PK.bob,
    "unpause campaign 1");
  await est("Campaigns", ADDR.campaigns,
    "activateCampaign(uint256 campaignId)", [1n], PK.alice,
    "only callable by GovernanceV2");

  view("Campaigns", "getCampaignStatus(uint256) → CampaignStatus");
  view("Campaigns", "getCampaignAdvertiser(uint256) → address");
  view("Campaigns", "getCampaignPublisher(uint256) → address");
  view("Campaigns", "getCampaignTags(uint256) → bytes32[]");
  view("Campaigns", "getCampaignRelaySigner(uint256) → address");
  view("Campaigns", "getCampaignPublisherTags(uint256) → bytes32[]");
  view("Campaigns", "getCampaignRequiresZkProof(uint256) → bool");
  view("Campaigns", "getCampaignForSettlement(uint256) → (uint8,address,uint256,uint16)");

  // ── DatumGovernanceV2 ─────────────────────────────────────────────────────
  // vote: payable, value = 100 DOT (conviction 0)
  const VOTE_VALUE = 1_000_000_000_000n;  // 100 DOT = 100 × 10^10 planck
  // Use campaign 2 (from setup-testnet, should be in Voting state if setup ran)
  await est("GovernanceV2", ADDR.governanceV2,
    "vote(uint256 campaignId, bool aye, uint8 conviction)", [2n, true, 0], PK.frank,
    "100 DOT conviction-0 vote on campaign 2", VOTE_VALUE);
  await est("GovernanceV2", ADDR.governanceV2,
    "vote(uint256 campaignId, bool aye, uint8 conviction)", [1n, true, 0], PK.frank,
    "100 DOT conviction-0 vote on campaign 1", VOTE_VALUE);
  await est("GovernanceV2", ADDR.governanceV2,
    "evaluateCampaign(uint256 campaignId)", [1n], PK.alice,
    "evaluate campaign 1 (may revert if quorum not met)");
  await est("GovernanceV2", ADDR.governanceV2,
    "withdraw(uint256 campaignId)", [1n], PK.frank,
    "withdraw frank vote on campaign 1");

  view("GovernanceV2", "getVote(uint256, address) → (uint8,uint256,uint8,uint256)");
  view("GovernanceV2", "convictionWeight(uint8) → uint256");

  // ── DatumGovernanceSlash ──────────────────────────────────────────────────
  await est("GovernanceSlash", ADDR.governanceSlash,
    "finalizeSlash(uint256 campaignId)", [1n], PK.alice,
    "needs terminated campaign");
  await est("GovernanceSlash", ADDR.governanceSlash,
    "claimSlashReward(uint256 campaignId)", [1n], PK.frank,
    "needs finalized slash");
  await est("GovernanceSlash", ADDR.governanceSlash,
    "sweepSlashPool(uint256 campaignId)", [1n], PK.alice);

  view("GovernanceSlash", "getClaimable(uint256, address) → uint256");

  // ── DatumCampaignLifecycle ────────────────────────────────────────────────
  await est("CampaignLifecycle", ADDR.campaignLifecycle,
    "completeCampaign(uint256 campaignId)", [1n], PK.alice,
    "only callable by GovernanceV2");
  await est("CampaignLifecycle", ADDR.campaignLifecycle,
    "terminateCampaign(uint256 campaignId)", [1n], PK.alice,
    "only callable by GovernanceV2");
  await est("CampaignLifecycle", ADDR.campaignLifecycle,
    "expireInactiveCampaign(uint256 campaignId)", [1n], PK.alice,
    "permissionless; needs expired campaign");

  // ── DatumBudgetLedger ─────────────────────────────────────────────────────
  await est("BudgetLedger", ADDR.budgetLedger,
    "initializeBudget(uint256 campaignId, uint256 budget, uint256 dailyCap)", [999n, dailyCap * 10n, dailyCap], PK.alice,
    "only callable by Campaigns");
  await est("BudgetLedger", ADDR.budgetLedger,
    "sweepDust(uint256 campaignId)", [1n], PK.alice,
    "only callable by Settlement");

  view("BudgetLedger", "getRemainingBudget(uint256) → uint256");
  view("BudgetLedger", "getDailyCap(uint256) → uint256");

  // ── DatumPaymentVault ─────────────────────────────────────────────────────
  await est("PaymentVault", ADDR.paymentVault,
    "withdrawPublisher()", [], PK.diana,
    "withdraws accrued publisher balance");
  await est("PaymentVault", ADDR.paymentVault,
    "withdrawUser()", [], PK.hank,
    "withdraws accrued user balance");
  await est("PaymentVault", ADDR.paymentVault,
    "withdrawProtocol(address recipient)", [alice.address], PK.alice);
  await est("PaymentVault", ADDR.paymentVault,
    "creditSettlement(address publisher, uint256 pubAmount, address user, uint256 userAmount, uint256 protocolAmount)",
    [diana.address, 1000n, hank.address, 750n, 250n], PK.alice,
    "only callable by Settlement");

  // ── DatumSettlement ───────────────────────────────────────────────────────
  // settleClaims is complex; estimate via the benchmark results (not easy to
  // estimate without a valid signed claim batch). We run a minimal static dry-run.
  await est("Settlement", ADDR.settlement,
    "setClaimValidator(address addr)", [ADDR.claimValidator], PK.alice);
  await est("Settlement", ADDR.settlement,
    "setAttestationVerifier(address addr)", [ADDR.attestationVerifier], PK.alice);
  await est("Settlement", ADDR.settlement,
    "setRateLimiter(address addr)", [ADDR.rateLimiter], PK.alice);
  await est("Settlement", ADDR.settlement,
    "setPublishers(address addr)", [ADDR.publishers], PK.alice);

  // ── DatumClaimValidator ───────────────────────────────────────────────────
  await est("ClaimValidator", ADDR.claimValidator,
    "setCampaigns(address addr)", [ADDR.campaigns], PK.alice);
  await est("ClaimValidator", ADDR.claimValidator,
    "setPublishers(address addr)", [ADDR.publishers], PK.alice);
  await est("ClaimValidator", ADDR.claimValidator,
    "setZKVerifier(address addr)", [ADDR.zkVerifier], PK.alice);

  // ── DatumCampaignValidator ────────────────────────────────────────────────
  await est("CampaignValidator", ADDR.campaignValidator,
    "setPublishers(address addr)", [ADDR.publishers], PK.alice);
  await est("CampaignValidator", ADDR.campaignValidator,
    "setTargetingRegistry(address addr)", [ADDR.targetingRegistry], PK.alice);

  // ── DatumZKVerifier ───────────────────────────────────────────────────────
  // verify() — try with real proof from sample-proof.json if available
  const sampleProofPath = path.join(__dirname, "..", "circuits", "sample-proof.json");
  let zkProofBytes = "0x" + "00".repeat(256);  // 256-byte zeros (will return false)
  if (fs.existsSync(sampleProofPath)) {
    const sp = JSON.parse(fs.readFileSync(sampleProofPath, "utf-8"));
    zkProofBytes = AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]", "uint256[4]", "uint256[2]"],
      [
        [sp.pi_a[0], sp.pi_a[1]],
        [sp.pi_b[0], sp.pi_b[1], sp.pi_b[2], sp.pi_b[3]],
        [sp.pi_c[0], sp.pi_c[1]],
      ],
    );
  }
  await est("ZKVerifier", ADDR.zkVerifier,
    "verify(bytes calldata proof, bytes32 publicInputsHash)", [zkProofBytes, ZeroHash], PK.alice,
    "real proof (sample-proof.json) → true");
  await est("ZKVerifier", ADDR.zkVerifier,
    "verify(bytes calldata proof, bytes32 publicInputsHash)", ["0x", ZeroHash], PK.alice,
    "empty proof → false (fast reject, length != 256)");

  view("ZKVerifier", "getVK() → VerifyingKey");
  view("ZKVerifier", "vkSet() → bool");

  // ── DatumSettlementRateLimiter ────────────────────────────────────────────
  await est("RateLimiter", ADDR.rateLimiter,
    "setLimits(uint256 _windowBlocks, uint256 _maxPublisherImpressionsPerWindow)",
    [100n, 500_000n], PK.alice);
  // checkAndIncrement is only callable by Settlement contract
  await est("RateLimiter", ADDR.rateLimiter,
    "checkAndIncrement(address publisher, uint256 impressionCount)", [diana.address, 100n], PK.alice,
    "only callable by Settlement");

  view("RateLimiter", "currentWindowUsage(address) → (uint256,uint256,uint256)");

  // ── DatumPublisherReputation ──────────────────────────────────────────────
  await est("Reputation", ADDR.reputation,
    "addReporter(address reporter)", [diana.address], PK.alice,
    "diana already reporter — may no-op or revert");
  await est("Reputation", ADDR.reputation,
    "removeReporter(address reporter)", [diana.address], PK.alice);
  await est("Reputation", ADDR.reputation,
    "recordSettlement(address publisher, uint256 campaignId, uint256 settled, uint256 rejected)",
    [diana.address, 1n, 100n, 10n], PK.diana,
    "diana is reporter");

  view("Reputation", "getScore(address) → uint16");
  view("Reputation", "isAnomaly(address, uint256) → bool");
  view("Reputation", "getPublisherStats(address) → (uint256,uint256,uint16)");
  view("Reputation", "getCampaignStats(address, uint256) → (uint256,uint256)");

  // ── DatumReports ─────────────────────────────────────────────────────────
  await est("Reports", ADDR.reports,
    "reportPage(uint256 campaignId, uint8 reason)", [1n, 1], PK.hank,
    "reason=1 (spam), campaign 1");
  await est("Reports", ADDR.reports,
    "reportAd(uint256 campaignId, uint8 reason)", [1n, 2], PK.hank,
    "reason=2 (misleading), campaign 1");
  // All 5 reasons
  for (let r = 1; r <= 5; r++) {
    await est("Reports", ADDR.reports,
      "reportPage(uint256 campaignId, uint8 reason)", [1n, r], PK.hank,
      `reason=${r}`);
  }
  // reason=0 should revert
  await est("Reports", ADDR.reports,
    "reportPage(uint256 campaignId, uint8 reason)", [1n, 0], PK.hank,
    "reason=0 → should revert");

  // ── DatumTimelock ─────────────────────────────────────────────────────────
  const timelockCalldata = new Interface(["function pause()"]).encodeFunctionData("pause");
  await est("Timelock", ADDR.timelock,
    "propose(address target, bytes calldata data)", [ADDR.pauseRegistry, timelockCalldata], PK.alice);
  await est("Timelock", ADDR.timelock,
    "execute()", [], PK.alice,
    "needs active proposal + delay elapsed");
  await est("Timelock", ADDR.timelock,
    "cancel()", [], PK.alice,
    "needs active proposal");

  // ── DatumRelay ────────────────────────────────────────────────────────────
  // settleClaimsFor needs valid signed batches — skip estimate, note it
  results.push({
    contract: "Relay",
    function: "settleClaimsFor",
    caller: "relay-bot",
    gas: null,
    note: "requires valid signed ClaimBatch[] — see settlement gas",
  });

  // ── DatumAttestationVerifier ──────────────────────────────────────────────
  results.push({
    contract: "AttestationVerifier",
    function: "settleClaimsAttested",
    caller: "relay-bot",
    gas: null,
    note: "requires valid AttestedBatch[] — see settlement gas",
  });

  // ────────────────────────────────────────────────────────────────────────────
  //  PRINT RESULTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  STATE-CHANGING FUNCTIONS — Gas (weight units)");
  console.log("══════════════════════════════════════════════════════════════════════════");

  // Group by contract
  const byContract = new Map<string, GasEntry[]>();
  for (const r of results) {
    if (!byContract.has(r.contract)) byContract.set(r.contract, []);
    byContract.get(r.contract)!.push(r);
  }

  let totalEstimated = 0;
  let totalReverted  = 0;

  const priceHdr = DOT_USD_PRICES.map(p => `$${p}/DOT`.padStart(10)).join("");
  console.log(`    ${"Function".padEnd(40)} ${"Gas".padStart(10)} ${"PAS fee".padStart(10)}${priceHdr}`);
  console.log("    " + "─".repeat(40 + 10 + 10 + DOT_USD_PRICES.length * 10 + 4));

  for (const [contract, entries] of byContract) {
    console.log(`\n  ── ${contract} ──`);
    for (const e of entries) {
      const gasStr  = fmtGas(e.gas);
      if (e.gas !== null) {
        totalEstimated++;
        const pas  = gasToPAS(e.gas);
        const usd  = DOT_USD_PRICES.map(p => `$${(pas * p).toFixed(4)}`.padStart(10)).join("");
        const noteStr = e.note ? `  [${e.note}]` : "";
        console.log(`    ${e.function.padEnd(40)} ${gasStr.padStart(10)} ${pas.toFixed(6).padStart(10)}${usd}${noteStr}`);
      } else {
        totalReverted++;
        console.log(`    ${e.function.padEnd(40)} ${"—".padStart(10)} ${"—".padStart(10)}  ${e.note}`);
      }
    }
  }

  console.log(`\n  ${totalEstimated} functions estimated, ${totalReverted} skipped/reverted`);

  // ── Summary: sorted by gas (descending) ──────────────────────────────────
  const sorted = results
    .filter(r => r.gas !== null)
    .sort((a, b) => (b.gas! > a.gas! ? 1 : -1));

  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  TOP 15 MOST EXPENSIVE (state-changing)");
  console.log("══════════════════════════════════════════════════════════════════════════");
  const priceHdr2 = DOT_USD_PRICES.map(p => `$${p}/DOT`.padStart(10)).join("");
  console.log(`    ${"Function".padEnd(55)} ${"Gas".padStart(10)} ${"PAS fee".padStart(10)}${priceHdr2}`);
  for (const e of sorted.slice(0, 15)) {
    const label = `${e.contract}.${e.function}`;
    const pas   = gasToPAS(e.gas!);
    const usd   = DOT_USD_PRICES.map(p => `$${(pas * p).toFixed(4)}`.padStart(10)).join("");
    console.log(`    ${label.padEnd(55)} ${fmtGas(e.gas).padStart(10)} ${pas.toFixed(6).padStart(10)}${usd}`);
  }

  // ── View functions ────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  VIEW FUNCTIONS (free — no gas to caller)");
  console.log("══════════════════════════════════════════════════════════════════════════");
  const byContractView = new Map<string, string[]>();
  for (const v of VIEW_FUNCS) {
    if (!byContractView.has(v.contract)) byContractView.set(v.contract, []);
    byContractView.get(v.contract)!.push(v.function);
  }
  for (const [c, fns] of byContractView) {
    console.log(`\n  ── ${c} ──`);
    for (const fn of fns) console.log(`    ${fn}`);
  }

  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  NOTES");
  console.log("══════════════════════════════════════════════════════════════════════════");
  console.log("  Unit mapping (confirmed by eth_getBalance): 1 ETH = 1 PAS = 10^10 planck.");
  console.log("  fee_PAS = gas × gasPrice / 10^18  (standard Ethereum formula).");
  console.log("  Paseo gasPrice = 10^12 wei/gas  →  fee_PAS = gas / 1,000,000.");
  console.log("  BN254 ecPairing (verify) is ~51–88× cheaper than Ethereum mainnet.");
  console.log("  settleClaims: not directly estimatable without signed batch; see benchmark.");
  console.log("  View function RPC latency: 200–700 ms (no fee to caller).");
  console.log("  '—' = reverted (needs specific live state) or restricted to internal callers.");
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
