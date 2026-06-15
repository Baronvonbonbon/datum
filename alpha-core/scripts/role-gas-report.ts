// role-gas-report.ts
//
// Deploys the alpha-5 contract surface in-process and measures gas for the
// state-changing operations each role performs. Emits a markdown + CSV
// report with per-op cost, low/medium/high usage projections, and monthly
// + yearly DOT totals at three reference gas prices.
//
// Run modes
// ---------
//   npx hardhat run scripts/role-gas-report.ts
//     → Default: Hardhat in-process EVM (chainId 31337). Fast, deterministic.
//
//   npx hardhat run scripts/role-gas-report.ts --network polkadotTestnet
//     → Paseo testnet via eth-rpc. Real gas, real tx hashes (Blockscout-
//       linkable). Slower; requires funded signer keys in alpha-core/.env.
//       The mine/fund helpers auto-detect substrate (chainId 420420420)
//       and route accordingly.
//
// Outputs (both modes)
// --------------------
//   docs/gas-by-role.md   — human-readable report with per-test breakout,
//                           cost projections, skipped-test table, coverage
//                           matrix.
//   docs/gas-by-role.csv  — flat one-row-per-measurement table for
//                           spreadsheet pivots. Columns: role, op,
//                           gas, txHash, blockNumber, note.
//
// Design notes
// ------------
// - Every measurement is wrapped in try/catch. Failures are reported as
//   SKIPPED rows so the report degrades gracefully when ops depend on
//   external setup (real ZK proofs, MPC ceremony, on-chain DATUM token,
//   live People Chain). SKIPPED rows preserve the skip reason and are
//   surfaced in a dedicated section of the report.
// - Tier model: each role has a baseline frequency profile (medium).
//   Low = baseline × 0.25, High = baseline × 4. Single multiplier keeps
//   tables comparable across roles.
// - Coverage matrix lists every alpha-5 contract and marks each measured
//   / unmeasured / skipped, so it's obvious what the report does and
//   doesn't claim to cover.

import { ethers } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import { fundSigners, mineBlocks } from "../test/helpers/mine";
import { wireSettlementLogic } from "../test/helpers/settlementLogic";
import { mkProof, contentHashClaims } from "../test/helpers/slimClaim";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Cost-projection knobs
// ─────────────────────────────────────────────────────────────────────────────

/** Gas-price scenarios (gwei). 1 gwei = 1e9 wei = 1e-9 ETH/PAS.
 *  NOTE: live Paseo eth_gasPrice is 1000 gwei (1e12 wei/gas) — verified against
 *  real receipts' effectiveGasPrice (see docs/gas-economics.md). The old 1-gwei
 *  "Paseo" row was wrong by 1000×. Real per-op PAS cost + break-even analysis
 *  lives in docs/gas-economics.md (uses live-tx pallet-revive gas, which runs
 *  ~6× below the hardhat EVM gas measured here). */
const GAS_PRICE_SCENARIOS: Array<{ label: string; gwei: number; note: string }> = [
  { label: "Paseo (live)",                gwei: 1000, note: "Real Paseo eth_gasPrice = 1e12 wei/gas (verified on-chain)" },
  { label: "Polkadot Hub (conservative)", gwei: 5,    note: "Plausible mainnet steady state" },
  { label: "Polkadot Hub (busy)",         gwei: 50,   note: "High-load worst case" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Tier model: each role has one BASELINE (= medium) per-op daily frequency.
// Low = baseline × 0.25, High = baseline × 4. The L/M/H multipliers are
// applied uniformly across every op for the role; per-op rationales describe
// what the medium baseline represents.
// ─────────────────────────────────────────────────────────────────────────────

const TIER_MULTIPLIERS = { Low: 0.25, Medium: 1, High: 4 } as const;
type TierName = keyof typeof TIER_MULTIPLIERS;
const TIER_ORDER: readonly TierName[] = ["Low", "Medium", "High"] as const;

interface OpBaseline {
  /// Role-scoped operation label (must match a row's `op` exactly).
  op: string;
  /// Medium-tier daily frequency for the role.
  daily: number;
  /// What the medium baseline represents in plain language.
  rationale: string;
}

interface RoleBaseline {
  role: string;
  /// One-sentence persona for the role at the medium tier.
  description: string;
  ops: OpBaseline[];
}

const ROLE_BASELINES: RoleBaseline[] = [
  {
    role: "User",
    description: "An end-user with the extension installed. Medium = 1 onboarding/yr, monthly report + withdraw.",
    ops: [
      { op: "zkStake.depositWith",         daily: 1/365, rationale: "Onboarding once per year" },
      { op: "zkStake.requestWithdrawal",   daily: 1/365, rationale: "Rare unstake" },
      { op: "reportPage (reason 1)",       daily: 1/30,  rationale: "~1 report per active user per month" },
      { op: "vault.withdrawUser",          daily: 1/30,  rationale: "Monthly micropayment claim" },
      { op: "settlement.setUserMinAssurance", daily: 1/365, rationale: "Set once on signup" },
    ],
  },
  {
    role: "Publisher",
    description: "A site operator running the SDK. Medium = monthly stake top-up + profile, weekly withdraw.",
    ops: [
      { op: "registerPublisher",       daily: 1/365, rationale: "Once per publisher per year" },
      { op: "setRelaySigner",          daily: 1/30,  rationale: "Monthly key rotation" },
      { op: "setProfile",              daily: 1/30,  rationale: "Monthly profile refresh" },
      { op: "publisherStake.stake",    daily: 1/30,  rationale: "Monthly stake top-up" },
      { op: "vault.withdrawPublisher", daily: 1/7,   rationale: "Weekly earnings withdraw" },
    ],
  },
  {
    role: "Advertiser",
    description: "A campaign creator. Medium = 1 campaign/wk + self-vote.",
    ops: [
      { op: "createCampaign",                daily: 1/7, rationale: "1 campaign per advertiser per week" },
      { op: "vote (own campaign, aye)",      daily: 1/7, rationale: "1 self-vote per campaign created" },
      { op: "challengeBonds.openBond",       daily: 1/7, rationale: "1 bond per new campaign" },
    ],
  },
  {
    role: "Relay",
    description: "A relay operator submitting batches. Medium = 1 batch/hour at 5 claims/batch (typical commercial relay).",
    ops: [
      { op: "settleClaims (5 claims × 100 imps)", daily: 24, rationale: "Hourly settlement at typical batch size" },
    ],
  },
  {
    role: "Voter",
    description: "Conviction-weighted governance voter. Medium = 1 vote/week, occasional nay.",
    ops: [
      { op: "governance.vote (aye)", daily: 1/7,  rationale: "1 aye vote per week" },
      { op: "governance.vote (nay)", daily: 1/30, rationale: "Nays rarer than ayes" },
      { op: "governance.evaluateCampaign", daily: 1/7, rationale: "Public-service activation call after quorum" },
    ],
  },
  {
    role: "Reporter V1",
    description: "StakeRoot V1 owner-managed reporter. Medium = hourly epoch with 2-of-N cosig.",
    ops: [
      { op: "stakeRoot.commitStakeRoot (threshold 1)", daily: 24, rationale: "Hourly epoch (testnet 1-of-1)" },
      { op: "commitStakeRoot (first signer, 2-of-N)",  daily: 24, rationale: "Each reporter posts every epoch" },
      { op: "commitStakeRoot (cosigner finalises)",    daily: 24, rationale: "Each reporter cosigns every epoch" },
    ],
  },
  {
    role: "Reporter V2",
    description: "StakeRoot V2 permissionless bonded reporter. Medium = hourly propose / approve / finalize cycle.",
    ops: [
      { op: "stakeRootV2.joinReporters", daily: 1/365, rationale: "One-time onboarding" },
      { op: "stakeRootV2.proposeRoot",   daily: 24,    rationale: "1 propose per epoch" },
      { op: "stakeRootV2.approveRoot",   daily: 24,    rationale: "Approve every epoch" },
      { op: "stakeRootV2.finalizeRoot",  daily: 24,    rationale: "Finalize once per epoch (anyone)" },
    ],
  },
  {
    role: "Council",
    description: "Phase-1 N-of-M council member. Medium = 1 proposal/month, bi-weekly votes.",
    ops: [
      { op: "council.propose", daily: 1/30, rationale: "1 proposal per member per month" },
      { op: "council.vote",    daily: 1/14, rationale: "Bi-weekly votes" },
      { op: "council.execute", daily: 1/30, rationale: "1 execution per month" },
    ],
  },
  {
    role: "Curator",
    description: "Blocklist curator (council-delegated). Medium = weekly block, monthly unblock.",
    ops: [
      { op: "curator.blockAddr",   daily: 1/7,  rationale: "1 blocklist update per week" },
      { op: "curator.unblockAddr", daily: 1/30, rationale: "Unblocks rarer than blocks" },
    ],
  },
  {
    role: "Challenger",
    description: "StakeRoot V2 fraud challenger. Medium = monthly registration, rare phantom-leaf challenge.",
    ops: [
      { op: "stakeRootV2.registerCommitment",    daily: 1/30, rationale: "User-driven; modest steady state" },
      { op: "stakeRootV2.challengePhantomLeaf",  daily: 1/90, rationale: "Rare; only on fraudulent root" },
    ],
  },
  {
    role: "Admin",
    description: "Owner / guardian for incident response. Medium = ~2 pauses per year.",
    ops: [
      { op: "pauseRegistry.pause (owner)",          daily: 1/180, rationale: "Twice per year (incident response)" },
      { op: "pauseRegistry.proposeCategoryUnpause", daily: 1/180, rationale: "Once per pause incident" },
      { op: "pauseRegistry.approve (unpause)",      daily: 1/180, rationale: "Co-signer on each unpause" },
    ],
  },
  {
    role: "TokenHolder",
    description: "DATUM token participant. Medium = monthly wrap + occasional stake, weekly fee-share claim.",
    ops: [
      { op: "wrapper.requestWrap",   daily: 1/30,  rationale: "Monthly intent to wrap DATUM → WDATUM" },
      { op: "wrapper.wrap",          daily: 1/30,  rationale: "Monthly wrap completion" },
      { op: "wrapper.unwrap",        daily: 1/90,  rationale: "Quarterly unwrap back to canonical DATUM" },
      { op: "feeShare.stake",        daily: 1/90,  rationale: "Quarterly stake top-up" },
      { op: "feeShare.claim",        daily: 1/7,   rationale: "Weekly fee-share claim" },
      { op: "feeShare.unstake",      daily: 1/180, rationale: "Rare unstake (twice/yr)" },
    ],
  },
  {
    role: "Vesting",
    description: "Founder / team vesting beneficiary. Medium = monthly release().",
    ops: [
      { op: "vesting.release", daily: 1/30, rationale: "Monthly release of vested DATUM" },
    ],
  },
  {
    role: "Bootstrap",
    description: "House-ad / onboarding pool claimer (settlement-side caller).",
    ops: [
      { op: "bootstrap.claim", daily: 1/30, rationale: "One bootstrap claim per new user per month" },
    ],
  },
  {
    role: "EmissionOperator",
    description: "Permissionless caller maintaining the EmissionEngine. Medium = daily rate adjust + per-epoch roll.",
    ops: [
      { op: "emissionEngine.adjustRate", daily: 1,        rationale: "Daily rate adjustment (governance-tunable [1, 90] days)" },
      { op: "emissionEngine.rollEpoch",  daily: 1/2555,   rationale: "Once per epoch (7 calendar years = 2,555 days)" },
    ],
  },
  {
    role: "Settlement-CPC",
    description: "CPC settle path: a single click-based claim per settle. Same hourly cadence as the CPM relay.",
    ops: [
      { op: "settleClaims (1 CPC click)",  daily: 24, rationale: "Hourly settlement of click-based pots" },
    ],
  },
  {
    role: "Settlement-CPA",
    description: "CPA settle path: a single action-signed claim per settle. Generally lower cadence than CPC.",
    ops: [
      { op: "settleClaims (1 CPA action)", daily: 6, rationale: "~Every 4 hours; CPA flows are higher-value, lower-volume" },
    ],
  },
];

// Flat list of (role, op, daily) tuples for projection tables. Built from
// ROLE_BASELINES so the rationale stays attached to one place.
interface FrequencyAssumption { role: string; op: string; daily: number; rationale: string }
const FREQUENCY_ASSUMPTIONS: FrequencyAssumption[] = ROLE_BASELINES.flatMap((r) =>
  r.ops.map((o) => ({ role: r.role, op: o.op, daily: o.daily, rationale: o.rationale })),
);

// ─────────────────────────────────────────────────────────────────────────────
// Number formatting helpers — replace scientific notation with decimal form.
// ─────────────────────────────────────────────────────────────────────────────

/** Format a number as a decimal string with adaptive precision.
 *  Very small numbers get more decimals; round numbers don't get trailing zeros.
 *  Negatives are preserved. NaN/Infinity falls through to native toString. */
function fmt(n: number): string {
  if (!isFinite(n) || isNaN(n)) return String(n);
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1000)     return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1)        return n.toFixed(2).replace(/\.?0+$/, "");
  if (abs >= 0.01)     return n.toFixed(4).replace(/\.?0+$/, "");
  if (abs >= 0.0001)   return n.toFixed(6).replace(/\.?0+$/, "");
  if (abs >= 0.000001) return n.toFixed(8).replace(/\.?0+$/, "");
  // Below 1e-6: keep meaningful digits but stay decimal
  return n.toFixed(12).replace(/\.?0+$/, "");
}

/** Format DOT amounts with a "DOT" suffix for clarity in narratives. */
function fmtDOT(n: number): string { return `${fmt(n)} DOT`; }

