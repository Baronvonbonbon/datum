// /about/economics — value-proposition + cost model deep dive.
//
// Synthesises the Paseo gas figures from docs/gas-paseo-20260528.md into a
// per-role cost/revenue narrative. Six things to deliver at once:
//   1. Compare DATUM's revenue split against three real ad-tech baselines.
//   2. Quantify monthly campaign cost in mPAS / PAS / USD based on measured gas.
//   3. Break out each role (User, Publisher, Advertiser, Relay, Protocol) with
//      its own collapsible section, colour-themed per the app's role tokens.
//   4. Let the reader tune assumptions (impressions, CPM, PAS price, batch size).
//   5. Render comparison charts via recharts so the numbers are readable at a
//      glance, not stuck in a table.
//   6. Stay honest about what's measured vs projected.

import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
  PieChart, Pie, Cell,
  LineChart, Line,
} from "recharts";

// ── Two gas sources ────────────────────────────────────────────────────────
// PASEO = docs/gas-paseo-20260528.md — eth_estimateGas against the live alpha-5
//   deploy with PoW disabled. Optimistic; reflects what the gateway returns.
// HARDHAT = docs/gas-by-role.md — actual gas used during full-pipeline runs
//   with every gate active. Conservative; matches what a real TX consumes.
//
// The Hardhat numbers for settle are ~11× the Paseo numbers for the same op.
// The page exposes a toggle so the reader can pick which model is in force.
type GasSource = "paseo" | "hardhat";
type ActionType = "cpm" | "cpc" | "cpa";

interface GasTable {
  // Campaign lifecycle
  createCampaign: number;
  adminActivateCampaign: number;
  // Settle by action type — first claim in a fresh TX
  settleCpmCold: number;
  settleCpmWarm: number;
  settleCpc: number;
  settleCpa: number;
  // Marginal claim cost when batched into the same TX (Hardhat-measured)
  settleAddedClaimSmall: number;   // claims 2..5 in same TX
  settleAddedClaimLarge: number;   // claims 6+ in same TX
  // User-side
  withdrawUser: number;
  reportPage: number;
  reportAd: number;
  setUserMinAssurance: number;
  zkStakeDeposit: number;
  zkStakeWithdraw: number;
  // Publisher / Relay
  withdrawPublisher: number;
  registerPublisher: number;
  setRelaySigner: number;
  setProfile: number;
  publisherStake: number;
  // Reporter — V1 (single-sig threshold path)
  reporterV1Commit: number;
  reporterV1FirstSigner: number;
  reporterV1Cosign: number;
  // Reporter — V2 (4-step multi-sig)
  reporterV2Join: number;
  reporterV2Propose: number;
  reporterV2Approve: number;
  reporterV2Finalize: number;
  // Governance / Voter
  governanceVoteAye: number;
  governanceVoteNay: number;
  governanceEvaluate: number;
  // Council
  councilPropose: number;
  councilVote: number;
  councilExecute: number;
  // Curator
  curatorBlock: number;
  curatorUnblock: number;
  // Admin / Pause
  pauseFast: number;
  pauseProposeUnpause: number;
  pauseApproveUnpause: number;
  // TokenHolder
  feeShareClaim: number;
  bootstrapClaim: number;
  emissionAdjustRate: number;
}

// Marginal claim costs (Hardhat-measured from the 1/5/10-claim batch points):
//   (579,680 − 443,908) / 4 = 33,943 per added claim in small batches (2..5)
//   (834,851 − 579,680) / 5 = 51,034 per added claim in large batches (6+)
// Inferred CPC/CPA ratios for Paseo are derived from the Hardhat ratio applied
// to the measured Paseo cold-CPM figure.
const PASEO_RATIO_CPC = 179_789 / 443_908;  // ~0.405
const PASEO_RATIO_CPA = 371_330 / 443_908;  // ~0.836
const PASEO_TABLE: GasTable = {
  createCampaign: 73_799,
  adminActivateCampaign: 2_356,
  settleCpmCold: 40_915,
  settleCpmWarm: 32_815,
  settleCpc: Math.round(40_915 * PASEO_RATIO_CPC),  // ≈16,571 (inferred)
  settleCpa: Math.round(40_915 * PASEO_RATIO_CPA),  // ≈34,205 (inferred)
  settleAddedClaimSmall: 33_943,
  settleAddedClaimLarge: 51_034,
  withdrawUser: 59_661,        // not measured Paseo-side; uses Hardhat value
  reportPage: 8_899,
  reportAd: 8_458,
  setUserMinAssurance: 48_328,
  zkStakeDeposit: 135_185,
  zkStakeWithdraw: 77_904,
  withdrawPublisher: 34_883,
  registerPublisher: 90_697,
  setRelaySigner: 80_743,
  setProfile: 59_536,
  publisherStake: 47_683,
  reporterV1Commit: 191_605,
  reporterV1FirstSigner: 127_764,
  reporterV1Cosign: 113_566,
  reporterV2Join: 164_844,
  reporterV2Propose: 251_088,
  reporterV2Approve: 103_157,
  reporterV2Finalize: 106_437,
  governanceVoteAye: 216_044,
  governanceVoteNay: 238_263,
  governanceEvaluate: 74_090,
  councilPropose: 338_338,
  councilVote: 79_033,
  councilExecute: 132_301,
  curatorBlock: 73_034,
  curatorUnblock: 30_500,
  pauseFast: 170_543,
  pauseProposeUnpause: 142_517,
  pauseApproveUnpause: 117_012,
  feeShareClaim: 33_124,
  bootstrapClaim: 34_866,
  emissionAdjustRate: 54_083,
};

const HARDHAT_TABLE: GasTable = {
  createCampaign: 388_063,
  adminActivateCampaign: 74_090,  // proxy: governance.evaluateCampaign
  settleCpmCold: 443_908,
  settleCpmWarm: 443_908,  // Hardhat doesn't distinguish; use cold for both
  settleCpc: 179_789,
  settleCpa: 371_330,
  settleAddedClaimSmall: 33_943,
  settleAddedClaimLarge: 51_034,
  withdrawUser: 59_661,
  reportPage: 118_412,
  reportAd: 118_412,  // not separately measured; mirror reportPage
  setUserMinAssurance: 48_328,
  zkStakeDeposit: 135_185,
  zkStakeWithdraw: 77_904,
  withdrawPublisher: 34_883,
  registerPublisher: 90_697,
  setRelaySigner: 80_743,
  setProfile: 59_536,
  publisherStake: 47_683,
  reporterV1Commit: 191_605,
  reporterV1FirstSigner: 127_764,
  reporterV1Cosign: 113_566,
  reporterV2Join: 164_844,
  reporterV2Propose: 251_088,
  reporterV2Approve: 103_157,
  reporterV2Finalize: 106_437,
  governanceVoteAye: 216_044,
  governanceVoteNay: 238_263,
  governanceEvaluate: 74_090,
  councilPropose: 338_338,
  councilVote: 79_033,
  councilExecute: 132_301,
  curatorBlock: 73_034,
  curatorUnblock: 30_500,
  pauseFast: 170_543,
  pauseProposeUnpause: 142_517,
  pauseApproveUnpause: 117_012,
  feeShareClaim: 33_124,
  bootstrapClaim: 34_866,
  emissionAdjustRate: 54_083,
};

function gasTable(source: GasSource): GasTable {
  return source === "paseo" ? PASEO_TABLE : HARDHAT_TABLE;
}

// gasForSettle: base settle gas for a TX containing `claims` claim records of
// the given action type. Uses the Hardhat-measured marginal curve regardless
// of source — the curve shape is the same; only the base differs.
function gasForSettle(claimsInTx: number, actionType: ActionType, source: GasSource): number {
  const t = gasTable(source);
  const base =
    actionType === "cpc" ? t.settleCpc :
    actionType === "cpa" ? t.settleCpa :
    t.settleCpmCold;
  if (claimsInTx <= 1) return base;
  const small = Math.min(claimsInTx - 1, 4);  // claims 2..5
  const large = Math.max(0, claimsInTx - 5);  // claims 6+
  return base + small * t.settleAddedClaimSmall + large * t.settleAddedClaimLarge;
}

// Publisher stake bonding curve (measured by STAKE-1 in the Paseo run).
const STAKE_BASE_PLANCK = 1;             // baseStakeWei
const STAKE_PER_IMP_PLANCK = 1_000;      // planckPerImpression
const PLANCK_PER_PAS = 1e10;             // substrate-native: 1 PAS = 10^10 planck
// Bonded relay fee (governance-tunable). Modelled as a flat percentage of
// total settled revenue retained by the relay operator under the Bonded path.
const BONDED_RELAY_FEE_PCT = 1.0;        // 1% of revenue
// Opportunity cost of locked stake capital (annualised).
const STAKE_OPPORTUNITY_APR_PCT = 5.0;

// gasPrice = 10^12 wei/gas at the Paseo eth-rpc layer (18-decimal wei).
// 1 PAS = 10^18 wei = 10^10 planck. So 1 gas unit = 10^-6 PAS = 1 μPAS.
const PAS_PER_GAS = 1e-6;

// ── Revenue split ──────────────────────────────────────────────────────────
// Settlement math in DatumSettlementLogicB:
//   total          = rateWei × eventCount / 1000   (CPM normalisation)
//   publisherPay   = total × takeRateBps / 10_000     (default 50%)
//   remainder      = total - publisherPay
//   userPayment    = remainder × userShareBps / 10_000 (default 75% of rem)
//   protocolFee    = remainder - userPayment           (the remaining 25%)
// With default 50% take + 75% user-of-remainder:
//   publisher = 50.00 %
//   user      = 37.50 %
//   protocol  = 12.50 %
// Legacy comparison baselines. Sum to 100 within each row. The DATUM row at
// index 0 is replaced at render time with the live slider state.
const LEGACY_SPLITS = [
  { name: "DATUM",      publisher: 50.0, user: 37.5, protocol: 12.5, adTech: 0,    opaque: 0 },
  { name: "IAB 2024",   publisher: 51.0, user: 0,    protocol: 0,    adTech: 30.0, opaque: 19.0 },
  { name: "Google AM",  publisher: 68.0, user: 0,    protocol: 0,    adTech: 32.0, opaque: 0 },
  { name: "ANA 2023",   publisher: 36.0, user: 0,    protocol: 0,    adTech: 22.0, opaque: 42.0 },
];

const COLORS = {
  publisher: "var(--role-publisher)",
  user:      "var(--role-user)",
  protocol:  "var(--role-protocol)",
  adTech:    "#94a3b8",   // neutral slate
  opaque:    "#475569",   // darker slate
  advertiser:"var(--role-advertiser)",
  relay:     "var(--role-relay)",
} as const;

// Bake the literals out for recharts (it doesn't evaluate CSS vars).
const PIE_COLORS = {
  publisher: "#fbbf24",
  user:      "#4ade80",
  protocol:  "#f472b6",
  adTech:    "#94a3b8",
  opaque:    "#475569",
} as const;

