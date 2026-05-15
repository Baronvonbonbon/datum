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
interface UserTier {
  label: string;
  description: string;
  ops: Record<string, number>;  // op -> daily frequency
}
const USER_TIERS: UserTier[] = [
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

  // ─── Per-user fee burn (annual, by engagement tier) ───────────────────────
  out.push(`## Per-user fee burn (annual)\n`);
  out.push(`Annual transaction-fee cost (DOT/PAS) for a single end user across four`);
  out.push(`engagement tiers. Excludes posted bonds, locked stake, and DATUM token movement —`);
  out.push(`pure gas spend. Calculation: \`Σ ops × gas[op] × 365 × gas_price\`.\n`);

  out.push(`### Tier definitions\n`);
  out.push(`| Tier | Description | Onboard/yr | Reports/yr | Withdrawals/yr |`);
  out.push(`|---|---|---:|---:|---:|`);
  for (const t of USER_TIERS) {
    const onboard = (t.ops["zkStake.depositWith"] ?? 0) * 365;
    const reports = (t.ops["reportPage (reason 1)"] ?? 0) * 365;
    const withdraws = (t.ops["vault.withdrawUser"] ?? 0) * 365;
    out.push(`| ${t.label} | ${t.description} | ${onboard.toFixed(1)} | ${reports.toFixed(0)} | ${withdraws.toFixed(0)} |`);
  }
  out.push("");

  // Compute gas for one user-year per tier
  const userOpGas = new Map<string, bigint>();
  for (const r of rows.filter(r => r.role === "User")) userOpGas.set(r.op, r.gas);

  out.push(`### Annual gas per user (units)\n`);
  out.push(`| Tier | Gas/user/year |`);
  out.push(`|---|---:|`);
  const tierGas = new Map<string, bigint>();
  for (const t of USER_TIERS) {
    let total = 0n;
    for (const [op, daily] of Object.entries(t.ops)) {
      const gas = userOpGas.get(op) ?? 0n;
      // gas × daily × 365 — but daily is fractional, so use big-number-safe math via Number for the multiplier
      total += BigInt(Math.round(Number(gas) * daily * 365));
    }
    tierGas.set(t.label, total);
    out.push(`| ${t.label} | ${total.toString()} |`);
  }
  out.push("");

  out.push(`### Annual cost per user (DOT/PAS)\n`);
  out.push(`| Tier | ${GAS_PRICE_SCENARIOS.map(s => `${s.label} (${s.gwei} gwei)`).join(" | ")} |`);
  out.push(`|---|${GAS_PRICE_SCENARIOS.map(() => "---:").join("|")}|`);
  for (const t of USER_TIERS) {
    const gas = Number(tierGas.get(t.label) ?? 0n);
    const cells = GAS_PRICE_SCENARIOS.map(s => (gas * s.gwei * 1e-9).toExponential(2));
    out.push(`| ${t.label} | ${cells.join(" | ")} |`);
  }
  out.push("");

  // Network-scale aggregate: per-user cost × user count examples
  out.push(`### Network-aggregate at common user counts (annual DOT, Typical tier)\n`);
  out.push(`Multiplies the Typical-tier per-user cost by example user counts.`);
  out.push(`Linear in user count — divide by 1000 for any other base.\n`);
  const typicalGas = Number(tierGas.get("Typical") ?? 0n);
  const counts = [100, 1_000, 10_000, 100_000, 1_000_000];
  out.push(`| Users | ${GAS_PRICE_SCENARIOS.map(s => `${s.gwei} gwei`).join(" | ")} |`);
  out.push(`|---:|${GAS_PRICE_SCENARIOS.map(() => "---:").join("|")}|`);
  for (const n of counts) {
    const cells = GAS_PRICE_SCENARIOS.map(s => (typicalGas * n * s.gwei * 1e-9).toExponential(2));
    out.push(`| ${n.toLocaleString()} | ${cells.join(" | ")} |`);
  }
  out.push("");

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
