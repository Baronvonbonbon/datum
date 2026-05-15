// role-gas-report.ts
//
// Deploys the full alpha-4 21-contract surface in-process and measures gas
// for the operations each role performs. Emits a markdown report grouped by
// role, with daily/monthly cost projections at three reference gas prices.
//
// Run:
//   npx hardhat run scripts/role-gas-report.ts
//
// Output:
//   docs/gas-by-role.md
//
// Design notes:
// - Every measurement is wrapped in try/catch. Failures are reported as
//   SKIPPED rows so the report degrades gracefully when ops depend on
//   external setup (ZK proofs, MPC ceremony, on-chain DATUM token).
// - Frequencies and gas-price scenarios are constants near the top — edit
//   to re-run with different assumptions.

import { ethers } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import { fundSigners, mineBlocks } from "../test/helpers/mine";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Cost-projection knobs
// ─────────────────────────────────────────────────────────────────────────────

/** Gas-price scenarios (gwei). 1 gwei = 1e9 wei = 1e-9 ETH/PAS. */
const GAS_PRICE_SCENARIOS: Array<{ label: string; gwei: number; note: string }> = [
  { label: "Paseo (cheap testnet)",       gwei: 1,   note: "Current Paseo eth-rpc baseline" },
  { label: "Polkadot Hub (conservative)", gwei: 5,   note: "Plausible mainnet steady state" },
  { label: "Polkadot Hub (busy)",         gwei: 50,  note: "High-load worst case" },
];

/** Per-role frequency assumptions for cost projections.
 *  Rationale baked into each entry's `daily` field — edit to override. */