// ── Tiers + sliders ─────────────────────────────────────────────────────────
const TIERS = [
  { id: "small",  label: "Small",  impsPerMonth:    10_000 },
  { id: "medium", label: "Medium", impsPerMonth:   100_000 },
  { id: "large",  label: "Large",  impsPerMonth: 1_000_000 },
] as const;

type SettlementPath = "direct" | "dualsig" | "bonded";
type Horizon = "month" | "year" | "3year";

interface Params {
  impsPerMonth: number;
  cpmPAS: number;            // CPM bid in PAS (rate per 1000 view events)
  cpcPAS: number;            // CPC bid in PAS per click
  cpaPAS: number;            // CPA bid in PAS per action
  pasPriceUSD: number;       // PAS → USD assumption
  impsPerClaim: number;      // how many events are batched into one claim
  claimsPerTx: number;       // how many claim records get bundled into one settle TX
  takeRateBps: number;       // publisher take, in basis points (3000..8000)
  userShareBps: number;      // user's share of remainder (5000..9000)
  actionType: ActionType;
  path: SettlementPath;
  horizon: Horizon;
  gasSource: GasSource;
  // Publisher cadence
  withdrawsPerMonth: number;
  // User cadence (per-user, per-month)
  userWithdrawsPerMonth: number;
  userReportsPerMonth: number;
  userZkOpsPerMonth: number;
  // Audience size — how many unique users share the user-pool take
  uniqueUsersPerMonth: number;
}

function defaultParams(impsPerMonth: number): Params {
  return {
    impsPerMonth,
    cpmPAS: 0.5,
    cpcPAS: 0.20,
    cpaPAS: 2.50,
    pasPriceUSD: 1.0,
    impsPerClaim: 1000,
    claimsPerTx: 1,
    takeRateBps: 5000,
    userShareBps: 7500,
    actionType: "cpm",
    path: "direct",
    horizon: "month",
    gasSource: "hardhat",    // conservative default
    withdrawsPerMonth: 4,
    userWithdrawsPerMonth: 1,
    userReportsPerMonth: 0,
    userZkOpsPerMonth: 0,
    uniqueUsersPerMonth: 1000,
  };
}

const HORIZON_MULT: Record<Horizon, number> = { month: 1, year: 12, "3year": 36 };
const HORIZON_LABEL: Record<Horizon, string> = { month: "/ month", year: "/ year", "3year": "/ 3 years" };

// ── Core economics computation ──────────────────────────────────────────────
// All figures are monthly first; horizon scaling happens via horizonMult so the
// callers can choose to apply it (or not) on a per-stat basis.
function compute(p: Params) {
  const g = gasTable(p.gasSource);
  const horizonMult = HORIZON_MULT[p.horizon];
  const impsPerDay = p.impsPerMonth / 30;
  const claimsPerMonth = Math.ceil(p.impsPerMonth / Math.max(1, p.impsPerClaim));
  const txsPerMonth = Math.ceil(claimsPerMonth / Math.max(1, p.claimsPerTx));
  // Per-TX settle gas, using the measured density curve and action type.
  const perTxSettleGas = gasForSettle(p.claimsPerTx, p.actionType, p.gasSource);

  // ── Revenue per event depends on action type ──
  // CPM (view): bid is per-1000 events.
  // CPC (click): bid is per-event (flat).
  // CPA (action): bid is per-event (flat, higher rate).
  const revenuePerEvent =
    p.actionType === "cpm" ? p.cpmPAS / 1000 :
    p.actionType === "cpc" ? p.cpcPAS :
    p.cpaPAS;

  const totalRevenuePAS = revenuePerEvent * p.impsPerMonth;

  // ── Split: publisher / user / protocol ──
  const takeRatePct  = p.takeRateBps / 100;
  const userSharePct = p.userShareBps / 100;
  const publisherSharePct = takeRatePct;
  const userOfWhole = (100 - takeRatePct) * (userSharePct / 100);
  const protocolOfWhole = (100 - takeRatePct) * (1 - userSharePct / 100);

  let publisherPAS = totalRevenuePAS * (publisherSharePct / 100);
  let userPAS      = totalRevenuePAS * (userOfWhole / 100);
  let protocolPAS  = totalRevenuePAS * (protocolOfWhole / 100);

  // ── Gas (recurring per month) ──
  const oneTimeGasUnits = g.createCampaign + g.adminActivateCampaign;
  const monthlySettleGasUnits = txsPerMonth * perTxSettleGas;
  const oneTimeGasPAS = oneTimeGasUnits * PAS_PER_GAS;
  const monthlySettleGasPAS = monthlySettleGasUnits * PAS_PER_GAS;

  // ── Settlement path: who absorbs the gas, who earns the bonded relay fee ──
  let gasOnPublisherPAS = 0;
  let gasOnAdvertiserPAS = 0;
  let gasOnRelayPAS = 0;
  let bondedRelayFeePAS = 0;

  if (p.path === "direct") {
    gasOnPublisherPAS = monthlySettleGasPAS;
  } else if (p.path === "dualsig") {
    gasOnAdvertiserPAS = monthlySettleGasPAS;
  } else {
    gasOnRelayPAS = monthlySettleGasPAS;
    bondedRelayFeePAS = totalRevenuePAS * (BONDED_RELAY_FEE_PCT / 100);
    publisherPAS -= bondedRelayFeePAS;
  }

  // ── Publisher overhead: vault withdraws ──
  const withdrawGasPAS = Math.max(0, p.withdrawsPerMonth) * g.withdrawPublisher * PAS_PER_GAS;

  // ── User-side gas (cadence-driven, per-user, per-month) ──
  // Cadence sliders are per single user; userPAS aggregates across the whole
  // audience. To avoid mixing scales we expose both: per-user (what a wallet
  // actually nets) and pool (what the protocol routes to all users combined).
  const uniqueUsers = Math.max(1, p.uniqueUsersPerMonth);
  const userWithdrawGasPAS = Math.max(0, p.userWithdrawsPerMonth) * g.withdrawUser * PAS_PER_GAS;
  const userReportGasPAS   = Math.max(0, p.userReportsPerMonth)   * g.reportPage   * PAS_PER_GAS;
  const userZkGasPAS       = Math.max(0, p.userZkOpsPerMonth)     * g.zkStakeDeposit * PAS_PER_GAS;
  const userTotalGasPAS    = userWithdrawGasPAS + userReportGasPAS + userZkGasPAS; // per-user
  // Per-user (what a single wallet sees)
  const perUserGrossPAS    = userPAS / uniqueUsers;
  const perUserNetMonthlyPAS = perUserGrossPAS - userTotalGasPAS;
  // Pool (aggregate user-side: divide gas inputs not made; multiply gas instead)
  const userPoolGasPAS     = userTotalGasPAS * uniqueUsers;
  const userPoolNetPAS     = userPAS - userPoolGasPAS;

  // ── Publisher stake bonding curve ──
  // requiredStake = base + cumulativeImpressions × perImp (in planck).
  // The "cumulative" depends on lifetime; for monthly view treat it as a
  // running floor of p.impsPerMonth × horizonMult (proxy for the horizon's worth
  // of impressions). Opportunity cost = locked × APR / horizon.
  const horizonImps = p.impsPerMonth * horizonMult;
  const requiredStakeWei = STAKE_BASE_PLANCK + horizonImps * STAKE_PER_IMP_PLANCK;
  const requiredStakePAS = requiredStakeWei / PLANCK_PER_PAS;
  // Annualised opportunity cost prorated to horizon
  const stakeOpportunityCostPAS =
    requiredStakePAS * (STAKE_OPPORTUNITY_APR_PCT / 100) * (horizonMult / 12);

  // ── Net take after gas + withdraw + stake opportunity (publisher view) ──
  const publisherNetMonthlyPAS = publisherPAS - gasOnPublisherPAS - withdrawGasPAS;
  const publisherNetHorizonPAS = publisherNetMonthlyPAS * horizonMult - stakeOpportunityCostPAS;

  // ── TCO ──
  const monthlyTCO_AdvertiserPAS = totalRevenuePAS + gasOnAdvertiserPAS;
  const firstMonthTCO_AdvertiserPAS = monthlyTCO_AdvertiserPAS + oneTimeGasPAS;

  // ── Per-impression cost summary ──
  const costPerImpPAS = totalRevenuePAS / Math.max(1, p.impsPerMonth);
  const gasPerImpPAS  = monthlySettleGasPAS / Math.max(1, p.impsPerMonth);

  return {
    // Volume & cadence
    impsPerDay, claimsPerMonth, horizonMult,
    revenuePerEvent,

    // Revenue (monthly)
    totalRevenuePAS,
    publisherPAS, userPAS, protocolPAS,
    bondedRelayFeePAS,

    // Gas (monthly)
    oneTimeGasPAS,
    monthlySettleGasPAS,
    gasOnPublisherPAS, gasOnAdvertiserPAS, gasOnRelayPAS,
    withdrawGasPAS,

    // Publisher net + stake
    publisherNetMonthlyPAS,
    publisherNetHorizonPAS,
    requiredStakePAS,
    stakeOpportunityCostPAS,

    // Advertiser TCO
    monthlyTCO_AdvertiserPAS,
    firstMonthTCO_AdvertiserPAS,

    // User gas + net (per-user + pool)
    userWithdrawGasPAS, userReportGasPAS, userZkGasPAS,
    userTotalGasPAS,
    perUserGrossPAS, perUserNetMonthlyPAS,
    userPoolGasPAS, userPoolNetPAS,
    uniqueUsers,

    // Splits as percentages (for chart data)
    publisherSharePct, userOfWhole, protocolOfWhole,

    // Per-impression
    costPerImpPAS, gasPerImpPAS,

    // Settle gas detail (for UI explanation)
    txsPerMonth, perTxSettleGas,

    // Horizon helpers
    h: (monthlyValue: number) => monthlyValue * horizonMult,
    usd: (pas: number) => pas * p.pasPriceUSD,
  };
}

// ── Pretty-format helpers ───────────────────────────────────────────────────
function fmtPAS(v: number): string {
  if (v === 0) return "0";
  if (v < 1e-3) return `${(v * 1e6).toFixed(2)} μPAS`;
  if (v < 1)    return `${(v * 1e3).toFixed(2)} mPAS`;
  if (v < 1e3)  return `${v.toFixed(3)} PAS`;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} PAS`;
}
function fmtUSD(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${(v * 100).toFixed(2)}¢`;
  if (v < 1)    return `$${v.toFixed(3)}`;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function fmtInt(v: number): string {
  return v.toLocaleString();
}

// ── Reusable: collapsible role section ──────────────────────────────────────
interface RoleSectionProps {
  roleVar: string;            // CSS var name, e.g. "--role-publisher"
  icon: string;
  title: string;
  subtitle: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}
