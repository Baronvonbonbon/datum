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

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
  PieChart, Pie, Cell,
  LineChart, Line,
} from "recharts";

// ── Measured Paseo gas figures (alpha-5 deploy 2026-05-23) ─────────────────
// Source: docs/gas-paseo-20260528.md
const GAS = {
  createCampaign: 73_799,
  adminActivateCampaign: 2_356,
  settleClaimCold: 40_915,        // 1 claim, cold publisher storage slot
  settleClaimWarm: 32_815,        // 1 claim, warm slot (same block re-touch)
  reportPage: 8_899,
  reportAd: 8_458,
} as const;

// gasPrice = 10^12 wei/gas at the Paseo eth-rpc layer (18-decimal wei).
// 1 PAS = 10^18 wei = 10^10 planck. So 1 gas unit = 10^-6 PAS = 1 μPAS.
const PAS_PER_GAS = 1e-6;

// ── Revenue split ──────────────────────────────────────────────────────────
// Settlement math in DatumSettlementLogicB:
//   total          = ratePlanck × eventCount / 1000   (CPM normalisation)
//   publisherPay   = total × takeRateBps / 10_000     (default 50%)
//   remainder      = total - publisherPay
//   userPayment    = remainder × userShareBps / 10_000 (default 75% of rem)
//   protocolFee    = remainder - userPayment           (the remaining 25%)
// With default 50% take + 75% user-of-remainder:
//   publisher = 50.00 %
//   user      = 37.50 %
//   protocol  = 12.50 %
const DATUM_SPLIT = { publisher: 50, user: 37.5, protocol: 12.5, adTech: 0, opaque: 0 };

// Legacy comparison baselines. Sum to 100 within each row.
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

interface Params {
  impsPerMonth: number;
  cpmPAS: number;       // CPM bid in PAS
  pasPriceUSD: number;  // PAS → USD assumption
  impsPerClaim: number; // how many impressions are batched into one settle
}

function defaultParams(impsPerMonth: number): Params {
  return { impsPerMonth, cpmPAS: 0.5, pasPriceUSD: 1.0, impsPerClaim: 1000 };
}