interface FrequencyAssumption {
  role: string;
  op: string;
  daily: number;
  rationale: string;
}
// Note: `op` must match the measurement label exactly (used as a lookup key).
const FREQUENCY_ASSUMPTIONS: FrequencyAssumption[] = [
  { role: "Advertiser",    op: "createCampaign",                          daily: 1/7,   rationale: "1 campaign per advertiser per week" },
  { role: "Advertiser",    op: "vote (own campaign, aye)",                daily: 1/7,   rationale: "1 self-vote per campaign created" },
  { role: "Publisher",     op: "registerPublisher",                       daily: 1/365, rationale: "Once per publisher per year" },
  { role: "Publisher",     op: "setRelaySigner",                          daily: 1/30,  rationale: "Monthly key rotation" },
  { role: "Publisher",     op: "setProfile",                              daily: 1/30,  rationale: "Monthly profile refresh" },
  { role: "Publisher",     op: "publisherStake.stake",                    daily: 1/30,  rationale: "Monthly stake top-up" },
  { role: "Publisher",     op: "vault.withdrawPublisher",                 daily: 1/7,   rationale: "Weekly earnings withdraw" },
  { role: "User",          op: "zkStake.depositWith",                     daily: 1/365, rationale: "Yearly onboarding" },
  { role: "User",          op: "zkStake.requestWithdrawal",               daily: 1/365, rationale: "Rare unstake" },
  { role: "User",          op: "reportPage (reason 1)",                   daily: 1/30,  rationale: "~1 report per active user per month" },
  { role: "User",          op: "vault.withdrawUser",                      daily: 1/30,  rationale: "Monthly micropayment claim" },
  { role: "Relay",         op: "settleClaims (1 claim × 100 imps)",       daily: 24,    rationale: "Hourly settlement batch (single user × single claim)" },
  { role: "Relay",         op: "settleClaims (5 claims × 100 imps)",      daily: 8,     rationale: "Larger batch every 3h" },
  { role: "Reporter V1",   op: "stakeRoot.commitStakeRoot (threshold 1)", daily: 24,    rationale: "Hourly epoch; testnet 1-of-1" },
  { role: "Reporter V1",   op: "commitStakeRoot (first signer, 2-of-N)",  daily: 24,    rationale: "Mainnet: each reporter posts every epoch" },
  { role: "Reporter V1",   op: "commitStakeRoot (cosigner finalises)",    daily: 24,    rationale: "Mainnet: each reporter cosigns every epoch" },
  { role: "Reporter V2",   op: "stakeRootV2.proposeRoot",                 daily: 24,    rationale: "1 propose per epoch (1st reporter only — divides amongst pool)" },
  { role: "Reporter V2",   op: "stakeRootV2.approveRoot",                 daily: 24,    rationale: "Approve every epoch" },
  { role: "Reporter V2",   op: "stakeRootV2.finalizeRoot",                daily: 24,    rationale: "Finalize once per epoch (anyone)" },
  { role: "Reporter V2",   op: "stakeRootV2.joinReporters",               daily: 1/365, rationale: "One-time onboarding" },
  { role: "Voter",         op: "governance.vote (aye)",                   daily: 1/7,   rationale: "1 vote per active voter per week" },
  { role: "Voter",         op: "governance.vote (nay)",                   daily: 1/30,  rationale: "Nays rarer than ayes" },
  { role: "Council",       op: "council.propose",                         daily: 1/30,  rationale: "1 proposal per member per month" },
  { role: "Council",       op: "council.vote",                            daily: 1/14,  rationale: "Bi-weekly votes" },
  { role: "Council",       op: "council.execute",                         daily: 1/30,  rationale: "1 execution per month" },
  { role: "Curator",       op: "curator.blockAddr",                       daily: 1/7,   rationale: "1 blocklist update per week" },
  { role: "Curator",       op: "curator.unblockAddr",                     daily: 1/30,  rationale: "Unblocks rarer than blocks" },
  { role: "Challenger",    op: "stakeRootV2.registerCommitment",          daily: 1/30,  rationale: "User-driven; modest steady state" },
  { role: "Challenger",    op: "stakeRootV2.challengePhantomLeaf",        daily: 1/90,  rationale: "Rare; only on fraudulent root" },
  { role: "Admin",         op: "pauseRegistry.pause (owner)",             daily: 1/180, rationale: "Twice per year (incident response)" },
  { role: "Admin",         op: "pauseRegistry.proposeCategoryUnpause",    daily: 1/180, rationale: "Once per pause incident" },
  { role: "Admin",         op: "pauseRegistry.approve (unpause)",         daily: 1/180, rationale: "Co-signer on each unpause" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-user engagement tiers — what an end user spends in gas fees per year.
// `ops` keys must match measurement labels exactly; daily is ops/day for that user.
// ─────────────────────────────────────────────────────────────────────────────
interface ActorTier {
  label: string;
  description: string;
  ops: Record<string, number>;  // op -> daily frequency
}
const USER_TIERS: ActorTier[] = [
  {
    label: "Minimal",
    description: "Signs up once, never reports, withdraws once per year.",
    ops: {
      "zkStake.depositWith":     1/365,
      "zkStake.requestWithdrawal": 1/365,
      "vault.withdrawUser":      1/365,
    },
  },
  {
    label: "Typical",
    description: "Default engagement: yearly onboarding, monthly report + withdraw.",
    ops: {
      "zkStake.depositWith":     1/365,
      "zkStake.requestWithdrawal": 1/365,
      "reportPage (reason 1)":   1/30,
      "vault.withdrawUser":      1/30,
    },
  },
  {
    label: "Active",
    description: "Engaged user: weekly report, fortnightly withdraw.",
    ops: {
      "zkStake.depositWith":     1/365,
      "zkStake.requestWithdrawal": 1/365,
      "reportPage (reason 1)":   1/7,
      "vault.withdrawUser":      2/30,
    },
  },
  {
    label: "Power",
    description: "Heavy user: bi-weekly stake adjustments, daily reports, weekly withdraw.",
    ops: {
      "zkStake.depositWith":     1/14,
      "zkStake.requestWithdrawal": 1/14,
      "reportPage (reason 1)":   1,
      "vault.withdrawUser":      1/7,
    },
  },
];

const PUBLISHER_TIERS: ActorTier[] = [
  {
    label: "Hobbyist",
    description: "Signs up once. Withdraws monthly. No further setup churn.",
    ops: {
      "registerPublisher":        1/365,
      "vault.withdrawPublisher":  1/30,
    },
  },
  {
    label: "Casual",
    description: "Signs up + quarterly relay-key rotation + monthly profile + monthly withdraw.",
    ops: {
      "registerPublisher":        1/365,
      "setRelaySigner":           1/90,
      "setProfile":               1/30,
      "vault.withdrawPublisher":  1/30,
    },
  },
  {
    label: "Active",
    description: "Monthly stake top-up, monthly key rotation + profile, weekly withdraw.",
    ops: {
      "registerPublisher":        1/365,
      "setRelaySigner":           1/30,
      "setProfile":               1/30,
      "publisherStake.stake":     1/30,
      "vault.withdrawPublisher":  1/7,
    },
  },
  {
    label: "Heavy",
    description: "Weekly stake top-up, weekly profile, weekly key rotation, daily withdraw.",
    ops: {
      "registerPublisher":        1/365,
      "setRelaySigner":           1/7,
      "setProfile":               1/7,
      "publisherStake.stake":     1/7,
      "vault.withdrawPublisher":  1,
    },
  },
];

// Relay tiers: a relay operator submitting batches throughout the day.
// Frequencies are PER-RELAY (not network-wide). Each tier expresses a
// combination of batch cadence × batch size; the report's per-op gas figures
// already absorb the per-claim marginal cost.
const RELAY_TIERS: ActorTier[] = [
  {
    label: "Hobby",
    description: "1 batch/hour, 1 claim/batch (single-user side-relay).",
    ops: {
      "settleClaims (1 claim × 100 imps)":  24,
    },
  },
  {
    label: "Standard",
    description: "1 batch/hour, 5 claims/batch (typical commercial relay).",
    ops: {
      "settleClaims (5 claims × 100 imps)": 24,
    },
  },
  {
    label: "Heavy",
    description: "10 batches/hour, 10 claims/batch (large publisher network).",
    ops: {
      "settleClaims (10 claims × 100 imps)": 240,
    },
  },
  {
    label: "Hyper",
    description: "1 batch/minute, 10 claims/batch (programmatic settlement).",
    ops: {
      "settleClaims (10 claims × 100 imps)": 1440,
    },
  },
];

const ADVERTISER_TIERS: ActorTier[] = [
  {
    label: "Occasional",
    description: "1 campaign per quarter; self-votes each.",
    ops: {
      "createCampaign":            4/365,
      "vote (own campaign, aye)":  4/365,
    },
  },
  {
    label: "Regular",
    description: "1 campaign per month + self-vote.",
    ops: {
      "createCampaign":            1/30,
      "vote (own campaign, aye)":  1/30,
    },
  },
  {
    label: "Active",
    description: "1 campaign per week + self-vote.",
    ops: {
      "createCampaign":            1/7,
      "vote (own campaign, aye)":  1/7,
    },
  },
  {
    label: "Heavy",
    description: "1 campaign per day + self-vote (e.g., automated programmatic buyer).",
    ops: {
      "createCampaign":            1,
      "vote (own campaign, aye)":  1,
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Measurement infrastructure
// ─────────────────────────────────────────────────────────────────────────────

interface Row { role: string; op: string; gas: bigint; note?: string }
const rows: Row[] = [];

async function measure(role: string, op: string, txPromise: Promise<any>, note?: string) {
  try {
    const tx = await txPromise;
    const r = await tx.wait();
    const gas = r.gasUsed as bigint;
    rows.push({ role, op, gas, note });
    console.log(`  ${role.padEnd(14)} ${op.padEnd(40)} ${gas.toString().padStart(8)}`);
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 80);
    rows.push({ role, op, gas: 0n, note: `SKIPPED: ${msg}` });
    console.warn(`  ${role.padEnd(14)} ${op.padEnd(40)} SKIPPED: ${msg}`);
  }
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

async function deployAll() {
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
  await (await settlement.setRateLimits(200n, 50000n)).wait();
  await (await tokenRewardVault.setSettlement(await settlement.getAddress())).wait();

  await (await claimVal.setZKVerifier(await zkVerifier.getAddress())).wait();

  await (await lifecycle.setCampaigns(await campaigns.getAddress())).wait();
  await (await lifecycle.setBudgetLedger(await ledger.getAddress())).wait();
  await (await lifecycle.setGovernanceContract(await governance.getAddress())).wait();
  await (await lifecycle.setSettlementContract(await settlement.getAddress())).wait();

  // bootstrap
  await (await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS)).wait();
  await (await publishers.connect(publisher2).registerPublisher(TAKE_RATE_BPS)).wait();

  return {
    owner, advertiser, publisher, publisher2, user, voter, relay,
    councilA, councilB, councilC, councilGuardian,
    reporter2, curator, challenger,
    pauseReg, timelock, publishers, ledger, vault, campaigns, lifecycle,
    claimVal, settlement, governance, datumRelay, attestVerifier, tokenRewardVault,
    publisherStake, challengeBonds, publisherGov, paramGov, router, council,
    clickReg, curatorContract, activationBonds, stakeRootV1, stakeRootV2,
    identityVer, mockToken, zkStake,
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
    [c.campaignId, c.publisher, c.user, c.eventCount, c.ratePlanck, c.actionType, c.clickSessionHash, c.nonce, c.previousClaimHash, c.stakeRootUsed],
  ));
}

function buildClaim(args: { cid: bigint; publisher: string; user: string; rate: bigint; events: bigint; nonce: bigint; prev: string }) {
  const c: any = {
    campaignId: args.cid,
    publisher: args.publisher,
    user: args.user,
    eventCount: args.events,
    ratePlanck: args.rate,
    actionType: 0,
    clickSessionHash: ethers.ZeroHash,
    nonce: args.nonce,
    previousClaimHash: args.prev,
    claimHash: ethers.ZeroHash,
    zkProof: ZERO_PROOF(),
    nullifier: ethers.ZeroHash,
    stakeRootUsed: ethers.ZeroHash,
    actionSig: ZERO_ACTION(),
    powNonce: ethers.ZeroHash,
  };
  c.claimHash = computeClaimHash(c);
  return c;
}

function buildClaimChain(cid: bigint, pub: string, user: string, rate: bigint, count: number, events: bigint, startNonce: bigint = 1n) {
  const claims = [];
  let prev = ethers.ZeroHash;
  for (let i = 0; i < count; i++) {
    const c = buildClaim({ cid, publisher: pub, user, rate, events, nonce: startNonce + BigInt(i), prev });
    claims.push(c);
    prev = c.claimHash;
  }
  return claims;
}

async function activateCampaign(ctx: any, budget: bigint, dailyCap: bigint, cpm: bigint): Promise<bigint> {
  const tx = await ctx.campaigns.connect(ctx.advertiser).createCampaign(
    ctx.publisher.address,
    [{ actionType: 0, budgetPlanck: budget, dailyCapPlanck: dailyCap, ratePlanck: cpm, actionVerifier: ethers.ZeroAddress }],
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
    [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY, ratePlanck: CPM, actionVerifier: ethers.ZeroAddress }],
    [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET },
  ));
  const advCid = await ctx.campaigns.nextCampaignId() - 1n;
  await measure("Advertiser", "vote (own campaign, aye)",
    ctx.governance.connect(ctx.advertiser).vote(advCid, true, 0, { value: QUORUM }));

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
    ctx.campaigns.connect(ctx.user).reportPage(cidR1, 1));
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
    [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY, ratePlanck: CPM, actionVerifier: ethers.ZeroAddress }],
    [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET },
  );
  await voteTx.wait();
  const voteCid = await ctx.campaigns.nextCampaignId() - 1n;
  await measure("Voter", "governance.vote (aye)",
    ctx.governance.connect(ctx.voter).vote(voteCid, true, 0, { value: QUORUM }));
  // nay on a different campaign
  const nayTx = await ctx.campaigns.connect(ctx.advertiser).createCampaign(
    ctx.publisher.address,
    [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY, ratePlanck: CPM, actionVerifier: ethers.ZeroAddress }],
    [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET },
  );
  await nayTx.wait();
  const nayCid = await ctx.campaigns.nextCampaignId() - 1n;
  await measure("Voter", "governance.vote (nay)",
    ctx.governance.connect(ctx.voter).vote(nayCid, false, 0, { value: QUORUM }));

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
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