function RoleSection({ roleVar, icon, title, subtitle, defaultOpen, children }: RoleSectionProps) {
  return (
    <details
      open={defaultOpen}
      className="nano-card"
      style={{
        padding: 0,
        borderLeft: `3px solid var(${roleVar})`,
        background: `var(${roleVar}-dim)`,
        overflow: "hidden",
      }}
    >
      <summary
        style={{
          padding: "14px 18px",
          cursor: "pointer",
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          fontSize: 16,
          fontWeight: 600,
          color: "var(--text-strong)",
          listStyle: "none",
        }}
      >
        <span style={{ fontSize: 22, lineHeight: 1 }}>{icon}</span>
        <span>{title}</span>
        <span style={{
          marginLeft: "auto",
          fontSize: 12,
          color: "var(--text-muted)",
          fontWeight: 400,
        }}>
          {subtitle}
        </span>
      </summary>
      <div style={{ padding: "0 18px 20px 18px", background: "var(--bg-raised)" }}>
        {children}
      </div>
    </details>
  );
}

// ── Small numeric "stat" block ──────────────────────────────────────────────
// tone:
//   - "credit" (green border + value tint, "+" prefix on value) → money in
//   - "debit"  (red border + value tint, "−" prefix on value)   → money out
//   - "neutral" → informational (counts, percentages, gas paid by someone else)
type StatTone = "credit" | "debit" | "neutral";
function Stat({ label, value, sub, tone = "neutral" }: {
  label: string; value: string; sub?: string; tone?: StatTone;
}) {
  const isCredit = tone === "credit";
  const isDebit  = tone === "debit";
  const accent =
    isCredit ? "var(--ok)" :
    isDebit  ? "var(--error)" :
    "var(--border)";
  const valueColor =
    isCredit ? "var(--ok)" :
    isDebit  ? "var(--error)" :
    "var(--text-strong)";
  const prefix =
    isCredit ? "+" :
    isDebit  ? "−" :
    "";
  return (
    <div style={{
      padding: "10px 12px",
      background: "var(--bg-surface)",
      border: "1px solid var(--border)",
      borderLeft: `3px solid ${accent}`,
      borderRadius: 6,
      minWidth: 130,
    }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, color: valueColor, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
        {prefix}{value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

// ── Prominent net card ─────────────────────────────────────────────────────
// Displayed at the top of each role section. tone defines the chrome (green
// for net-positive earner, red for net-negative spender, neutral for breakeven).
function NetCard({
  label, value, sub, tone, roleVar,
}: {
  label: string; value: string; sub?: string;
  tone: StatTone; roleVar?: string;
}) {
  const accent =
    tone === "credit" ? "var(--ok)" :
    tone === "debit"  ? "var(--error)" :
    "var(--border)";
  const valueColor =
    tone === "credit" ? "var(--ok)" :
    tone === "debit"  ? "var(--error)" :
    "var(--text-strong)";
  const prefix =
    tone === "credit" ? "+" :
    tone === "debit"  ? "−" :
    "";
  return (
    <div style={{
      padding: "14px 18px",
      marginTop: 14,
      background: roleVar ? `var(${roleVar}-dim)` : "var(--bg-surface)",
      border: `1px solid ${accent}`,
      borderLeft: `4px solid ${accent}`,
      borderRadius: 8,
      display: "flex",
      flexDirection: "column",
      gap: 4,
    }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, color: valueColor, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: "-0.01em" }}>
        {prefix}{value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{sub}</div>
      )}
    </div>
  );
}

function StatRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12, marginBottom: 12 }}>
      {children}
    </div>
  );
}

// ── Segmented toggle (radio-style chip group) ───────────────────────────────
interface SegOption<T extends string> { id: T; label: string; hint?: string }
function Segmented<T extends string>(
  { value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: SegOption<T>[]; label?: string }
) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220, flex: 1 }}>
      {label && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            title={o.hint}
            style={{
              fontSize: 12,
              padding: "5px 10px",
              borderRadius: 4,
              border: `1px solid ${value === o.id ? "var(--accent)" : "var(--border)"}`,
              background: value === o.id ? "var(--accent)" : "transparent",
              color: value === o.id ? "var(--bg)" : "var(--text)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Slider control ──────────────────────────────────────────────────────────
// Value is both slider-draggable and directly typeable in the small input on
// the right. Free typing is allowed while the input is focused; on blur or
// Enter the value is parsed, clamped to [min, max], and snapped to `step`.
// `tooltip` renders a small ⓘ next to the label with a native title hover;
// it defaults to `hint` so each slider gets at least a tooltip for free.
function Slider({
  label, value, onChange, min, max, step, fmt, hint, tooltip,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number;
  fmt: (v: number) => string; hint?: string; tooltip?: string;
}) {
  // Local text mirror so typing "0." or partials doesn't snap-back to the
  // committed value mid-keystroke. We commit (clamp + snap) on blur/Enter.
  const [text, setText] = React.useState<string>(() => formatTyped(value, step));
  const [focused, setFocused] = React.useState(false);
  // Re-sync local text whenever the external value changes and we're not
  // actively editing (e.g. user dragged the slider).
  React.useEffect(() => {
    if (!focused) setText(formatTyped(value, step));
  }, [value, step, focused]);

  const commit = (raw: string) => {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) {
      setText(formatTyped(value, step));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    // Snap to step grid, anchored at `min`, to keep slider position consistent.
    const snapped = Math.round((clamped - min) / step) * step + min;
    const final = Number(snapped.toFixed(stepDecimals(step)));
    onChange(final);
    setText(formatTyped(final, step));
  };

  const effectiveTooltip = tooltip ?? hint;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220, flex: 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--text-muted)", gap: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {label}
          {effectiveTooltip && (
            <span
              title={effectiveTooltip}
              aria-label={effectiveTooltip}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 14, height: 14, borderRadius: "50%",
                border: "1px solid var(--border)", color: "var(--text-muted)",
                fontSize: 9, fontWeight: 700, cursor: "help",
                lineHeight: 1, userSelect: "none",
              }}
            >
              i
            </span>
          )}
        </span>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
          <input
            type="text"
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={(e) => { setFocused(true); e.target.select(); }}
            onBlur={() => { setFocused(false); commit(text); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); }
              if (e.key === "Escape") { setText(formatTyped(value, step)); (e.target as HTMLInputElement).blur(); }
            }}
            title={effectiveTooltip}
            style={{
              width: 72,
              padding: "1px 4px",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              color: "var(--text-strong)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              textAlign: "right",
            }}
          />
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, minWidth: 60, textAlign: "right" }}>
            {fmt(value)}
          </span>
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
      {hint && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{hint}</div>}
    </div>
  );
}

// Render the raw numeric value at the precision implied by `step` (e.g.
// step=0.01 → 2 decimals). Keeps the typeable text input compact while still
// letting users see the underlying precision the slider snaps to.
function formatTyped(value: number, step: number): string {
  const d = stepDecimals(step);
  return d > 0 ? value.toFixed(d) : String(Math.round(value));
}
function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step >= 1) return 0;
  const s = String(step);
  const dot = s.indexOf(".");
  return dot >= 0 ? s.length - dot - 1 : 0;
}

// ── Common ops-role section ────────────────────────────────────────────────
// All the ops/governance roles are cadence-driven (not impression-driven), so
// they share the same compact shell: cadence slider, total gas, total cost,
// horizon scaling.
interface OpsRoleProps {
  params: Params;
  roleVar: string;
  icon: string;
  title: string;
  subtitle: string;
  intro: React.ReactNode;
  // List of ops with their gas cost and how to project them
  ops: { label: string; gas: number; cadencePerMonth: number; sub?: string }[];
}
function OpsRoleSection({ params, roleVar, icon, title, subtitle, intro, ops }: OpsRoleProps) {
  const horizonMult = HORIZON_MULT[params.horizon];
  const monthlyTotal = ops.reduce((s, op) => s + op.gas * op.cadencePerMonth * PAS_PER_GAS, 0);
  const horizonTotal = monthlyTotal * horizonMult;
  return (
    <RoleSection roleVar={roleVar} icon={icon} title={title} subtitle={subtitle}>
      <NetCard
        roleVar={roleVar}
        tone="debit"
        label={`Ops cost ${HORIZON_LABEL[params.horizon].replace("/ ", "")}`}
        value={`${fmtPAS(horizonTotal)} · ${fmtUSD(horizonTotal * params.pasPriceUSD)}`}
        sub={`= Σ (gas × cadence) over ${ops.length} op${ops.length > 1 ? "s" : ""}`}
      />
      <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>{intro}</p>
      <StatRow>
        {ops.map((op, i) => {
          const monthlyCost = op.gas * op.cadencePerMonth * PAS_PER_GAS;
          return (
            <Stat
              key={i}
              tone={op.cadencePerMonth > 0 ? "debit" : "neutral"}
              label={op.label}
              value={fmtPAS(monthlyCost * horizonMult)}
              sub={op.sub ?? `${op.cadencePerMonth}/mo × ${fmtPAS(op.gas * PAS_PER_GAS)}`}
            />
          );
        })}
      </StatRow>
    </RoleSection>
  );
}

// ── Reporter ────────────────────────────────────────────────────────────────
function ReporterSection({ params }: { params: Params }) {
  const [version, setVersion] = useState<"v1" | "v2">("v2");
  const [commitsPerMonth, setCommitsPerMonth] = useState(4);  // weekly attestation
  const g = gasTable(params.gasSource);
  const ops = version === "v1"
    ? [
        { label: "commitStakeRoot (threshold 1)", gas: g.reporterV1Commit, cadencePerMonth: commitsPerMonth },
        { label: "first-signer (2-of-N)",         gas: g.reporterV1FirstSigner, cadencePerMonth: 0 },
        { label: "cosigner finalise",             gas: g.reporterV1Cosign, cadencePerMonth: 0 },
      ]
    : [
        { label: "joinReporters (one-time)",  gas: g.reporterV2Join,     cadencePerMonth: 0 },
        { label: "proposeRoot",               gas: g.reporterV2Propose,  cadencePerMonth: commitsPerMonth },
        { label: "approveRoot",               gas: g.reporterV2Approve,  cadencePerMonth: commitsPerMonth },
        { label: "finalizeRoot",              gas: g.reporterV2Finalize, cadencePerMonth: commitsPerMonth },
      ];
  return (
    <div>
      <OpsRoleSection
        params={params}
        roleVar="--role-relay"
        icon="📜"
        title="Reporter"
        subtitle={`${version === "v1" ? "V1 single-threshold" : "V2 4-step multi-sig"} stake-root attestation`}
        intro={<>
          The Reporter role posts periodic stake-root attestations to <code>DatumStakeRoot{version === "v2" ? "V2" : ""}</code>.
          V2 is the 4-step (join → propose → approve → finalize) multi-sig flow that landed
          with alpha-5's identity bridge. Cadence depends on the configured attestation window
          (default ~weekly). Each cycle hits multiple ops; the total is what a reporter operator
          pays per month.
        </>}
        ops={ops}
      />
      <div style={{ marginTop: -14, padding: "10px 14px 14px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 6px 6px", display: "flex", flexWrap: "wrap", gap: 24 }}>
        <Segmented
          label="Reporter version"
          value={version}
          onChange={setVersion}
          options={[
            { id: "v2", label: "V2 · 4-step" },
            { id: "v1", label: "V1 · threshold" },
          ]}
        />
        <Slider
          label={`${version === "v2" ? "Full cycles" : "Commits"} / month`}
          value={commitsPerMonth} onChange={setCommitsPerMonth}
          min={0} max={30} step={1}
          fmt={(v) => `${v}`}
          hint="default 4 = ~weekly cadence"
        />
      </div>
    </div>
  );
}

