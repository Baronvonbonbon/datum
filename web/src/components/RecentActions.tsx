// RecentActions — chip strip rendered above the hero on each
// dashboard. Pulls from the per-(role, address) localStorage
// bucket and updates live as new actions are recorded.
//
// Each chip is a Link to the action's route. A tiny clock icon +
// relative-time label tells the user how recent it was. Hidden
// when the bucket is empty.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "../hooks/useWallet";
import {
  getRecentActions,
  subscribeRecentActions,
  type Role,
  type RecentAction,
} from "../lib/recentActions";

export function RecentActions({ role }: { role: Role }) {
  const wallet = useWallet();
  const address = wallet.address ?? null;
  const [actions, setActions] = useState<RecentAction[]>(() =>
    getRecentActions(role, address)
  );

  useEffect(() => {
    const refresh = () => setActions(getRecentActions(role, address));
    refresh();
    return subscribeRecentActions(refresh);
  }, [role, address]);

  if (actions.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        marginBottom: 8,
      }}
    >
      <span
        style={{
          color: "var(--text-muted)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          alignSelf: "center",
          marginRight: 4,
        }}
      >
        Recent
      </span>
      {actions.map((a, i) => (
        <Link
          key={`${a.ts}:${i}`}
          to={a.route}
          title={a.txHash ? `tx ${a.txHash}` : a.label}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 8px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius, 4px)",
            background: "var(--bg-surface)",
            color: "var(--text-strong)",
            fontSize: 11,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          <span>{a.label}</span>
          <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
            {relativeTime(a.ts)}
          </span>
        </Link>
      ))}
    </div>
  );
}

function relativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}
