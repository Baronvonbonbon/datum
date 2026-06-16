import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useBlock } from "../../hooks/useBlock";
import { useSettings } from "../../context/SettingsContext";
import { getCurrencySymbol, getNetworkDisplayName } from "@shared/networks";
import { queryFilterAll } from "@shared/eventQuery";
import { humanizeError } from "@shared/errorCodes";
import { formatDotWei } from "@shared/dot";
import { StatCardSkeleton } from "../../components/Skeleton";
import { RegisterInterest } from "../../components/RegisterInterest";
import { useToast } from "../../context/ToastContext";

interface Stats {
  totalCampaigns: number;
  activeCampaigns: number;
  pendingCampaigns: number;
  totalImpressions: number;
  totalSettledWei: bigint;
  publishersRegistered: number;
  councilMembers: number;
  paused: boolean;
}

export function Overview() {
  const contracts = useContracts();
  const { blockNumber, connected } = useBlock();
  const { settings } = useSettings();
  const { push } = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sym = getCurrencySymbol(settings.network);

  useEffect(() => {
    if (!settings.contractAddresses.campaigns) return;
    load();
  }, [settings.contractAddresses.campaigns]);

  // Refresh impression count on each new block (after initial load)
  useEffect(() => {
    if (!stats || !settings.contractAddresses.settlement) return;
    refreshImpressions();
  }, [blockNumber]);

  async function refreshImpressions() {
    try {
      const filter = contracts.settlement.filters.ClaimSettled();
      const logs = await queryFilterAll(contracts.settlement, filter);
      const total = logs.reduce((s: number, log: any) => s + Number(log.args?.eventCount ?? 0), 0);
      const paid = logs.reduce((s: bigint, log: any) =>
        s + BigInt(log.args?.publisherPayment ?? 0n)
          + BigInt(log.args?.userPayment ?? 0n)
          + BigInt(log.args?.protocolFee ?? 0n), 0n);
      setStats((prev) => prev ? { ...prev, totalImpressions: total, totalSettledWei: paid } : prev);
    } catch { /* settlement not configured */ }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Alpha-5 DatumPublishers has no registeredCount() — count unique
      // addresses that have ever emitted PublisherRegistered. queryFilterAll
      // de-dupes inside the page's render loop already; just count uniques.
      async function countRegisteredPublishers(): Promise<number> {
        try {
          const filter = contracts.publishers.filters.PublisherRegistered();
          const logs = await queryFilterAll(contracts.publishers, filter);
          const uniq = new Set<string>();
          for (const log of logs) {
            const addr = (log as any).args?.publisher as string | undefined;
            if (addr) uniq.add(addr.toLowerCase());
          }
          return uniq.size;
        } catch {
          return 0;
        }
      }
      const [nextId, paused, pubCountNum, councilSizeRaw] = await Promise.all([
        contracts.campaigns.nextCampaignId().catch(() => 0n),
        contracts.pauseRegistry.paused().catch(() => false),
        countRegisteredPublishers(),
        (contracts.council as any).memberCount?.().catch(() => 0n) ?? Promise.resolve(0n),
      ]);

      const total = Number(nextId);
      let active = 0;
      let pending = 0;

      const ids = Array.from({ length: total }, (_, i) => total - 1 - i).filter((i) => i >= 0);

      await Promise.all(ids.map(async (id) => {
        try {
          const c = await contracts.campaigns.getCampaignForSettlement(BigInt(id));
          const status = Number(c[0]);
          if (status === 1) active++;
          if (status === 0) pending++;
        } catch { /* skip */ }
      }));

      // Count total impressions + total DOT settled from ClaimSettled events.
      // Alpha-5 split the old `amountPaid` field into three: publisherPayment
      // + userPayment + protocolFee. Total settled is the sum of all three.
      let totalImpressions = 0;
      let totalSettledWei = 0n;
      try {
        const filter = contracts.settlement.filters.ClaimSettled();
        const logs = await queryFilterAll(contracts.settlement, filter);
        totalImpressions = logs.reduce((s: number, log: any) =>
          s + Number(log.args?.eventCount ?? 0), 0);
        totalSettledWei = logs.reduce((s: bigint, log: any) =>
          s + BigInt(log.args?.publisherPayment ?? 0n)
            + BigInt(log.args?.userPayment ?? 0n)
            + BigInt(log.args?.protocolFee ?? 0n), 0n);
      } catch { /* settlement not configured */ }

      setStats({
        // Campaign ids start at 1, so the count is nextCampaignId - 1 (the
        // loop below still scans the full range; id 0 just never exists).
        totalCampaigns: Math.max(0, total - 1),
        activeCampaigns: active,
        pendingCampaigns: pending,
        totalImpressions,
        totalSettledWei,
        publishersRegistered: pubCountNum,
        councilMembers: Number(councilSizeRaw ?? 0n),
        paused: Boolean(paused),
      });
    } catch (err) {
      push(humanizeError(err), "error");
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 920 }}>
      {/* Hero */}
      <div className="nano-fade" style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 26, marginBottom: 6 }}>DATUM Protocol</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, lineHeight: 1.6, maxWidth: 640 }}>
          Decentralized advertising on Polkadot Hub — on-chain settlement,
          privacy-preserving impressions, no intermediaries. Runs trustlessly
          in your browser via the pine light client.{" "}
          <Link to="/how-it-works">How it works →</Link>
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          <Link
            to="/demo"
            className="nano-btn nano-btn-primary"
            style={{ fontSize: 14, padding: "9px 18px", textDecoration: "none" }}
          >
            ▶ Try the in-browser demo
          </Link>
          <Link to="/how-it-works" className="nano-btn" style={{ fontSize: 13, padding: "9px 16px", textDecoration: "none" }}>
            How it works →
          </Link>
        </div>
      </div>

      {/* Register interest */}
      <RegisterInterest source="landing" />

      {/* Status banner — always rendered, content swaps */}
      <div className="nano-fade" style={{ marginBottom: 22 }}>
        {stats ? (
          <div className="nano-info" style={{
            borderColor: stats.paused ? "rgba(248,113,113,0.3)" : "rgba(74,222,128,0.3)",
            background: stats.paused ? "rgba(252,165,165,0.06)" : "rgba(110,231,183,0.06)",
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%", display: "inline-block",
              background: stats.paused ? "var(--error)" : "var(--ok)",
              boxShadow: stats.paused ? "none" : "0 0 6px var(--ok)",
            }} />
            <span style={{ color: stats.paused ? "var(--error)" : "var(--ok)", fontWeight: 600 }}>
              Protocol {stats.paused ? "Paused" : "Active"}
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              · {getNetworkDisplayName(settings.network)} · {connected ? `block #${blockNumber}` : "connecting…"}
            </span>
          </div>
        ) : error ? (
          <div className="nano-info nano-info--error">
            {settings.contractAddresses.campaigns
              ? `Error: ${error}`
              : <>No contracts configured. Go to <Link to="/settings">Settings</Link>.</>}
          </div>
        ) : (
          <div className="nano-skeleton" style={{ height: 38, borderRadius: "var(--radius-sm)" }} />
        )}
      </div>

      {/* Stat cards — always rendered, values swap */}
      <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>
        Live network stats
      </h2>
      <div className="nano-fade" style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
        gap: 12,
        marginBottom: 32,
      }}>
        {loading && !stats ? (
          <>{Array.from({ length: 8 }, (_, i) => <StatCardSkeleton key={i} />)}</>
        ) : (
          <>
            <StatCard
              label="Campaigns"
              value={stats?.totalCampaigns ?? "—"}
              hint="All campaigns ever created (active, pending, completed, slashed)."
              link="/campaigns"
            />
            <StatCard
              label="Active"
              value={stats?.activeCampaigns ?? "—"}
              color={stats ? "var(--ok)" : undefined}
              hint="Currently accepting impressions."
              link="/campaigns"
            />
            <StatCard
              label="Pending activation"
              value={stats?.pendingCampaigns ?? "—"}
              color={stats ? "var(--warn)" : undefined}
              hint="Created but not yet live. Alpha-5 uses optimistic activation — an activation bond clears after a short timelock (or governance activates)."
              link="/campaigns"
            />
            <StatCard
              label="Impressions settled"
              value={stats ? stats.totalImpressions.toLocaleString() : "—"}
              color={stats && stats.totalImpressions > 0 ? "var(--ok)" : undefined}
              hint="Total verified impressions paid out across all campaigns."
            />
            <StatCard
              label={`${sym} settled`}
              value={stats ? formatDotWei(stats.totalSettledWei) : "—"}
              hint="Total DOT/PAS paid out by Settlement across all campaigns. Split between publisher take-rate and user share."
            />
            <StatCard
              label="Publishers"
              value={stats?.publishersRegistered ?? "—"}
              hint="Registered publisher addresses. Each runs the SDK and earns a take rate per impression."
              link="/publishers"
            />
            <StatCard
              label="Council members"
              value={stats?.councilMembers ?? "—"}
              hint="N-of-M emergency Council (Phase 1 governance). Members can pause, blocklist, and propose router upgrades."
              link="/governance/council"
            />
            <StatCard
              label="Network"
              value={getNetworkDisplayName(settings.network)}
              hint="Switch network from Settings. Pine validates blocks for whichever network is configured."
              link="/settings"
            />
          </>
        )}
      </div>

      {/* Explore — compact link grid to every major area */}
      <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>
        Explore
      </h2>
      <div className="nano-fade" style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
        gap: 8,
        marginBottom: 28,
      }}>
        <NavTile to="/me" label="Me" desc="Wallet, claims, identity" />
        <NavTile to="/advertiser" label="Advertiser" desc="Create & fund campaigns" />
        <NavTile to="/publisher" label="Publisher" desc="Register, stake, earn" />
        <NavTile to="/governance" label="Governance" desc="Vote, slash, reward" />
        <NavTile to="/token" label="Token" desc="Wrapper, mint, vesting" />
        <NavTile to="/identity" label="Identity" desc="People Chain & ZK" />
        <NavTile to="/protocol" label="Protocol" desc="Contracts & upgrades" />
        <NavTile to="/campaigns" label="Campaigns" desc="Browse every campaign" />
      </div>

      {/* New here — slim role launcher (full detail lives on How It Works) */}
      <div className="nano-fade" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>New here? Jump in as a</span>
        <Link to="/advertiser/create" className="nano-btn" style={{ fontSize: 12, padding: "6px 12px", textDecoration: "none" }}>📢 Advertiser</Link>
        <Link to="/publisher/register" className="nano-btn" style={{ fontSize: 12, padding: "6px 12px", textDecoration: "none" }}>🌐 Publisher</Link>
        <Link to="/governance" className="nano-btn" style={{ fontSize: 12, padding: "6px 12px", textDecoration: "none" }}>⚖️ Voter</Link>
        <Link to="/how-it-works" className="nano-btn nano-btn-accent" style={{ fontSize: 12, padding: "6px 12px", textDecoration: "none" }}>Full walkthrough →</Link>
      </div>
    </div>
  );
}

function NavTile({ to, label, desc }: { to: string; label: string; desc: string }) {
  return (
    <Link to={to} style={{ textDecoration: "none" }}>
      <div className="nano-card" style={{ padding: "11px 13px", cursor: "pointer" }}>
        <div style={{ color: "var(--text-strong)", fontWeight: 600, fontSize: 13 }}>
          {label} <span style={{ color: "var(--text-muted)" }}>→</span>
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>{desc}</div>
      </div>
    </Link>
  );
}

function StatCard({ label, value, color, hint, link }: {
  label: string;
  value: number | string;
  color?: string;
  hint?: string;
  link?: string;
}) {
  const body = (
    <div
      className="nano-card"
      title={hint}
      style={{
        padding: "16px 18px",
        cursor: hint ? (link ? "pointer" : "help") : undefined,
      }}
    >
      <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
      <div style={{ color: color ?? "var(--text-strong)", fontSize: 22, fontWeight: 600 }}>{value}</div>
    </div>
  );
  if (link) return <Link to={link} style={{ textDecoration: "none" }}>{body}</Link>;
  return body;
}
