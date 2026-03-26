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

      // Batch scan (up to 50 most recent)
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

      setStats({ totalCampaigns: total, activeCampaigns: active, pendingCampaigns: pending, paused: Boolean(paused) });
    } catch (err) {
      setError(String(err).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ color: "#e0e0e0", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>DATUM Protocol</h1>
        <p style={{ color: "#666", fontSize: 14 }}>Decentralized advertising on Polkadot Hub</p>
      </div>

      {/* Protocol status */}
      {stats && (
        <div style={{
          padding: "8px 16px",
          background: stats.paused ? "#2a0a0a" : "#0a2a0a",
          border: `1px solid ${stats.paused ? "#5a2a2a" : "#2a5a2a"}`,
          borderRadius: 6,
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: stats.paused ? "#ff6060" : "#60c060",
            display: "inline-block",
          }} />
          <span style={{ color: stats.paused ? "#ff8080" : "#80c080", fontWeight: 600 }}>
            Protocol {stats.paused ? "PAUSED" : "Active"}
          </span>
          <span style={{ color: "#555", fontSize: 12 }}>
            · {getNetworkDisplayName(settings.network)} · {connected ? `block #${blockNumber}` : "connecting..."}
          </span>
        </div>
      )}

      {loading && <div style={{ color: "#555", padding: 20 }}>Loading protocol stats...</div>}
      {error && (
        <div style={{ padding: 12, background: "#1a0a0a", border: "1px solid #3a1a1a", borderRadius: 6, color: "#ff8080", marginBottom: 16, fontSize: 13 }}>
          {settings.contractAddresses.campaigns
            ? `Error loading stats: ${error}`
            : "No contracts configured. Go to Settings to set contract addresses."}
        </div>
      )}

      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 28 }}>
          <StatCard label="Total Campaigns" value={stats.totalCampaigns} />
          <StatCard label="Active" value={stats.activeCampaigns} color="#60c060" />
          <StatCard label="Pending Votes" value={stats.pendingCampaigns} color="#c0c060" />
          <StatCard label="Network" value={getNetworkDisplayName(settings.network)} />
        </div>
      )}

      {/* Quick links */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: "#a0a0ff", fontSize: 16, marginBottom: 12 }}>Browse</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <QuickLink to="/campaigns" label="All Campaigns" desc="Browse and filter all campaigns" />
          <QuickLink to="/publishers" label="Publishers" desc="Registered publisher directory" />
          <QuickLink to="/governance" label="Governance" desc="Vote on active campaigns" />
        </div>
      </div>

      <div>
        <h2 style={{ color: "#a0a0ff", fontSize: 16, marginBottom: 12 }}>Participate</h2>
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
    <div style={{
      background: "#111",
      border: "1px solid #1a1a2e",
      borderRadius: 8,
      padding: "16px 20px",
    }}>
      <div style={{ color: "#555", fontSize: 12, marginBottom: 6 }}>{label}</div>
      <div style={{ color: color ?? "#e0e0e0", fontSize: 24, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function QuickLink({ to, label, desc }: { to: string; label: string; desc: string }) {
  return (
    <Link to={to} style={{ textDecoration: "none" }}>
      <div style={{
        padding: "12px 16px",
        background: "#111",
        border: "1px solid #1a1a2e",
        borderRadius: 6,
        minWidth: 160,
        cursor: "pointer",
        transition: "border-color 0.1s",
      }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#4a4a8a")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1a1a2e")}
      >
        <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 13 }}>{label}</div>
        <div style={{ color: "#555", fontSize: 11, marginTop: 2 }}>{desc}</div>
      </div>
    </Link>
  );
}
