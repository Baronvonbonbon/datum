// PollStatusBar — live visualizer of the background campaignPoller's progress.
// Reads the `pollStatus` object the poller publishes to chrome.storage.local and
// re-renders on every change, so the user can see discovery + detail-fetch
// progress on either chain-access path (Pine light client or RPC gateway).
import { useEffect, useState } from "react";

interface PollStatus {
  path: "pine" | "rpc";
  phase: "discovery" | "details" | "metadata" | "done" | "error";
  discovered: number;
  detailed: number;
  detailTotal: number;
  active: number;
  newThisPoll: number;
  scanProgress: string;
  currentBlock: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

// Published by the (demo daemon / background) settlement path so the bar can show
// a claim submission in flight, its assurance path, and the settled/failed result.
interface ClaimStatus {
  phase: "building" | "submitting" | "settled" | "failed";
  path?: string;            // submit path = assurance proxy
  campaigns?: number[];
  claimCount?: number;
  settledCount?: number;
  error?: string;
  updatedAt: number;
}

const PATH_LABEL: Record<string, string> = {
  "relay-gasless": "gasless relay",
  "user-wallet": "your wallet",
  "publisher-cosign": "publisher cosign",
};

function ago(ts: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function PollStatusBar() {
  const [ps, setPs] = useState<PollStatus | null>(null);
  const [cs, setCs] = useState<ClaimStatus | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    // Guard every chrome.* access: in the webapp demo (chromeShim) or any
    // non-extension host, storage/onChanged may be partially implemented.
    // An unguarded throw here would unmount the whole tree (blank page).
    const storage = (globalThis as { chrome?: typeof chrome }).chrome?.storage;
    storage?.local?.get?.("pollStatus", (s) => setPs((s as { pollStatus?: PollStatus }).pollStatus ?? null));
    storage?.local?.get?.("claimStatus", (s) => setCs((s as { claimStatus?: ClaimStatus }).claimStatus ?? null));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
      if (changes.pollStatus) setPs((changes.pollStatus.newValue as PollStatus) ?? null);
      if (changes.claimStatus) setCs((changes.claimStatus.newValue as ClaimStatus) ?? null);
    };
    storage?.onChanged?.addListener?.(onChange);
    // tick so the "Xs ago" label + the auto-hide of a finished claim stay fresh
    const t = setInterval(() => force((n) => n + 1), 2000);
    return () => {
      storage?.onChanged?.removeListener?.(onChange);
      clearInterval(t);
    };
  }, []);

  // While a claim submission is in flight — or just finished (show the result for
  // ~12s) — commandeer the bar so the user sees it instead of the poll status.
  const claimActive =
    !!cs &&
    (cs.phase === "building" ||
      cs.phase === "submitting" ||
      ((cs.phase === "settled" || cs.phase === "failed") && Date.now() - cs.updatedAt < 12000));
  if (claimActive && cs) return <ClaimBar cs={cs} />;

  if (!ps) return null;

  const busy = ps.phase === "discovery" || ps.phase === "details" || ps.phase === "metadata";
  const isErr = ps.phase === "error";
  const pathLabel = ps.path === "pine" ? "Pine · light client" : "RPC · gateway";

  // Progress: detail-fetch is the long phase; otherwise indeterminate/complete.
  const pct =
    ps.phase === "details" && ps.detailTotal > 0
      ? Math.min(100, Math.round((ps.detailed / ps.detailTotal) * 100))
      : ps.phase === "done"
        ? 100
        : ps.phase === "metadata"
          ? 92
          : ps.phase === "discovery"
            ? 8
            : 0;

  const label = isErr
    ? `Sync error: ${ps.error ?? "unknown"}`
    : ps.phase === "discovery"
      ? ps.path === "pine"
        ? "Discovering campaigns (enumerating on-chain)…"
        : "Scanning chain logs for campaigns…"
      : ps.phase === "details"
        ? `Loading campaign details · ${ps.detailed}/${ps.detailTotal}`
        : ps.phase === "metadata"
          ? "Fetching tags + creatives…"
          : `${ps.active} campaign${ps.active === 1 ? "" : "s"} ready`;

  const accent = isErr ? "var(--danger, #e5484d)" : "var(--accent)";

  return (
    <div
      style={{
        padding: "6px 14px 7px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-surface)",
        fontFamily: "var(--font-sans)",
      }}
      title={`Last update ${ago(ps.updatedAt)} · block ${ps.currentBlock || "—"}`}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: accent,
            flex: "0 0 auto",
            animation: busy ? "datum-pulse 1.1s ease-in-out infinite" : "none",
            opacity: busy ? 1 : 0.55,
          }}
        />
        <span style={{ color: "var(--text-strong)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 9.5,
            color: ps.path === "pine" ? "var(--accent)" : "var(--text-muted)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "1px 5px",
            whiteSpace: "nowrap",
            flex: "0 0 auto",
          }}
        >
          {pathLabel}
        </span>
      </div>

      {/* progress track */}
      <div style={{ height: 3, borderRadius: 3, background: "var(--border)", marginTop: 5, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: accent,
            borderRadius: 3,
            transition: "width 0.4s ease",
            opacity: ps.phase === "done" ? 0.6 : 1,
          }}
        />
      </div>

      {/* sub-line: counts + scan position + freshness */}
      <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 9.5, color: "var(--text-muted)" }}>
        <span>{ps.discovered} found</span>
        {ps.newThisPoll > 0 && <span>+{ps.newThisPoll} new</span>}
        {ps.path === "rpc" && ps.scanProgress && ps.scanProgress !== "history complete" && (
          <span title="RPC scans the chain backward over several polls">history: {ps.scanProgress}</span>
        )}
        <span style={{ flex: 1 }} />
        <span>{ago(ps.updatedAt)}</span>
      </div>

      <style>{`@keyframes datum-pulse{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.5);opacity:1}}`}</style>
    </div>
  );
}