/** Format USD amounts with $ prefix and currency-style rounding. */
function fmtUSD(n: number): string {
  if (!isFinite(n) || isNaN(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1)       return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (abs >= 0.01)    return `$${n.toFixed(4).replace(/\.?0+$/, "")}`;
  if (abs >= 0.0001)  return `$${n.toFixed(6).replace(/\.?0+$/, "")}`;
  return `$${n.toFixed(8).replace(/\.?0+$/, "")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurement infrastructure
// ─────────────────────────────────────────────────────────────────────────────

/// A single measured operation. `gas === 0n` ↔ the call reverted or
/// was deliberately skipped; the reason lives in `note`. Successful
/// measurements carry the resulting tx hash and finalized block number
/// so each row can be cross-checked against a block explorer (live
/// Paseo runs) or the in-process Hardhat receipt log.
interface Row {
  role: string;
  op: string;
  gas: bigint;
  txHash?: string;
  blockNumber?: number;
  /// Free-form note. For skipped rows, format is `SKIPPED: <reason>`.
  note?: string;
}

const rows: Row[] = [];

async function measure(role: string, op: string, txPromise: Promise<any>, note?: string) {
  try {
    const tx = await txPromise;
    const r = await tx.wait();
    const gas = r.gasUsed as bigint;
    rows.push({
      role,
      op,
      gas,
      txHash: tx.hash ?? r.hash,
      blockNumber: Number(r.blockNumber ?? 0),
      note,
    });
    const short = tx.hash ? `${tx.hash.slice(0, 10)}…` : "—";
    console.log(`  ${role.padEnd(14)} ${op.padEnd(40)} ${gas.toString().padStart(8)}  blk=${r.blockNumber}  tx=${short}`);
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
    rows.push({ role, op, gas: 0n, note: `SKIPPED: ${msg}` });
    console.warn(`  ${role.padEnd(14)} ${op.padEnd(40)} SKIPPED: ${msg}`);
  }
}

/// Explicitly mark an operation skipped without running it. Use when the
/// dependency makes the test pointless to even attempt (e.g. requires a
/// constructed Merkle proof, a real ZK ceremony, an off-chain oracle).
function markSkipped(role: string, op: string, reason: string) {
  rows.push({ role, op, gas: 0n, note: `SKIPPED: ${reason}` });
  console.warn(`  ${role.padEnd(14)} ${op.padEnd(40)} SKIPPED: ${reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deploy
// ─────────────────────────────────────────────────────────────────────────────

const QUORUM        = parseDOT("0.5");
const SLASH_BPS     = 500n;
const TERM_QUORUM   = parseDOT("0.5");
const BASE_GRACE    = 5n;
const GRACE_PER_Q   = 10n;
const MAX_GRACE     = 30n;
const TAKE_RATE_BPS = 5000;
const TAKE_RATE_DELAY = 20n;
const PENDING_TIMEOUT = 50n;
const INACTIVITY_TIMEOUT = 432000n;

export async function deployAll() {
  await fundSigners(20);
  const [owner, advertiser, publisher, publisher2, user, voter, relay, councilA, councilB, councilC, councilGuardian, reporter2, curator, challenger] = await ethers.getSigners();

  const F = (name: string) => ethers.getContractFactory(name);

  // Infra
  const pauseReg = await (await F("DatumPauseRegistry")).deploy(owner.address, advertiser.address, publisher.address);
  const timelock = await (await F("DatumTimelock")).deploy();
  const zkVerifier = await (await F("MockZKVerifier")).deploy();
  const publishers = await (await F("DatumPublishers")).deploy(TAKE_RATE_DELAY, await pauseReg.getAddress());
  const ledger = await (await F("DatumBudgetLedger")).deploy();
  const vault = await (await F("DatumPaymentVault")).deploy();
  const campaigns = await (await F("DatumCampaigns")).deploy(
    0n, PENDING_TIMEOUT, await publishers.getAddress(), await pauseReg.getAddress()
  );
  const lifecycle = await (await F("DatumCampaignLifecycle")).deploy(await pauseReg.getAddress(), INACTIVITY_TIMEOUT);
  const claimVal = await (await F("DatumClaimValidator")).deploy(
    await campaigns.getAddress(), await publishers.getAddress(), await pauseReg.getAddress()
  );
  const settlement = await (await F("DatumSettlement")).deploy(await pauseReg.getAddress());
  // Alpha-5: Settlement is split into two Logic delegates (EIP-170 carve-out).
  // setLogic(logicA, logicB) MUST be wired or settleClaims reverts E00.
  await wireSettlementLogic({ setLogic: (a: string, b: string) => settlement.setLogic(a, b) });
  const governance = await (await F("DatumGovernanceV2")).deploy(
    await campaigns.getAddress(), QUORUM, SLASH_BPS, TERM_QUORUM, BASE_GRACE, GRACE_PER_Q, MAX_GRACE, await pauseReg.getAddress()
  );
  const datumRelay = await (await F("DatumRelay")).deploy(
    await settlement.getAddress(), await campaigns.getAddress(), await pauseReg.getAddress()
  );
  const attestVerifier = await (await F("DatumAttestationVerifier")).deploy(
    await settlement.getAddress(), await campaigns.getAddress(), await pauseReg.getAddress()
  );
  const tokenRewardVault = await (await F("DatumTokenRewardVault")).deploy(await campaigns.getAddress());

  // DatumReports carved out of Campaigns (alpha-4 EIP-170).
  const reports = await (await F("DatumReports")).deploy();
  await (await reports.setCampaigns(await campaigns.getAddress())).wait();
  await (await reports.setSettlement(await settlement.getAddress())).wait();

  // FP contracts
  const publisherStake = await (await F("DatumPublisherStake")).deploy(parseDOT("1"), parseDOT("0.0001"), 14400n);
  const challengeBonds = await (await F("DatumChallengeBonds")).deploy();
  const publisherGov = await (await F("DatumPublisherGovernance")).deploy(
    await publisherStake.getAddress(),
    await challengeBonds.getAddress(),
    await pauseReg.getAddress(),
    parseDOT("0.5"), 5000n, 2000n, 14400n, parseDOT("1")
  );

  // Governance ladder
  const paramGov = await (await F("DatumParameterGovernance")).deploy(
    await pauseReg.getAddress(), 100n, 200n, parseDOT("0.5"), parseDOT("1")
  );
  const router = await (await F("DatumGovernanceRouter")).deploy(
    await campaigns.getAddress(), await lifecycle.getAddress(), owner.address
  );
  const council = await (await F("DatumCouncil")).deploy(
    [councilA.address, councilB.address, councilC.address],
    2n,
    councilGuardian.address,
    100n,  // votingPeriodBlocks
    10n,   // executionDelayBlocks (>= MIN_EXECUTION_DELAY=1)
    5n,    // vetoWindowBlocks
    1000n  // maxExecutionWindowBlocks
  );

  // Click / curator / activation
  const clickReg = await (await F("DatumClickRegistry")).deploy();
  const curatorContract = await (await F("DatumCouncilBlocklistCurator")).deploy();
  const activationBonds = await (await F("DatumActivationBonds")).deploy(
    parseDOT("1"), 100n, 5000n, 1000n, owner.address
  );

  // Stake roots
  const stakeRootV1 = await (await F("DatumStakeRoot")).deploy();
  const stakeRootV2 = await (await F("DatumStakeRootV2")).deploy(
    owner.address,
    parseDOT("1"),
    100n, 5100, 20n,
    parseDOT("0.1"), parseDOT("0.05"),
    8000, 1000,
    parseDOT("0.01"),
    ethers.ZeroAddress,
  );
  const identityVer = await (await F("MockIdentityVerifier")).deploy();

  // ZKStake + token
  const mockToken = await (await F("MockERC20")).deploy("Datum", "DTM");
  const zkStake = await (await F("DatumZKStake")).deploy(await mockToken.getAddress());

  // ── wiring ──
  await (await governance.setLifecycle(await lifecycle.getAddress())).wait();
  await (await campaigns.setGovernanceContract(await governance.getAddress())).wait();
  await (await campaigns.setSettlementContract(await settlement.getAddress())).wait();
  await (await campaigns.setLifecycleContract(await lifecycle.getAddress())).wait();
  await (await campaigns.setBudgetLedger(await ledger.getAddress())).wait();

  await (await ledger.setCampaigns(await campaigns.getAddress())).wait();
  await (await ledger.setSettlement(await settlement.getAddress())).wait();
  await (await ledger.setLifecycle(await lifecycle.getAddress())).wait();

  await (await vault.setSettlement(await settlement.getAddress())).wait();

  await (await settlement.configure(
    await ledger.getAddress(),
    await vault.getAddress(),
    await lifecycle.getAddress(),
    await datumRelay.getAddress(),
  )).wait();
  await (await settlement.setClaimValidator(await claimVal.getAddress())).wait();
  await (await settlement.setAttestationVerifier(await attestVerifier.getAddress())).wait();
  await (await settlement.setTokenRewardVault(await tokenRewardVault.getAddress())).wait();
  await (await settlement.setCampaigns(await campaigns.getAddress())).wait();
  // Alpha-5: rate-limiter is a separate contract. Deploy + wire if available;
  // otherwise leave Settlement without an explicit limiter (== unlimited),
  // which is fine for benchmarking the happy path.
  try {
    const rateLimiter = await (await F("DatumSettlementRateLimiter")).deploy(
      await settlement.getAddress(), 200n, 50000n,
    );
    await (await settlement.setRateLimiter(await rateLimiter.getAddress())).wait();
  } catch {
    // RateLimiter constructor signature drift or not deployed — skip.
  }
  await (await tokenRewardVault.setSettlement(await settlement.getAddress())).wait();

  // DualSig: gasless dual-sig settlement path (settleSignedClaims → processVerifiedBatch).
  const dualSig = await (await F("DatumDualSigSettlement")).deploy();
  await (await dualSig.setSettlement(await settlement.getAddress())).wait();
  await (await dualSig.setPauseRegistry(await pauseReg.getAddress())).wait();
  await (await dualSig.setPublishers(await publishers.getAddress())).wait();
  await (await dualSig.setCampaigns(await campaigns.getAddress())).wait();
  await (await settlement.setDualSig(await dualSig.getAddress())).wait();

  await (await claimVal.setZKVerifier(await zkVerifier.getAddress())).wait();

  await (await lifecycle.setCampaigns(await campaigns.getAddress())).wait();
  await (await lifecycle.setBudgetLedger(await ledger.getAddress())).wait();
  await (await lifecycle.setGovernanceContract(await governance.getAddress())).wait();
  await (await lifecycle.setSettlementContract(await settlement.getAddress())).wait();

  // bootstrap
  await (await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS)).wait();
  await (await publishers.connect(publisher2).registerPublisher(TAKE_RATE_BPS)).wait();

  // ── Token plane (DATUM ERC-20 surface) ───────────────────────────────────
  // Devnet stand-in for the Asset Hub precompile + the five token-plane
  // contracts. Mirrors scripts/deploy-token.ts in shape; condensed here to
  // keep the benchmark self-contained.
  const ASSET_ID = 31337n;
  let tokenPlane: any = {};
  try {
    const precompile = await (await F("AssetHubPrecompileMock")).deploy();
    const authority  = await (await F("DatumMintAuthority")).deploy(await precompile.getAddress(), ASSET_ID);
    await (await precompile.registerAsset(ASSET_ID, await authority.getAddress(), "DATUM", "DATUM", 10)).wait();
    const wrapper    = await (await F("DatumWrapper")).deploy(
      await authority.getAddress(), await precompile.getAddress(), ASSET_ID, true,
    );
    await (await authority.setWrapper(await wrapper.getAddress())).wait();
    const latestBlk  = await ethers.provider.getBlock("latest");
    const startTime  = BigInt(latestBlk!.timestamp);
    const vesting    = await (await F("DatumVesting")).deploy(owner.address, await authority.getAddress(), startTime);
    await (await authority.setVesting(await vesting.getAddress())).wait();
    // BootstrapPool needs a settlement caller; we pass owner as a stand-in
    // so we can directly invoke claim() in the measurement.
    const bootstrap  = await (await F("DatumBootstrapPool")).deploy(owner.address, await authority.getAddress());
    await (await authority.setBootstrapPool(await bootstrap.getAddress())).wait();
    // FeeShare stakes the wrapper token; needs vault wiring for DOT fees.
    const feeShare   = await (await F("DatumFeeShare")).deploy(await wrapper.getAddress());
    try {
      await (await feeShare.setPaymentVault(await vault.getAddress())).wait();
    } catch { /* setter may not exist on this build */ }
    // EmissionEngine + MintCoordinator (per-batch emission orchestrator).
    let emissionEngine: any = null;
    let mintCoordinator: any = null;
    try {
      emissionEngine  = await (await F("DatumEmissionEngine")).deploy();
      mintCoordinator = await (await F("DatumMintCoordinator")).deploy();
      // Wire coordinator → settlement + authority + engine (owner-only).
      try { await (await mintCoordinator.setSettlement(await settlement.getAddress())).wait(); } catch {}
      try { await (await mintCoordinator.setMintAuthority(await authority.getAddress())).wait(); } catch {}
      try { await (await mintCoordinator.setEmissionEngine(await emissionEngine.getAddress())).wait(); } catch {}
    } catch { /* engine/coordinator constructor drift; leave null */ }

    tokenPlane = { precompile, authority, wrapper, vesting, bootstrap, feeShare, emissionEngine, mintCoordinator };
  } catch (e: any) {
    console.warn(`[token plane] deploy failed: ${(e?.shortMessage ?? e?.message ?? String(e)).slice(0, 200)}`);
  }

  return {
    owner, advertiser, publisher, publisher2, user, voter, relay,
    councilA, councilB, councilC, councilGuardian,
    reporter2, curator, challenger,
    pauseReg, timelock, publishers, ledger, vault, campaigns, lifecycle,
    claimVal, settlement, dualSig, governance, datumRelay, attestVerifier, tokenRewardVault,
    publisherStake, challengeBonds, publisherGov, paramGov, router, council,
    clickReg, curatorContract, activationBonds, stakeRootV1, stakeRootV2,
    identityVer, mockToken, zkStake,
    reports,
    ...tokenPlane,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim helpers
// ─────────────────────────────────────────────────────────────────────────────

function ZERO_PROOF(): string[]  { return new Array(8).fill(ethers.ZeroHash); }
function ZERO_ACTION(): string[] { return new Array(3).fill(ethers.ZeroHash); }

function computeClaimHash(c: any): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256","address","address","uint256","uint256","uint8","bytes32","uint256","bytes32","bytes32"],
    [c.campaignId, c.publisher, c.user, c.eventCount, c.rateWei, c.actionType, c.clickSessionHash, c.nonce, c.previousClaimHash, c.stakeRootUsed],
  ));
}

export function buildClaim(args: {
  cid: bigint;
  publisher: string;
  user: string;
  rate: bigint;
  events: bigint;
  nonce: bigint;
  prev: string;
  /// Defaults to 0 (CPM view). Pass 1 for CPC, 2 for CPA.
  actionType?: 0 | 1 | 2;
  /// Required when actionType=1; computed via _sessionHash(user, cid, nonce).
  clickSessionHash?: string;
}) {
  const actionType = args.actionType ?? 0;
  const clickSessionHash = args.clickSessionHash ?? ethers.ZeroHash;
  const c: any = {
    // ── SLIM (#2b) on-chain wire fields: { publisher, eventCount, rateWei, actionType, proof[] } ──
    publisher: args.publisher,
    eventCount: args.events,
    rateWei: args.rate,
    actionType,
    // Plain CPM view claim → empty sidecar. CPC carries the click session hash.
    // CPA's actionSig is filled in by the caller after signing (see signCpaClaim).
    proof: actionType === 1 ? mkProof({ clickSessionHash }) : [],
    // ── JS-only bookkeeping (ignored by the ABI encoder; used for hashing/signing) ──
    campaignId: args.cid,
    user: args.user,
    clickSessionHash,
    nonce: args.nonce,
    previousClaimHash: args.prev,
    stakeRootUsed: ethers.ZeroHash,
    claimHash: ethers.ZeroHash,
  };
  c.claimHash = computeClaimHash(c);
  return c;
}

/// Sign a CPA claim's claimHash with the `actionVerifier` EOA. Produces
/// the [r, s, v-as-bytes32] tuple the ClaimValidator expects in
/// `actionSig`. Uses EIP-191 personal-sign because the validator
/// re-prepends "\x19Ethereum Signed Message:\n32" before ecrecover.
async function signCpaClaim(claim: any, signer: any): Promise<string[]> {
  const sig = await signer.signMessage(ethers.getBytes(claim.claimHash));
  // ethers v6 signature is 0x{r}{s}{v}. v is 0x1b or 0x1c (27 / 28).
  const r = "0x" + sig.slice(2, 66);
  const s = "0x" + sig.slice(66, 130);
  const v = parseInt(sig.slice(130, 132), 16);
  const vAsBytes32 = "0x" + v.toString(16).padStart(64, "0");
  return [r, s, vAsBytes32];
}

export function buildClaimChain(cid: bigint, pub: string, user: string, rate: bigint, count: number, events: bigint, startNonce: bigint = 1n) {
  const claims = [];
  let prev = ethers.ZeroHash;
  for (let i = 0; i < count; i++) {
    const c = buildClaim({ cid, publisher: pub, user, rate, events, nonce: startNonce + BigInt(i), prev });
    claims.push(c);
    prev = c.claimHash;
  }
  return claims;
}

interface PotSpec { actionType: 0 | 1 | 2; budget: bigint; dailyCap: bigint; rate: bigint; actionVerifier?: string }

export async function activateCampaignWithPots(ctx: any, pots: PotSpec[]): Promise<bigint> {
  const totalBudget = pots.reduce((s, p) => s + p.budget, 0n);
  const potArray = pots.map((p) => ({
    actionType: p.actionType,
    budgetWei: p.budget,
    dailyCapWei: p.dailyCap,
    rateWei: p.rate,
    actionVerifier: p.actionVerifier ?? ethers.ZeroAddress,
  }));
  const tx = await ctx.campaigns.connect(ctx.advertiser).createCampaign(
    ctx.publisher.address,
    potArray,
    [], false, ethers.ZeroAddress, 0n, 0n, { value: totalBudget },
  );
  await tx.wait();
  const cid = await ctx.campaigns.nextCampaignId() - 1n;
  await (await ctx.governance.connect(ctx.voter).vote(cid, true, 0, { value: QUORUM })).wait();
  await mineBlocks(MAX_GRACE + 1n);
  await (await ctx.governance.evaluateCampaign(cid)).wait();
  return cid;
}

export async function activateCampaign(ctx: any, budget: bigint, dailyCap: bigint, cpm: bigint): Promise<bigint> {
  const tx = await ctx.campaigns.connect(ctx.advertiser).createCampaign(
    ctx.publisher.address,
    [{ actionType: 0, budgetWei: budget, dailyCapWei: dailyCap, rateWei: cpm, actionVerifier: ethers.ZeroAddress }],
    [], false, ethers.ZeroAddress, 0n, 0n, { value: budget },
  );
  await tx.wait();
  const cid = await ctx.campaigns.nextCampaignId() - 1n;
  await (await ctx.governance.connect(ctx.voter).vote(cid, true, 0, { value: QUORUM })).wait();
  await mineBlocks(MAX_GRACE + 1n);
  await (await ctx.governance.evaluateCampaign(cid)).wait();
  return cid;
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurements
// ─────────────────────────────────────────────────────────────────────────────

async function measureAll(ctx: any) {
  const CPM = parseDOT("0.2");
  const BUDGET = parseDOT("20");
  const DAILY = parseDOT("4");

  // ─── Advertiser ──────────────────────────────────────────────────────────
  console.log("\n[Advertiser]");
  await measure("Advertiser", "createCampaign", ctx.campaigns.connect(ctx.advertiser).createCampaign(
    ctx.publisher.address,
    [{ actionType: 0, budgetWei: BUDGET, dailyCapWei: DAILY, rateWei: CPM, actionVerifier: ethers.ZeroAddress }],
    [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET },
  ));
  const advCid = await ctx.campaigns.nextCampaignId() - 1n;
  await measure("Advertiser", "vote (own campaign, aye)",
    ctx.governance.connect(ctx.advertiser).vote(advCid, true, 0, { value: QUORUM }));
  // Advertiser activation bond — refundable; locked at creation, returned
  // on clean end. Alpha-5 entry point is lockBond(campaignId, advertiser,
  // publisher). Wire the campaigns contract reference so the bond
  // contract recognises us, then measure.
  try {
    await (await ctx.challengeBonds.setCampaignsContract(await ctx.campaigns.getAddress())).wait();
    // lockBond requires msg.sender == campaigns (in production). For the
    // benchmark we exercise from the advertiser directly via a fresh
    // campaignId not yet used, accepting a likely SKIPPED if the caller
    // gate is strict on this build.
    await measure("Advertiser", "challengeBonds.openBond",
      ctx.challengeBonds.connect(ctx.advertiser).lockBond(advCid + 100n, ctx.advertiser.address, ctx.publisher.address, { value: parseDOT("1") }));
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
    markSkipped("Advertiser", "challengeBonds.openBond", msg);
  }

  // ─── Publisher ───────────────────────────────────────────────────────────
  console.log("\n[Publisher]");
  const fresh = (await ethers.getSigners())[14]; // unregistered signer
  await measure("Publisher", "registerPublisher",
    ctx.publishers.connect(fresh).registerPublisher(TAKE_RATE_BPS));
  await measure("Publisher", "setRelaySigner",
    ctx.publishers.connect(ctx.publisher).setRelaySigner(ctx.relay.address));
  await measure("Publisher", "setProfile",
    ctx.publishers.connect(ctx.publisher).setProfile(ethers.keccak256(ethers.toUtf8Bytes("profile-v1"))));
  await measure("Publisher", "publisherStake.stake",
    ctx.publisherStake.connect(ctx.publisher).stake({ value: parseDOT("2") }));

  // ─── Relay operator (run first so users/publishers have balances) ───────
  console.log("\n[Relay]");
  const cidR1 = await activateCampaign(ctx, BUDGET, DAILY, CPM);
  const sc1 = buildClaimChain(cidR1, ctx.publisher.address, ctx.user.address, CPM, 1, 100n);
  await measure("Relay", "settleClaims (1 claim × 100 imps)",
    ctx.settlement.connect(ctx.user).settleClaims([{ user: ctx.user.address, campaignId: cidR1, claims: sc1 }]));
  const cidR5 = await activateCampaign(ctx, BUDGET, DAILY, CPM);
  const sc5 = buildClaimChain(cidR5, ctx.publisher.address, ctx.user.address, CPM, 5, 100n);
  await measure("Relay", "settleClaims (5 claims × 100 imps)",
    ctx.settlement.connect(ctx.user).settleClaims([{ user: ctx.user.address, campaignId: cidR5, claims: sc5 }]));
  const cidR10 = await activateCampaign(ctx, BUDGET, parseDOT("20"), CPM);
  const sc10 = buildClaimChain(cidR10, ctx.publisher.address, ctx.user.address, CPM, 10, 100n);
  await measure("Relay", "settleClaims (10 claims × 100 imps)",
    ctx.settlement.connect(ctx.user).settleClaims([{ user: ctx.user.address, campaignId: cidR10, claims: sc10 }]));
  // Scale probe: 25 & 50 (= live maxBatchSize cap) to map the per-claim gas curve.
  try {
    const cidR25 = await activateCampaign(ctx, BUDGET, parseDOT("20"), CPM);
    const sc25 = buildClaimChain(cidR25, ctx.publisher.address, ctx.user.address, CPM, 25, 100n);
    await measure("Relay", "settleClaims (25 claims × 100 imps)",
      ctx.settlement.connect(ctx.user).settleClaims([{ user: ctx.user.address, campaignId: cidR25, claims: sc25 }]));
  } catch (e: any) { markSkipped("Relay", "settleClaims (25 claims × 100 imps)", (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 80)); }
  try {
    const cidR50 = await activateCampaign(ctx, BUDGET, parseDOT("20"), CPM);
    const sc50 = buildClaimChain(cidR50, ctx.publisher.address, ctx.user.address, CPM, 50, 100n);
    await measure("Relay", "settleClaims (50 claims × 100 imps, = batch cap)",
      ctx.settlement.connect(ctx.user).settleClaims([{ user: ctx.user.address, campaignId: cidR50, claims: sc50 }]));
  } catch (e: any) { markSkipped("Relay", "settleClaims (50 claims × 100 imps, = batch cap)", (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 80)); }

  // ─── CPC settle (actionType=1) ──────────────────────────────────────────
  // Click-based settlement requires (a) a multi-pot campaign with a CPC
  // pot configured and (b) a click session pre-recorded in ClickRegistry
  // keyed by (user, campaignId, impressionNonce). The relay-bot records
  // the session when the user actually clicks; here we wire ClickRegistry
  // → relay signer and emit a session ourselves.
  try {
    await (await ctx.clickReg.setRelay(ctx.relay.address)).wait();
    await (await ctx.clickReg.setSettlement(await ctx.settlement.getAddress())).wait();
    const CPC_RATE = parseDOT("0.005"); // per-click rate (5× the CPM equivalent)
    const cidCPC = await activateCampaignWithPots(ctx, [
      { actionType: 0, budget: BUDGET, dailyCap: DAILY, rate: CPM },
      { actionType: 1, budget: parseDOT("5"), dailyCap: parseDOT("1"), rate: CPC_RATE },
    ]);
    const impressionNonce = ethers.keccak256(ethers.toUtf8Bytes("cpc-click-1"));
    const clickSessionHash: string = await ctx.clickReg.sessionHash(ctx.user.address, cidCPC, impressionNonce);
    await (await ctx.clickReg.connect(ctx.relay).recordClick(ctx.user.address, cidCPC, impressionNonce)).wait();
    const cpcClaim = buildClaim({
      cid: cidCPC, publisher: ctx.publisher.address, user: ctx.user.address,
      rate: CPC_RATE, events: 1n, nonce: 1n, prev: ethers.ZeroHash,
      actionType: 1, clickSessionHash,
    });
    await measure("Relay", "settleClaims (1 CPC click)",
      ctx.settlement.connect(ctx.user).settleClaims([{ user: ctx.user.address, campaignId: cidCPC, claims: [cpcClaim] }]));
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
    markSkipped("Relay", "settleClaims (1 CPC click)", msg);
  }

  // ─── CPA settle (actionType=2) ──────────────────────────────────────────
  // Remote-action settlement requires the pot's `actionVerifier` field to
  // be set to a known EOA, and the claim's `actionSig` to be that EOA's
  // EIP-191 signature over claimHash. We use a fresh hardhat signer.
  try {
    const actionSigner = (await ethers.getSigners())[15];
    const CPA_RATE = parseDOT("0.05"); // per-action rate (50× CPM)
    const cidCPA = await activateCampaignWithPots(ctx, [
      { actionType: 0, budget: BUDGET, dailyCap: DAILY, rate: CPM },
      { actionType: 2, budget: parseDOT("5"), dailyCap: parseDOT("1"), rate: CPA_RATE, actionVerifier: actionSigner.address },
    ]);
    const cpaClaim = buildClaim({
      cid: cidCPA, publisher: ctx.publisher.address, user: ctx.user.address,
      rate: CPA_RATE, events: 1n, nonce: 1n, prev: ethers.ZeroHash,
      actionType: 2,
    });
    cpaClaim.proof = mkProof({ actionSig: await signCpaClaim(cpaClaim, actionSigner) });
    await measure("Relay", "settleClaims (1 CPA action)",
      ctx.settlement.connect(ctx.user).settleClaims([{ user: ctx.user.address, campaignId: cidCPA, claims: [cpaClaim] }]));
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
    markSkipped("Relay", "settleClaims (1 CPA action)", msg);
  }

  // ─── Gasless dual-sig path: settleSignedClaims + withdrawUserBySig ───────
  // The production gasless flow: user signs nothing on-chain; relay submits +
  // pays gas. Publisher side is the relaySigner (== relay here); advertiser
  // self-signs (expectedAdvertiserRelaySigner = 0). A dedicated beneficiary
  // signer keeps ctx.user's balance intact for the withdrawUser row below.
  try {
    const dsUser = (await ethers.getSigners())[16];
    const cidDS = await activateCampaignWithPots(ctx, [{ actionType: 0, budget: BUDGET, dailyCap: DAILY, rate: CPM }]);
    const net = await ethers.provider.getNetwork();
    const dsClaim = buildClaim({ cid: cidDS, publisher: ctx.publisher.address, user: dsUser.address, rate: CPM, events: 100n, nonce: 1n, prev: ethers.ZeroHash });
    // SLIM (#2): firstNonce added; claimsHash binds to keccak(abi.encode(slimClaim)) per claim.
    const claimsHash = contentHashClaims([dsClaim]);
    const firstNonce = (dsClaim as any).nonce;
    const deadlineBlock = BigInt(await ethers.provider.getBlockNumber()) + 1000n;
    const dsDomain = { name: "DatumSettlement", version: "1", chainId: net.chainId, verifyingContract: await ctx.dualSig.getAddress() };
    const cbTypes = { ClaimBatch: [
      { name: "user", type: "address" }, { name: "campaignId", type: "uint256" }, { name: "firstNonce", type: "uint256" },
      { name: "claimsHash", type: "bytes32" }, { name: "deadlineBlock", type: "uint256" },
      { name: "expectedRelaySigner", type: "address" }, { name: "expectedAdvertiserRelaySigner", type: "address" },
    ] };
    const cbValue = { user: dsUser.address, campaignId: cidDS, firstNonce, claimsHash, deadlineBlock, expectedRelaySigner: ctx.relay.address, expectedAdvertiserRelaySigner: ethers.ZeroAddress };
    const publisherSig = await ctx.relay.signTypedData(dsDomain, cbTypes, cbValue);      // publisher's relaySigner == relay
    const advertiserSig = await ctx.advertiser.signTypedData(dsDomain, cbTypes, cbValue); // advertiser self-signs
    const batch = {
      user: dsUser.address, campaignId: cidDS, firstNonce, claims: [dsClaim], deadlineBlock,
      expectedRelaySigner: ctx.relay.address, expectedAdvertiserRelaySigner: ethers.ZeroAddress,
      userSig: "0x", publisherSig, advertiserSig,
    };
    await measure("Relay", "settleSignedClaims (1 claim × 100 imps, dual-sig)",
      ctx.dualSig.connect(ctx.relay).settleSignedClaims([batch]));

    // dsUser now holds a vault balance → measure the gasless withdrawal.
    const bal = await ctx.vault.userBalance(dsUser.address);
    if (bal > 0n) {
      const wNonce = await ctx.vault.withdrawNonce(dsUser.address);
      const deadline = BigInt(await ethers.provider.getBlockNumber()) + 100n;
      const maxFee = bal / 100n; // 1%
      const wDomain = { name: "DatumPaymentVault", version: "1", chainId: net.chainId, verifyingContract: await ctx.vault.getAddress() };
      const waTypes = { WithdrawAuth: [
        { name: "user", type: "address" }, { name: "recipient", type: "address" }, { name: "maxFee", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] };
      const wsig = await dsUser.signTypedData(wDomain, waTypes, { user: dsUser.address, recipient: dsUser.address, maxFee, nonce: wNonce, deadline });
      await measure("Relay", "withdrawUserBySig (gasless, relay-submitted)",
        ctx.vault.connect(ctx.relay).withdrawUserBySig(dsUser.address, dsUser.address, maxFee, deadline, wsig));
    } else {
      markSkipped("Relay", "withdrawUserBySig (gasless, relay-submitted)", "dsUser had zero credit after dual-sig settle");
    }
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
    markSkipped("Relay", "settleSignedClaims (dual-sig)", msg);
    markSkipped("Relay", "withdrawUserBySig (gasless, relay-submitted)", "prerequisite dual-sig settle failed");
  }

  // Now publisher and user have balances; withdraw measurements work.
  console.log("\n[Publisher withdraws]");
  const pubBal = await ctx.vault.publisherBalance(ctx.publisher.address);
  console.log(`  publisher vault balance: ${pubBal} planck`);
  if (pubBal > 0n) {
    await measure("Publisher", "vault.withdrawPublisher",
      ctx.vault.connect(ctx.publisher).withdrawPublisher());
  } else {
    rows.push({ role: "Publisher", op: "vault.withdrawPublisher", gas: 0n, note: "SKIPPED: publisher had zero credit after settle (likely take-rate or stake gate)" });
    console.warn("  vault.withdrawPublisher SKIPPED: publisher balance zero");
  }

  // ─── User ────────────────────────────────────────────────────────────────
  console.log("\n[User]");
  await (await ctx.mockToken.mint(ctx.user.address, parseDOT("100"))).wait();
  await (await ctx.mockToken.connect(ctx.user).approve(await ctx.zkStake.getAddress(), parseDOT("100"))).wait();
  const commit = ethers.keccak256(ethers.toUtf8Bytes("user-secret-1"));
  await measure("User", "zkStake.depositWith",
    ctx.zkStake.connect(ctx.user).depositWith(commit, parseDOT("10")));
  await measure("User", "zkStake.requestWithdrawal",
    ctx.zkStake.connect(ctx.user).requestWithdrawal(parseDOT("1")));
  await measure("User", "reportPage (reason 1)",
    ctx.reports.connect(ctx.user).reportPage(cidR1, 1));
  // User self-floor on AssuranceLevel — single-tx, B5 CB7 cypherpunk
  // posture. Should be exercised at least once on signup.
  try {
    await measure("User", "settlement.setUserMinAssurance",
      ctx.settlement.connect(ctx.user).setUserMinAssurance(1));
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
    markSkipped("User", "settlement.setUserMinAssurance", msg);
  }
  const userBal = await ctx.vault.userBalance(ctx.user.address);
  console.log(`  user vault balance: ${userBal} planck`);
  if (userBal > 0n) {
    await measure("User", "vault.withdrawUser",
      ctx.vault.connect(ctx.user).withdrawUser());
  } else {
    rows.push({ role: "User", op: "vault.withdrawUser", gas: 0n, note: "SKIPPED: zero user balance after settle" });
    console.warn("  vault.withdrawUser SKIPPED: user balance zero");
  }

  // ─── StakeRoot V1 reporter ───────────────────────────────────────────────
  console.log("\n[Reporter V1]");
  await (await ctx.stakeRootV1.addReporter(ctx.owner.address)).wait();
  await (await ctx.stakeRootV1.setThreshold(1)).wait();
  await measure("Reporter V1", "stakeRoot.commitStakeRoot (threshold 1)",
    ctx.stakeRootV1.commitStakeRoot(1n, ethers.keccak256(ethers.toUtf8Bytes("root-1"))));
  // 2-of-N case: add a second reporter, raise threshold, measure both legs
  await (await ctx.stakeRootV1.addReporter(ctx.reporter2.address)).wait();
  await (await ctx.stakeRootV1.setThreshold(2)).wait();
  const root2 = ethers.keccak256(ethers.toUtf8Bytes("root-2"));
  await measure("Reporter V1", "commitStakeRoot (first signer, 2-of-N)",
    ctx.stakeRootV1.commitStakeRoot(2n, root2));
  await measure("Reporter V1", "commitStakeRoot (cosigner finalises)",
    ctx.stakeRootV1.connect(ctx.reporter2).commitStakeRoot(2n, root2));

  // ─── StakeRoot V2 reporter ───────────────────────────────────────────────
  console.log("\n[Reporter V2]");
  await measure("Reporter V2", "stakeRootV2.joinReporters",
    ctx.stakeRootV2.connect(ctx.reporter2).joinReporters({ value: parseDOT("1") }));
  await mineBlocks(30n); // advance past SNAPSHOT_MIN_AGE
  const block = await ethers.provider.getBlockNumber();
  const v2Root = ethers.keccak256(ethers.toUtf8Bytes("v2-root-1"));
  await measure("Reporter V2", "stakeRootV2.proposeRoot",
    ctx.stakeRootV2.connect(ctx.reporter2).proposeRoot(1n, block - 15, v2Root, { value: parseDOT("0.1") }));
  // Second reporter — give councilA stake then approve (need same root)
  await (await ctx.stakeRootV2.connect(ctx.councilA).joinReporters({ value: parseDOT("1") })).wait();
  await measure("Reporter V2", "stakeRootV2.approveRoot",
    ctx.stakeRootV2.connect(ctx.councilA).approveRoot(1n));
  await mineBlocks(22n); // past challenge window (20)
  await measure("Reporter V2", "stakeRootV2.finalizeRoot",
    ctx.stakeRootV2.finalizeRoot(1n));

  // ─── Voter (governance V2) ───────────────────────────────────────────────
  console.log("\n[Voter]");
  // Create another campaign for vote-only measurement
  const voteTx = await ctx.campaigns.connect(ctx.advertiser).createCampaign(
    ctx.publisher.address,
    [{ actionType: 0, budgetWei: BUDGET, dailyCapWei: DAILY, rateWei: CPM, actionVerifier: ethers.ZeroAddress }],
    [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET },
  );
  await voteTx.wait();
  const voteCid = await ctx.campaigns.nextCampaignId() - 1n;
  await measure("Voter", "governance.vote (aye)",
    ctx.governance.connect(ctx.voter).vote(voteCid, true, 0, { value: QUORUM }));
  // nay on a different campaign
  const nayTx = await ctx.campaigns.connect(ctx.advertiser).createCampaign(
    ctx.publisher.address,
    [{ actionType: 0, budgetWei: BUDGET, dailyCapWei: DAILY, rateWei: CPM, actionVerifier: ethers.ZeroAddress }],
    [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET },
  );
  await nayTx.wait();
  const nayCid = await ctx.campaigns.nextCampaignId() - 1n;
  await measure("Voter", "governance.vote (nay)",
    ctx.governance.connect(ctx.voter).vote(nayCid, false, 0, { value: QUORUM }));

  // Public-service activation call. evaluateCampaign is callable by
  // anyone once quorum is reached + grace window elapsed; we vote +
  // mine + evaluate on a fresh campaign to isolate the gas.
  try {
    const evalTx = await ctx.campaigns.connect(ctx.advertiser).createCampaign(
      ctx.publisher.address,
      [{ actionType: 0, budgetWei: BUDGET, dailyCapWei: DAILY, rateWei: CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET },
    );
    await evalTx.wait();
    const evalCid = await ctx.campaigns.nextCampaignId() - 1n;
    await (await ctx.governance.connect(ctx.voter).vote(evalCid, true, 0, { value: QUORUM })).wait();
    await mineBlocks(MAX_GRACE + 1n);
    await measure("Voter", "governance.evaluateCampaign",
      ctx.governance.evaluateCampaign(evalCid));
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
    markSkipped("Voter", "governance.evaluateCampaign", msg);
  }

  // ─── Council member ──────────────────────────────────────────────────────
  console.log("\n[Council]");
  // Target the curator (which we'll have the council own) — a known, valid
  // call surface. Wire ownership first.
  try {
    await (await ctx.curatorContract.setCouncil(await ctx.council.getAddress())).wait();
    const targets = [await ctx.curatorContract.getAddress()];
    const values = [0n];
    const datas = [ctx.curatorContract.interface.encodeFunctionData(
      "blockAddr", [ctx.publisher2.address, ethers.keccak256(ethers.toUtf8Bytes("reason"))]
    )];
    const tx = await ctx.council.connect(ctx.councilA).propose(targets, values, datas, "block publisher2");
    const r = await tx.wait();
    rows.push({ role: "Council", op: "council.propose", gas: r.gasUsed as bigint });
    console.log(`  ${"Council".padEnd(14)} ${"council.propose".padEnd(40)} ${(r.gasUsed as bigint).toString().padStart(8)}`);
    const propId = await ctx.council.nextProposalId() - 1n;
    await measure("Council", "council.vote",
      ctx.council.connect(ctx.councilB).vote(propId));
    // Need threshold (2) reached: councilA's propose counted as their vote? Let's check by adding councilC.
    // (Doesn't matter for gas — second vote = measurement source of truth)
    try { await (await ctx.council.connect(ctx.councilC).vote(propId)).wait(); } catch {}
    // Mine past voting + delay + veto windows so execute() can land
    await mineBlocks(120n);
    await measure("Council", "council.execute",
      ctx.council.execute(propId));
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0].slice(0, 80);
    rows.push({ role: "Council", op: "council.propose", gas: 0n, note: `SKIPPED: ${msg}` });
    console.warn(`  Council/propose SKIPPED: ${msg}`);
  }

  // ─── Curator (direct calls — council-only in production, owner-only here) ──
  console.log("\n[Curator]");
  // Repoint the curator to ctx.owner so we can measure direct calls cleanly.
  await (await ctx.curatorContract.setCouncil(ctx.owner.address)).wait();
  // publisher2 may already be blocked from the council execute path — unblock first
  try { await (await ctx.curatorContract.unblockAddr(ctx.publisher2.address)).wait(); } catch {}
  await measure("Curator", "curator.blockAddr",
    ctx.curatorContract.blockAddr(ctx.publisher2.address, ethers.keccak256(ethers.toUtf8Bytes("reason"))));
  await measure("Curator", "curator.unblockAddr",
    ctx.curatorContract.unblockAddr(ctx.publisher2.address));

  // ─── Fraud challenger ────────────────────────────────────────────────────
  console.log("\n[Challenger]");
  const commitment = ethers.keccak256(ethers.toUtf8Bytes("user-commitment-1"));
  await measure("Challenger", "stakeRootV2.registerCommitment",
    ctx.stakeRootV2.connect(ctx.challenger).registerCommitment(commitment, { value: parseDOT("0.01") }));
  // challengePhantomLeaf requires a Merkle proof against a still-pending root.
  // For measurement, we'd need a separate pending root with a known phantom leaf — skip and note.
  rows.push({ role: "Challenger", op: "stakeRootV2.challengePhantomLeaf", gas: 0n, note: "SKIPPED: requires constructed phantom-leaf Merkle proof; measure separately" });
  console.warn(`  Challenger/challengePhantomLeaf SKIPPED: needs phantom-leaf Merkle proof`);

  // ─── Admin (governance / pause) ──────────────────────────────────────────
  console.log("\n[Admin]");
  await measure("Admin", "pauseRegistry.pause (owner)",
    ctx.pauseReg.connect(ctx.owner).pause());
  // 2-of-3 guardian unpause path: propose then approve.
  try {
    const propTx = await ctx.pauseReg.connect(ctx.advertiser).proposeCategoryUnpause(0x0F); // CAT_ALL = 0x0F
    const propR = await propTx.wait();
    rows.push({ role: "Admin", op: "pauseRegistry.proposeCategoryUnpause", gas: propR.gasUsed as bigint });
    console.log(`  ${"Admin".padEnd(14)} ${"pauseRegistry.proposeCategoryUnpause".padEnd(40)} ${(propR.gasUsed as bigint).toString().padStart(8)}`);
    // Pull proposalId from PauseProposed event
    let propId = 0n;
    for (const log of propR.logs as any[]) {
      try {
        const p = ctx.pauseReg.interface.parseLog({ topics: log.topics, data: log.data });
        if (p?.name === "PauseProposed") { propId = p.args[0] as bigint; break; }
      } catch {}
    }
    await measure("Admin", "pauseRegistry.approve (unpause)",
      ctx.pauseReg.connect(ctx.publisher).approve(propId));
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0].slice(0, 80);
    rows.push({ role: "Admin", op: "pauseRegistry.proposeCategoryUnpause", gas: 0n, note: `SKIPPED: ${msg}` });
    console.warn(`  Admin/proposeCategoryUnpause SKIPPED: ${msg}`);
  }

  // ─── Token plane ─────────────────────────────────────────────────────────
  // Three personas surface here:
  //   - TokenHolder: end-user wrap/unwrap, fee-share staking
  //   - TokenAdvertiser: depositCampaignBudget for ERC-20 reward sidecar
  //   - EmissionOperator: rollEpoch / adjustRate on EmissionEngine
  //   - Vesting: founder release()
  //   - Bootstrap: house-ad claim()
  console.log("\n[Token plane]");

  // Mint some WDATUM to the user via the precompile shim so we can exercise
  // wrap/stake/unwrap. The mock precompile lets the issuer (=authority) mint
  // canonical DATUM directly; we'll bypass the authority by minting from
  // the mock issuer itself (only works because authority is the issuer).
  if (ctx.wrapper && ctx.authority && ctx.precompile) {
    try {
      // First mint canonical DATUM to wrapper so the invariant holds, then
      // call wrapper.mintTo via authority.
      // The authority's mintTo path requires going through wrap()/unwrap;
      // for benchmarking we exercise requestWrap → wrap directly.

      // wrap path needs the user to own canonical DATUM. Pre-fund via the
      // mock precompile's owner-issuer.
      await (await ctx.precompile.connect(ctx.owner).transferIssuer(31337n, ctx.owner.address)).wait();
      await (await ctx.precompile.connect(ctx.owner).mint(31337n, ctx.user.address, parseDOT("10"))).wait();
      // Restore issuer back to authority so wrap path stays consistent.
      await (await ctx.precompile.connect(ctx.owner).transferIssuer(31337n, await ctx.authority.getAddress())).wait();

      await measure("TokenHolder", "wrapper.requestWrap",
        ctx.wrapper.connect(ctx.user).requestWrap(parseDOT("1")));
      await measure("TokenHolder", "wrapper.wrap",
        ctx.wrapper.connect(ctx.user).wrap(parseDOT("1")));
      await measure("TokenHolder", "wrapper.unwrap",
        ctx.wrapper.connect(ctx.user).unwrap(parseDOT("0.1"), ethers.ZeroHash));
    } catch (e: any) {
      const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
      markSkipped("TokenHolder", "wrapper.requestWrap", msg);
      markSkipped("TokenHolder", "wrapper.wrap",       "SKIPPED: prerequisite wrapper.requestWrap failed");
      markSkipped("TokenHolder", "wrapper.unwrap",     "SKIPPED: prerequisite wrap chain failed");
    }
  } else {
    markSkipped("TokenHolder", "wrapper.requestWrap", "token plane not deployed");
    markSkipped("TokenHolder", "wrapper.wrap",       "token plane not deployed");
    markSkipped("TokenHolder", "wrapper.unwrap",     "token plane not deployed");
  }

  // FeeShare stake/unstake/claim — user stakes WDATUM, accumulates DOT
  // dividends, claims. Requires WDATUM balance from the wrap path above.
  if (ctx.feeShare && ctx.wrapper) {
    try {
      const stakeAmount = parseDOT("0.5");
      await (await ctx.wrapper.connect(ctx.user).approve(await ctx.feeShare.getAddress(), stakeAmount)).wait();
      await measure("TokenHolder", "feeShare.stake",
        ctx.feeShare.connect(ctx.user).stake(stakeAmount));
      // Fund the share pool with DOT so a claim has something to pull.
      try { await (await ctx.feeShare.connect(ctx.owner).fund({ value: parseDOT("1") })).wait(); } catch {}
      await measure("TokenHolder", "feeShare.claim",
        ctx.feeShare.connect(ctx.user).claim());
      await measure("TokenHolder", "feeShare.unstake",
        ctx.feeShare.connect(ctx.user).unstake(parseDOT("0.1")));
    } catch (e: any) {
      const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
      markSkipped("TokenHolder", "feeShare.stake",   msg);
      markSkipped("TokenHolder", "feeShare.claim",   "SKIPPED: prerequisite feeShare.stake failed");
      markSkipped("TokenHolder", "feeShare.unstake", "SKIPPED: prerequisite feeShare.stake failed");
    }
  } else {
    markSkipped("TokenHolder", "feeShare.stake",   "FeeShare not deployed");
    markSkipped("TokenHolder", "feeShare.claim",   "FeeShare not deployed");
    markSkipped("TokenHolder", "feeShare.unstake", "FeeShare not deployed");
  }

  // Founder vesting release — beneficiary-only. We pass `owner` as the
  // beneficiary at deploy time, so owner.release() is the call.
  if (ctx.vesting) {
    try {
      // Vesting requires elapsed time; bump 1 day worth of seconds.
      await ethers.provider.send("evm_increaseTime", [86400]);
      await ethers.provider.send("evm_mine", []);
      await measure("Vesting", "vesting.release",
        ctx.vesting.connect(ctx.owner).release());
    } catch (e: any) {
      const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
      markSkipped("Vesting", "vesting.release", msg);
    }
  } else {
    markSkipped("Vesting", "vesting.release", "Vesting not deployed");
  }

  // BootstrapPool — house-ad claim path. `settlement caller` was set to
  // owner at deploy time so we can invoke directly.
  if (ctx.bootstrap) {
    try {
      await measure("Bootstrap", "bootstrap.claim",
        ctx.bootstrap.connect(ctx.owner).claim(ctx.user.address, 1n));
    } catch (e: any) {
      const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
      markSkipped("Bootstrap", "bootstrap.claim", msg);
    }
  } else {
    markSkipped("Bootstrap", "bootstrap.claim", "BootstrapPool not deployed");
  }

  // TokenRewardVault — advertiser pre-funds an ERC-20 reward budget for a
  // campaign. Exercised here as a one-off deposit by the advertiser.
  if (ctx.tokenRewardVault && ctx.mockToken) {
    try {
      const amt = parseDOT("10");
      await (await ctx.mockToken.mint(ctx.advertiser.address, amt)).wait();
      await (await ctx.mockToken.connect(ctx.advertiser).approve(await ctx.tokenRewardVault.getAddress(), amt)).wait();
      // Use a fresh campaign id (any uint256) — the vault doesn't gate on
      // existence here, only on amount/token wiring.
      await measure("Advertiser", "tokenRewardVault.depositCampaignBudget",
        ctx.tokenRewardVault.connect(ctx.advertiser).depositCampaignBudget(999n, await ctx.mockToken.getAddress(), amt));
    } catch (e: any) {
      const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
      markSkipped("Advertiser", "tokenRewardVault.depositCampaignBudget", msg);
    }
  } else {
    markSkipped("Advertiser", "tokenRewardVault.depositCampaignBudget", "TokenRewardVault not deployed");
  }

  // EmissionEngine — rollEpoch + adjustRate. These are permissionless
  // (whenNotFrozen), but rollEpoch only fires if the epoch duration has
  // elapsed; for the benchmark we accept the SKIPPED outcome on Hardhat
  // (the time-based gate makes this a noop in-process unless we evm_warp
  // by the HALVING_PERIOD).
  if (ctx.emissionEngine) {
    try {
      await measure("EmissionOperator", "emissionEngine.adjustRate",
        ctx.emissionEngine.adjustRate());
    } catch (e: any) {
      const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
      markSkipped("EmissionOperator", "emissionEngine.adjustRate", msg);
    }
    try {
      await measure("EmissionOperator", "emissionEngine.rollEpoch",
        ctx.emissionEngine.rollEpoch());
    } catch (e: any) {
      const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
      markSkipped("EmissionOperator", "emissionEngine.rollEpoch", msg);
    }
  } else {
    markSkipped("EmissionOperator", "emissionEngine.adjustRate", "EmissionEngine not deployed");
    markSkipped("EmissionOperator", "emissionEngine.rollEpoch",  "EmissionEngine not deployed");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage matrix — every alpha-5 production contract, mapped to the op
// labels this script attempts to measure for it. Reading this list tells
// you exactly what coverage the report claims (and doesn't).
// ─────────────────────────────────────────────────────────────────────────────

interface CoverageEntry { contract: string; measuredOps: string[]; notes?: string }
const COVERAGE_MATRIX: CoverageEntry[] = [
  { contract: "DatumPauseRegistry",          measuredOps: ["pauseRegistry.pause (owner)", "pauseRegistry.proposeCategoryUnpause", "pauseRegistry.approve (unpause)"] },
  { contract: "DatumTimelock",               measuredOps: [],                                                  notes: "Owner role only; exercised indirectly via governance phase tests" },
  { contract: "DatumPublishers",             measuredOps: ["registerPublisher", "setRelaySigner", "setProfile"] },
  { contract: "DatumBudgetLedger",           measuredOps: [],                                                  notes: "State changes triggered by Settlement, not direct calls" },
  { contract: "DatumPaymentVault",           measuredOps: ["vault.withdrawPublisher", "vault.withdrawUser", "withdrawUserBySig (gasless, relay-submitted)"] },
  { contract: "DatumCampaigns",              measuredOps: ["createCampaign"] },
  { contract: "DatumCampaignLifecycle",      measuredOps: [],                                                  notes: "Driven by Settlement and Governance" },
  { contract: "DatumClaimValidator",         measuredOps: [],                                                  notes: "Validation invoked inside settleClaims gas" },
  { contract: "DatumSettlement",             measuredOps: ["settleClaims (1 claim × 100 imps)", "settleClaims (5 claims × 100 imps)", "settleClaims (10 claims × 100 imps)", "settleClaims (1 CPC click)", "settleClaims (1 CPA action)", "settlement.setUserMinAssurance"] },
  { contract: "DatumSettlementLogicA",       measuredOps: [],                                                  notes: "Delegate of Settlement; included in settleClaims gas" },
  { contract: "DatumSettlementLogicB",       measuredOps: [],                                                  notes: "Delegate of Settlement; included in settleClaims gas" },
  { contract: "DatumSettlementRateLimiter",  measuredOps: [],                                                  notes: "Read-only checks inside settleClaims; no separate write paths" },
  { contract: "DatumGovernanceV2",           measuredOps: ["governance.vote (aye)", "governance.vote (nay)", "vote (own campaign, aye)", "governance.evaluateCampaign"] },
  { contract: "DatumGovernanceRouter",       measuredOps: [],                                                  notes: "Upgrade ops gated to governor; needs phase-1/2 setup" },
  { contract: "DatumCouncil",                measuredOps: ["council.propose", "council.vote", "council.execute"] },
  { contract: "DatumCouncilBlocklistCurator",measuredOps: ["curator.blockAddr", "curator.unblockAddr"] },
  { contract: "DatumRelay",                  measuredOps: [],                                                  notes: "Bonded operator path; covered indirectly by settleClaims measurements" },
  { contract: "DatumRelayStake",             measuredOps: [],                                                  notes: "Deferred — needs relay operator harness" },
  { contract: "DatumRelayGovernance",        measuredOps: [],                                                  notes: "Deferred — same harness as RelayStake" },
  { contract: "DatumAttestationVerifier",    measuredOps: [],                                                  notes: "Pure verifier; invoked inside settleClaims" },
  { contract: "DatumTokenRewardVault",       measuredOps: ["tokenRewardVault.depositCampaignBudget"] },
  { contract: "DatumPublisherStake",         measuredOps: ["publisherStake.stake"] },
  { contract: "DatumChallengeBonds",         measuredOps: ["challengeBonds.openBond"] },
  { contract: "DatumPublisherGovernance",    measuredOps: [],                                                  notes: "Deferred — full propose/vote/resolve cycle needs separate harness" },
  { contract: "DatumAdvertiserGovernance",   measuredOps: [],                                                  notes: "Mirrors PublisherGovernance; same deferral" },
  { contract: "DatumAdvertiserStake",        measuredOps: [],                                                  notes: "Deferred — needs advertiser stake harness" },
  { contract: "DatumParameterGovernance",    measuredOps: [],                                                  notes: "Deferred — bicameral veto-window flow needs separate harness" },
  { contract: "DatumPublisherReputation",    measuredOps: [],                                                  notes: "Reporter-only writes; covered indirectly via settleClaims path" },
  { contract: "DatumNullifierRegistry",      measuredOps: [],                                                  notes: "Per-claim nullifier writes are inside settleClaims gas" },
  { contract: "DatumPowEngine",              measuredOps: [],                                                  notes: "Pre-settlement read; no standalone write paths to measure" },
  { contract: "DatumActivationBonds",        measuredOps: [],                                                  notes: "Measured indirectly via challengeBonds.openBond" },
  { contract: "DatumReports",                measuredOps: ["reportPage (reason 1)"] },
  { contract: "DatumCampaignAllowlist",      measuredOps: [],                                                  notes: "Deferred — allowlist add/remove flow not exercised" },
  { contract: "DatumCampaignCreative",       measuredOps: [],                                                  notes: "Deferred — Bulletin Chain pin/renew flow needs parachain harness" },
  { contract: "DatumTagSystem",              measuredOps: [],                                                  notes: "Deferred — tag declare/match flow not exercised" },
  { contract: "DatumTagCurator",             measuredOps: [],                                                  notes: "Deferred — propose/appeal/resolve flow not exercised" },
  { contract: "DatumTagRegistry",            measuredOps: [],                                                  notes: "Deferred — write paths gated to TagCurator" },
  { contract: "DatumStakeRoot",              measuredOps: ["stakeRoot.commitStakeRoot (threshold 1)", "commitStakeRoot (first signer, 2-of-N)", "commitStakeRoot (cosigner finalises)"] },
  { contract: "DatumStakeRootV2",            measuredOps: ["stakeRootV2.joinReporters", "stakeRootV2.proposeRoot", "stakeRootV2.approveRoot", "stakeRootV2.finalizeRoot", "stakeRootV2.registerCommitment", "stakeRootV2.challengePhantomLeaf"] },
  { contract: "DatumPeopleChainIdentity",    measuredOps: [],                                                  notes: "Deferred — needs People Chain XCM bridge + bonded reporter harness" },
  { contract: "DatumPeopleChainXcmBridge",   measuredOps: [],                                                  notes: "Deferred — XCM dispatch not exercisable in-process" },
  { contract: "DatumBondedIdentityReporter", measuredOps: [],                                                  notes: "Deferred — needs People Chain harness" },
  { contract: "DatumIdentityVerifier",       measuredOps: [],                                                  notes: "Pure verifier; exercised via MockIdentityVerifier in this run" },
  { contract: "DatumZKVerifier",             measuredOps: [],                                                  notes: "Pure verifier; exercised via MockZKVerifier in this run" },
  { contract: "DatumZKStake",                measuredOps: ["zkStake.depositWith", "zkStake.requestWithdrawal"] },
  { contract: "DatumClickRegistry",          measuredOps: ["settleClaims (1 CPC click)"],                       notes: "Exercised via the CPC settle path (recordClick + markClaimed)" },
  { contract: "DatumInterestCommitments",    measuredOps: [],                                                  notes: "Deferred — extension-driven write path" },
  { contract: "DatumDualSigSettlement",      measuredOps: ["settleSignedClaims (1 claim × 100 imps, dual-sig)"], notes: "Gasless path: publisher relaySigner + advertiser EIP-712 co-sigs; relay submits + pays gas" },
  { contract: "DatumEmissionEngine",         measuredOps: ["emissionEngine.adjustRate", "emissionEngine.rollEpoch"], notes: "rollEpoch typically SKIPs in-process (time-gated; needs epoch-duration warp)" },
  { contract: "DatumMintCoordinator",        measuredOps: [],                                                  notes: "Wired in deploy but no direct state-changing op exercised; mint happens inside settleClaims gas" },
  // ── Token plane ─────────────────────────────────────────────────────────
  { contract: "DatumWrapper",                measuredOps: ["wrapper.requestWrap", "wrapper.wrap", "wrapper.unwrap"] },
  { contract: "DatumMintAuthority",          measuredOps: [],                                                  notes: "Owner-only setters exercised during deploy wiring; production mint paths go via Wrapper/Vesting/Bootstrap" },
  { contract: "DatumBootstrapPool",          measuredOps: ["bootstrap.claim"] },
  { contract: "DatumVesting",                measuredOps: ["vesting.release"] },
  { contract: "DatumFeeShare",               measuredOps: ["feeShare.stake", "feeShare.claim", "feeShare.unstake"] },
  { contract: "AssetHubPrecompileMock",      measuredOps: [],                                                  notes: "Devnet stand-in for Asset Hub precompile; not a production contract" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Tier helpers — derive L/M/H gas spend per role from ROLE_BASELINES.
// ─────────────────────────────────────────────────────────────────────────────

/// Sum the yearly gas for `role` at the given tier, using the medium
/// baseline × tier multiplier across every op listed for the role.
/// Unmeasured ops (gas === 0n) contribute zero — they're surfaced in the
/// skipped section instead of silently inflating the projection.
function sumRoleTierGas(role: string, tier: TierName): number {
  const baseline = ROLE_BASELINES.find((b) => b.role === role);
  if (!baseline) return 0;
  const mult = TIER_MULTIPLIERS[tier];
  let total = 0;
  for (const op of baseline.ops) {
    const r = rows.find((x) => x.role === role && x.op === op.op);
    const gas = Number(r?.gas ?? 0n);
    total += gas * op.daily * mult * 365;
  }
  return total;
}

/// Format a tx-hash table cell. On networks with a known explorer base
/// URL, the hash links to the tx page; otherwise the short hash is
/// rendered as text.
function formatTxCell(txHash: string | undefined, explorerBase: string | null): string {
  if (!txHash) return "—";
  const short = `${txHash.slice(0, 10)}…${txHash.slice(-6)}`;
  if (!explorerBase) return `\`${short}\``;
  return `[\`${short}\`](${explorerBase}/tx/${txHash})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

function emitMarkdown(network: { chainId: number; explorer: string | null }): string {
  const out: string[] = [];
  out.push(`# Datum Alpha-5 — Gas Cost Report by Role\n`);
  out.push(`Generated by \`scripts/role-gas-report.ts\` on ${new Date().toISOString()}.`);
  if (network.chainId === 420420417) {
    out.push(`Run target: **Paseo testnet** (chainId ${network.chainId}). tx hashes are clickable Blockscout URLs.`);
  } else if (network.chainId === 420420420) {
    out.push(`Run target: **pallet-revive substrate** (chainId ${network.chainId}). Real gas weight; no explorer link.`);
  } else {
    out.push(`Run target: **Hardhat in-process EVM** (chainId ${network.chainId}). Numbers are unit gas; production pallet-revive weight may differ within a few percent.`);
  }
  out.push(`Convert gas → DOT/PAS via: \`cost_DOT = gas × gas_price_gwei × 1e-9\`.\n`);

  const totalMeasured = rows.filter((r) => r.gas !== 0n).length;
  const totalSkipped = rows.filter((r) => r.gas === 0n).length;
  out.push(`**Totals:** ${totalMeasured} measured, ${totalSkipped} skipped, ${rows.length} rows.\n`);

  // ── Per-test breakout ────────────────────────────────────────────────
  out.push(`## Per-test breakout\n`);
  out.push(`Every measurement, in deploy order. \`gas = 0\` rows are skipped — see the Skipped tests section for reasons. tx hashes link to the run's transaction; on Paseo / live networks these are Blockscout URLs.\n`);
  out.push(`| # | Role | Operation | Gas | Block | Tx | Note |`);
  out.push(`|---:|---|---|---:|---:|---|---|`);
  rows.forEach((r, i) => {
    const txCell = formatTxCell(r.txHash, network.explorer);
    const blkCell = r.blockNumber ? r.blockNumber.toLocaleString() : "—";
    const gasCell = r.gas === 0n ? "—" : Number(r.gas).toLocaleString();
    const note = (r.note ?? "").replace(/\|/g, "\\|");
    out.push(`| ${i + 1} | ${r.role} | ${r.op} | ${gasCell} | ${blkCell} | ${txCell} | ${note} |`);
  });
  out.push("");

  // ── Skipped tests ────────────────────────────────────────────────────
  const skipped = rows.filter((r) => r.gas === 0n);
  out.push(`## Skipped tests (${skipped.length})\n`);
  if (skipped.length === 0) {
    out.push(`*None — every measured operation produced a gas reading.*\n`);
  } else {
    out.push(`Operations that did not produce a gas number, with the reason recorded by the harness. \`SKIPPED:\` is the prefix the harness writes when an op reverts; rows without that prefix were marked skipped explicitly because the dependency makes the op pointless to run in this environment.\n`);
    out.push(`| Role | Operation | Skip reason |`);
    out.push(`|---|---|---|`);
    for (const r of skipped) {
      const note = (r.note ?? "(no reason recorded)").replace(/\|/g, "\\|");
      out.push(`| ${r.role} | ${r.op} | ${note} |`);
    }
    out.push("");
  }

  // ── Coverage matrix ──────────────────────────────────────────────────
  out.push(`## Coverage matrix\n`);
  out.push(`Every alpha-5 production contract, mapped to its measurement status in this run. \`measured\` = at least one state-changing op got a gas reading; \`skipped\` = present but every op listed for it was skipped; \`unmeasured\` = the contract is deployed but the script doesn't currently exercise any of its state-changing functions.\n`);
  out.push(`| Contract | Status | Ops measured | Notes |`);
  out.push(`|---|---|---:|---|`);
  for (const c of COVERAGE_MATRIX) {
    const measured = c.measuredOps.filter((op) => rows.find((r) => r.op === op && r.gas !== 0n)).length;
    const present  = c.measuredOps.filter((op) => rows.find((r) => r.op === op)).length;
    let status: string;
    if (measured > 0) status = "✓ measured";
    else if (present > 0) status = "✗ skipped";
    else if (c.measuredOps.length === 0) status = "○ unmeasured";
    else status = "○ unmeasured";
    out.push(`| ${c.contract} | ${status} | ${measured}/${c.measuredOps.length || "—"} | ${c.notes ?? ""} |`);
  }
  out.push("");

  // ── L/M/H cost projection per role ───────────────────────────────────
  out.push(`## Cost projection: Low / Medium / High per role\n`);
  out.push(`For each role, the medium baseline reflects a realistic typical operator/user. Low = baseline × ${TIER_MULTIPLIERS.Low}, High = baseline × ${TIER_MULTIPLIERS.High}. Multiplier applies uniformly across every op for that role.\n`);
  out.push(`Cost columns assume the **Hub conservative (5 gwei)** scenario unless otherwise noted; full L/M/H × scenario sweep follows.\n`);

  for (const baseline of ROLE_BASELINES) {
    out.push(`### ${baseline.role}\n`);
    out.push(`> ${baseline.description}\n`);
    out.push(`| Operation | Gas | Medium daily ops | Rationale |`);
    out.push(`|---|---:|---:|---|`);
    for (const op of baseline.ops) {
      const r = rows.find((r) => r.role === baseline.role && r.op === op.op);
      const gas = r?.gas ?? 0n;
      const gasCell = gas === 0n ? "—" : Number(gas).toLocaleString();
      out.push(`| ${op.op} | ${gasCell} | ${op.daily.toFixed(4)} | ${op.rationale} |`);
    }
    out.push("");

    // L/M/H × gas-price table for this role
    out.push(`| Tier | ops/day | ops/mo | ops/yr | ${GAS_PRICE_SCENARIOS.map((s) => `${s.gwei}gwei DOT/yr`).join(" | ")} | DOT/month @ 5gwei |`);
    out.push(`|---|---:|---:|---:|${GAS_PRICE_SCENARIOS.map(() => "---:").join("|")}|---:|`);
    for (const tier of TIER_ORDER) {
      const mult = TIER_MULTIPLIERS[tier];
      const dailyOps = baseline.ops.reduce((s, o) => s + o.daily * mult, 0);
      const tierGas = sumRoleTierGas(baseline.role, tier);
      const yearly = GAS_PRICE_SCENARIOS.map((s) => fmt(tierGas * s.gwei * 1e-9));
      const monthlyAt5 = (tierGas * 5e-9) / 12;
      out.push(`| ${tier} | ${fmt(dailyOps)} | ${fmt(dailyOps * 30)} | ${fmt(dailyOps * 365)} | ${yearly.join(" | ")} | ${fmt(monthlyAt5)} |`);
    }
    out.push("");
  }

  // ── Cross-role rollup ────────────────────────────────────────────────
  out.push(`## Cross-role rollup (Medium tier, monthly + yearly)\n`);
  out.push(`Per-actor totals at the Medium baseline. Each row is one operator of that role; multiply by the number of actors to estimate aggregate network spend.\n`);
  out.push(`| Role | Gas/yr | ${GAS_PRICE_SCENARIOS.map((s) => `DOT/mo @ ${s.gwei}gwei`).join(" | ")} | ${GAS_PRICE_SCENARIOS.map((s) => `DOT/yr @ ${s.gwei}gwei`).join(" | ")} |`);
  out.push(`|---|---:|${GAS_PRICE_SCENARIOS.map(() => "---:").join("|")}|${GAS_PRICE_SCENARIOS.map(() => "---:").join("|")}|`);
  for (const baseline of ROLE_BASELINES) {
    const yearGas = sumRoleTierGas(baseline.role, "Medium");
    const monthCells = GAS_PRICE_SCENARIOS.map((s) => fmt((yearGas * s.gwei * 1e-9) / 12));
    const yearCells = GAS_PRICE_SCENARIOS.map((s) => fmt(yearGas * s.gwei * 1e-9));
    out.push(`| ${baseline.role} | ${Math.round(yearGas).toLocaleString()} | ${monthCells.join(" | ")} | ${yearCells.join(" | ")} |`);
  }
  out.push("");

  // Combined network economy view ───────────────────────────────────────────
  out.push(`## Combined network economy (annual fee burn)\n`);
  out.push(`Three sample networks at conservative Hub pricing (5 gwei). Sum across`);
  out.push(`all actor classes at the baseline tier for each. The hot path (relays +`);
  out.push(`stake-root reporters) is included from the per-role projection above.\n`);

  // Per-actor annual DOT @ 5 gwei, computed from the new L/M/H model
  // at the Medium tier (= baseline). The downstream CPM/halving
  // analysis sections were written against the old tier model; in the
  // new model "Typical/Active/Regular/Standard" all map to "Medium".
  const userTypical_DOT  = sumRoleTierGas("User",       "Medium") * 5e-9;
  const pubActive_DOT    = sumRoleTierGas("Publisher",  "Medium") * 5e-9;
  const advRegular_DOT   = sumRoleTierGas("Advertiser", "Medium") * 5e-9;
  const relay_DOT        = sumRoleTierGas("Relay",      "Medium") * 5e-9;
  const reporterV1_DOT   = sumRoleTierGas("Reporter V1","Medium") * 5e-9;
  const reporterV2_DOT   = sumRoleTierGas("Reporter V2","Medium") * 5e-9;

  const scenarios: Array<{ label: string; users: number; pubs: number; advs: number; relays: number; v1: number; v2: number }> = [
    { label: "Small (community)",   users: 100,      pubs: 10,   advs: 5,   relays: 1,  v1: 1, v2: 1 },
    { label: "Medium (growth)",     users: 10_000,   pubs: 200,  advs: 50,  relays: 2,  v1: 3, v2: 5 },
    { label: "Large (at-scale)",    users: 1_000_000,pubs: 2_000,advs: 500, relays: 10, v1: 5, v2: 20 },
  ];
  out.push(`| Network | Users | Publishers | Advertisers | Relays | V1 Reporters | V2 Reporters | Users DOT | Pubs DOT | Advs DOT | Relays DOT | Reporters DOT | **Total DOT/yr** |`);
  out.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const s of scenarios) {
    const uDOT  = userTypical_DOT * s.users;
    const pDOT  = pubActive_DOT * s.pubs;
    const aDOT  = advRegular_DOT * s.advs;
    const rDOT  = relay_DOT * s.relays;
    const rpDOT = reporterV1_DOT * s.v1 + reporterV2_DOT * s.v2;
    const tot   = uDOT + pDOT + aDOT + rDOT + rpDOT;
    out.push(`| ${s.label} | ${s.users.toLocaleString()} | ${s.pubs} | ${s.advs} | ${s.relays} | ${s.v1} | ${s.v2} | ${uDOT.toFixed(2)} | ${pDOT.toFixed(2)} | ${aDOT.toFixed(2)} | ${rDOT.toFixed(2)} | ${rpDOT.toFixed(2)} | **${tot.toFixed(2)}** |`);
  }
  out.push("");

  // ─── Minimum viable CPM (when users self-settle) ─────────────────────────
  out.push(`## Minimum viable CPM — economics by batching cadence\n`);
  out.push(`When users batch their own impressions and settle directly (no commercial relay`);
  out.push(`taking a margin), the binding economic constraint is the user's own settlement-tx`);
  out.push(`gas cost. This section derives the minimum CPM (DOT per 1,000 impressions) at`);
  out.push(`which a user breaks even on a self-settle workflow at various batching cadences.\n`);

  out.push(`**Revenue split assumption:** publisher 50% / user 37.5% / protocol 12.5%`);
  out.push(`(per the BM-ECO benchmark suite). Users earn 37.5% of CPM × imps_settled.\n`);

  // Gas model: per-tx overhead + per-claim marginal. Derived from measurements.
  const gas1  = Number(rows.find(r => r.role === "Relay" && r.op === "settleClaims (1 claim × 100 imps)")?.gas ?? 0n);
  const gas5  = Number(rows.find(r => r.role === "Relay" && r.op === "settleClaims (5 claims × 100 imps)")?.gas ?? 0n);
  const gas10 = Number(rows.find(r => r.role === "Relay" && r.op === "settleClaims (10 claims × 100 imps)")?.gas ?? 0n);
  // Two-point fit from 1 and 5: marginalPerClaim = (gas5 - gas1)/4, base = gas1 - marginalPerClaim
  const marginalPerClaim = (gas5 - gas1) / 4;
  const txOverhead = gas1 - marginalPerClaim;

  out.push(`**Gas model (linear fit from measurements):**`);
  out.push(`- 1-claim batch: ${gas1.toLocaleString()} gas`);
  out.push(`- 5-claim batch: ${gas5.toLocaleString()} gas`);
  out.push(`- 10-claim batch: ${gas10.toLocaleString()} gas`);
  out.push(`- Fitted: \`gas(n) = ${Math.round(txOverhead).toLocaleString()} + ${Math.round(marginalPerClaim).toLocaleString()} × n\`\n`);

  // Each user-settle tx contains 1 claim (one user's own batch of imps).
  // imps_per_tx = how many impressions the user packs into a single eventCount.
  // batches_per_yr = settles per user per year.
  // user pays gas: gas1 × batches_per_yr (single claim, but variable eventCount)
  // user earns: 0.375 × CPM × imps_per_yr
  // imps_per_yr ≈ batches_per_yr × imps_per_tx
  // Break-even: 0.375 × CPM × imps_per_yr ≥ gas_cost × gas_price + user_overhead_cost
  // → CPM ≥ (gas_cost × gas_price + user_overhead_cost) / (0.375 × imps_per_yr)

  out.push(`### Break-even CPM by user batching cadence\n`);
  out.push(`Assumes each user receives **10 impressions/day on average** (3,650/yr).`);
  out.push(`Higher-traffic users hit break-even at proportionally lower CPMs.\n`);

  // User overhead per year (non-settle ops): zkStake setup + 12 reports + 12 withdraws
  const userOverheadGas = Number(rows.find(r => r.role === "User" && r.op === "zkStake.depositWith")?.gas ?? 0n) * (1/365) * 365
                       + Number(rows.find(r => r.role === "User" && r.op === "zkStake.requestWithdrawal")?.gas ?? 0n) * (1/365) * 365
                       + Number(rows.find(r => r.role === "User" && r.op === "reportPage (reason 1)")?.gas ?? 0n) * (1/30) * 365
                       + Number(rows.find(r => r.role === "User" && r.op === "vault.withdrawUser")?.gas ?? 0n) * (1/30) * 365;

  const impsPerYr = 3650;

  const cadences: Array<{ label: string; batchesPerYr: number }> = [
    { label: "Daily",       batchesPerYr: 365 },
    { label: "Weekly",      batchesPerYr: 52 },
    { label: "Bi-weekly",   batchesPerYr: 26 },
    { label: "Monthly",     batchesPerYr: 12 },
    { label: "Quarterly",   batchesPerYr: 4 },
    { label: "Yearly",      batchesPerYr: 1 },
  ];

  out.push(`| Cadence | Settles/yr | Settle gas/yr | User overhead gas/yr | Total gas/yr | Min CPM @ 1 gwei | Min CPM @ 5 gwei | Min CPM @ 50 gwei |`);
  out.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const c of cadences) {
    // Each settle is 1 claim × eventCount imps. We measured gas1 with eventCount=100; gas is roughly fixed
    // regardless of eventCount (just bigger numbers, same storage writes), so use gas1 per settle.
    const settleGasYr = gas1 * c.batchesPerYr;
    const totalGas = settleGasYr + userOverheadGas;
    const cells = GAS_PRICE_SCENARIOS.map(s => {
      const annualFeeDOT = totalGas * s.gwei * 1e-9;
      // Break-even: 0.375 × CPM × (impsPerYr/1000) = annualFeeDOT
      // CPM = annualFeeDOT / (0.375 × impsPerYr / 1000) = annualFeeDOT × 1000 / (0.375 × impsPerYr)
      const minCPM = annualFeeDOT * 1000 / (0.375 * impsPerYr);
      return fmt(minCPM);
    });
    out.push(`| ${c.label} | ${c.batchesPerYr} | ${Math.round(settleGasYr).toLocaleString()} | ${Math.round(userOverheadGas).toLocaleString()} | ${Math.round(totalGas).toLocaleString()} | ${cells[0]} | ${cells[1]} | ${cells[2]} |`);
  }
  out.push("");

  out.push(`### Sensitivity to user traffic\n`);
  out.push(`At 5 gwei (Hub conservative), monthly batching, with **N impressions/year per user**:\n`);
  out.push(`| Imps/yr | Min CPM | Annual user fee | Annual user revenue (at min CPM) |`);
  out.push(`|---:|---:|---:|---:|`);
  for (const impsYr of [365, 1000, 3650, 10000, 36500, 100000]) {
    const settleGasYr = gas1 * 12;
    const totalGas = settleGasYr + userOverheadGas;
    const annualFeeDOT = totalGas * 5 * 1e-9;
    const minCPM = annualFeeDOT * 1000 / (0.375 * impsYr);
    const revenueAtMin = 0.375 * minCPM * impsYr / 1000;
    out.push(`| ${impsYr.toLocaleString()} | ${fmt(minCPM)} | ${fmt(annualFeeDOT)} | ${fmt(revenueAtMin)} |`);
  }
  out.push("");

  out.push(`### What "viable for all" looks like\n`);
  out.push(`Each party's economics at 5 gwei, **monthly user-batching cadence, 3,650 imps/user/yr**:\n`);
  const monthlySettleGas = gas1 * 12;
  const userAnnualGas = monthlySettleGas + userOverheadGas;
  const userAnnualFee = userAnnualGas * 5e-9;
  const userMinCPM = userAnnualFee * 1000 / (0.375 * impsPerYr);

  // Publisher: aggregate across many users. Assume 100 users/publisher, 365 imps/user/yr settled = 36,500 imps/yr
  const pubActiveGas = sumRoleTierGas("Publisher", "Medium");
  const pubAnnualFee = pubActiveGas * 5e-9;
  const pubImpsYr = 100 * impsPerYr;       // 100-user publisher
  const pubMinCPM = pubAnnualFee * 1000 / (0.5 * pubImpsYr);

  // Advertiser: pays full CPM. Fees are setup, not per-imp. Their viability is ROI on the ad.
  const advRegularGas = sumRoleTierGas("Advertiser", "Medium");
  const advAnnualFee = advRegularGas * 5e-9;

  out.push(`| Party | Assumptions | Annual fee (DOT) | Min CPM to break even (DOT) |`);
  out.push(`|---|---|---:|---:|`);
  out.push(`| User | Monthly settle, 3,650 imps/yr | ${fmt(userAnnualFee)} | ${fmt(userMinCPM)} |`);
  out.push(`| Publisher (Active) | 100 users × 3,650 imps/yr = 365k imps/yr | ${fmt(pubAnnualFee)} | ${fmt(pubMinCPM)} |`);
  out.push(`| Advertiser (Regular) | Fees independent of imps; need ROI > CPM | ${fmt(advAnnualFee)} | n/a (volume-independent) |`);
  out.push(`| Relay (Medium) | If used; otherwise users self-settle | ${fmt(sumRoleTierGas("Relay", "Medium") * 5e-9)} | n/a (operator margin model) |`);
  out.push("");

  out.push(`**Headline:** at conservative Hub pricing with monthly user-batching, the binding`);
  out.push(`constraint is the user side. Minimum CPM for a user receiving 3,650 imps/year to`);
  out.push(`break even on fees alone is **${fmt(userMinCPM)} DOT** per 1,000 impressions.`);
  out.push(`Above that, every party in the chain is net-positive on fees alone (revenue redistribution`);
  out.push(`and DATUM rewards are upside on top).\n`);

  // ─── DATUM token monetary policy (Path H per TOKENOMICS.md §3.3) ─────────
  const gasPerKimp = (gas1 * 12 + userOverheadGas) * 5e-9 * 1000 / impsPerYr; // DOT/1000 imps user must net
  const gasPerYr = (gas1 * 12 + userOverheadGas) * 5e-9; // DOT/yr at 5 gwei
  const initialRate = 19;                  // INITIAL_RATE (DATUM/DOT, bootstrap; adapts immediately)
  const minRate = 0.001;
  const maxRate = 200;
  const halvingYears = 7;                  // HALVING_PERIOD (baked, non-governable)
  const daysPerEpoch = 2555;               // 7 × 365
  const epoch0Budget = 47_500_000;         // first epoch budget; halves each subsequent epoch
  const epoch0DailyCap = epoch0Budget / daysPerEpoch;  // 18,591 DATUM/day
  const settlementCap = 89_000_000;        // 89M settlement slice of MINTABLE_CAP
  const totalEmittable = 95_000_000;       // full 95M emittable (bootstrap + vesting + settlement)
  const userShare = 0.55;                  // 55% to user
  const cpmDOT = 0.20;                     // illustrative CPM
  // Legacy alias for downstream sections that pre-date the Path H rewrite.
  // Reflects the bootstrap rate; in steady state the rate adapts dynamically.
  const baseMintRate = initialRate;

  out.push(`### DATUM token mint emission (Path H — TOKENOMICS §3.3)\n`);
  out.push(`The protocol's intended emission model is **Path H: baked halvings + adaptive rate**.`);
  out.push(`Mirroring Bitcoin's two-layer design: outer halving + inner difficulty adjustment.\n`);
  out.push(`**Outer (baked, non-governable):**`);
  out.push(`- Total emittable supply: **95M DATUM** (after 5M founder premint).`);
  out.push(`- Halving period: **7 calendar years**.`);
  out.push(`- Epoch budgets (geometric): **47.5M, 23.75M, 11.875M, 5.94M, 2.97M, ...** Sums to exactly 95M.`);
  out.push(`- Daily cap derived: \`epoch_budget / 2,555 days\`. Epoch 0 = **18,591 DATUM/day**.\n`);
  out.push(`**Inner (dynamic adjustment, permissionless):**`);
  out.push(`- Per-DOT mint rate adapts every 1 day (governance-tunable [1, 90] days) to target the daily cap.`);
  out.push(`- Bounded: **MIN_RATE 0.001**, **MAX_RATE 200** DATUM/DOT.`);
  out.push(`- Max change per adjustment period: **2×** (anti-volatility).`);
  out.push(`- Bootstrap rate: 19 DATUM/DOT; adapts on first adjustment.\n`);
  out.push(`**Per-claim mint:** \`totalMint = DOT_paid × currentRate\`, capped by remaining daily +`);
  out.push(`epoch budgets. Split user 55% / publisher 40% / advertiser 5% (baked, not governable).\n`);
  out.push(`> **Implementation status:** Path H is **implemented** in \`DatumEmissionEngine.sol\``);
  out.push(`> (commit de9a4a6+). \`DatumSettlement\` delegates the mint amount to the engine when wired;`);
  out.push(`> the legacy flat-rate path remains as a bootstrap fallback. Engine state, \`rollEpoch()\`,`);
  out.push(`> \`adjustRate()\`, and the per-batch cap clipping all match the spec.\n`);

  out.push(`### Per-epoch emission curve (baked schedule)\n`);
  out.push(`Hardwired geometric halving over 70 years (10 epochs):\n`);
  out.push(`| Epoch | Years | Epoch budget (DATUM) | Daily cap (DATUM) | Cumulative (DATUM) | % of 95M |`);
  out.push(`|---:|---|---:|---:|---:|---:|`);
  let cumBudget = 0;
  for (let e = 0; e < 10; e++) {
    const startYr = e * halvingYears;
    const endYr = (e + 1) * halvingYears;
    const epochBudget = epoch0Budget / Math.pow(2, e);
    const dailyCap = epochBudget / daysPerEpoch;
    cumBudget += epochBudget;
    const pctTotal = (cumBudget / totalEmittable) * 100;
    out.push(`| ${e} | ${startYr}–${endYr} | ${fmt(epochBudget)} | ${fmt(dailyCap)} | ${fmt(cumBudget)} | ${fmt(pctTotal)}% |`);
  }
  out.push("");
  out.push(`The geometric series converges to **exactly 95M** (50% + 25% + 12.5% + ... = 100% of 95M).`);
  out.push(`Total dilution is bounded by construction; halving cadence is baked.\n`);

  out.push(`### Dynamic rate at different network volumes (epoch 0, daily cap 18,591 DATUM/day)\n`);
  out.push(`The adjustment loop drives the rate toward \`daily_cap / observed_DOT_volume\`.`);
  out.push(`Three rate-binding regimes:\n`);
  out.push(`| Daily DOT volume | Required rate to hit cap | Effective rate (clamped) | Effective daily mint | Regime |`);
  out.push(`|---:|---:|---:|---:|---|`);
  const dailyVolumes = [1, 10, 93, 1_000, 10_000, 100_000, 1_000_000, 18_591_000, 100_000_000];
  for (const v of dailyVolumes) {
    const requiredRate = epoch0DailyCap / v;
    let effRate: number, regime: string;
    if (requiredRate > maxRate) { effRate = maxRate; regime = "MAX_RATE clamp (cap not filled)"; }
    else if (requiredRate < minRate) { effRate = minRate; regime = "MIN_RATE clamp (daily cap clips mint)"; }
    else { effRate = requiredRate; regime = "rate adapts to fill cap exactly"; }
    const effMint = Math.min(v * effRate, epoch0DailyCap);
    out.push(`| ${fmt(v)} | ${fmt(requiredRate)} | ${fmt(effRate)} | ${fmt(effMint)} | ${regime} |`);
  }
  out.push("");
  out.push(`**Cap-fill threshold:** at volume ≥ **${fmt(epoch0DailyCap / maxRate)} DOT/day** the rate is below MAX_RATE,`);
  out.push(`so the daily cap is fully filled and per-recipient DATUM scales with their share of total volume.`);
  out.push(`Below this volume, the rate is pinned at 200 DATUM/DOT and total daily emission < cap.\n`);

  out.push(`### Per-user DATUM revenue at different network sizes (epoch 0, steady state)\n`);
  out.push(`Assumes daily cap is filled (network volume above ${fmt(epoch0DailyCap / maxRate)} DOT/day),`);
  out.push(`each user receives an equal share of total settlement volume, 0.20 DOT CPM, 3,650 imps/user/yr:\n`);
  out.push(`| Users | Daily DOT settled | User's share of daily mint (DATUM) | Annual DATUM per user | Annual DOT-eq at DATUM/DOT = 0.10 |`);
  out.push(`|---:|---:|---:|---:|---:|`);
  for (const n of [1_000, 10_000, 100_000, 1_000_000, 10_000_000]) {
    const dailyDot = n * impsPerYr / 365 * cpmDOT / 1000;
    let effRate: number;
    const requiredRate = epoch0DailyCap / dailyDot;
    if (requiredRate > maxRate) effRate = maxRate;
    else if (requiredRate < minRate) effRate = minRate;
    else effRate = requiredRate;
    const totalDailyMint = Math.min(dailyDot * effRate, epoch0DailyCap);
    const userDailyMint = totalDailyMint * userShare / n;
    const userAnnualMint = userDailyMint * 365;
    const userAnnualDOTeq = userAnnualMint * 0.10;
    out.push(`| ${fmt(n)} | ${fmt(dailyDot)} | ${fmt(userDailyMint)} | ${fmt(userAnnualMint)} | ${fmt(userAnnualDOTeq)} |`);
  }
  out.push("");
  out.push(`Notice the **counter-intuitive dynamic**: as the network grows past the cap-fill threshold,`);
  out.push(`each user's DATUM share *shrinks* (fixed cap divided across more users). The user-side`);
  out.push(`subsidy is generous in early adoption and dilutes as the network scales — by design, to`);
  out.push(`reward bootstrap participants more than late-arrivals.\n`);

  out.push(`### DATUM mint as a user-side subsidy (dynamic rate)\n`);
  out.push(`The user receives **55% of every DATUM mint**, but under Path H the per-DOT rate is`);
  out.push(`*dynamic* — it adapts daily to target the epoch's daily cap. The user's effective`);
  out.push(`revenue share per impression depends on:`);
  out.push(`1. **DATUM/DOT spot price P** (market-determined)`);
  out.push(`2. **Current rate** (adapts to volume — see table above)`);
  out.push(`3. **Network volume share** (per-user share of total daily DOT settled)\n`);
  out.push(`\`share_eff_DOT_per_imp = 0.000375 × CPM_DOT + 0.55 × (DOT_per_imp × currentRate) × P\``);
  out.push("");
  out.push(`Solving at 5 gwei, 3,650 imps/user/yr, **epoch 0 daily cap saturated** (1M users +),`);
  out.push(`rate adapts to keep total daily mint = 18,591 DATUM. Per-user daily DATUM ≈ 0.01 (1M users):\n`);
  out.push(`| DATUM/DOT price (P) | Effective rate (1M users, 0.20 CPM) | User share of cap (DATUM/yr) | DOT-eq subsidy per user/yr | User-side floor reduction |`);
  out.push(`|---:|---:|---:|---:|---:|`);
  const datumPrices = [0, 0.001, 0.01, 0.05, 0.1, 0.5, 1, 2];
  // Compute effective rate at 1M-user steady state
  const dailyDot_1M = 1_000_000 * impsPerYr / 365 * cpmDOT / 1000;
  let effRate_1M: number;
  {
    const req = epoch0DailyCap / dailyDot_1M;
    if (req > maxRate) effRate_1M = maxRate;
    else if (req < minRate) effRate_1M = minRate;
    else effRate_1M = req;
  }
  const userDailyMint_1M = epoch0DailyCap * userShare / 1_000_000;
  const userAnnualMint_1M = userDailyMint_1M * 365;
  for (const P of datumPrices) {
    const userAnnualDOTeq = userAnnualMint_1M * P;
    // Effective user share per imp = 0.375 DOT/1kimp DOT-share + DATUM bonus
    // Annual user revenue per 1k imps = 0.375 × CPM + (annual DATUM/yr × P / imps_per_yr × 1000)
    // For break-even calc: gasPerYr = 0.375 × CPM × impsPerYr/1000 + userAnnualDOTeq
    // → CPM = (gasPerYr - userAnnualDOTeq) × 1000 / (0.375 × impsPerYr)
    const cpmReq = (gasPerYr - userAnnualDOTeq) * 1000 / (0.375 * impsPerYr);
    const cpmDisplay = cpmReq <= 0 ? "**0 (DATUM covers fees)**" : fmt(cpmReq);
    out.push(`| ${fmt(P)} | ${fmt(effRate_1M)} | ${fmt(userAnnualMint_1M)} | ${fmt(userAnnualDOTeq)} | ${cpmDisplay} |`);
  }
  out.push("");
  const subsidyCrossover = gasPerYr / userAnnualMint_1M;
  out.push(`**Crossover at DATUM/DOT = ${fmt(subsidyCrossover)}**: at this spot ratio the DATUM mint`);
  out.push(`subsidy alone covers the user's annual gas cost — any positive DOT CPM is pure upside.\n`);
  out.push(`Note: the dynamic-rate dilution means **early-network users get much higher DATUM/imp**`);
  out.push(`than late-network users — the daily cap is fixed but the divisor (user count) grows.\n`);

  out.push(`### Combined revenue lens (epoch 0, daily cap saturated, 1M users)\n`);
  out.push(`Three regimes for the user's net per-1k-imps compensation at conservative Hub pricing:\n`);
  out.push(`| Regime | DOT CPM needed | DATUM revenue per user/yr | Notes |`);
  out.push(`|---|---|---|---|`);
  const cpmAt0 = userMinCPM;
  const cpmAt10pct = Math.max(0, (gasPerYr - userAnnualMint_1M * 0.1) * 1000 / (0.375 * impsPerYr));
  const cpmAtParity = Math.max(0, (gasPerYr - userAnnualMint_1M * 1.0) * 1000 / (0.375 * impsPerYr));
  out.push(`| **DATUM at $0 (worthless token)** | ≥ ${fmt(cpmAt0)} DOT | ${fmt(userAnnualMint_1M)} DATUM (no spot value) | Pure DOT economics; DATUM is upside |`);
  out.push(`| **DATUM at 10% of DOT** | ≥ ${fmt(cpmAt10pct)} DOT | ${fmt(userAnnualMint_1M * 0.1)} DOT-eq/yr | Subsidy reduces floor |`);
  out.push(`| **DATUM at parity with DOT** | ≥ ${fmt(cpmAtParity)} DOT | ${fmt(userAnnualMint_1M)} DOT-eq/yr | DATUM dominates compensation |`);
  out.push("");

  // ─── Advertiser ROI break-even ──────────────────────────────────────────
  out.push(`### Advertiser ROI break-even\n`);
  out.push(`An advertiser pays CPM (cost per 1,000 impressions) and extracts value via clicks /`);
  out.push(`conversions / brand lift / attribution. Per-impression value (**VPI**) is the`);
  out.push(`fundamental economic input. Their break-even condition:\n`);
  out.push(`\`VPI × imps_settled ≥ CPM × (imps_settled/1000) + setup_gas_DOT\`\n`);
  out.push(`Solving for the maximum CPM they can pay while ROI ≥ 0:`);
  out.push(`\`MaxCPM = 1000 × VPI − (setup_gas_DOT × 1000 / imps_settled)\``);
  out.push("");

  const setupGasAdv = Number(rows.find(r => r.role === "Advertiser" && r.op === "createCampaign")?.gas ?? 0n)
                    + Number(rows.find(r => r.role === "Advertiser" && r.op === "vote (own campaign, aye)")?.gas ?? 0n);
  const setupGwei = 5;
  const setupDOT = setupGasAdv * setupGwei * 1e-9;
  out.push(`Measured setup gas per campaign: \`createCampaign + vote = ${setupGasAdv.toLocaleString()} gas\``);
  out.push(`= **${setupDOT.toFixed(5)} DOT** at 5 gwei. Amortises linearly across the campaign's settled imps.\n`);

  out.push(`### Maximum CPM by value-per-impression × campaign size (5 gwei)\n`);
  out.push(`VPI scenarios are stated in DOT-equivalent at $5/DOT for intuition. Web2 reference points:`);
  out.push(`brand awareness ~$0.10 CPM value, programmatic display ~$1, retargeting ~$10,`);
  out.push(`direct-response ~$100, high-intent search ~$1,000.\n`);
  const VPI_SCENARIOS = [
    { label: "Brand awareness", usd: 0.0001 },  // $0.10 CPM
    { label: "Programmatic display", usd: 0.001 },  // $1 CPM
    { label: "Retargeting", usd: 0.01 },  // $10 CPM
    { label: "Direct-response", usd: 0.1 },  // $100 CPM
    { label: "High-intent search", usd: 1.0 },  // $1000 CPM
  ];
  const dotPriceUSD = 5;
  const campaignSizes = [1_000, 10_000, 100_000, 1_000_000, 10_000_000];
  out.push(`| VPI scenario | VPI (USD/imp) | VPI (DOT/imp) | ${campaignSizes.map(n => `Max CPM @ ${n.toLocaleString()} imps`).join(" | ")} |`);
  out.push(`|---|---:|---:|${campaignSizes.map(() => "---:").join("|")}|`);
  for (const v of VPI_SCENARIOS) {
    const vpiDOT = v.usd / dotPriceUSD;
    const cells = campaignSizes.map(n => {
      const setupPerKimp = setupDOT * 1000 / n;
      const maxCPM = 1000 * vpiDOT - setupPerKimp;
      return maxCPM > 0 ? fmt(maxCPM) : `**neg**`;
    });
    out.push(`| ${v.label} | $${v.usd.toFixed(4)} | ${fmt(vpiDOT)} | ${cells.join(" | ")} |`);
  }
  out.push("");

  out.push(`### Viability window (advertiser max CPM − user min CPM)\n`);
  out.push(`The market only clears where advertiser MaxCPM ≥ user MinCPM. With user MinCPM`);
  out.push(`= ${userMinCPM.toFixed(3)} DOT at monthly batching + 3,650 imps/user/yr, computing the`);
  out.push(`viability margin (positive = market clears with that much headroom):\n`);
  out.push(`| VPI scenario | ${campaignSizes.map(n => `Margin @ ${n.toLocaleString()} imps`).join(" | ")} |`);
  out.push(`|---|${campaignSizes.map(() => "---:").join("|")}|`);
  for (const v of VPI_SCENARIOS) {
    const vpiDOT = v.usd / dotPriceUSD;
    const cells = campaignSizes.map(n => {
      const setupPerKimp = setupDOT * 1000 / n;
      const maxCPM = 1000 * vpiDOT - setupPerKimp;
      const margin = maxCPM - userMinCPM;
      if (margin <= 0) return `**no market**`;
      const ratio = maxCPM / userMinCPM;
      return `${fmt(margin)} (${ratio.toFixed(0)}×)`;
    });
    out.push(`| ${v.label} | ${cells.join(" | ")} |`);
  }
  out.push("");

  // Minimum viable campaign size — where setup amortization < 5% of user min CPM
  const minViableImps = setupDOT * 1000 / (0.05 * userMinCPM);
  out.push(`### Minimum viable campaign size\n`);
  out.push(`Setup gas amortises over the campaign's settled imps. For the setup fee to be ≤ 5%`);
  out.push(`of the user-side minimum CPM at 5 gwei:\n`);
  out.push(`\`setup_DOT × 1000 / N ≤ 0.05 × MinCPM_user\` → **N ≥ ${Math.round(minViableImps).toLocaleString()} impressions**\n`);
  out.push(`Below this size, setup overhead becomes a meaningful share of the campaign's cost.`);
  out.push(`Above it, setup is structural rounding error. The recommended minimum campaign size`);
  out.push(`is therefore ~${Math.round(minViableImps / 1000)}k impressions — at $1 CPM that's a $${(minViableImps * 0.001 * dotPriceUSD).toFixed(0)}+ campaign budget.\n`);

  // DATUM-subsidized advertiser economics
  out.push(`### Advertiser economics with DATUM subsidy\n`);
  out.push(`When the advertiser routes part of their per-imp budget through DATUM rewards`);
  out.push(`(via \`Campaigns.rewardPerImpression\`), the cost accounting becomes:\n`);
  out.push(`\`Total cost per imp = DOT_CPM/1000 + DATUM_reward_DOT_eq + setup/imps\``);
  out.push(`\`ROI break-even: VPI ≥ Total cost per imp\`\n`);
  out.push(`Whether the advertiser pays a unit of value in DOT or DATUM is a routing choice —`);
  out.push(`the **total per-impression compensation** is what matters. The economic floor is set`);
  out.push(`by VPI; the mix of DOT vs DATUM lets the advertiser shape the user-acquisition profile`);
  out.push(`(higher DATUM share = stronger network growth incentive; higher DOT share = clearer`);
  out.push(`market price signal).\n`);

  out.push(`**Key takeaway:** at any reasonable VPI ($0.001/imp and up — basically any campaign`);
  out.push(`with measurable conversion intent), the advertiser has 6×–60,000× of CPM headroom`);
  out.push(`above the user-side floor. Campaigns with VPI < $0.0001/imp (pure brand-awareness on`);
  out.push(`small audiences) struggle; everyone else has comfortable margins.\n`);

  // ─── DOT/USD price sensitivity ──────────────────────────────────────────
  out.push(`### DOT/USD price sensitivity\n`);
  out.push(`All previous numbers are DOT-denominated at a baseline of $5/DOT for the USD-side`);
  out.push(`narrative. Gas prices on the chain are denominated in gwei (1e-9 DOT), so as DOT`);
  out.push(`price moves, the DOT-denominated costs stay constant but USD costs scale linearly.`);
  out.push(`Below: headline economics at common DOT price points. **Gas-market repricing is not`);
  out.push(`modelled** — in reality, a long-term DOT spike would likely see the network reprice`);
  out.push(`gas downward to keep real-world fees stable.\n`);

  const DOT_PRICES = [1, 2, 5, 10, 20, 50, 100];

  // 1. User min CPM
  out.push(`**1. User minimum CPM (monthly batching, 3,650 imps/yr, 5 gwei)** — constant in DOT, varies in USD:\n`);
  out.push(`| DOT price | User min CPM (DOT) | User min CPM (USD) | $/1k imps |`);
  out.push(`|---:|---:|---:|---:|`);
  for (const p of DOT_PRICES) {
    out.push(`| $${p} | ${userMinCPM.toFixed(4)} | $${(userMinCPM * p).toFixed(4)} | $${(userMinCPM * p).toFixed(4)} |`);
  }
  out.push("");

  // 2. Advertiser max CPM at programmatic-display VPI ($0.001/imp)
  out.push(`**2. Advertiser max CPM at programmatic-display VPI ($0.001/imp), 10k-imp campaign:**\n`);
  out.push(`Note: VPI is USD-denominated (advertiser's value per impression doesn't depend on DOT`);
  out.push(`price). Max CPM in DOT depends on VPI ÷ DOT_price. Bigger DOT = lower max CPM in DOT,`);
  out.push(`but USD compensation stays constant.\n`);
  out.push(`| DOT price | VPI (DOT/imp) | Max CPM (DOT) | Max CPM (USD) | Viability margin vs user floor (DOT) |`);
  out.push(`|---:|---:|---:|---:|---:|`);
  const programmaticVPI_USD = 0.001;
  const campaignSize10k = 10_000;
  const setupPerKimp10k = setupDOT * 1000 / campaignSize10k;
  for (const p of DOT_PRICES) {
    const vpiDOT = programmaticVPI_USD / p;
    const maxCPM_DOT = 1000 * vpiDOT - setupPerKimp10k;
    const margin = maxCPM_DOT - userMinCPM;
    const marginCell = margin > 0 ? `${margin.toFixed(4)} (${(maxCPM_DOT/userMinCPM).toFixed(1)}×)` : "**no market**";
    out.push(`| $${p} | ${fmt(vpiDOT)} | ${fmt(maxCPM_DOT)} | $${fmt(maxCPM_DOT * p)} | ${marginCell} |`);
  }
  out.push("");
  out.push(`At **$50+/DOT** with no gas-market repricing, programmatic display starts to fail to`);
  out.push(`clear the user-side floor — gas costs (constant in DOT) consume the entire VPI in USD terms.`);
  out.push(`Either the chain reprices gas (validators lower base fee) or higher-VPI campaigns dominate.\n`);

  // 3. Network annual fee burn in USD
  out.push(`**3. Network annual fee burn — USD across DOT prices (5 gwei, conservative Hub):**\n`);
  out.push(`Same DOT figures from the Combined-network-economy section, multiplied by DOT price.\n`);
  const networkScenarios: Array<{ label: string; dotTotal: number }> = [
    { label: "Small (community)",   dotTotal: 68.45    },
    { label: "Medium (growth)",     dotTotal: 301.72   },
    { label: "Large (at-scale)",    dotTotal: 10549.85 },
  ];
  out.push(`| Network | DOT/yr | ${DOT_PRICES.map(p => `$${p}/DOT`).join(" | ")} |`);
  out.push(`|---|---:|${DOT_PRICES.map(() => "---:").join("|")}|`);
  for (const s of networkScenarios) {
    const cells = DOT_PRICES.map(p => `$${(s.dotTotal * p).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    out.push(`| ${s.label} | ${s.dotTotal.toFixed(0)} | ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push(`At million-user scale, network gas spend ranges from **~$10k/year** (at $1 DOT) to`);
  out.push(`**~$1M/year** (at $100 DOT) before any gas-market repricing. The 100× spread is the`);
  out.push(`scenario uncertainty operators should plan around.\n`);

  // 4. DATUM mint emission volume (protocol-side) across user counts
  out.push(`**4. DATUM mint per year at default rate (mintRatePerDot = 19, 0.20 DOT CPM):**\n`);
  out.push(`Token-volume emitted by the protocol on every settled batch. Independent of DOT price`);
  out.push(`since the rate is DATUM-per-DOT-settled.\n`);
  out.push(`| Users | DOT settled/yr | DATUM minted/yr |`);
  out.push(`|---:|---:|---:|`);
  for (const n of [10_000, 100_000, 1_000_000]) {
    const annualSettleDOT = n * impsPerYr * cpmDOT / 1000;
    const annualMint = annualSettleDOT * baseMintRate;
    out.push(`| ${n.toLocaleString()} | ${fmt(annualSettleDOT)} | ${fmt(annualMint)} |`);
  }
  out.push("");

  // 5. Minimum viable campaign size in USD
  out.push(`**5. Minimum viable campaign size in USD:**\n`);
  out.push(`Setup gas (~${setupGasAdv.toLocaleString()} gas = ${setupDOT.toFixed(5)} DOT at 5 gwei) translated to`);
  out.push(`minimum advertiser budget at $1 CPM (where overhead is ≤ 5% of CPM):\n`);
  out.push(`| DOT price | Setup (USD) | Min campaign budget at $1 CPM | Min budget at $0.10 CPM |`);
  out.push(`|---:|---:|---:|---:|`);
  for (const p of DOT_PRICES) {
    const setupUSD = setupDOT * p;
    // Min imps where setup ≤ 5% of CPM (at $1 CPM USD): setup_USD × 1000 / imps ≤ 0.05 × 1
    // → imps ≥ setup_USD × 1000 / 0.05 = setup_USD × 20000
    // → budget = imps × 1USD/1000 = setup_USD × 20
    const minBudget_1CPM = setupUSD * 20;
    const minBudget_10cents = setupUSD * 200;
    out.push(`| $${p} | $${setupUSD.toFixed(5)} | $${minBudget_1CPM.toFixed(2)} | $${minBudget_10cents.toFixed(2)} |`);
  }
  out.push("");
  out.push(`Setup overhead scales linearly with DOT price. At $100/DOT, even tiny campaigns ($66 budget`);
  out.push(`at $1 CPM) clear the overhead threshold — at $1/DOT it's well under a dollar.\n`);

  out.push(`### DOT-price decision summary\n`);
  out.push(`- **$1–$5/DOT** (current): all campaign types viable, generous margins everywhere.`);
  out.push(`- **$10–$20/DOT**: programmatic display still clears with 1–3× margin; brand awareness`);
  out.push(`  remains uneconomical; everything direct-response and above is comfortable.`);
  out.push(`- **$50+/DOT** (bull case, no gas repricing): programmatic display crowds out, only`);
  out.push(`  retargeting+ stays viable. This is the regime where the gas-market would need to`);
  out.push(`  reprice (validators set lower base fee) OR a Hub upgrade lowers fees.`);
  out.push(`- **DATUM peg to USD** is recommended early — auto-rebases the subsidy as DOT moves.\n`);

  // ─── 70-year halving projection ─────────────────────────────────────────
  out.push(`### 70-year halving projection\n`);
  out.push(`Long-horizon model accounting for periodic halvings of both DOT issuance and DATUM`);
  out.push(`emission. Each halving compresses circulating-supply growth, which (under standard`);
  out.push(`monetary scarcity assumptions) tends to push price upward. The model is illustrative —`);
  out.push(`actual price paths are subject to demand-side dynamics, gas-market re-pricing,`);
  out.push(`and macro forces this exercise can't predict.\n`);

  out.push(`**Assumptions:**`);
  out.push(`- DATUM emission follows Path H: **7-year epoch halvings** with daily-cap-driven adaptive rate.`);
  out.push(`- 10 epochs span exactly 70 years; epoch n daily cap = ${epoch0DailyCap.toFixed(0)} / 2^n DATUM/day.`);
  out.push(`- DOT/USD growth: 2× per **DOT halving cycle** (assumed 4-yr — Polkadot's actual cadence).`);
  out.push(`- DATUM/USD growth: 2× per DATUM halving (7-yr) on supply scarcity alone.`);
  out.push(`- Baseline DOT = $5; baseline DATUM/DOT spot ratio = 0.10 (so DATUM ≈ $0.50 at year 0).`);
  out.push(`- Steady-state 1M-user network, 0.20 DOT CPM, monthly user batching, 3,650 imps/user/yr.`);
  out.push(`- Gas held at 5 gwei (no on-chain repricing modelled).\n`);

  const DOT_BASE_USD = 5;
  const DATUM_DOT_RATIO_BASE = 0.10;
  const DOT_HALVING = 4;          // years
  const DATUM_HALVING = halvingYears; // 7 years from Path H
  const programmaticVPI = 0.001;  // USD/imp

  out.push(`**Conservative trajectory (DOT 2× per 4yr, DATUM/DOT 2× per 7yr):**\n`);
  out.push(`The DATUM mint rate adapts to the daily cap, so total DATUM per year = epoch_budget / 7yrs.`);
  out.push(`Per-user DATUM share = (epoch_budget × 55%) / (7yrs × users).\n`);
  out.push(`| Year | Epoch | DOT/USD | DATUM/DOT | Daily cap | Annual mint | User DATUM/yr | DOT-eq subsidy | User min CPM USD | Adv max CPM USD | Viable? |`);
  out.push(`|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|`);
  let cumMintActual = 0;
  for (let yr = 0; yr <= 70; yr += 7) {
    const epoch = Math.floor(yr / DATUM_HALVING);
    const dotHalvingsPassed = Math.floor(yr / DOT_HALVING);
    const datumHalvingsPassed = Math.floor(yr / DATUM_HALVING);
    const dotUSD = DOT_BASE_USD * Math.pow(2, dotHalvingsPassed);
    const datumDotRatio = DATUM_DOT_RATIO_BASE * Math.pow(2, datumHalvingsPassed);
    const epochBudget = epoch0Budget / Math.pow(2, epoch);
    const dailyCap = epochBudget / daysPerEpoch;
    const annualMintCap = dailyCap * 365;
    cumMintActual += annualMintCap * (yr === 0 ? 7 : 7);
    // Per-user DATUM share (assumes 1M users, cap saturated)
    const userAnnualDATUM = annualMintCap * userShare / 1_000_000;
    const userAnnualDOTeq = userAnnualDATUM * datumDotRatio;
    // User effective per-imp share: DOT 0.375 + DATUM subsidy
    // Break-even CPM: (gasPerYr − userAnnualDOTeq) / (0.375 × impsPerYr/1000)
    const cpmReqDOT = Math.max(0, (gasPerYr - userAnnualDOTeq) * 1000 / (0.375 * impsPerYr));
    const userMinCPM_USD = cpmReqDOT * dotUSD;
    // Advertiser max CPM at $0.001 VPI, 10k campaign
    const vpiDOT = programmaticVPI / dotUSD;
    const setupPerKimpDOT = setupDOT * 1000 / 10_000;
    const maxCPM_USD = (1000 * vpiDOT - setupPerKimpDOT) * dotUSD;
    const viable = maxCPM_USD > userMinCPM_USD;
    out.push(`| ${yr} | ${epoch} | $${fmt(dotUSD)} | ${fmt(datumDotRatio)} | ${fmt(dailyCap)} | ${fmt(annualMintCap)} | ${fmt(userAnnualDATUM)} | ${fmt(userAnnualDOTeq)} | $${fmt(userMinCPM_USD)} | $${fmt(maxCPM_USD)} | ${viable ? "✓" : "✗"} |`);
  }
  out.push("");
  out.push(`Total emission over 70 years (geometric series of 7-yr epoch budgets): converges to`);
  out.push(`**${fmt(totalEmittable - 92_773)} DATUM** (≈ 95M, with tiny remainder rolling forward).`);
  out.push(`Cap is **never** breached because the emission curve is geometrically bounded by design.\n`);

  // Find first year programmatic becomes unviable
  let firstUnviableYear = -1;
  for (let yr = 0; yr <= 70; yr++) {
    const epoch = Math.floor(yr / DATUM_HALVING);
    const dotHalvingsPassed = Math.floor(yr / DOT_HALVING);
    const datumHalvingsPassed = Math.floor(yr / DATUM_HALVING);
    const dotUSD = DOT_BASE_USD * Math.pow(2, dotHalvingsPassed);
    const datumDotRatio = DATUM_DOT_RATIO_BASE * Math.pow(2, datumHalvingsPassed);
    const epochBudget = epoch0Budget / Math.pow(2, epoch);
    const annualMintCap = (epochBudget / daysPerEpoch) * 365;
    const userAnnualDOTeq = annualMintCap * userShare / 1_000_000 * datumDotRatio;
    const cpmReqDOT = Math.max(0, (gasPerYr - userAnnualDOTeq) * 1000 / (0.375 * impsPerYr));
    const userMinCPM_USD = cpmReqDOT * dotUSD;
    const vpiDOT = programmaticVPI / dotUSD;
    const setupPerKimpDOT = setupDOT * 1000 / 10_000;
    const maxCPM_USD = (1000 * vpiDOT - setupPerKimpDOT) * dotUSD;
    if (firstUnviableYear < 0 && maxCPM_USD < userMinCPM_USD) firstUnviableYear = yr;
  }

  out.push(`**Aggressive DOT growth (4× per 4yr, DATUM/DOT 2× per 7yr):**\n`);
  out.push(`Stress-test: DOT outruns DATUM in USD terms; when does the chain hit a viability cliff?\n`);
  out.push(`| Year | DOT/USD | Daily cap | User DATUM/yr | DOT-eq subsidy | User min CPM USD | Adv max CPM USD | Viable? | Notes |`);
  out.push(`|---:|---:|---:|---:|---:|---:|---:|:---:|---|`);
  for (let yr = 0; yr <= 32; yr += 4) {
    const epoch = Math.floor(yr / DATUM_HALVING);
    const dotHalvingsPassed = Math.floor(yr / DOT_HALVING);
    const datumHalvingsPassed = Math.floor(yr / DATUM_HALVING);
    const dotUSD = DOT_BASE_USD * Math.pow(4, dotHalvingsPassed);
    const datumDotRatio = DATUM_DOT_RATIO_BASE * Math.pow(2, datumHalvingsPassed);
    const epochBudget = epoch0Budget / Math.pow(2, epoch);
    const dailyCap = epochBudget / daysPerEpoch;
    const annualMintCap = dailyCap * 365;
    const userAnnualDATUM = annualMintCap * userShare / 1_000_000;
    const userAnnualDOTeq = userAnnualDATUM * datumDotRatio;
    const cpmReqDOT = Math.max(0, (gasPerYr - userAnnualDOTeq) * 1000 / (0.375 * impsPerYr));
    const userMinCPM_USD = cpmReqDOT * dotUSD;
    const vpiDOT = programmaticVPI / dotUSD;
    const setupPerKimpDOT = setupDOT * 1000 / 10_000;
    const maxCPM_USD = (1000 * vpiDOT - setupPerKimpDOT) * dotUSD;
    const viable = maxCPM_USD > userMinCPM_USD;
    let notes = "";
    if (yr === 0) notes = "Baseline";
    else if (!viable) notes = "Gas repricing required";
    else if (maxCPM_USD < 2 * userMinCPM_USD) notes = "Margin tight (<2×)";
    out.push(`| ${yr} | $${fmt(dotUSD)} | ${fmt(dailyCap)} | ${fmt(userAnnualDATUM)} | ${fmt(userAnnualDOTeq)} | $${fmt(userMinCPM_USD)} | $${fmt(maxCPM_USD)} | ${viable ? "✓" : "✗"} | ${notes} |`);
  }
  out.push("");

  out.push(`### Halving-projection findings\n`);
  out.push(`- **Programmatic-display first hits no-market under conservative growth**: ${firstUnviableYear < 0 ? "never within 70 years" : `year ${firstUnviableYear}`}.`);
  out.push(`  Higher-VPI campaigns (retargeting and above) stay viable longer because their per-imp value`);
  out.push(`  is 10×–1000× higher.`);
  out.push(`- **Cap-depletion risk**: at default mintRate of 19 and 1M users, the 89M cap is hit in ~9 years.`);
  out.push(`  Halving extends this to perpetuity if asymptotic mint < cap.`);
  out.push(`- **DATUM mint subsidy stays constant in DOT-equivalent terms** under symmetric halving`);
  out.push(`  (mintRate halves, DATUM/DOT doubles → \`mintRate × ratio\` is invariant). The user's`);
  out.push(`  effective share stays at ${fmt(0.375 + 0.55 * baseMintRate * DATUM_DOT_RATIO_BASE)} for all 17 halvings.`);
  out.push(`  If DATUM/DOT grows **slower** than mintRate halves, the subsidy shrinks and the user-side`);
  out.push(`  floor rises; if **faster**, the subsidy expands and the floor falls.`);
  out.push(`- **Under aggressive DOT growth (4×/halving)**, programmatic display fails within ~8 years`);
  out.push(`  without gas repricing — the strongest argument for an on-chain gas-fee governor.`);
  out.push(`- **Optimal halving cadence trades off** scarcity narrative vs. user-side subsidy. Slower`);
  out.push(`  halvings (8-yr instead of 4-yr) preserve user subsidy longer; faster halvings amplify`);
  out.push(`  token scarcity. Governance lever via \`setMintRate\`.\n`);

  out.push(`### Long-run structural picture\n`);
  out.push(`Three forces compete on a 70-year horizon:`);
  out.push("");
  out.push(`1. **DOT halvings** push DOT price up, increasing USD-denominated transaction fees`);
  out.push(`   (without on-chain repricing). This compresses the advertiser's USD margin.`);
  out.push(`2. **DATUM halvings** make each emitted token scarcer. If DATUM price tracks scarcity,`);
  out.push(`   token-unit emission halving doesn't reduce USD subsidy. If DATUM lags, subsidy weakens.`);
  out.push(`3. **Gas-market repricing** is the natural release valve: validators on Polkadot Hub`);
  out.push(`   could lower base fee (in DOT) as DOT price spikes, keeping real-world USD costs stable.`);
  out.push("");
  out.push(`The dominant variable is whether **the Hub re-prices its gas fee curve**. If yes, DOT`);
  out.push(`halvings are absorbed by the chain and the user-side floor stays near today's level in`);
  out.push(`USD. If no, the chain becomes increasingly expensive over time and programmatic display`);
  out.push(`is the first ad category squeezed out.\n`);

  out.push(`**Strategic implications:**`);
  out.push(`- Bake gas-fee governance into the protocol roadmap (oracle-fed fee adjustments).`);
  out.push(`- Index DATUM rewards to USD via oracle so subsidy purchasing power is stable.`);
  out.push(`- Encourage longer user-batching cadence (quarterly+) as DOT price climbs to preserve`);
  out.push(`  the user-side margin without protocol intervention.`);
  out.push(`- Target high-VPI advertiser categories first; brand-awareness/low-VPI campaigns are`);
  out.push(`  the most fragile under DOT appreciation.\n`);

  // ─── Practical implications / interpretation ─────────────────────────────
  out.push(`## Interpretation\n`);

  out.push(`### Per-relay batch-size economics (5 gwei)\n`);
  out.push(`Cost a single relay operator pays depending on batch size and cadence. The Low / Medium / High columns are the protocol-uniform L/M/H multipliers from the cost-projection section (×0.25 / 1 / 4 around the 1-batch/hour at 5 claims medium baseline). The Mega scenario shows what aggressive sub-minute batching with maximum claims would cost — included so the curve's right tail is visible.\n`);
  out.push(`| Cadence | DOT/yr | Per-claim gas |`);
  out.push(`|---|---:|---:|`);
  const relayLow   = sumRoleTierGas("Relay", "Low")    * 5e-9;
  const relayMed   = sumRoleTierGas("Relay", "Medium") * 5e-9;
  const relayHigh  = sumRoleTierGas("Relay", "High")   * 5e-9;
  // Mega scenario: 1 batch/minute × 10 claims/batch — computed off the
  // 10-claim measurement directly since it falls outside the L/M/H ladder.
  const relayMega = (gas10 * 1440) * 365 * 5e-9;
  out.push(`| Low (~6 batches/day × 5 claims) | ${relayLow.toFixed(2)} | ${Math.round(gas5/5).toLocaleString()} |`);
  out.push(`| Medium (24 batches/day × 5 claims) | ${relayMed.toFixed(2)} | ${Math.round(gas5/5).toLocaleString()} |`);
  out.push(`| High (96 batches/day × 5 claims) | ${relayHigh.toFixed(2)} | ${Math.round(gas5/5).toLocaleString()} |`);
  out.push(`| Mega (1 batch/min × 10 claims) | ${relayMega.toFixed(2)} | ${Math.round(gas10/10).toLocaleString()} |`);
  out.push("");
  out.push(`Linear-fit marginal cost: \`gas(n_claims) ≈ ${Math.round(txOverhead).toLocaleString()} + ${Math.round(marginalPerClaim).toLocaleString()} × n\`.`);
  out.push(`Bigger batches get dramatically cheaper per claim — at 10 claims/batch, per-claim`);
  out.push(`gas drops from ${Math.round(gas1).toLocaleString()} to ${Math.round(gas10/10).toLocaleString()}.`);
  out.push(`Relay operators should batch as aggressively as latency tolerance allows.\n`);

  out.push(`### Headline finding\n`);
  out.push(`With users self-settling and a monthly batching cadence at conservative Hub pricing,`);
  out.push(`the minimum CPM for the user side to be net-positive on gas fees is`);
  out.push(`**${userMinCPM.toFixed(3)} DOT per 1,000 impressions**. At $5/DOT that's ~$${(userMinCPM * 5).toFixed(2)} CPM`);
  out.push(`— over an order of magnitude below traditional web2 CPMs ($1–5).\n`);

  out.push(`### Practical implications\n`);
  out.push(`- **The user side dominates.** Publishers and advertisers break even at CPMs`);
  out.push(`  100–300× lower than what users need.`);
  out.push(`- **Higher-traffic users dominate proportionally less.** A user with 36k imps/yr`);
  out.push(`  breaks even at CPM ≈ 0.003 DOT — 10× cheaper than the 3,650-imp baseline.`);
  out.push(`- **Cadence is the lever, not contract optimisation.** Switching users from daily`);
  out.push(`  to monthly batching drops the break-even CPM 24×. Yearly batching drops it 80×.`);
  out.push(`- **At-scale viability is comfortable.** Real-world programmatic CPMs ($0.50–$5)`);
  out.push(`  sit 15–300× above the break-even floor at conservative pricing.`);
  out.push(`- **Worst-case (50 gwei × daily batching)** still bottoms out at CPM ≈ 7.3 DOT`);
  out.push(`  = ~$36/CPM — above traditional rates, but only in pathological combinations.`);
  out.push(`- The protocol's incentive design should encourage users to batch monthly+ via`);
  out.push(`  UI defaults and/or DATUM token rewards for delayed settlement.\n`);

  // Combined network economy view ───────────────────────────────────────────
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV emitter — one row per measurement. Columns:
//   role, op, gas, blockNumber, txHash, daily_baseline, rationale, note
// daily_baseline + rationale come from ROLE_BASELINES when the row's op is
// listed there; otherwise blank.
// ─────────────────────────────────────────────────────────────────────────────

function emitCsv(): string {
  const baselineByOp = new Map<string, OpBaseline>();
  for (const b of ROLE_BASELINES) for (const o of b.ops) baselineByOp.set(`${b.role}|${o.op}`, o);

  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines: string[] = [];
  lines.push("role,op,gas,blockNumber,txHash,daily_baseline,rationale,note");
  for (const r of rows) {
    const base = baselineByOp.get(`${r.role}|${r.op}`);
    lines.push([
      escape(r.role),
      escape(r.op),
      r.gas === 0n ? "0" : r.gas.toString(),
      r.blockNumber?.toString() ?? "",
      r.txHash ?? "",
      base ? base.daily.toString() : "",
      base ? escape(base.rationale) : "",
      escape(r.note ?? ""),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Network-aware explorer URL resolution
// ─────────────────────────────────────────────────────────────────────────────

function explorerForChain(chainId: number): string | null {
  switch (chainId) {
    case 420420417: return "https://blockscout-testnet.polkadot.io";  // Paseo
    case 420420421: return "https://blockscout-westend.polkadot.io";  // Westend
    case 420420424: return "https://blockscout-kusama.polkadot.io";   // Kusama
    case 420420416: return "https://blockscout.polkadot.io";          // Polkadot Hub
    default:        return null;                                       // Hardhat / unknown
  }
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const explorer = explorerForChain(chainId);
  console.log(`Run target: chainId=${chainId}${explorer ? ` (explorer: ${explorer})` : " (in-process)"}`);
  console.log("Deploying full alpha-5 stack...");
  const ctx = await deployAll();
  console.log("Deploy complete. Measuring operations:\n");

  // ── PROBE: settle batch-size breakpoint (force gasLimit, capture eth_call reason) ──
  if (process.env.PROBE_SETTLE_LIMIT === "1") {
    const CPM = parseDOT("0.2"), BUDGET = parseDOT("40"), DAILY = parseDOT("40");
    console.log("[PROBE] settle batch-size limit (explicit gasLimit, eth_call reason on revert)");
    for (const n of [4, 5, 6, 7, 8]) {
      try {
        const cid = await activateCampaign(ctx, BUDGET, DAILY, CPM);
        const claims = buildClaimChain(cid, ctx.publisher.address, ctx.user.address, CPM, n, 100n);
        const batch = [{ user: ctx.user.address, campaignId: cid, claims }];
        // 1) eth_call to surface the revert reason (if any)
        let reason = "ok";
        try { await ctx.settlement.connect(ctx.user).settleClaims.staticCall(batch); }
        catch (e: any) { reason = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 90); }
        // 2) force-send with explicit gasLimit (bypass estimateGas)
        let sent = "—", gas = "—";
        try {
          const tx = await ctx.settlement.connect(ctx.user).settleClaims(batch, { gasLimit: 12_000_000 });
          const r = await tx.wait(); sent = r.status === 1 ? "MINED" : "REVERTED"; gas = String(r.gasUsed);
        } catch (e: any) { sent = "SEND-FAIL: " + (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0].slice(0, 60); }
        console.log(`[PROBE] n=${String(n).padStart(2)}  ethcall=${reason.padEnd(40)} forced=${sent} gas=${gas}`);
      } catch (e: any) {
        console.log(`[PROBE] n=${String(n).padStart(2)}  setup-failed: ${(e?.message ?? e).toString().slice(0, 80)}`);
      }
    }
    console.log("[PROBE] done — exiting before full measureAll");
    return;
  }

  await measureAll(ctx);

  const md = emitMarkdown({ chainId, explorer });
  const csv = emitCsv();
  const docsDir = path.join(__dirname, "..", "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  const mdPath = path.join(docsDir, "gas-by-role.md");
  const csvPath = path.join(docsDir, "gas-by-role.csv");
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(csvPath, csv);
  console.log(`\nReport written to ${mdPath}`);
  console.log(`CSV written to    ${csvPath}`);
  console.log(`Total measurements: ${rows.length}, skipped: ${rows.filter((r) => r.gas === 0n).length}`);
}

// Only auto-run when invoked directly (e.g. `hardhat run scripts/role-gas-report.ts`).
// When imported by another script (e.g. the stress harness) for its deploy/claim
// helpers, the importer drives its own flow.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
