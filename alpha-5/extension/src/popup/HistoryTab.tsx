// HistoryTab — popup view of the user's settled-claims history.
// Reads from chrome.storage.local; updates live via storage.onChanged.

import { useEffect, useMemo, useState } from "react";
import { formatDotWei } from "@shared/dot";
import {
  earningsKey,
  emptyIndex,
  topCampaigns,
  TopSortKey,
  EarningsIndex,
} from "@shared/earningsIndex";

const SORT_LABELS: Record<TopSortKey, string> = {
  totalUserWei: "Total earned",
  claimCount: "Claims",
  totalEvents: "Events",
  lastBlock: "Recently active",
};

interface Props {
  address: string | null;
}

export function HistoryTab({ address }: Props) {
  const [chainId, setChainId] = useState<number>(0);
  const [index, setIndex] = useState<EarningsIndex>(emptyIndex());
  const [sortBy, setSortBy] = useState<TopSortKey>("totalUserWei");
  const [webAppUrl, setWebAppUrl] = useState<string>("https://datum.javcon.io");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function refreshHistoryOneShot() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const resp: { ok: boolean; error?: string } =
        await chrome.runtime.sendMessage({ type: "EARNINGS_REFRESH_ONESHOT" });
      if (!resp?.ok) {
        setRefreshError(resp?.error ?? "refresh failed");
      }
    } catch (e: any) {
      setRefreshError(String(e?.message ?? e).slice(0, 120));
    } finally {
      setRefreshing(false);
    }
  }

  // Resolve the active network's chainId so we read the right slice.
  // NETWORK_CONFIGS doesn't currently expose chainId, so we keep a small map.
  const NETWORK_CHAIN_IDS: Record<string, number> = {
    polkadotTestnet: 420420417,
    paseoEvm: 420420422,
    local: 31337,
  };
  useEffect(() => {
    chrome.storage.local.get(["settings"]).then((s) => {
      const network = (s.settings?.network ?? "polkadotTestnet") as string;
      setChainId(NETWORK_CHAIN_IDS[network] ?? 0);
      setWebAppUrl("https://datum.javcon.io");
    });
  }, []);

  // Load index for the active (chainId, address)
  useEffect(() => {
    if (!address || !chainId) return;
    const key = earningsKey(chainId, address);
    chrome.storage.local.get(key).then((s) => {
      setIndex((s[key] as EarningsIndex | undefined) ?? emptyIndex());
    });

    // Live updates: re-load on storage change for our key
    const handler = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== "local") return;
      if (changes[key]) {
        setIndex((changes[key].newValue as EarningsIndex) ?? emptyIndex());
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [address, chainId]);

  const top = useMemo(() => topCampaigns(index, sortBy, 10), [index, sortBy]);
  const recent = useMemo(() => index.recent.slice(0, 10), [index]);

  if (!address) {
    return (
      <div className="nano-fade" style={{ padding: 16, color: "var(--text-dim)" }}>
        Connect a wallet to view earnings history.
      </div>
    );
  }

  const hasAny = recent.length > 0 || top.length > 0;

  return (
    <div className="nano-fade" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header / link to web app for deeper history */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
          Settled-claim history
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            onClick={refreshHistoryOneShot}
            disabled={refreshing}
            title="Pull historical earnings via RPC for this one fetch. RPC turns back off when the scan completes."
            style={{
              fontSize: 10,
              padding: "3px 8px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm, 4px)",
              color: refreshing ? "var(--text-dim)" : "var(--accent)",
              cursor: refreshing ? "default" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {refreshing ? "Pulling…" : "Refresh history"}
          </button>
          <a
            href={`${webAppUrl}/me/history?address=${address}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none" }}
          >
            Deeper history →
          </a>
        </div>
      </div>
      {refreshError && (
        <div
          className="nano-card"
          style={{
            padding: 8,
            background: "rgba(248,113,113,0.06)",
            borderColor: "rgba(248,113,113,0.3)",
            color: "var(--error, #f87171)",
            fontSize: 11,
          }}
        >
          Refresh failed: {refreshError}
        </div>
      )}

      {!hasAny && (
        <div className="nano-card" style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
          No settled claims indexed yet for this wallet.<br />
          The extension scans the most recent ~3.5 days on first load. Use the
          web app's "Deeper history" view if you need a longer window.
        </div>
      )}

      {/* Recent (last 10) */}
      {recent.length > 0 && (
        <Section title="Recent">
          <div style={{ display: "flex", flexDirection: "column" }}>
            {recent.map((r) => (
              <div
                key={`${r.txHash}:${r.logIndex}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 8,
                  padding: "6px 0",
                  fontSize: 11,
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span style={{ color: "var(--text-dim)", fontFamily: "monospace" }}>
                  {r.blockTimestamp ? new Date(r.blockTimestamp * 1000).toLocaleDateString() : `#${r.blockNumber}`}
                </span>
                <span style={{ color: "var(--text)" }}>
                  Campaign #{r.campaignId}
                  <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                    {actionTypeLabel(r.actionType)}
                  </span>
                </span>
                <span style={{ color: "var(--ok)", fontFamily: "monospace" }}>
                  +{formatDotWei(BigInt(r.userPaymentWei))}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Top campaigns */}
      {top.length > 0 && (
        <Section
          title="Top campaigns"
          right={
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as TopSortKey)}
              className="nano-select"
              style={{ fontSize: 11, padding: "2px 6px" }}
            >
              {Object.entries(SORT_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          }
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            {top.map((row, i) => (
              <div
                key={row.campaignId}
                style={{
                  display: "grid",
                  gridTemplateColumns: "20px 1fr auto",
                  gap: 8,
                  padding: "6px 0",
                  fontSize: 11,
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span style={{ color: "var(--text-muted)", fontFamily: "monospace" }}>
                  {i + 1}.
                </span>
                <span style={{ color: "var(--text)" }}>
                  Campaign #{row.campaignId}
                  <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>
                    {row.totals.claimCount} claim{row.totals.claimCount === 1 ? "" : "s"}
                    {" · "}{row.totals.totalEvents} events
                  </span>
                </span>
                <span style={{ color: "var(--ok)", fontFamily: "monospace" }}>
                  {formatDotWei(BigInt(row.totals.totalUserWei))}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {hasAny && (
        <div style={{ color: "var(--text-muted)", fontSize: 10, padding: "0 4px" }}>
          Indexed up to block {index.lastScannedBlock.toLocaleString()}.
          {" "}Tracking {Object.keys(index.byCampaign).length} campaigns,
          {" "}{index.recent.length} recent settles.
        </div>
      )}
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="nano-card" style={{ padding: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 12 }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function actionTypeLabel(at: 0 | 1 | 2): string {
  return at === 0 ? "view" : at === 1 ? "click" : "action";
}
