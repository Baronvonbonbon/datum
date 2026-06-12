// RouterHealthBanner — Option B staleness guard. Surfaces when the configured
// DatumGovernanceRouter looks wrong: an empty registry (router returned no
// address for a core slot → wrong/old router address) or a dead resolved core
// contract (no bytecode). Both point at a stale `governanceRouter` in
// networks.ts / Settings — the one address that must stay fresh across
// redeploys for on-chain resolution to work.
//
// A stale-but-alive previous deploy can't be detected from chain alone, so
// this is a best-effort guard, not a guarantee. The benign "live registry is
// newer than the bundled seed" case is info-only and not shown here.
import { useEffect, useState } from "react";
import { subscribeRouterHealth, type RouterHealth } from "../shared/contracts";

export function RouterHealthBanner() {
  const [health, setHealth] = useState<RouterHealth>(null);
  useEffect(() => subscribeRouterHealth(setHealth), []);

  if (!health) return null;
  if (!health.registryEmpty && !health.deadCore) return null;

  const message = health.registryEmpty
    ? "Contract registry is empty — the configured governance router returned no address for a core contract. The router address in Settings / networks.ts is likely stale or wrong; on-chain addresses can't be resolved."
    : "Resolved core contract has no bytecode — the deployment this router points at appears to be gone. Update the deploy addresses in Settings.";

  return (
    <div
      role="alert"
      style={{
        background: "rgba(169, 48, 48, 0.12)",
        color: "var(--error)",
        borderBottom: "1px solid rgba(169,48,48,0.35)",
        padding: "6px 12px",
        fontSize: 12,
        fontFamily: "var(--font-mono, ui-monospace)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--error)", display: "inline-block", flexShrink: 0 }}
      />
      <span>{message}</span>
    </div>
  );
}