// ── Voter ───────────────────────────────────────────────────────────────────
function VoterSection({ params }: { params: Params }) {
  const [votesPerMonth, setVotesPerMonth] = useState(4);
  const [evalsPerMonth, setEvalsPerMonth] = useState(1);
  const g = gasTable(params.gasSource);
  return (
    <div>
      <OpsRoleSection
        params={params}
        roleVar="--role-voter"
        icon="🗳"
        title="Voter (conviction governance)"
        subtitle={`vote aye ${(g.governanceVoteAye / 1000).toFixed(0)}k · vote nay ${(g.governanceVoteNay / 1000).toFixed(0)}k gas`}
        intro={<>
          DatumGovernanceV2 votes are conviction-weighted with 0–8x multipliers. <strong>Nay
          votes cost ~10% more gas than aye</strong> (238k vs 216k) — the contract takes a
          slightly different code path to record dissent. <code>evaluateCampaign</code>
          finalises tallies and is typically called by the same voter who pushes the proposal
          over quorum.
        </>}
        ops={[
          { label: "vote (aye)",         gas: g.governanceVoteAye,   cadencePerMonth: votesPerMonth },
          { label: "vote (nay) +10%",    gas: g.governanceVoteNay,   cadencePerMonth: 0 },
          { label: "evaluateCampaign",   gas: g.governanceEvaluate,  cadencePerMonth: evalsPerMonth },
        ]}
      />
      <div style={{ marginTop: -14, padding: "10px 14px 14px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 6px 6px", display: "flex", flexWrap: "wrap", gap: 24 }}>
        <Slider label="Votes / month" value={votesPerMonth} onChange={setVotesPerMonth} min={0} max={50} step={1} fmt={(v) => `${v}`} hint="cast on active proposals" />
        <Slider label="evaluateCampaign / month" value={evalsPerMonth} onChange={setEvalsPerMonth} min={0} max={20} step={1} fmt={(v) => `${v}`} hint="finalise tallies" />
      </div>
    </div>
  );
}

// ── Council ─────────────────────────────────────────────────────────────────
function CouncilSection({ params }: { params: Params }) {
  const [proposalsPerMonth, setProposalsPerMonth] = useState(1);
  const [votesPerMonth, setVotesPerMonth] = useState(4);
  const [executesPerMonth, setExecutesPerMonth] = useState(1);
  const g = gasTable(params.gasSource);
  return (
    <div>
      <OpsRoleSection
        params={params}
        roleVar="--role-voter"
        icon="⚖️"
        title="Council"
        subtitle={`propose ${(g.councilPropose / 1000).toFixed(0)}k · vote ${(g.councilVote / 1000).toFixed(0)}k · execute ${(g.councilExecute / 1000).toFixed(0)}k`}
        intro={<>
          <code>DatumCouncil</code> handles phase-1 governance + multi-sig safety overrides.
          <strong> Proposing is by far the most expensive op</strong> (338k gas) — it
          allocates a fresh proposal slot, hashes the payload, and writes initial vote
          state. Voting and execute are cheap by comparison.
        </>}
        ops={[
          { label: "propose",  gas: g.councilPropose, cadencePerMonth: proposalsPerMonth },
          { label: "vote",     gas: g.councilVote,    cadencePerMonth: votesPerMonth },
          { label: "execute",  gas: g.councilExecute, cadencePerMonth: executesPerMonth },
        ]}
      />
      <div style={{ marginTop: -14, padding: "10px 14px 14px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 6px 6px", display: "flex", flexWrap: "wrap", gap: 24 }}>
        <Slider label="Proposes / month" value={proposalsPerMonth} onChange={setProposalsPerMonth} min={0} max={20} step={1} fmt={(v) => `${v}`} hint="council.propose calls / month" />
        <Slider label="Votes / month"    value={votesPerMonth}     onChange={setVotesPerMonth}     min={0} max={50} step={1} fmt={(v) => `${v}`} hint="council.vote calls / month" />
        <Slider label="Executes / month" value={executesPerMonth}  onChange={setExecutesPerMonth}  min={0} max={20} step={1} fmt={(v) => `${v}`} hint="council.execute calls / month — runs the queued proposal" />
      </div>
    </div>
  );
}

// ── Curator ────────────────────────────────────────────────────────────────
function CuratorSection({ params }: { params: Params }) {
  const [blocksPerMonth, setBlocksPerMonth] = useState(2);
  const [unblocksPerMonth, setUnblocksPerMonth] = useState(0);
  const g = gasTable(params.gasSource);
  return (
    <div>
      <OpsRoleSection
        params={params}
        roleVar="--role-protocol"
        icon="🛡"
        title="Curator (blocklist)"
        subtitle={`block ${(g.curatorBlock / 1000).toFixed(0)}k · unblock ${(g.curatorUnblock / 1000).toFixed(0)}k gas`}
        intro={<>
          <code>DatumCouncilBlocklistCurator</code> is the per-campaign address blocklist
          managed by elected Council members. <strong>Block is ~2.4× the cost of unblock</strong>
          (73k vs 31k) — block writes a new entry plus reverse-index, unblock only clears
          a slot. Asymmetry is by design: easy to forgive, slow to escalate.
        </>}
        ops={[
          { label: "blockAddr",    gas: g.curatorBlock,   cadencePerMonth: blocksPerMonth },
          { label: "unblockAddr",  gas: g.curatorUnblock, cadencePerMonth: unblocksPerMonth },
        ]}
      />
      <div style={{ marginTop: -14, padding: "10px 14px 14px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 6px 6px", display: "flex", flexWrap: "wrap", gap: 24 }}>
        <Slider label="Blocks / month"   value={blocksPerMonth}   onChange={setBlocksPerMonth}   min={0} max={30} step={1} fmt={(v) => `${v}`} hint="curator.blockAddr calls / month" />
        <Slider label="Unblocks / month" value={unblocksPerMonth} onChange={setUnblocksPerMonth} min={0} max={30} step={1} fmt={(v) => `${v}`} hint="curator.unblockAddr calls / month — cheaper than block" />
      </div>
    </div>
  );
}

// ── TokenHolder ─────────────────────────────────────────────────────────────
function TokenHolderSection({ params }: { params: Params }) {
  const [feeShareClaimsPerMonth, setFeeShareClaimsPerMonth] = useState(1);
  const [bootstrapClaimsPerMonth, setBootstrapClaimsPerMonth] = useState(0);
  const g = gasTable(params.gasSource);
  return (
    <div>
      <OpsRoleSection
        params={params}
        roleVar="--role-protocol"
        icon="🪙"
        title="DATUM token holder"
        subtitle={`feeShare claim ${(g.feeShareClaim / 1000).toFixed(0)}k · bootstrap claim ${(g.bootstrapClaim / 1000).toFixed(0)}k gas`}
        intro={<>
          Holders of DATUM access protocol-fee revenue via <code>feeShare.claim</code>,
          which pulls accumulated treasury distributions into the holder's wallet. The
          bootstrap pool is a one-time pre-launch allocation reclaimed via <code>bootstrap.claim</code>.
          Both are cheap (~33–35k gas) — designed for high-frequency holder withdrawals.
        </>}
        ops={[
          { label: "feeShare.claim",   gas: g.feeShareClaim,   cadencePerMonth: feeShareClaimsPerMonth },
          { label: "bootstrap.claim",  gas: g.bootstrapClaim,  cadencePerMonth: bootstrapClaimsPerMonth },
        ]}
      />
      <div style={{ marginTop: -14, padding: "10px 14px 14px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 6px 6px", display: "flex", flexWrap: "wrap", gap: 24 }}>
        <Slider label="feeShare claims / month"  value={feeShareClaimsPerMonth}  onChange={setFeeShareClaimsPerMonth}  min={0} max={20} step={1} fmt={(v) => `${v}`} hint="feeShare.claim calls / month — pull treasury fee distributions" />
        <Slider label="bootstrap claims / month" value={bootstrapClaimsPerMonth} onChange={setBootstrapClaimsPerMonth} min={0} max={5}  step={1} fmt={(v) => `${v}`} hint="bootstrap.claim calls / month — one-time pre-launch allocation pull" />
      </div>
    </div>
  );
}

// ── Admin / Pause ───────────────────────────────────────────────────────────
function AdminSection({ params }: { params: Params }) {
  const [pausesPerMonth, setPausesPerMonth] = useState(0);
  const g = gasTable(params.gasSource);
  return (
    <div>
      <OpsRoleSection
        params={params}
        roleVar="--role-voter"
        icon="🛑"
        title="Admin / Pause"
        subtitle="Event-driven · ideally never used"
        intro={<>
          Pause + unpause are event-driven (incidents, scheduled upgrades). Cost-per-event
          is what matters here, not monthly cadence. <code>pauseFast</code> is the single-call
          owner pause; <code>proposeCategoryUnpause</code> + <code>approve</code> is the
          guardian unpause flow.
        </>}
        ops={[
          { label: "pause (owner)",         gas: g.pauseFast,             cadencePerMonth: pausesPerMonth },
          { label: "proposeCategoryUnpause", gas: g.pauseProposeUnpause,   cadencePerMonth: pausesPerMonth },
          { label: "approve (unpause)",     gas: g.pauseApproveUnpause,   cadencePerMonth: pausesPerMonth },
        ]}
      />
      <div style={{ marginTop: -14, padding: "10px 14px 14px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 6px 6px" }}>
        <Slider label="Pause/unpause cycles / month" value={pausesPerMonth} onChange={setPausesPerMonth} min={0} max={10} step={1} fmt={(v) => `${v}`} hint="default 0 — assume system stays up" />
      </div>
    </div>
  );
}