// Claim-submission view — shown in the poll-bar slot while a settlement is in
// flight (or just finished). Surfaces the submit path (assurance proxy),
// campaigns, and the settled count / failure reason.
function ClaimBar({ cs }: { cs: ClaimStatus }) {
  const busy = cs.phase === "building" || cs.phase === "submitting";
  const accent =
    cs.phase === "failed" ? "var(--danger, #e5484d)"
    : cs.phase === "settled" ? "var(--ok, #46a758)"
    : "var(--accent)";
  const pct = cs.phase === "settled" ? 100 : cs.phase === "failed" ? 100 : 45;
  const camps = cs.campaigns ?? [];
  const pathLabel = cs.path ? (PATH_LABEL[cs.path] ?? cs.path) : "relay";

  const label =
    cs.phase === "building" ? "Building claims…"
    : cs.phase === "submitting"
      ? `Submitting ${cs.claimCount ?? camps.length} claim${(cs.claimCount ?? 0) === 1 ? "" : "s"}${camps.length ? ` · ${camps.length} campaign${camps.length === 1 ? "" : "s"}` : ""}…`
    : cs.phase === "settled"
      ? `✓ Settled ${cs.settledCount ?? 0} claim${(cs.settledCount ?? 0) === 1 ? "" : "s"}`
      : "Settlement failed";

  return (
    <div
      style={{ padding: "6px 14px 7px", borderBottom: "1px solid var(--border)", background: "var(--bg-surface)", fontFamily: "var(--font-sans)" }}
      title={cs.error ?? `claims via ${pathLabel}`}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: accent, flex: "0 0 auto", animation: busy ? "datum-pulse 1.1s ease-in-out infinite" : "none", opacity: busy ? 1 : 0.7 }} />
        <span style={{ color: "var(--text-strong)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 9.5, color: "var(--accent)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap", flex: "0 0 auto" }}>{pathLabel}</span>
      </div>

      <div style={{ height: 3, borderRadius: 3, background: "var(--border)", marginTop: 5, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: accent, borderRadius: 3, transition: "width 0.4s ease", animation: busy ? "datum-pulse 1.4s ease-in-out infinite" : "none" }} />
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 9.5, color: cs.phase === "failed" ? "var(--danger, #e5484d)" : "var(--text-muted)" }}>
        {cs.phase === "failed" && cs.error
          ? <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cs.error}</span>
          : camps.length > 0
            ? <span>campaign{camps.length === 1 ? "" : "s"} {camps.slice(0, 6).map((c) => `#${c}`).join(", ")}{camps.length > 6 ? "…" : ""}</span>
            : <span>preparing…</span>}
        <span style={{ flex: 1 }} />
        <span>{ago(cs.updatedAt)}</span>
      </div>
    </div>
  );
}
