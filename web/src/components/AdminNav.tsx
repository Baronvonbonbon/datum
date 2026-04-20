import { NavLink } from "react-router-dom";

const ADMIN_LINKS = [
  { to: "/admin/timelock", label: "Timelock" },
  { to: "/admin/pause", label: "Pause" },
  { to: "/admin/blocklist", label: "Blocklist" },
  { to: "/admin/protocol", label: "Protocol Fees" },
  { to: "/admin/rate-limiter", label: "Rate Limiter" },
  { to: "/admin/reputation", label: "Reputation" },
  { to: "/admin/parameter-governance", label: "Param Gov" },
  { to: "/admin/publisher-stake", label: "Pub Stake" },
  { to: "/admin/publisher-governance", label: "Pub Gov" },
  { to: "/admin/challenge-bonds", label: "Bonds" },
  { to: "/admin/nullifier-registry", label: "Nullifiers" },
];

export function AdminNav() {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20 }}>
      {ADMIN_LINKS.map(({ to, label }) => (
        <NavLink
          key={to}
          to={to}
          style={({ isActive }) => ({
            textDecoration: "none",
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            background: isActive ? "var(--accent)" : "var(--bg-raised)",
            color: isActive ? "#000" : "var(--text-muted)",
            fontWeight: isActive ? 700 : 400,
            transition: "background 150ms, color 150ms",
          })}
        >
          {label}
        </NavLink>
      ))}
    </div>
  );
}
