import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useBlock } from "../../hooks/useBlock";
import { useSettings } from "../../context/SettingsContext";
import { getCurrencySymbol, getNetworkDisplayName } from "@shared/networks";

interface Stats {
  totalCampaigns: number;
  activeCampaigns: number;
  pendingCampaigns: number;
  totalImpressions: number;
  paused: boolean;
}

export function Overview() {
  const contracts = useContracts();
  const { blockNumber, connected } = useBlock();
  const { settings } = useSettings();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sym = getCurrencySymbol(settings.network);

  useEffect(() => {
    if (!settings.contractAddresses.campaigns) return;
    load();
  }, [settings.contractAddresses.campaigns]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextId, paused] = await Promise.all([
        contracts.campaigns.nextCampaignId().catch(() => 0n),
        contracts.pauseRegistry.paused().catch(() => false),
      ]);

      const total = Number(nextId);
      let active = 0;
      let pending = 0;

      const scanCount = Math.min(total, 50);
      const ids = Array.from({ length: scanCount }, (_, i) => total - 1 - i).filter((i) => i >= 0);

      await Promise.all(ids.map(async (id) => {
        try {
          const c = await contracts.campaigns.getCampaignForSettlement(BigInt(id));
          const status = Number(c[0]);
          if (status === 1) active++;
          if (status === 0) pending++;
        } catch { /* skip */ }
      }));

      // Count total impressions from ClaimSettled events
      let totalImpressions = 0;
      try {
        const filter = contracts.settlement.filters.ClaimSettled();
        const logs = await contracts.settlement.queryFilter(filter);
        totalImpressions = logs.reduce((s: number, log: any) => s + Number(log.args?.impressionCount ?? 0), 0);
      } catch { /* settlement not configured */ }

      setStats({ totalCampaigns: total, activeCampaigns: active, pendingCampaigns: pending, totalImpressions, paused: Boolean(paused) });
    } catch (err) {
      setError(String(err).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 800 }}>
      {/* Hero */}
      <div className="nano-fade" style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, marginBottom: 6 }}>DATUM Protocol</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Decentralized advertising on Polkadot Hub — on-chain settlement, no intermediaries.
        </p>
      </div>

      {/* Status banner — always rendered, content swaps */}
      <div className="nano-fade" style={{ marginBottom: 28 }}>
        {stats ? (
          <div className="nano-info" style={{
            borderColor: stats.paused ? "rgba(252,165,165,0.3)" : "rgba(110,231,183,0.3)",
            background: stats.paused ? "rgba(252,165,165,0.06)" : "rgba(110,231,183,0.06)",
            display: "flex", alignItems: "center", gap: 8,
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
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
        )}
      </div>

      {/* Stat cards — always rendered, values swap */}
      <div className="nano-fade" style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
        gap: 12,
        marginBottom: 36,
      }}>
        <StatCard label="Total Campaigns" value={stats?.totalCampaigns ?? "—"} />
        <StatCard label="Active" value={stats?.activeCampaigns ?? "—"} color={stats ? "var(--ok)" : undefined} />
        <StatCard label="Pending Votes" value={stats?.pendingCampaigns ?? "—"} color={stats ? "var(--warn)" : undefined} />
        <StatCard label="Impressions Settled" value={stats ? stats.totalImpressions.toLocaleString() : "—"} color={stats && stats.totalImpressions > 0 ? "var(--ok)" : undefined} />
        <StatCard label="Network" value={getNetworkDisplayName(settings.network)} />
      </div>

      {/* Browse */}
      <div className="nano-fade" style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Browse</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <QuickLink to="/campaigns" label="Campaigns" desc="Browse all campaigns" />
          <QuickLink to="/publishers" label="Publishers" desc="Registered publisher directory" />
          <QuickLink to="/governance" label="Governance" desc="Vote on active campaigns" />
        </div>
      </div>

      {/* Participate */}
      <div className="nano-fade">
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Participate</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <QuickLink to="/advertiser/create" label="Create Campaign" desc="Launch a new ad campaign" />
          <QuickLink to="/publisher/register" label="Become a Publisher" desc="Register and serve ads" />
          <QuickLink to="/governance" label="Vote" desc="Stake DOT to approve campaigns" />
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="nano-card" style={{ padding: "16px 18px" }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
      <div style={{ color: color ?? "var(--text-strong)", fontSize: 22, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function QuickLink({ to, label, desc }: { to: string; label: string; desc: string }) {
  return (
    <Link to={to} style={{ textDecoration: "none" }}>
      <div
        className="nano-card"
        style={{ padding: "12px 16px", minWidth: 148, cursor: "pointer" }}
      >
        <div style={{ color: "var(--text-strong)", fontWeight: 600, fontSize: 13, marginBottom: 3 }}>{label} →</div>
        <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{desc}</div>
      </div>
    </Link>
  );
}