// ── Core economics computation ──────────────────────────────────────────────
function compute(p: Params) {
  const impsPerDay = p.impsPerMonth / 30;
  const claimsPerMonth = Math.ceil(p.impsPerMonth / Math.max(1, p.impsPerClaim));

  // Revenue per impression (in PAS): CPM in PAS / 1000.
  const revenuePerImp = p.cpmPAS / 1000;
  const totalRevenuePAS = revenuePerImp * p.impsPerMonth;
  const publisherPAS = totalRevenuePAS * (DATUM_SPLIT.publisher / 100);
  const userPAS      = totalRevenuePAS * (DATUM_SPLIT.user / 100);
  const protocolPAS  = totalRevenuePAS * (DATUM_SPLIT.protocol / 100);

  // Advertiser gas costs (one-time + per-claim):
  // - createCampaign: once per campaign (~73,799 gas)
  // - adminActivateCampaign: once per campaign (~2,356 gas)
  //   (production phase-1/2 will be more, but for now this is the measured cost)
  // - settleClaims: claimsPerMonth × cold settle gas
  const oneTimeGasUnits = GAS.createCampaign + GAS.adminActivateCampaign;
  const monthlySettleGasUnits = claimsPerMonth * GAS.settleClaimCold;
  const oneTimeGasPAS = oneTimeGasUnits * PAS_PER_GAS;
  const monthlySettleGasPAS = monthlySettleGasUnits * PAS_PER_GAS;
  const monthlyGasPAS = monthlySettleGasPAS;          // recurring only
  const tcoMonthlyPAS = totalRevenuePAS + monthlyGasPAS;
  const tcoFirstMonthPAS = tcoMonthlyPAS + oneTimeGasPAS;

  // Per-impression cost summary
  const costPerImpPAS = totalRevenuePAS / p.impsPerMonth;
  const gasPerImpPAS  = monthlyGasPAS  / p.impsPerMonth;

  return {
    impsPerDay,
    claimsPerMonth,
    revenuePerImp,
    totalRevenuePAS,
    publisherPAS, userPAS, protocolPAS,
    oneTimeGasPAS, monthlyGasPAS, tcoMonthlyPAS, tcoFirstMonthPAS,
    costPerImpPAS, gasPerImpPAS,
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
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      padding: "10px 12px",
      background: "var(--bg-surface)",
      border: "1px solid var(--border)",
      borderRadius: 6,
      minWidth: 130,
    }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, color: "var(--text-strong)", fontWeight: 600, fontFamily: "var(--font-mono)" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>
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

// ── Slider control ──────────────────────────────────────────────────────────
function Slider({
  label, value, onChange, min, max, step, fmt, hint,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number;
  fmt: (v: number) => string; hint?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220, flex: 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-muted)" }}>
        <span>{label}</span>
        <span style={{ color: "var(--text-strong)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>{fmt(value)}</span>
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
    { name: "Publisher", value: DATUM_SPLIT.publisher, fill: PIE_COLORS.publisher },
    { name: "User",      value: DATUM_SPLIT.user,      fill: PIE_COLORS.user },
    { name: "Protocol",  value: DATUM_SPLIT.protocol,  fill: PIE_COLORS.protocol },
  ];

  // Monthly trajectory data — vary impressions/mo, hold others
  const trajectoryData = useMemo(() => {
    const points = [10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000];
    return points.map((imps) => {
      const e = compute({ ...params, impsPerMonth: imps });
      return {
        imps,
        impsLabel: imps >= 1e6 ? `${imps / 1e6}M` : `${imps / 1e3}k`,
        budget: e.totalRevenuePAS,
        gas: e.monthlyGasPAS,
        gasPct: (e.monthlyGasPAS / Math.max(e.totalRevenuePAS, 1e-12)) * 100,
      };
    });
  }, [params]);

  // Per-role earnings data for advertiser cost bar
  const advertiserCostBar = [
    { name: "Budget (revenue paid out)", value: econ.totalRevenuePAS, fill: PIE_COLORS.publisher },
    { name: "Monthly gas (settles)",     value: econ.monthlyGasPAS,   fill: PIE_COLORS.adTech },
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
      </div>

      {/* Above-the-fold summary ─────────────────────────────────── */}
      <div className="nano-fade" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--text-strong)" }}>
          Monthly snapshot
        </h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Stat label="Total revenue" value={fmtPAS(econ.totalRevenuePAS)} sub={fmtUSD(econ.usd(econ.totalRevenuePAS))} />
          <Stat label="Publisher" value={fmtPAS(econ.publisherPAS)} sub={fmtUSD(econ.usd(econ.publisherPAS))} />
          <Stat label="User" value={fmtPAS(econ.userPAS)} sub={fmtUSD(econ.usd(econ.userPAS))} />
          <Stat label="Protocol" value={fmtPAS(econ.protocolPAS)} sub={fmtUSD(econ.usd(econ.protocolPAS))} />
          <Stat label="Settlement gas" value={fmtPAS(econ.monthlyGasPAS)} sub={`${(econ.monthlyGasPAS / econ.totalRevenuePAS * 100).toFixed(2)}% of revenue`} />
          <Stat label="Cost per imp" value={fmtPAS(econ.costPerImpPAS)} sub={fmtUSD(econ.usd(econ.costPerImpPAS))} />
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
            <BarChart data={LEGACY_SPLITS} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 16 }}>
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
        subtitle="Earns 37.5% of every settled impression — net new revenue stream"
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>
          The user is the role legacy ad-tech doesn't pay. DATUM routes 37.5% of every
          settled CPM to the user wallet that emitted the impression. The user pays
          no gas — Settlement credits a pull-payment vault, withdrawn at the user's
          schedule.
        </p>
        <StatRow>
          <Stat label="Per impression" value={fmtPAS(econ.revenuePerImp * DATUM_SPLIT.user / 100)} sub={fmtUSD(econ.usd(econ.revenuePerImp * DATUM_SPLIT.user / 100))} />
          <Stat label="Per month (your tier)" value={fmtPAS(econ.userPAS)} sub={fmtUSD(econ.usd(econ.userPAS))} />
          <Stat label="Per year" value={fmtPAS(econ.userPAS * 12)} sub={fmtUSD(econ.usd(econ.userPAS * 12))} />
          <Stat label="Gas to claim" value="0" sub="pull-payment vault" />
        </StatRow>
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
              <li><strong>Default share:</strong> 37.5% (= 75% of the 50% remainder after publisher take)</li>
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
        subtitle="50% take rate — comparable to AdSense's ~68% but with no platform-side rake on top"
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>
          Publishers register a take rate (default 50%, negotiable 30–80% within
          governance bounds). The take rate locks per-campaign at activation. Gas
          for settlement is paid by whoever submits the batch — the publisher's
          own relay, a dual-signed advertiser, or a bonded DatumRelay operator.
          When the publisher operates their own relay (Direct path), they pay
          ~41 mPAS per settle TX.
        </p>
        <StatRow>
          <Stat label="Per impression" value={fmtPAS(econ.revenuePerImp * DATUM_SPLIT.publisher / 100)} sub={fmtUSD(econ.usd(econ.revenuePerImp * DATUM_SPLIT.publisher / 100))} />
          <Stat label="Monthly take" value={fmtPAS(econ.publisherPAS)} sub={fmtUSD(econ.usd(econ.publisherPAS))} />
          <Stat label="Yearly take" value={fmtPAS(econ.publisherPAS * 12)} sub={fmtUSD(econ.usd(econ.publisherPAS * 12))} />
          <Stat label="Self-relay gas" value={fmtPAS(econ.monthlyGasPAS)} sub={`${(econ.monthlyGasPAS / econ.publisherPAS * 100).toFixed(2)}% of take`} />
          <Stat label="Net (self-relay)" value={fmtPAS(econ.publisherPAS - econ.monthlyGasPAS)} sub={fmtUSD(econ.usd(econ.publisherPAS - econ.monthlyGasPAS))} />
        </StatRow>
        <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>
          <strong style={{ color: "var(--text-strong)" }}>Three operational postures:</strong>
          <ul style={{ paddingLeft: 18, marginTop: 6 }}>
            <li><strong>Direct (self-relay):</strong> you pay gas, you keep cadence control. ~41 mPAS per settle TX.</li>
            <li><strong>Dual-sig:</strong> advertiser co-signs and submits. Your gas cost is 0; ops overhead is signing.</li>
            <li><strong>Bonded DatumRelay:</strong> a third-party operator submits on your behalf. They post a relayStake and earn a fee + gas reimbursement out of your take.</li>
          </ul>
        </div>
        <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 8 }}>
          <strong style={{ color: "var(--text-strong)" }}>Required stake</strong> (bonding curve): starts at a flat
          base and grows linearly with cumulative impressions. Stake is slashable
          if fraud is upheld against you — but it also gates access to higher-value
          campaigns and to the publisher reputation score (which monotonically
          increases with every accepted settle).
        </div>
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
        <StatRow>
          <Stat label="One-time gas (create + activate)" value={fmtPAS(econ.oneTimeGasPAS)} sub={fmtUSD(econ.usd(econ.oneTimeGasPAS))} />
          <Stat label="Monthly budget (delivered)" value={fmtPAS(econ.totalRevenuePAS)} sub={fmtUSD(econ.usd(econ.totalRevenuePAS))} />
          <Stat label="Monthly settle gas" value={fmtPAS(econ.monthlyGasPAS)} sub={`${(econ.monthlyGasPAS / econ.totalRevenuePAS * 100).toFixed(3)}%`} />
          <Stat label="First-month TCO" value={fmtPAS(econ.tcoFirstMonthPAS)} sub={fmtUSD(econ.usd(econ.tcoFirstMonthPAS))} />
          <Stat label="Subsequent month TCO" value={fmtPAS(econ.tcoMonthlyPAS)} sub={fmtUSD(econ.usd(econ.tcoMonthlyPAS))} />
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
          no SSP fee, no ad exchange cut, no data broker, no agency markup. The 12.5% protocol
          fee is the only middle. The user's 37.5% is direct revenue back to your audience,
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
          <Stat label="Per settle gas" value={fmtPAS(GAS.settleClaimCold * PAS_PER_GAS)} sub="cold publisher slot" />
          <Stat label="Warm settle gas" value={fmtPAS(GAS.settleClaimWarm * PAS_PER_GAS)} sub="same-block second touch" />
          <Stat label="Settles/mo (your tier)" value={fmtInt(econ.claimsPerMonth)} sub={`${params.impsPerClaim} imps/claim`} />
          <Stat label="Monthly gas float" value={fmtPAS(econ.monthlyGasPAS)} sub={fmtUSD(econ.usd(econ.monthlyGasPAS))} />
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
        subtitle="12.5% of every settle accumulates into PaymentVault.protocolBalance, withdrawable by governance"
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginTop: 14 }}>
          The protocol fee is what funds DAO operations — audits, grants, infra,
          the People Chain identity bridge, the Bulletin Chain creative storage,
          and emission engine maintenance. It accumulates into a single
          PaymentVault slot keyed by governance authority. Phase 2 OpenGov
          decides withdraw cadence and target allocation.
        </p>
        <StatRow>
          <Stat label="Per impression" value={fmtPAS(econ.revenuePerImp * DATUM_SPLIT.protocol / 100)} sub={fmtUSD(econ.usd(econ.revenuePerImp * DATUM_SPLIT.protocol / 100))} />
          <Stat label="Monthly accrual" value={fmtPAS(econ.protocolPAS)} sub={fmtUSD(econ.usd(econ.protocolPAS))} />
          <Stat label="Yearly accrual" value={fmtPAS(econ.protocolPAS * 12)} sub={fmtUSD(econ.usd(econ.protocolPAS * 12))} />
          <Stat label="At 10× this campaign" value={fmtPAS(econ.protocolPAS * 12 * 10)} sub={fmtUSD(econ.usd(econ.protocolPAS * 12 * 10))} />
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
          12.5% protocol fee is governance-tunable via DatumParameterGovernance (bounds enforced
          on-chain). The 50% publisher take is per-publisher and per-campaign-snapshot. The 75%
          user-share-of-remainder is a global parameter. All three can move; see the gas-by-role
          report for the per-role TCO under each adjustment.
        </div>
      </RoleSection>

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
