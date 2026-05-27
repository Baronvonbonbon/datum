// /about index — landing for the persona deep dives. Lists the seven
// personas with a one-line teaser each.

import { Link } from "react-router-dom";

const PERSONAS = [
  { to: "/about/me",          icon: "👤", label: "Me",          tagline: "Your wallet-scoped view of DATUM activity." },
  { to: "/about/advertiser",  icon: "📢", label: "Advertiser",  tagline: "Create, fund, and operate ad campaigns." },
  { to: "/about/publisher",   icon: "🌐", label: "Publisher",   tagline: "Earn DOT for serving ads with the SDK." },
  { to: "/about/governance",  icon: "⚖️", label: "Governance",  tagline: "Conviction-voting, slash pools, phase ladder." },
  { to: "/about/token",       icon: "🪙", label: "DATUM Token", tagline: "The protocol's native ERC-20 — mint, vest, fee-share." },
  { to: "/about/rewards",     icon: "🎁", label: "Sidecar Rewards", tagline: "Advertiser-funded per-campaign rewards in any third-party ERC-20." },
  { to: "/about/identity",    icon: "🪪", label: "Identity",    tagline: "People Chain bridge + ZK tooling." },
  { to: "/about/protocol",    icon: "🛠", label: "Protocol",    tagline: "Contracts, upgrades, parameters, pauses." },
];

export function AboutIndex() {
  return (
    <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 22 }}>
      <div className="nano-fade">
        <Link
          to="/"
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            textDecoration: "none",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          ← Back to overview
        </Link>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: "10px 0 4px" }}>About DATUM</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, lineHeight: 1.6 }}>
          Seven persona-specific deep dives. Each one explains the part of
          the protocol that touches that persona, the pages they'll use, and
          the contracts behind those pages.
        </p>
      </div>

      <div className="nano-fade" style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: 10,
      }}>
        {PERSONAS.map((p) => (
          <Link key={p.to} to={p.to} style={{ textDecoration: "none" }}>
            <div
              className="nano-card"
              style={{
                padding: "14px 16px",
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                cursor: "pointer",
                height: "100%",
              }}
            >
              <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>{p.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "var(--text-strong)", fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                  {p.label} <span style={{ color: "var(--text-muted)" }}>→</span>
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                  {p.tagline}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="nano-fade" style={{
        marginTop: 8,
        fontSize: 13,
        color: "var(--text-muted)",
      }}>
        Looking for the full system architecture instead?{" "}
        <Link to="/how-it-works">How It Works →</Link>
      </div>
    </div>
  );
}