function emitMarkdown(): string {
  const out: string[] = [];
  out.push(`# Datum Alpha-4 — Gas Cost Report by Role\n`);
  out.push(`Generated by \`scripts/role-gas-report.ts\` on ${new Date().toISOString()}.`);
  out.push(`Measurements taken on the in-process hardhat EVM (chainId 31337); production pallet-revive`);
  out.push(`weight may differ. Numbers are unit gas; convert to DOT/PAS via the price table at the bottom.\n`);

  // Per-role tables
  const roles = Array.from(new Set(rows.map(r => r.role)));
  for (const role of roles) {
    out.push(`## ${role}\n`);
    out.push(`| Operation | Gas | Note |`);
    out.push(`|---|---:|---|`);
    for (const r of rows.filter(r => r.role === role)) {
      const g = r.gas === 0n ? "—" : r.gas.toString();
      out.push(`| ${r.op} | ${g} | ${r.note ?? ""} |`);
    }
    out.push("");
  }

  // Cost projection
  out.push(`## Cost projection\n`);
  out.push(`Daily/monthly fee burn per role, using the frequency assumptions documented in`);
  out.push(`\`scripts/role-gas-report.ts\` and three gas-price scenarios.\n`);
  out.push(`Conversion: \`cost_DOT = gas × gas_price_gwei × 1e-9\` (since 1 DOT/PAS = 1e18 base units = 1e9 gwei,`);
  out.push(`and gas × wei/gas = wei, then wei × 1e-18 = DOT).\n`);

  const freqMap = new Map<string, FrequencyAssumption>();
  for (const f of FREQUENCY_ASSUMPTIONS) freqMap.set(`${f.role}|${f.op}`, f);

  out.push(`| Role | Op | Gas | Daily ops | Monthly ops | Rationale |`);
  out.push(`|---|---|---:|---:|---:|---|`);
  for (const f of FREQUENCY_ASSUMPTIONS) {
    const row = rows.find(r => r.role === f.role && r.op === f.op);
    const gas = row?.gas ?? 0n;
    const monthly = (f.daily * 30).toFixed(2);
    out.push(`| ${f.role} | ${f.op} | ${gas.toString()} | ${f.daily.toFixed(3)} | ${monthly} | ${f.rationale} |`);
  }
  out.push("");

  // Per-scenario tables
  for (const scenario of GAS_PRICE_SCENARIOS) {
    out.push(`### Cost at ${scenario.label} (${scenario.gwei} gwei)`);
    out.push(`> ${scenario.note}\n`);
    out.push(`| Role | Op | Gas | DOT/op | DOT/day | DOT/month |`);
    out.push(`|---|---|---:|---:|---:|---:|`);
    let dailyTotalByRole = new Map<string, number>();
    for (const f of FREQUENCY_ASSUMPTIONS) {
      const row = rows.find(r => r.role === f.role && r.op === f.op);
      const gas = row?.gas ?? 0n;
      const costPerOp = Number(gas) * scenario.gwei * 1e-9;
      const daily = costPerOp * f.daily;
      const monthly = daily * 30;
      dailyTotalByRole.set(f.role, (dailyTotalByRole.get(f.role) ?? 0) + daily);
      out.push(`| ${f.role} | ${f.op} | ${gas} | ${costPerOp.toExponential(2)} | ${daily.toExponential(2)} | ${monthly.toExponential(2)} |`);
    }
    out.push("");
    out.push(`**Per-role daily totals (${scenario.label})**\n`);
    out.push(`| Role | DOT/day | DOT/month |`);
    out.push(`|---|---:|---:|`);
    for (const [role, total] of dailyTotalByRole) {
      out.push(`| ${role} | ${total.toExponential(2)} | ${(total * 30).toExponential(2)} |`);
    }
    out.push("");
  }

  // ─── Per-actor fee burn sections ─────────────────────────────────────────
  function emitActorSection(actorLabel: string, sectionTitle: string, lead: string, role: string, tiers: ActorTier[], aggregateBaselineTier: string) {
    out.push(`## ${sectionTitle}\n`);
    out.push(lead + "\n");

    out.push(`### Tier definitions\n`);
    // Build dynamic columns from union of op keys
    const allOps = Array.from(new Set(tiers.flatMap(t => Object.keys(t.ops))));
    out.push(`| Tier | Description | ${allOps.map(o => `${o} /yr`).join(" | ")} |`);
    out.push(`|---|---|${allOps.map(() => "---:").join("|")}|`);
    for (const t of tiers) {
      const cells = allOps.map(o => {
        const v = (t.ops[o] ?? 0) * 365;
        return v < 1 ? v.toFixed(2) : v.toFixed(0);
      });
      out.push(`| ${t.label} | ${t.description} | ${cells.join(" | ")} |`);
    }
    out.push("");

    // Per-op gas for this role
    const opGas = new Map<string, bigint>();
    for (const r of rows.filter(r => r.role === role)) opGas.set(r.op, r.gas);

    out.push(`### Annual gas per ${actorLabel} (units)\n`);
    out.push(`| Tier | Gas/yr |`);
    out.push(`|---|---:|`);
    const tierGas = new Map<string, number>();
    for (const t of tiers) {
      let total = 0;
      for (const [op, daily] of Object.entries(t.ops)) {
        const gas = Number(opGas.get(op) ?? 0n);
        total += gas * daily * 365;
      }
      tierGas.set(t.label, total);
      out.push(`| ${t.label} | ${Math.round(total).toLocaleString()} |`);
    }
    out.push("");

    out.push(`### Annual cost per ${actorLabel} (DOT/PAS)\n`);
    out.push(`| Tier | ${GAS_PRICE_SCENARIOS.map(s => `${s.label} (${s.gwei} gwei)`).join(" | ")} |`);
    out.push(`|---|${GAS_PRICE_SCENARIOS.map(() => "---:").join("|")}|`);
    for (const t of tiers) {
      const gas = tierGas.get(t.label) ?? 0;
      const cells = GAS_PRICE_SCENARIOS.map(s => (gas * s.gwei * 1e-9).toExponential(2));
      out.push(`| ${t.label} | ${cells.join(" | ")} |`);
    }
    out.push("");

    out.push(`### Network-aggregate at common ${actorLabel} counts (annual DOT, ${aggregateBaselineTier} tier)\n`);
    out.push(`Linear in count × linear in gas price.\n`);
    const baseGas = tierGas.get(aggregateBaselineTier) ?? 0;
    const counts = [10, 100, 1_000, 10_000, 100_000];
    out.push(`| ${actorLabel}s | ${GAS_PRICE_SCENARIOS.map(s => `${s.gwei} gwei`).join(" | ")} |`);
    out.push(`|---:|${GAS_PRICE_SCENARIOS.map(() => "---:").join("|")}|`);
    for (const n of counts) {
      const cells = GAS_PRICE_SCENARIOS.map(s => (baseGas * n * s.gwei * 1e-9).toExponential(2));
      out.push(`| ${n.toLocaleString()} | ${cells.join(" | ")} |`);
    }
    out.push("");
  }

  emitActorSection(
    "user",
    "Per-user fee burn (annual)",
    "Annual transaction-fee cost (DOT/PAS) for a single end user across four engagement tiers. Excludes posted bonds, locked stake, and DATUM token movement — pure gas spend. Calculation: `Σ ops × gas[op] × 365 × gas_price`.",
    "User",
    USER_TIERS,
    "Typical",
  );

  emitActorSection(
    "publisher",
    "Per-publisher fee burn (annual)",
    "Annual fee cost for a publisher across four engagement tiers. Registration is a one-time cost amortised over the year (one twelve-and-a-half thousandth per day). Withdrawals dominate for active sites.",
    "Publisher",
    PUBLISHER_TIERS,
    "Active",
  );

  emitActorSection(
    "advertiser",
    "Per-advertiser fee burn (annual)",
    "Annual fee cost for an advertiser across four campaign-volume tiers. `createCampaign` is the dominant op (450k gas — ActionPotConfig storage + budget escrow). Self-vote at creation is paired 1:1.",
    "Advertiser",
    ADVERTISER_TIERS,
    "Regular",
  );

  emitActorSection(
    "relay",
    "Per-relay fee burn (annual)",
    "Annual fee cost for a single relay operator submitting settlement batches. Heavier tiers amortise the ~510k tx overhead across more claims (~30k marginal gas/claim measured from 1- vs 5-claim batches).",
    "Relay",
    RELAY_TIERS,
    "Standard",
  );

  // Combined network economy view ───────────────────────────────────────────
  out.push(`## Combined network economy (annual fee burn)\n`);
  out.push(`Three sample networks at conservative Hub pricing (5 gwei). Sum across`);
  out.push(`all actor classes at the baseline tier for each. The hot path (relays +`);
  out.push(`stake-root reporters) is included from the per-role projection above.\n`);

  function tierGasFor(role: string, tiers: ActorTier[], tier: string): number {
    const opGas = new Map<string, bigint>();
    for (const r of rows.filter(r => r.role === role)) opGas.set(r.op, r.gas);
    const t = tiers.find(t => t.label === tier);
    if (!t) return 0;
    let total = 0;
    for (const [op, daily] of Object.entries(t.ops)) {
      total += Number(opGas.get(op) ?? 0n) * daily * 365;
    }
    return total;
  }

  // Per-actor annual DOT @ 5 gwei
  const userTypical_DOT      = tierGasFor("User",       USER_TIERS,       "Typical")    * 5e-9;
  const pubActive_DOT        = tierGasFor("Publisher",  PUBLISHER_TIERS,  "Active")     * 5e-9;
  const advRegular_DOT       = tierGasFor("Advertiser", ADVERTISER_TIERS, "Regular")    * 5e-9;
  // Reporter & relay annual: pull from the per-role projection (sum of daily ops × gas × 365 × 5e-9)
  function roleAnnual_DOT(role: string): number {
    let g = 0;
    for (const f of FREQUENCY_ASSUMPTIONS.filter(f => f.role === role)) {
      const r = rows.find(r => r.role === f.role && r.op === f.op);
      if (r) g += Number(r.gas) * f.daily * 365;
    }
    return g * 5e-9;
  }
  const relay_DOT     = roleAnnual_DOT("Relay");
  const reporterV1_DOT = roleAnnual_DOT("Reporter V1");
  const reporterV2_DOT = roleAnnual_DOT("Reporter V2");

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
      return minCPM.toExponential(2);
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
    out.push(`| ${impsYr.toLocaleString()} | ${minCPM.toExponential(2)} | ${annualFeeDOT.toExponential(2)} | ${revenueAtMin.toExponential(2)} |`);
  }
  out.push("");

  out.push(`### What "viable for all" looks like\n`);
  out.push(`Each party's economics at 5 gwei, **monthly user-batching cadence, 3,650 imps/user/yr**:\n`);
  const monthlySettleGas = gas1 * 12;
  const userAnnualGas = monthlySettleGas + userOverheadGas;
  const userAnnualFee = userAnnualGas * 5e-9;
  const userMinCPM = userAnnualFee * 1000 / (0.375 * impsPerYr);

  // Publisher: aggregate across many users. Assume 100 users/publisher, 365 imps/user/yr settled = 36,500 imps/yr
  const pubActiveGas = tierGasFor("Publisher", PUBLISHER_TIERS, "Active");
  const pubAnnualFee = pubActiveGas * 5e-9;
  const pubImpsYr = 100 * impsPerYr;       // 100-user publisher
  const pubMinCPM = pubAnnualFee * 1000 / (0.5 * pubImpsYr);

  // Advertiser: pays full CPM. Fees are setup, not per-imp. Their viability is ROI on the ad.
  const advRegularGas = tierGasFor("Advertiser", ADVERTISER_TIERS, "Regular");
  const advAnnualFee = advRegularGas * 5e-9;

  out.push(`| Party | Assumptions | Annual fee (DOT) | Min CPM to break even (DOT) |`);
  out.push(`|---|---|---:|---:|`);
  out.push(`| User | Monthly settle, 3,650 imps/yr | ${userAnnualFee.toExponential(2)} | ${userMinCPM.toExponential(2)} |`);
  out.push(`| Publisher (Active) | 100 users × 3,650 imps/yr = 365k imps/yr | ${pubAnnualFee.toExponential(2)} | ${pubMinCPM.toExponential(2)} |`);
  out.push(`| Advertiser (Regular) | Fees independent of imps; need ROI > CPM | ${advAnnualFee.toExponential(2)} | n/a (volume-independent) |`);
  out.push(`| Relay (Standard) | If used; otherwise users self-settle | ${(roleAnnual_DOT("Relay")).toExponential(2)} | n/a (operator margin model) |`);
  out.push("");

  out.push(`**Headline:** at conservative Hub pricing with monthly user-batching, the binding`);
  out.push(`constraint is the user side. Minimum CPM for a user receiving 3,650 imps/year to`);
  out.push(`break even on fees alone is **${userMinCPM.toExponential(2)} DOT** per 1,000 impressions.`);
  out.push(`Above that, every party in the chain is net-positive on fees alone (revenue redistribution`);
  out.push(`and DATUM rewards are upside on top).\n`);

  // ─── DATUM token reward subsidy ─────────────────────────────────────────
  out.push(`### DATUM token reward subsidy\n`);
  out.push(`Campaigns may pay a per-impression DATUM token reward on top of the DOT split`);
  out.push(`(via \`DatumTokenRewardVault\`). The reward credits the user pull-payment style`);
  out.push(`and is non-critical — it doesn't revert settlement if the token budget runs out.`);
  out.push(`Modelling reward-per-impression in **DOT-equivalent** (i.e., reward × DATUM/DOT spot price):\n`);

  out.push(`User's revised break-even condition:`);
  out.push(`\`0.375 × CPM_DOT + reward_per_imp_DOT × 1000 ≥ annual_gas_DOT / (imps_yr / 1000)\``);
  out.push("");
  out.push(`Solving for CPM with a DATUM reward subsidy at 5 gwei, 3,650 imps/user/yr, monthly batching:\n`);

  const gasPerKimp = (gas1 * 12 + userOverheadGas) * 5e-9 * 1000 / impsPerYr; // DOT/1000 imps user must net
  // reward_per_imp_DOT in DOT
  const rewardLevels = [
    { label: "0",       perImp: 0           },
    { label: "1e-9",    perImp: 1e-9        },  // 1 nDOT/imp = 1e-6 DOT/kimp
    { label: "1e-8",    perImp: 1e-8        },  // 10 nDOT/imp = 1e-5 DOT/kimp
    { label: "1e-7",    perImp: 1e-7        },  // ~equal to gas at high volume
    { label: "1e-6",    perImp: 1e-6        },  // 1 µDOT/imp = 0.001 DOT/kimp
    { label: "1e-5",    perImp: 1e-5        },  // covers most user fees
    { label: "1e-4",    perImp: 1e-4        },  // 100 µDOT/imp = 0.1 DOT/kimp
  ];

  out.push(`| Reward (DOT-eq /imp) | Reward (DOT-eq /1000 imps) | User net per 1k imps from reward | Min DOT CPM to break even |`);
  out.push(`|---|---:|---:|---:|`);
  for (const r of rewardLevels) {
    const rewardPerKimp = r.perImp * 1000;
    const requiredDOTPerKimp = gasPerKimp - rewardPerKimp; // user share must cover this
    const minCPM = requiredDOTPerKimp / 0.375;
    const label = minCPM <= 0
      ? "**0 (DATUM alone covers fees)**"
      : minCPM.toExponential(2);
    out.push(`| ${r.label} | ${rewardPerKimp.toExponential(2)} | ${rewardPerKimp.toExponential(2)} | ${label} |`);
  }
  out.push("");

  // Find the crossover: DATUM reward level at which CPM_breakeven = 0
  const crossoverPerImp = gasPerKimp / 1000;  // DOT/imp where reward fully covers
  out.push(`**Crossover threshold:** at a DATUM reward of **${crossoverPerImp.toExponential(2)} DOT-equivalent`);
  out.push(`per impression** (${(crossoverPerImp * 1000).toExponential(2)} per 1,000 imps), the DATUM payout alone covers`);
  out.push(`the user's gas fees and the campaign can pay **any** DOT CPM — including zero — while keeping`);
  out.push(`the user net-positive.\n`);

  // Protocol-side cost of subsidy
  out.push(`### Protocol-side emission cost of the subsidy\n`);
  out.push(`Total DATUM-equivalent emitted per year at the crossover threshold, assuming each user`);
  out.push(`receives 3,650 impressions/yr:\n`);
  out.push(`| Users | Annual impressions | DATUM emission (DOT-eq) |`);
  out.push(`|---:|---:|---:|`);
  for (const n of [1_000, 10_000, 100_000, 1_000_000]) {
    const totalImps = n * impsPerYr;
    const emission = totalImps * crossoverPerImp;
    out.push(`| ${n.toLocaleString()} | ${totalImps.toLocaleString()} | ${emission.toFixed(2)} |`);
  }
  out.push("");
  out.push(`Interpretation: at 1M users the protocol would need to mint/distribute ~${(1_000_000 * impsPerYr * crossoverPerImp).toFixed(0)} DOT-equivalent`);
  out.push(`worth of DATUM per year to fully cover user gas fees via subsidy alone — well within`);
  out.push(`the bounds of a typical token-emission schedule (e.g., 1–5% of supply/yr at a `);
  out.push(`$10M FDV token).\n`);

  out.push(`### Combined revenue lens\n`);
  out.push(`At conservative Hub pricing + monthly batching + 3,650 imps/user/yr, **total user`);
  out.push(`compensation per 1,000 impressions** for net-positive economics:\n`);
  out.push(`| Path | DOT side | DATUM side | Notes |`);
  out.push(`|---|---|---|---|`);
  out.push(`| Pure DOT (no DATUM reward) | ≥ ${userMinCPM.toFixed(3)} DOT CPM | — | Today's break-even floor |`);
  out.push(`| Mixed (half each) | ≥ ${(userMinCPM / 2).toFixed(3)} DOT CPM | + ${(gasPerKimp / 2).toExponential(2)} DOT-eq/1k imps | Sustainable; small DATUM commitment |`);
  out.push(`| Pure DATUM | 0 (free for advertisers) | ≥ ${gasPerKimp.toExponential(2)} DOT-eq/1k imps | Maximum user-acquisition mode |`);
  out.push("");
  out.push(`The economic design lever: campaigns that want to operate **below break-even in DOT**`);
  out.push(`can backfill with DATUM token rewards. This unlocks loss-leader pricing, free trials,`);
  out.push(`and the bootstrap-an-audience subsidy without changing contract logic — the lever is`);
  out.push(`already plumbed via \`Campaigns.rewardToken\` + \`Campaigns.rewardPerImpression\`.\n`);

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
      return maxCPM > 0 ? maxCPM.toExponential(2) : `**neg**`;
    });
    out.push(`| ${v.label} | $${v.usd.toFixed(4)} | ${vpiDOT.toExponential(2)} | ${cells.join(" | ")} |`);
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
      return `${margin.toExponential(2)} (${ratio.toFixed(0)}×)`;
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
    out.push(`| $${p} | ${vpiDOT.toExponential(2)} | ${maxCPM_DOT.toFixed(4)} | $${(maxCPM_DOT * p).toFixed(4)} | ${marginCell} |`);
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

  // 4. DATUM crossover threshold + emission cost
  out.push(`**4. DATUM crossover-subsidy emission cost in USD:**\n`);
  out.push(`Total DATUM emission required to fully cover user gas via subsidy alone, valued in USD:\n`);
  out.push(`| Users | DATUM emission (DOT-eq/yr) | ${DOT_PRICES.map(p => `$${p}/DOT`).join(" | ")} |`);
  out.push(`|---:|---:|${DOT_PRICES.map(() => "---:").join("|")}|`);
  for (const n of [10_000, 100_000, 1_000_000]) {
    const emission = n * impsPerYr * crossoverPerImp;
    const cells = DOT_PRICES.map(p => `$${(emission * p).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    out.push(`| ${n.toLocaleString()} | ${emission.toFixed(0)} | ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push(`The protocol's DATUM emission policy must scale with DOT price if it wants to keep`);
  out.push(`real-world subsidy purchasing power constant. Alternatively, peg the DATUM-per-imp`);
  out.push(`reward to a USD value (re-priced via oracle), which automates this.\n`);

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
  out.push(`- Halving interval: 4 years (Bitcoin-style cadence; configurable).`);
  out.push(`- DOT price growth per halving: 2× (conservative; flat-priced and aggressive bands shown for comparison).`);
  out.push(`- DATUM emission halves every 4 years (Bitcoin-style cadence).`);
  out.push(`- DATUM price growth per halving: 2× (same scarcity logic as DOT).`);
  out.push(`- Baseline DOT = $5; baseline DATUM = $0.10 (illustrative).`);
  out.push(`- Baseline DATUM emission = enough to cover subsidy at 1M users = ~42,143 DOT-eq/yr.`);
  out.push(`- User behaviour (3,650 imps/yr, monthly batching) and gas price (5 gwei) held constant.`);
  out.push(`- No on-chain gas repricing modelled — pure exogenous price shifts.\n`);

  const HALVING_INTERVAL = 4;
  const HALVINGS = 17; // 0..17 covers years 0..72
  const DOT_BASE_USD = 5;
  const DATUM_BASE_USD = 0.10;
  const DATUM_BASE_EMISSION = 42143; // DOT-eq/yr at year 0 (1M user crossover subsidy)
  const DOT_GROWTH_PER_HALVING = 2;
  const DATUM_GROWTH_PER_HALVING = 2;
  const programmaticVPI = 0.001; // USD/imp

  out.push(`**Trajectory under conservative growth (2× per halving):**\n`);
  out.push(`| Year | Halvings | DOT/USD | DATUM/USD | User min CPM (USD) | Advertiser max CPM (USD, programmatic VPI) | Margin USD | Viable? | DATUM emission (DATUM/yr) | DATUM emission (USD/yr) |`);
  out.push(`|---:|---:|---:|---:|---:|---:|---:|:---:|---:|---:|`);
  for (let h = 0; h <= HALVINGS; h++) {
    const year = h * HALVING_INTERVAL;
    const dotUSD = DOT_BASE_USD * Math.pow(DOT_GROWTH_PER_HALVING, h);
    const datumUSD = DATUM_BASE_USD * Math.pow(DATUM_GROWTH_PER_HALVING, h);
    const userMinCPM_USD = userMinCPM * dotUSD;
    // Advertiser max CPM in DOT for $0.001/imp at 10k campaign:
    const vpiDOT = programmaticVPI / dotUSD;
    const setupPerKimpDOT = setupDOT * 1000 / 10_000;
    const maxCPM_DOT = 1000 * vpiDOT - setupPerKimpDOT;
    const maxCPM_USD = maxCPM_DOT * dotUSD;
    const marginUSD = maxCPM_USD - userMinCPM_USD;
    const viable = marginUSD > 0;
    // DATUM emission halves each period (token-units per year)
    // Base token-units/yr = base USD emission / base price = DATUM_BASE_EMISSION / DATUM_BASE_USD
    // But the DOT-eq emission also halves
    const datumEmissionDOTeq = DATUM_BASE_EMISSION / Math.pow(2, h);
    // In token count, baseline = DATUM_BASE_EMISSION / DATUM_BASE_USD × DOT_BASE_USD  (since DOT-eq is in DOT)
    const datumTokensPerYr_base = (DATUM_BASE_EMISSION * DOT_BASE_USD) / DATUM_BASE_USD;  // tokens at year 0
    const datumTokensPerYr = datumTokensPerYr_base / Math.pow(2, h);
    const datumEmissionUSD = datumTokensPerYr * datumUSD;
    out.push(`| ${year} | ${h} | $${dotUSD.toFixed(2)} | $${datumUSD.toFixed(2)} | $${userMinCPM_USD.toFixed(3)} | $${maxCPM_USD.toFixed(3)} | $${marginUSD.toFixed(3)} | ${viable ? "✓" : "✗"} | ${datumTokensPerYr.toExponential(2)} | $${datumEmissionUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })} |`);
  }
  out.push("");

  out.push(`**Trajectory under aggressive DOT growth (4× per halving):**\n`);
  out.push(`Same model, but DOT price quadruples per halving while DATUM doubles. Stress-test:`);
  out.push(`when does the chain hit a viability cliff?\n`);
  out.push(`| Year | DOT/USD | User min CPM (USD) | Advertiser max CPM (USD, programmatic VPI) | Viable? | Notes |`);
  out.push(`|---:|---:|---:|---:|:---:|---|`);
  for (let h = 0; h <= 8; h++) {
    const year = h * HALVING_INTERVAL;
    const dotUSD = DOT_BASE_USD * Math.pow(4, h);
    const userMinCPM_USD = userMinCPM * dotUSD;
    const vpiDOT = programmaticVPI / dotUSD;
    const setupPerKimpDOT = setupDOT * 1000 / 10_000;
    const maxCPM_DOT = 1000 * vpiDOT - setupPerKimpDOT;
    const maxCPM_USD = maxCPM_DOT * dotUSD;
    const viable = maxCPM_USD > userMinCPM_USD;
    let notes = "";
    if (h === 0) notes = "Baseline";
    else if (!viable && h > 0) notes = "Gas repricing required";
    else if (maxCPM_USD < 2 * userMinCPM_USD) notes = "Margin tight (<2×)";
    out.push(`| ${year} | $${dotUSD.toFixed(0)} | $${userMinCPM_USD.toFixed(2)} | $${maxCPM_USD.toFixed(2)} | ${viable ? "✓" : "✗"} | ${notes} |`);
  }
  out.push("");

  // Find the year at which conservative growth makes programmatic no-longer-viable
  let firstUnviableYear = -1;
  let datumSubsidyCrossover = -1;
  for (let h = 0; h <= HALVINGS; h++) {
    const dotUSD = DOT_BASE_USD * Math.pow(2, h);
    const userMinCPM_USD = userMinCPM * dotUSD;
    const vpiDOT = programmaticVPI / dotUSD;
    const setupPerKimpDOT = setupDOT * 1000 / 10_000;
    const maxCPM_DOT = 1000 * vpiDOT - setupPerKimpDOT;
    const maxCPM_USD = maxCPM_DOT * dotUSD;
    if (firstUnviableYear < 0 && maxCPM_USD < userMinCPM_USD) firstUnviableYear = h * HALVING_INTERVAL;
  }
  // DATUM purchasing power: emission_DOTeq × DOT_price_USD (in original DOT-eq terms)
  // Crossover threshold: DATUM emission USD value can still cover gas for 1M users?
  for (let h = 0; h <= HALVINGS; h++) {
    const dotUSD = DOT_BASE_USD * Math.pow(2, h);
    const datumUSD = DATUM_BASE_USD * Math.pow(2, h);
    const datumTokens = (DATUM_BASE_EMISSION * DOT_BASE_USD / DATUM_BASE_USD) / Math.pow(2, h);
    const datumEmissionUSD = datumTokens * datumUSD;
    // 1M-user subsidy needs (in USD): 42,143 DOT-eq × current DOT price
    const subsidyNeededUSD = 42143 * dotUSD;
    if (datumSubsidyCrossover < 0 && datumEmissionUSD < subsidyNeededUSD) datumSubsidyCrossover = h * HALVING_INTERVAL;
  }

  out.push(`### Halving-projection findings\n`);
  out.push(`- **Programmatic-display first hits no-market under conservative growth**: ${firstUnviableYear < 0 ? "never within 70 years" : `year ${firstUnviableYear}`}.`);
  out.push(`  Higher-VPI campaigns (retargeting and above) stay viable longer.`);
  out.push(`- **DATUM subsidy purchasing power crosses below 1M-user need**: ${datumSubsidyCrossover < 0 ? "never within 70 years (token grows fast enough)" : `year ${datumSubsidyCrossover}`}.`);
  out.push(`  Beyond this, the protocol must mint more DATUM, raise the per-imp reward, or rely on`);
  out.push(`  organic gas-market repricing.`);
  out.push(`- **Under aggressive DOT growth (4×/halving)**, even programmatic display fails within ~8`);
  out.push(`  years without gas repricing. This is the strongest argument for an on-chain gas-fee`);
  out.push(`  governor or DOT-pegged fee market (Hub-level upgrade).`);
  out.push(`- **DATUM emission halves but its DOT-equivalent value grows**: if DATUM price grows`);
  out.push(`  ≥ 2× per halving, the per-imp subsidy maintains DOT-equivalent purchasing power.`);
  out.push(`  If it grows slower, subsidy weakens — argues for DATUM peg-to-USD via oracle.\n`);

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

  out.push(`### Per-relay annual cost recap (5 gwei)\n`);
  out.push(`| Tier | DOT/yr | Per-claim gas |`);
  out.push(`|---|---:|---:|`);
  const relayHobby = tierGasFor("Relay", RELAY_TIERS, "Hobby")    * 5e-9;
  const relayStd   = tierGasFor("Relay", RELAY_TIERS, "Standard") * 5e-9;
  const relayHvy   = tierGasFor("Relay", RELAY_TIERS, "Heavy")    * 5e-9;
  const relayHyp   = tierGasFor("Relay", RELAY_TIERS, "Hyper")    * 5e-9;
  out.push(`| Hobby (1 batch/hr × 1 claim) | ${relayHobby.toFixed(2)} | ${Math.round(gas1).toLocaleString()} (no amortisation) |`);
  out.push(`| Standard (1 batch/hr × 5 claims) | ${relayStd.toFixed(2)} | ${Math.round(gas5/5).toLocaleString()} |`);
  out.push(`| Heavy (10 batches/hr × 10 claims) | ${relayHvy.toFixed(2)} | ${Math.round(gas10/10).toLocaleString()} |`);
  out.push(`| Hyper (1 batch/min × 10 claims) | ${relayHyp.toFixed(2)} | ${Math.round(gas10/10).toLocaleString()} |`);
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

async function main() {
  console.log("Deploying full alpha-4 stack in-process...");
  const ctx = await deployAll();
  console.log("Deploy complete. Measuring operations:\n");
  await measureAll(ctx);

  const md = emitMarkdown();
  const outPath = path.join(__dirname, "..", "docs", "gas-by-role.md");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  console.log(`\nReport written to ${outPath}`);
  console.log(`Total measurements: ${rows.length}, skipped: ${rows.filter(r => r.gas === 0n).length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