// ── Network aggregate panel ─────────────────────────────────────────────────
// Multiplies the per-campaign economics by an assumed number of publishers
// running at the same volume. Drives home that DATUM's treasury sizing is
// a function of network throughput, not per-claim margin.
function NetworkAggregate({ params }: { params: Params }) {
  const [N, setN] = useState(1000);
  const e = compute(params);
  const scaledPub  = e.publisherPAS * N;
  const scaledUser = e.userPAS * N;
  const scaledProt = e.protocolPAS * N;
  const scaledRev  = e.totalRevenuePAS * N;
  const scaledGas  = e.monthlySettleGasPAS * N;
  const horizonMult = e.horizonMult;
  return (
    <div className="nano-fade nano-card" style={{ padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--text-strong)" }}>
          Network aggregate
        </h2>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          if <strong style={{ color: "var(--text-strong)", fontFamily: "var(--font-mono)" }}>{N.toLocaleString()}</strong> publishers each ran at this tier
        </span>
      </div>
      <Slider
        label="Active publishers"
        value={N}
        onChange={setN}
        min={10} max={100_000} step={10}
        fmt={(v) => v.toLocaleString()}
        hint="adjust to your network-scale hypothesis"
      />
      <StatRow>
        <Stat label={`Network revenue ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(scaledRev * horizonMult)} sub={fmtUSD(scaledRev * horizonMult * params.pasPriceUSD)} />
        <Stat label={`Publishers total ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(scaledPub * horizonMult)} sub={fmtUSD(scaledPub * horizonMult * params.pasPriceUSD)} />
        <Stat label={`Users total ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(scaledUser * horizonMult)} sub={fmtUSD(scaledUser * horizonMult * params.pasPriceUSD)} />
        <Stat label={`Treasury ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(scaledProt * horizonMult)} sub={fmtUSD(scaledProt * horizonMult * params.pasPriceUSD)} />
        <Stat label={`Settlement gas ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(scaledGas * horizonMult)} sub={fmtUSD(scaledGas * horizonMult * params.pasPriceUSD)} />
        <Stat label={`TXs ${HORIZON_LABEL[params.horizon]}`} value={fmtInt(e.claimsPerMonth * N * horizonMult)} sub="settle calls on chain" />
      </StatRow>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
        At {N.toLocaleString()} publishers × {(params.impsPerMonth / 1e3).toFixed(0)}k events each = {fmtInt(params.impsPerMonth * N)} events per month.
        Settlement gas stays under <strong>{((scaledGas / Math.max(scaledRev, 1e-12)) * 100).toFixed(3)}%</strong> of total network revenue — testnet pricing.
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export function AboutEconomics() {
  const [tier, setTier] = useState<typeof TIERS[number]["id"]>("medium");
  const [params, setParams] = useState<Params>(() =>
    defaultParams(TIERS.find(t => t.id === "medium")!.impsPerMonth)
  );
  const econ = useMemo(() => compute(params), [params]);

  function applyTier(t: typeof TIERS[number]["id"]) {
    setTier(t);
    const imps = TIERS.find(x => x.id === t)!.impsPerMonth;
    setParams((p) => ({ ...p, impsPerMonth: imps }));
  }

  // Build pie data for DATUM revenue split (per-role chart)
  const datumPie = [
    { name: "Publisher", value: econ.publisherSharePct, fill: PIE_COLORS.publisher },
    { name: "User",      value: econ.userOfWhole,       fill: PIE_COLORS.user },
    { name: "Protocol",  value: econ.protocolOfWhole,   fill: PIE_COLORS.protocol },
  ];

  // Dynamic legacy chart rows: DATUM reflects the live slider state, the
  // legacy rows stay anchored to published baselines so we're comparing
  // current tuning against the industry rather than against historical defaults.
  const legacyRows = useMemo(() => ([
    { name: "DATUM", publisher: econ.publisherSharePct, user: econ.userOfWhole, protocol: econ.protocolOfWhole, adTech: 0, opaque: 0 },
    ...LEGACY_SPLITS.slice(1),
  ]), [econ.publisherSharePct, econ.userOfWhole, econ.protocolOfWhole]);

  // Monthly trajectory data — vary impressions/mo, hold others
  const trajectoryData = useMemo(() => {
    const points = [10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000];
    return points.map((imps) => {
      const e = compute({ ...params, impsPerMonth: imps });
      return {
        imps,
        impsLabel: imps >= 1e6 ? `${imps / 1e6}M` : `${imps / 1e3}k`,
        budget: e.totalRevenuePAS,
        gas: e.monthlySettleGasPAS,
        gasPct: (e.monthlySettleGasPAS / Math.max(e.totalRevenuePAS, 1e-12)) * 100,
      };
    });
  }, [params]);

  // Per-role earnings data for advertiser cost bar
  const advertiserCostBar = [
    { name: "Budget (revenue paid out)", value: econ.totalRevenuePAS, fill: PIE_COLORS.publisher },
    { name: params.path === "dualsig" ? "Monthly gas (advertiser-paid)" : "Monthly gas (not advertiser-paid)", value: econ.gasOnAdvertiserPAS, fill: PIE_COLORS.adTech },
    { name: "First-month gas (create + activate)", value: econ.oneTimeGasPAS, fill: PIE_COLORS.opaque },
  ];

  return (
    <div style={{ maxWidth: 920, display: "flex", flexDirection: "column", gap: 28 }}>

      {/* Hero ─────────────────────────────────────────────────────── */}
      <div className="nano-fade" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Link to="/about" style={{
          fontSize: 11, color: "var(--text-muted)", textDecoration: "none",
          letterSpacing: "0.06em", textTransform: "uppercase",
        }}>
          ← About index
        </Link>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <span style={{ fontSize: 38, lineHeight: 1 }}>📊</span>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, color: "var(--text-strong)", letterSpacing: "-0.02em" }}>
            Economics
          </h1>
        </div>
        <p style={{ fontSize: 15, color: "var(--text)", lineHeight: 1.6, margin: 0, maxWidth: 700 }}>
          What each role earns and what each role pays, projected from <strong>measured Paseo gas figures</strong>{" "}
          (<Link to="https://github.com/Baronvonbonbon/datum/blob/main/alpha-5/docs/gas-paseo-20260528.md" target="_blank" rel="noopener" style={{ color: "var(--accent)" }}>full gas report</Link>).
          Costs scale with impressions, batch density, and the PAS price you assume —
          all three are tunable below. Compared against three published legacy ad-tech splits
          (IAB 2024, Google Ad Manager, ANA 2023). Two big numbers up front:{" "}
          <strong style={{ color: "var(--role-user)" }}>users earn 37.5%</strong> of every
          settled impression (currently $0 in legacy), and a 1,000-impression batch settles
          for <strong style={{ color: "var(--text-strong)" }}>~41 mPAS</strong> — under
          5¢ at $1/PAS.
        </p>
      </div>

      {/* Tier + slider panel ─────────────────────────────────────── */}
      <div className="nano-fade nano-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>Tune the model</div>
          <div style={{ display: "flex", gap: 6 }}>
            {TIERS.map((t) => (
              <button
                key={t.id}
                onClick={() => applyTier(t.id)}
                style={{
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: 4,
                  border: `1px solid ${tier === t.id ? "var(--accent)" : "var(--border)"}`,
                  background: tier === t.id ? "var(--accent)" : "transparent",
                  color: tier === t.id ? "var(--bg)" : "var(--text)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {t.label} · {t.impsPerMonth >= 1e6 ? `${t.impsPerMonth / 1e6}M` : `${t.impsPerMonth / 1e3}k`}/mo
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <Slider
            label="Impressions per month"
            value={params.impsPerMonth}
            onChange={(v) => setParams((p) => ({ ...p, impsPerMonth: v }))}
            min={1_000} max={10_000_000} step={1_000}
            fmt={(v) => v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${(v / 1e3).toFixed(0)}k`}
            hint={`≈ ${fmtInt(Math.round(econ.impsPerDay))} per day`}
          />
          <Slider
            label="CPM (cost per 1000 imps)"
            value={params.cpmPAS}
            onChange={(v) => setParams((p) => ({ ...p, cpmPAS: v }))}
            min={0.01} max={10} step={0.01}
            fmt={(v) => `${v.toFixed(2)} PAS`}
            hint={`= ${fmtUSD(params.cpmPAS * params.pasPriceUSD)} at $${params.pasPriceUSD}/PAS`}
          />
          <Slider
            label="PAS → USD assumption"
            value={params.pasPriceUSD}
            onChange={(v) => setParams((p) => ({ ...p, pasPriceUSD: v }))}
            min={0.10} max={50} step={0.10}
            fmt={(v) => `$${v.toFixed(2)}`}
            hint="testnet baseline = $1; mainnet projections welcome"
          />
          <Slider
            label="Impressions batched per claim"
            value={params.impsPerClaim}
            onChange={(v) => setParams((p) => ({ ...p, impsPerClaim: v }))}
            min={1} max={1000} step={1}
            fmt={(v) => `${v}`}
            hint={`${fmtInt(econ.claimsPerMonth)} settlement TXs/month`}
          />
        </div>

        {/* Gas source + claims-per-TX */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <Segmented
            label="Gas source"
            value={params.gasSource}
            onChange={(v) => setParams((p) => ({ ...p, gasSource: v }))}
            options={[
              { id: "hardhat", label: "Hardhat · actual", hint: "Conservative: actual gas used during the full settlement pipeline" },
              { id: "paseo",   label: "Paseo · estimate", hint: "Optimistic: eth_estimateGas with PoW disabled" },
            ]}
          />
          <Slider
            label="Claims batched per settle TX"
            value={params.claimsPerTx}
            onChange={(v) => setParams((p) => ({ ...p, claimsPerTx: v }))}
            min={1} max={10} step={1}
            fmt={(v) => `${v}`}
            hint={`${fmtInt(econ.txsPerMonth)} settle TXs / month`}
          />
        </div>

        {/* Action type + Settlement path + Horizon — modes that flip semantics */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <Segmented
            label="Action type"
            value={params.actionType}
            onChange={(v) => setParams((p) => ({ ...p, actionType: v }))}
            options={[
              { id: "cpm", label: "CPM · view" },
              { id: "cpc", label: "CPC · click" },
              { id: "cpa", label: "CPA · action" },
            ]}
          />
          <Segmented
            label="Settlement path"
            value={params.path}
            onChange={(v) => setParams((p) => ({ ...p, path: v }))}
            options={[
              { id: "direct",  label: "Direct" },
              { id: "dualsig", label: "Dual-sig" },
              { id: "bonded",  label: "Bonded relay" },
            ]}
          />
          <Segmented
            label="Time horizon"
            value={params.horizon}
            onChange={(v) => setParams((p) => ({ ...p, horizon: v }))}
            options={[
              { id: "month",  label: "Monthly" },
              { id: "year",   label: "Annual" },
              { id: "3year",  label: "3-year" },
            ]}
          />
        </div>

        {/* Split sliders */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <Slider
            label="Publisher take rate"
            value={params.takeRateBps}
            onChange={(v) => setParams((p) => ({ ...p, takeRateBps: v }))}
            min={3000} max={8000} step={50}
            fmt={(v) => `${(v / 100).toFixed(1)}%`}
            hint="governance bounds 30–80%; default 50%"
          />
          <Slider
            label="User share of remainder"
            value={params.userShareBps}
            onChange={(v) => setParams((p) => ({ ...p, userShareBps: v }))}
            min={5000} max={9000} step={50}
            fmt={(v) => `${(v / 100).toFixed(1)}%`}
            hint={`= ${econ.userOfWhole.toFixed(1)}% of total · protocol gets ${econ.protocolOfWhole.toFixed(1)}%`}
          />
          <Slider
            label="Publisher withdraws / month"
            value={params.withdrawsPerMonth}
            onChange={(v) => setParams((p) => ({ ...p, withdrawsPerMonth: v }))}
            min={0} max={30} step={1}
            fmt={(v) => `${v}`}
            hint="vault withdraw is one TX each (~35k gas)"
          />
        </div>

        {/* Action-type specific bid slider */}
        {params.actionType === "cpc" && (
          <Slider
            label="CPC bid"
            value={params.cpcPAS}
            onChange={(v) => setParams((p) => ({ ...p, cpcPAS: v }))}
            min={0.01} max={5} step={0.01}
            fmt={(v) => `${v.toFixed(2)} PAS / click`}
            hint={`= ${fmtUSD(params.cpcPAS * params.pasPriceUSD)} at $${params.pasPriceUSD}/PAS`}
          />
        )}
        {params.actionType === "cpa" && (
          <Slider
            label="CPA bid"
            value={params.cpaPAS}
            onChange={(v) => setParams((p) => ({ ...p, cpaPAS: v }))}
            min={0.10} max={50} step={0.10}
            fmt={(v) => `${v.toFixed(2)} PAS / action`}
            hint={`= ${fmtUSD(params.cpaPAS * params.pasPriceUSD)} at $${params.pasPriceUSD}/PAS`}
          />
        )}
      </div>

      {/* Above-the-fold summary ─────────────────────────────────── */}
      <div className="nano-fade" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--text-strong)" }}>
          {params.horizon === "month" ? "Monthly" : params.horizon === "year" ? "Annual" : "3-year"} snapshot
        </h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Stat label="Total revenue" value={fmtPAS(econ.h(econ.totalRevenuePAS))} sub={fmtUSD(econ.usd(econ.h(econ.totalRevenuePAS)))} />
          <Stat label={`Publisher (${econ.publisherSharePct.toFixed(1)}%)`} value={fmtPAS(econ.h(econ.publisherPAS))} sub={fmtUSD(econ.usd(econ.h(econ.publisherPAS)))} />
          <Stat label={`User (${econ.userOfWhole.toFixed(1)}%)`} value={fmtPAS(econ.h(econ.userPAS))} sub={fmtUSD(econ.usd(econ.h(econ.userPAS)))} />
          <Stat label={`Protocol (${econ.protocolOfWhole.toFixed(1)}%)`} value={fmtPAS(econ.h(econ.protocolPAS))} sub={fmtUSD(econ.usd(econ.h(econ.protocolPAS)))} />
          {params.path === "bonded" && (
            <Stat label="Bonded relay fee" value={fmtPAS(econ.h(econ.bondedRelayFeePAS))} sub={`${BONDED_RELAY_FEE_PCT}% of revenue (from publisher take)`} />
          )}
          <Stat label="Settlement gas" value={fmtPAS(econ.h(econ.monthlySettleGasPAS))} sub={`${(econ.monthlySettleGasPAS / Math.max(econ.totalRevenuePAS, 1e-12) * 100).toFixed(2)}% of revenue · paid by ${params.path === "direct" ? "publisher" : params.path === "dualsig" ? "advertiser" : "relay"}`} />
          <Stat label="Cost per event" value={fmtPAS(econ.costPerImpPAS)} sub={fmtUSD(econ.usd(econ.costPerImpPAS))} />
        </div>
      </div>

      {/* Legacy split comparison ────────────────────────────────── */}
      <div className="nano-fade nano-card" style={{ padding: 18 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 600, color: "var(--text-strong)" }}>
          Revenue split vs published baselines
        </h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)", maxWidth: 680 }}>
          Each row sums to 100 % of advertiser spend. The slate segments are
          ad-tech middleware fees (DSP, SSP, exchange) and the "opaque delta"
          ANA flagged as un-attributable. The green is the user share — the
          number every legacy row leaves at 0 %.
        </p>
        <div style={{ width: "100%", height: 260 }}>
          <ResponsiveContainer>
            <BarChart data={legacyRows} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 16 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="var(--text-muted)" fontSize={11} />
              <YAxis type="category" dataKey="name" stroke="var(--text-muted)" fontSize={12} width={80} />
              <Tooltip
                cursor={{ fill: "var(--bg-raised)" }}
                contentStyle={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 4, fontSize: 12 }}
                formatter={(v: number) => `${v.toFixed(1)}%`}
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              <Bar dataKey="publisher" stackId="a" fill={PIE_COLORS.publisher} name="Publisher" />
              <Bar dataKey="user"      stackId="a" fill={PIE_COLORS.user}      name="User" />
              <Bar dataKey="protocol"  stackId="a" fill={PIE_COLORS.protocol}  name="Protocol / Treasury" />
              <Bar dataKey="adTech"    stackId="a" fill={PIE_COLORS.adTech}    name="Ad-tech middleware" />
              <Bar dataKey="opaque"    stackId="a" fill={PIE_COLORS.opaque}    name="Opaque / unattributable" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Per-role breakouts ───────────────────────────────────────── */}
      <h2 style={{ margin: "8px 0 0", fontSize: 18, fontWeight: 600, color: "var(--text-strong)" }}>
        Per-role economics
      </h2>

      {/* User ─────────────────────────────────────────────────────── */}
      <RoleSection
        roleVar="--role-user"
        icon="👤"
        title="User"
        subtitle={`Earns ${econ.userOfWhole.toFixed(1)}% of every settled event minus user-side gas · per-wallet view`}
      >
        <NetCard
          roleVar="--role-user"
          tone={econ.perUserNetMonthlyPAS > 0 ? "credit" : "debit"}
          label={`Per-user net ${HORIZON_LABEL[params.horizon].replace("/ ", "")}`}
          value={`${fmtPAS(Math.abs(econ.h(econ.perUserNetMonthlyPAS)))} · ${fmtUSD(Math.abs(econ.usd(econ.h(econ.perUserNetMonthlyPAS))))}`}
          sub={econ.userTotalGasPAS > 0
            ? `1 of ${econ.uniqueUsers.toLocaleString()} unique users · gross ${fmtPAS(econ.h(econ.perUserGrossPAS))} − gas ${fmtPAS(econ.h(econ.userTotalGasPAS))}`
            : `1 of ${econ.uniqueUsers.toLocaleString()} unique users · no user-side ops this month`}
        />
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>
          The user is the role legacy ad-tech doesn't pay. DATUM routes {econ.userOfWhole.toFixed(1)}% of every
          settled event to the user wallet that emitted it. The pool fans out across the audience,
          so what one wallet sees is <strong>pool ÷ unique users</strong>. Gas (withdraws, reports,
          optional ZK stake) is paid per-wallet — adjust audience size below to see how thin the
          slice gets when impressions spread across many users.
        </p>
        <StatRow>
          <Stat tone="credit" label="Per event (any user)" value={fmtPAS(econ.revenuePerEvent * econ.userOfWhole / 100)} sub={fmtUSD(econ.usd(econ.revenuePerEvent * econ.userOfWhole / 100))} />
          <Stat tone="credit" label={`Per-user gross ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.perUserGrossPAS))} sub={fmtUSD(econ.usd(econ.h(econ.perUserGrossPAS)))} />
          <Stat tone={econ.userWithdrawGasPAS > 0 ? "debit" : "neutral"} label="Withdraw gas" value={fmtPAS(econ.h(econ.userWithdrawGasPAS))} sub={`${params.userWithdrawsPerMonth}/mo × ${fmtPAS(gasTable(params.gasSource).withdrawUser * PAS_PER_GAS)}`} />
          <Stat tone={econ.userReportGasPAS > 0 ? "debit" : "neutral"} label="Report gas" value={fmtPAS(econ.h(econ.userReportGasPAS))} sub={`${params.userReportsPerMonth}/mo × ${fmtPAS(gasTable(params.gasSource).reportPage * PAS_PER_GAS)}`} />
          <Stat tone={econ.userZkGasPAS > 0 ? "debit" : "neutral"} label="ZK-stake gas" value={fmtPAS(econ.h(econ.userZkGasPAS))} sub={`${params.userZkOpsPerMonth}/mo × ${fmtPAS(gasTable(params.gasSource).zkStakeDeposit * PAS_PER_GAS)}`} />
        </StatRow>

        {/* User pool — aggregate sanity-check across the whole audience */}
        <div style={{ marginTop: 8, padding: "10px 12px", background: "var(--bg-surface)", border: "1px dashed var(--border)", borderRadius: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-strong)", marginBottom: 8 }}>
            User pool — aggregate across all {econ.uniqueUsers.toLocaleString()} users
          </div>
          <StatRow>
            <Stat tone="credit" label={`Pool gross ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.userPAS))} sub={fmtUSD(econ.usd(econ.h(econ.userPAS)))} />
            <Stat tone={econ.userPoolGasPAS > 0 ? "debit" : "neutral"} label={`Pool gas ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.userPoolGasPAS))} sub={`${econ.uniqueUsers.toLocaleString()} × per-user gas`} />
            <Stat tone={econ.userPoolNetPAS > 0 ? "credit" : "debit"} label={`Pool net ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.userPoolNetPAS))} sub={fmtUSD(econ.usd(econ.h(econ.userPoolNetPAS)))} />
          </StatRow>
        </div>

        {/* User cadence sliders */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, padding: "10px 12px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6 }}>
          <Slider
            label="Unique users / month"
            value={params.uniqueUsersPerMonth}
            onChange={(v) => setParams((p) => ({ ...p, uniqueUsersPerMonth: v }))}
            min={1} max={1_000_000} step={1}
            fmt={(v) => v.toLocaleString()}
            hint={`audience size — splits pool ${(params.impsPerMonth / Math.max(1, params.uniqueUsersPerMonth)).toFixed(1)} imps/user/mo`}
          />
          <Slider
            label="User withdraws / month"
            value={params.userWithdrawsPerMonth}
            onChange={(v) => setParams((p) => ({ ...p, userWithdrawsPerMonth: v }))}
            min={0} max={30} step={1}
            fmt={(v) => `${v}`}
            hint="vault.withdrawUser ~60k gas"
          />
          <Slider
            label="Reports filed / month"
            value={params.userReportsPerMonth}
            onChange={(v) => setParams((p) => ({ ...p, userReportsPerMonth: v }))}
            min={0} max={30} step={1}
            fmt={(v) => `${v}`}
            hint="reportPage 118k gas (Hardhat) · 9k (Paseo)"
          />
          <Slider
            label="ZK-stake ops / month"
            value={params.userZkOpsPerMonth}
            onChange={(v) => setParams((p) => ({ ...p, userZkOpsPerMonth: v }))}
            min={0} max={10} step={1}
            fmt={(v) => `${v}`}
            hint="zkStake.deposit 135k gas"
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-strong)", marginBottom: 6 }}>Revenue capture share</div>
            <div style={{ width: "100%", height: 160 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={datumPie} dataKey="value" nameKey="name" innerRadius={36} outerRadius={62} strokeWidth={0}>
                    {datumPie.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} contentStyle={{ background: "var(--bg-surface)", border: "1px solid var(--border)", fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-strong)", marginBottom: 6 }}>Where the money comes from</div>
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, color: "var(--text)", lineHeight: 1.7 }}>
              <li><strong>Your share:</strong> {econ.userOfWhole.toFixed(1)}% (= {(params.userShareBps / 100).toFixed(1)}% of the {(100 - params.takeRateBps / 100).toFixed(1)}% remainder after publisher take)</li>
              <li><strong>Caps:</strong> per-user-per-campaign window cap (advertiser-set) + global MAX_USER_EVENTS = 100k</li>
              <li><strong>Frequency:</strong> credited every settle; vault withdraw is 1 TX whenever you want</li>
              <li><strong>Sybil floors:</strong> user min-assurance levels (L0 permissive, L3 ZK-only) opt in / out per user</li>
            </ul>
          </div>
        </div>
      </RoleSection>

      {/* Publisher ─────────────────────────────────────────────── */}
      <RoleSection
        roleVar="--role-publisher"
        icon="🌐"
        title="Publisher"
        subtitle={`${econ.publisherSharePct.toFixed(1)}% take · ${params.path === "direct" ? "self-pays gas" : params.path === "dualsig" ? "advertiser pays gas" : `relay pays gas, takes ${BONDED_RELAY_FEE_PCT}%`}`}
      >
        <NetCard
          roleVar="--role-publisher"
          tone={econ.publisherNetHorizonPAS > 0 ? "credit" : "debit"}
          label={`Net ${HORIZON_LABEL[params.horizon].replace("/ ", "")}`}
          value={`${fmtPAS(Math.abs(econ.publisherNetHorizonPAS))} · ${fmtUSD(Math.abs(econ.usd(econ.publisherNetHorizonPAS)))}`}
          sub={`= take − gas absorbed − withdraws − stake opportunity cost (${params.path === "direct" ? "Direct path" : params.path === "dualsig" ? "Dual-sig path" : "Bonded path"})`}
        />
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>
          Publishers register a take rate (default 50%, negotiable 30–80% within
          governance bounds, currently <strong>{econ.publisherSharePct.toFixed(1)}%</strong> per the slider).
          The take rate locks per-campaign at activation. Gas for settlement is paid by whoever submits
          the batch — the publisher's own relay, a dual-signed advertiser, or a bonded DatumRelay operator
          (currently <strong>{params.path === "direct" ? "Direct" : params.path === "dualsig" ? "Dual-sig" : "Bonded"}</strong>).
        </p>
        <StatRow>
          <Stat tone="credit" label="Per event" value={fmtPAS(econ.revenuePerEvent * econ.publisherSharePct / 100)} sub={fmtUSD(econ.usd(econ.revenuePerEvent * econ.publisherSharePct / 100))} />
          <Stat tone="credit" label={`Gross take ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.publisherPAS))} sub={fmtUSD(econ.usd(econ.h(econ.publisherPAS)))} />
          <Stat tone={econ.gasOnPublisherPAS > 0 ? "debit" : "neutral"} label="Settlement gas" value={fmtPAS(econ.h(econ.gasOnPublisherPAS))} sub={params.path === "direct" ? `${(econ.gasOnPublisherPAS / Math.max(econ.publisherPAS, 1e-12) * 100).toFixed(3)}% of take` : `paid by ${params.path === "dualsig" ? "advertiser" : "relay"}`} />
          <Stat tone={econ.withdrawGasPAS > 0 ? "debit" : "neutral"} label={`Withdraws ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.withdrawGasPAS))} sub={`${params.withdrawsPerMonth}/month × ~35k gas`} />
          {params.path === "bonded" && (
            <Stat tone="debit" label="Bonded relay fee" value={fmtPAS(econ.h(econ.bondedRelayFeePAS))} sub={`${BONDED_RELAY_FEE_PCT}% off gross take`} />
          )}
          <Stat tone="debit" label="Stake opp. cost" value={fmtPAS(econ.stakeOpportunityCostPAS)} sub={`@ ${STAKE_OPPORTUNITY_APR_PCT}% APR on locked stake`} />
        </StatRow>
        <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>
          <strong style={{ color: "var(--text-strong)" }}>Three operational postures:</strong>
          <ul style={{ paddingLeft: 18, marginTop: 6 }}>
            <li><strong>Direct (self-relay):</strong> you pay gas, you keep cadence control. ~41 mPAS per settle TX.</li>
            <li><strong>Dual-sig:</strong> advertiser co-signs and submits. Your gas cost is 0; ops overhead is signing.</li>
            <li><strong>Bonded DatumRelay:</strong> a third-party operator submits on your behalf. They post a relayStake and earn a fee ({BONDED_RELAY_FEE_PCT}% of revenue, deducted from your gross take) plus gas reimbursement.</li>
          </ul>
        </div>

        {/* Stake TCO subsection */}
        <details style={{ marginTop: 14, padding: 12, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6 }}>
          <summary style={{ fontWeight: 600, fontSize: 13, color: "var(--text-strong)", cursor: "pointer" }}>
            Bonded stake + opportunity cost
          </summary>
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 10 }}>
            From measured params: <code>baseStakeWei = {STAKE_BASE_PLANCK}</code>, <code>planckPerImpression = {STAKE_PER_IMP_PLANCK}</code>.
            Required stake = base + cumulativeImpressions × perImp. The locked capital
            doesn't earn the take share but isn't spent either — it's an opportunity cost
            at the prevailing yield. The figure below assumes a {STAKE_OPPORTUNITY_APR_PCT}%
            annualised reference rate (treasury rate proxy).
          </p>
          <StatRow>
            <Stat label="Locked stake (horizon)" value={fmtPAS(econ.requiredStakePAS)} sub={fmtUSD(econ.usd(econ.requiredStakePAS))} />
            <Stat label="Opportunity cost" value={fmtPAS(econ.stakeOpportunityCostPAS)} sub={`@ ${STAKE_OPPORTUNITY_APR_PCT}% APR`} />
            <Stat label="% of take" value={`${econ.h(econ.publisherPAS) > 0 ? (econ.stakeOpportunityCostPAS / econ.h(econ.publisherPAS) * 100).toFixed(4) : "—"}%`} sub="negligible at this bonding curve" />
          </StatRow>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            At the testnet bonding curve, stake costs are functionally a rounding error —
            10⁻⁷ PAS per impression. A production curve calibrated for higher capital
            commitment would move this materially.
          </p>
        </details>

        {/* Vault withdraw amortisation */}
        <details style={{ marginTop: 10, padding: 12, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6 }}>
          <summary style={{ fontWeight: 600, fontSize: 13, color: "var(--text-strong)", cursor: "pointer" }}>
            Vault withdraw amortisation
          </summary>
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 10 }}>
            Each withdraw is a ~{gasTable(params.gasSource).withdrawPublisher.toLocaleString()}-gas TX. At
            <strong> {params.withdrawsPerMonth}</strong> withdraws/month, that's a
            recurring cost that amortises against the publisher's take.
          </p>
          <StatRow>
            <Stat label="Per withdraw" value={fmtPAS(gasTable(params.gasSource).withdrawPublisher * PAS_PER_GAS)} sub={fmtUSD(econ.usd(gasTable(params.gasSource).withdrawPublisher * PAS_PER_GAS))} />
            <Stat label="Monthly withdraw cost" value={fmtPAS(econ.withdrawGasPAS)} sub={`${(econ.withdrawGasPAS / Math.max(econ.publisherPAS, 1e-12) * 100).toFixed(4)}% of take`} />
            <Stat label={`${HORIZON_LABEL[params.horizon]} (horizon)`} value={fmtPAS(econ.h(econ.withdrawGasPAS))} sub={fmtUSD(econ.usd(econ.h(econ.withdrawGasPAS)))} />
          </StatRow>
        </details>
      </RoleSection>

      {/* Advertiser ───────────────────────────────────────────────── */}
      <RoleSection
        roleVar="--role-advertiser"
        icon="📢"
        title="Advertiser"
        subtitle="One-time ~74 mPAS setup + budget. Gas overhead caps at sub-2% of spend at any batch size ≥100."
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>
          The advertiser pays the campaign budget upfront (escrowed in DatumBudgetLedger)
          plus ~76 mPAS in one-time gas to create + activate the campaign. Per-month
          settlement gas comes out of whoever submits batches; in dual-sig posture the
          advertiser pays the settle gas directly.
        </p>
        <NetCard
          roleVar="--role-advertiser"
          tone="debit"
          label={`Total spend ${HORIZON_LABEL[params.horizon]}`}
          value={`${fmtPAS(econ.h(econ.monthlyTCO_AdvertiserPAS))} · ${fmtUSD(econ.usd(econ.h(econ.monthlyTCO_AdvertiserPAS)))}`}
          sub={`= budget delivered + settle gas (${params.path === "dualsig" ? "you pay it" : params.path === "direct" ? "publisher pays it" : "relay pays it"})`}
        />
        <StatRow>
          <Stat tone="debit" label="One-time gas (create + activate)" value={fmtPAS(econ.oneTimeGasPAS)} sub={fmtUSD(econ.usd(econ.oneTimeGasPAS))} />
          <Stat tone="debit" label={`Budget ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.totalRevenuePAS))} sub={fmtUSD(econ.usd(econ.h(econ.totalRevenuePAS)))} />
          <Stat tone={params.path === "dualsig" ? "debit" : "neutral"} label={`Settle gas (${params.path === "dualsig" ? "your cost" : "not your cost"})`} value={fmtPAS(econ.h(econ.gasOnAdvertiserPAS))} sub={params.path === "dualsig" ? `${(econ.gasOnAdvertiserPAS / econ.totalRevenuePAS * 100).toFixed(3)}% of budget` : `paid by ${params.path === "direct" ? "publisher" : "relay"}`} />
          <Stat tone="debit" label="First-month TCO" value={fmtPAS(econ.firstMonthTCO_AdvertiserPAS)} sub={fmtUSD(econ.usd(econ.firstMonthTCO_AdvertiserPAS))} />
          <Stat tone="debit" label={`TCO ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.monthlyTCO_AdvertiserPAS))} sub={fmtUSD(econ.usd(econ.h(econ.monthlyTCO_AdvertiserPAS)))} />
        </StatRow>
        <div style={{ width: "100%", height: 220, marginTop: 8 }}>
          <ResponsiveContainer>
            <BarChart data={advertiserCostBar} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" horizontal={false} />
              <XAxis type="number" stroke="var(--text-muted)" fontSize={11} tickFormatter={(v) => fmtPAS(v)} />
              <YAxis type="category" dataKey="name" stroke="var(--text-muted)" fontSize={11} width={210} />
              <Tooltip
                cursor={{ fill: "var(--bg-raised)" }}
                contentStyle={{ background: "var(--bg-surface)", border: "1px solid var(--border)", fontSize: 12 }}
                formatter={(v: number) => fmtPAS(v)}
              />
              <Bar dataKey="value" name="PAS" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
          <strong style={{ color: "var(--text-strong)" }}>What you don't pay:</strong> no DSP fee,
          no SSP fee, no ad exchange cut, no data broker, no agency markup. The {econ.protocolOfWhole.toFixed(1)}% protocol
          fee is the only middle. The user's {econ.userOfWhole.toFixed(1)}% is direct revenue back to your audience,
          which is a marketing channel legacy can't even offer.
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-strong)", marginBottom: 8 }}>
            Cost trajectory across campaign sizes
          </div>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={trajectoryData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
                <XAxis dataKey="impsLabel" stroke="var(--text-muted)" fontSize={11} />
                <YAxis stroke="var(--text-muted)" fontSize={11} tickFormatter={(v) => fmtPAS(v)} />
                <Tooltip
                  contentStyle={{ background: "var(--bg-surface)", border: "1px solid var(--border)", fontSize: 12 }}
                  formatter={(v: number, name: string) => [fmtPAS(v), name]}
                  labelFormatter={(l) => `${l} imps/month`}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="budget" name="Budget" stroke={PIE_COLORS.publisher} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="gas"    name="Gas"    stroke={PIE_COLORS.adTech}    strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Gas stays well below 1% of budget for any campaign ≥ 100k impressions per month at the modelled batch size.
          </div>
        </div>
      </RoleSection>

      {/* Relay / Reporter ─────────────────────────────────────────── */}
      <RoleSection
        roleVar="--role-relay"
        icon="🛰"
        title="Relay / Reporter"
        subtitle="Earns gas-reimbursement + a configurable per-batch fee. Bonded posture; permissionless."
      >
        {(() => {
          const relayNet = params.path === "bonded"
            ? econ.h(econ.bondedRelayFeePAS - econ.gasOnRelayPAS)
            : 0;
          const relayTone: StatTone =
            params.path !== "bonded" ? "neutral" :
            relayNet > 0 ? "credit" : "debit";
          return (
            <NetCard
              roleVar="--role-relay"
              tone={relayTone}
              label={params.path === "bonded" ? `Net ${HORIZON_LABEL[params.horizon].replace("/ ", "")}` : "Inactive on this path"}
              value={params.path === "bonded"
                ? `${fmtPAS(Math.abs(relayNet))} · ${fmtUSD(Math.abs(econ.usd(relayNet)))}`
                : "—"}
              sub={params.path === "bonded"
                ? `= ${BONDED_RELAY_FEE_PCT}% fee on revenue − gas float`
                : `relay only earns on the Bonded path (current path: ${params.path === "direct" ? "Direct" : "Dual-sig"})`}
            />
          );
        })()}
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>
          The bonded DatumRelay role is for off-chain operators who run the
          settlement bot for publishers (or for users with consent) that prefer
          not to operate one themselves. The relay posts a relayStake bond,
          receives signed claim batches over the wire, batches them as densely
          as economically viable, and submits. Their compensation is the gas
          reimbursement (recouped from the settle TX itself via the publisher
          take share) plus a configurable per-batch fee in the relayGovernance
          parameter set.
        </p>
        <StatRow>
          <Stat tone="neutral" label={`Per-TX settle gas (${params.claimsPerTx} claim${params.claimsPerTx > 1 ? "s" : ""})`} value={fmtPAS(econ.perTxSettleGas * PAS_PER_GAS)} sub={`${params.actionType.toUpperCase()} · ${params.gasSource}`} />
          <Stat tone="neutral" label="Warm settle gas" value={fmtPAS(gasTable(params.gasSource).settleCpmWarm * PAS_PER_GAS)} sub="same-block second touch" />
          <Stat tone="neutral" label="Settles / month" value={fmtInt(econ.claimsPerMonth)} sub={`${params.impsPerClaim} imps/claim`} />
          <Stat tone={econ.gasOnRelayPAS > 0 ? "debit" : "neutral"} label={`Gas float ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.gasOnRelayPAS))} sub={params.path === "bonded" ? "your cost" : `not your cost (paid by ${params.path === "direct" ? "publisher" : "advertiser"})`} />
          {params.path === "bonded" && (
            <Stat tone="credit" label={`Relay fee ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.bondedRelayFeePAS))} sub={`${BONDED_RELAY_FEE_PCT}% of revenue`} />
          )}
        </StatRow>
        <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
          <strong style={{ color: "var(--text-strong)" }}>Density beats CPM</strong> for relay
          profitability. Doubling impressions per claim cuts per-impression gas
          in half because settle cost is per-claim, not per-impression — SCALE-2
          (1 claim × 1000 imps) and SCALE-3 (1 × 10 imps) both land at ~33–41k
          gas. Run the slider above from 100 → 1000 imps/claim to see the
          monthly TX count drop 10×.
        </div>
        <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 8 }}>
          <strong style={{ color: "var(--text-strong)" }}>Bond economics:</strong> the relayStake
          is slashable if the relay submits invalid batches (claim chain breaks,
          double-spends, etc.). A clean relay's bond is dead capital that earns
          the per-batch fee; if Reputation V2 lands the bond also gates access
          to higher-volume publisher contracts.
        </div>
      </RoleSection>

      {/* Protocol / Treasury ──────────────────────────────────────── */}
      <RoleSection
        roleVar="--role-protocol"
        icon="🏛"
        title="Protocol / Treasury"
        subtitle={`${econ.protocolOfWhole.toFixed(1)}% of every settle accumulates into PaymentVault.protocolBalance`}
      >
        <NetCard
          roleVar="--role-protocol"
          tone="credit"
          label={`Treasury accrual ${HORIZON_LABEL[params.horizon].replace("/ ", "")}`}
          value={`${fmtPAS(econ.h(econ.protocolPAS))} · ${fmtUSD(econ.usd(econ.h(econ.protocolPAS)))}`}
          sub={`pure accrual · ${econ.protocolOfWhole.toFixed(1)}% of every settled event · no protocol-side gas`}
        />
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>
          The protocol fee is what funds DAO operations — audits, grants, infra,
          the People Chain identity bridge, the Bulletin Chain creative storage,
          and emission engine maintenance. It accumulates into a single
          PaymentVault slot keyed by governance authority. Phase 2 OpenGov
          decides withdraw cadence and target allocation.
        </p>
        <StatRow>
          <Stat tone="credit" label="Per event" value={fmtPAS(econ.revenuePerEvent * econ.protocolOfWhole / 100)} sub={fmtUSD(econ.usd(econ.revenuePerEvent * econ.protocolOfWhole / 100))} />
          <Stat tone="credit" label={`Accrual ${HORIZON_LABEL[params.horizon]}`} value={fmtPAS(econ.h(econ.protocolPAS))} sub={fmtUSD(econ.usd(econ.h(econ.protocolPAS)))} />
          <Stat tone="credit" label="Yearly accrual" value={fmtPAS(econ.protocolPAS * 12)} sub={fmtUSD(econ.usd(econ.protocolPAS * 12))} />
          <Stat tone="credit" label="At 10× this campaign" value={fmtPAS(econ.protocolPAS * 12 * 10)} sub={fmtUSD(econ.usd(econ.protocolPAS * 12 * 10))} />
        </StatRow>
        <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
          <strong style={{ color: "var(--text-strong)" }}>Scaling note:</strong> at 1 M impressions/month
          across one campaign, the protocol accrues
          {" "}{fmtPAS(compute({ ...params, impsPerMonth: 1_000_000 }).protocolPAS * 12)} per year.
          At 1 B impressions/month across the network — roughly Google AdSense's
          per-publisher long tail — that's
          {" "}{fmtPAS(compute({ ...params, impsPerMonth: 1_000_000_000 }).protocolPAS * 12)} per year.
          Treasury sizing for a real ad network is a function of network throughput, not per-claim margin.
        </div>
        <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 8 }}>
          <strong style={{ color: "var(--text-strong)" }}>Governance levers:</strong> the
          {econ.protocolOfWhole.toFixed(1)}% protocol fee, the {econ.publisherSharePct.toFixed(1)}% publisher take,
          and the {(params.userShareBps / 100).toFixed(1)}% user-share-of-remainder are all governance-tunable
          via DatumParameterGovernance (bounds enforced on-chain). Move the sliders above to see how each role's
          take responds.
        </div>
      </RoleSection>

      {/* ── Network ops & governance roles ───────────────────────── */}
      <h2 style={{ margin: "8px 0 0", fontSize: 18, fontWeight: 600, color: "var(--text-strong)" }}>
        Network ops & governance roles
      </h2>
      <p style={{ margin: "0 0 4px", fontSize: 13, color: "var(--text-muted)", maxWidth: 700 }}>
        These roles don't scale with campaign impressions — their cadence is set by
        protocol events (votes, proposals, attestation windows, fraud reports). Each
        section lets you adjust a per-month cadence to project actual cost.
      </p>

      <ReporterSection params={params} />
      <VoterSection params={params} />
      <CouncilSection params={params} />
      <CuratorSection params={params} />
      <TokenHolderSection params={params} />
      <AdminSection params={params} />

      {/* Network aggregate ──────────────────────────────────────── */}
      <NetworkAggregate params={params} />

      {/* Footer ──────────────────────────────────────────────────── */}
      <div className="nano-fade" style={{
        marginTop: 14, padding: 18, background: "var(--bg-raised)",
        border: "1px solid var(--border)", borderRadius: 8,
        fontSize: 13, color: "var(--text)", lineHeight: 1.6,
      }}>
        <strong style={{ color: "var(--text-strong)" }}>Honesty disclosures:</strong>{" "}
        Gas figures are from `alpha-5/docs/gas-paseo-20260528.md` — `eth_estimateGas`
        against the live alpha-5 deploy at the testnet's hardcoded `gasPrice = 10¹²
        wei/gas`. PoW is disabled during the benchmark run because the funded test
        users carry accumulated buckets across runs; the per-claim PoW preimage cost
        is therefore not in these figures. Legacy splits cite published industry
        figures (IAB 2024 Programmatic Supply Chain, Google AdSense Help, ANA 2023
        Programmatic Media Supply Chain Transparency Study). Production gas pricing
        is the real cost driver and may differ materially from testnet pricing.
        Numbers above scale linearly with the PAS price you set; they do not
        forecast a particular price.
      </div>
    </div>
  );
}
