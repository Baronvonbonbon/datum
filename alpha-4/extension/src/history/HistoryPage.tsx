import { useState, useEffect, useMemo } from "react";
import { Contract, JsonRpcProvider } from "ethers";
import { ImpressionLogEntry } from "../background/impressionLog";
import { BrandChip } from "../popup/BrandChip";
import { CampaignChip } from "../popup/CampaignChip";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { StoredSettings } from "@shared/types";

// ── helpers ──────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<number, string> = { 0: "CPM", 1: "CPC", 2: "CPA" };
const ACTION_COLORS: Record<number, string> = {
  0: "rgba(160,160,255,0.8)",
  1: "rgba(74,222,128,0.8)",
  2: "rgba(251,191,36,0.8)",
};

/** Format planck → human-readable DOT with suffix. */
function fmtPlanck(planckStr: string): string {
  if (!planckStr || planckStr === "0") return "—";
  const p = BigInt(planckStr);
  if (p === 0n) return "—";
  // 1 DOT = 10^10 planck
  const dot = Number(p) / 1e10;
  if (dot >= 0.001) return `${dot.toFixed(4)} DOT`;
  // Show in µDOT (micro)
  const micro = Number(p) / 1e4;
  if (micro >= 0.001) return `${micro.toFixed(2)} µDOT`;
  return `${p.toString()} planck`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== "/" ? u.pathname.slice(0, 24) : "");
  } catch {
    return url.slice(0, 32);
  }
}

function shortId(id: string): string {
  return `#${id.slice(0, 6)}`;
}

// ── Campaign summary (grouped view) ──────────────────────────────────────────

interface CampaignSummary {
  campaignId: string;
  count: number;
  totalPayoutPlanck: bigint;
  lastSeen: number;
  actionTypes: Set<number>;
}

function buildCampaignSummary(log: ImpressionLogEntry[]): CampaignSummary[] {
  const map = new Map<string, CampaignSummary>();
  for (const e of log) {
    const existing = map.get(e.campaignId);
    if (existing) {
      existing.count++;
      existing.totalPayoutPlanck += BigInt(e.payoutPlanck ?? "0");
      if (e.timestamp > existing.lastSeen) existing.lastSeen = e.timestamp;
      existing.actionTypes.add(e.actionType);
    } else {
      map.set(e.campaignId, {
        campaignId: e.campaignId,
        count: 1,
        totalPayoutPlanck: BigInt(e.payoutPlanck ?? "0"),
        lastSeen: e.timestamp,
        actionTypes: new Set([e.actionType]),
      });
    }
  }
  return [...map.values()];
}

// ── Styles ────────────────────────────────────────────────────────────────────

const cellStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderBottom: "1px solid var(--border)",
  fontSize: 12,
  verticalAlign: "middle",
};

const headCellStyle: React.CSSProperties = {
  ...cellStyle,
  color: "var(--text-muted)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontWeight: 600,
  background: "var(--bg-raised)",
  position: "sticky",
  top: 0,
  zIndex: 1,
};

const pill = (color: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 3,
  fontSize: 10,
  fontWeight: 600,
  color,
  background: color.replace("0.8)", "0.12)"),
  border: `1px solid ${color.replace("0.8)", "0.25)")}`,
});

// ── Main Component ────────────────────────────────────────────────────────────

type SortImpression = "time" | "payout";
type SortCampaign = "count" | "payout" | "time";
type View = "impressions" | "campaigns";

export function HistoryPage() {
  const [log, setLog] = useState<ImpressionLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("impressions");
  const [sortImp, setSortImp] = useState<SortImpression>("time");
  const [sortCamp, setSortCamp] = useState<SortCampaign>("count");
  const [cleared, setCleared] = useState(false);
  const [settings, setSettings] = useState<StoredSettings>(DEFAULT_SETTINGS);
  const [campaignAdvertisers, setCampaignAdvertisers] = useState<Record<string, string>>({});

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_IMPRESSION_LOG" }).then((resp: any) => {
      setLog(resp?.log ?? []);
      setLoading(false);
    });
    chrome.storage.local.get(["settings"]).then((s) => {
      setSettings((s.settings as StoredSettings | undefined) ?? DEFAULT_SETTINGS);
    });
  }, []);

  // Resolve campaign → advertiser for every campaignId visible. Cached
  // per-(chainId, campaignId) in chrome.storage.local so re-opens are cheap.
  useEffect(() => {
    if (log.length === 0) return;
    if (!settings.contractAddresses.campaigns || !settings.rpcUrl) return;
    const ids = new Set<string>(log.map((e) => e.campaignId));
    const missing = Array.from(ids).filter((id) => !campaignAdvertisers[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const NETWORK_CHAIN_IDS: Record<string, number> = {
        polkadotTestnet: 420420417, paseoEvm: 420420422, local: 31337,
      };
      const chainId = NETWORK_CHAIN_IDS[settings.network ?? "polkadotTestnet"] ?? 0;
      const cacheKeys = missing.map((id) => `campaign_advertiser:${chainId}:${id}`);
      const cached = await chrome.storage.local.get(cacheKeys);
      const next: Record<string, string> = {};
      const stillMissing: string[] = [];
      for (const id of missing) {
        const k = `campaign_advertiser:${chainId}:${id}`;
        if (cached[k]) next[id] = cached[k] as string;
        else stillMissing.push(id);
      }
      if (stillMissing.length > 0) {
        try {
          const provider = new JsonRpcProvider(settings.rpcUrl);
          const c = new Contract(
            settings.contractAddresses.campaigns,
            ["function getCampaignAdvertiser(uint256) view returns (address)"],
            provider
          );
          // Process serially to avoid hammering Paseo with bursts.
          for (const id of stillMissing) {
            try {
              const addr = await c.getCampaignAdvertiser(BigInt(id));
              const a = String(addr);
              if (a && a !== "0x0000000000000000000000000000000000000000") {
                next[id] = a;
                await chrome.storage.local.set({ [`campaign_advertiser:${chainId}:${id}`]: a });
              }
            } catch { /* skip */ }
            if (cancelled) return;
          }
        } catch { /* RPC unavailable */ }
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setCampaignAdvertisers((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => { cancelled = true; };
  }, [log, settings.network, settings.rpcUrl, settings.contractAddresses.campaigns]);

  async function handleClear() {
    await chrome.runtime.sendMessage({ type: "CLEAR_IMPRESSION_LOG" });
    setLog([]);
    setCleared(true);
  }

  // ── Sorted impressions ────────────────────────────────────────────────────
  const sortedLog = useMemo(() => {
    const copy = [...log];
    if (sortImp === "time") {
      copy.sort((a, b) => b.timestamp - a.timestamp);
    } else {
      copy.sort((a, b) => {
        const diff = BigInt(b.payoutPlanck ?? "0") - BigInt(a.payoutPlanck ?? "0");
        return diff > 0n ? 1 : diff < 0n ? -1 : 0;
      });
    }
    return copy;
  }, [log, sortImp]);

  // ── Sorted campaign summaries ─────────────────────────────────────────────
  const sortedCampaigns = useMemo(() => {
    const summaries = buildCampaignSummary(log);
    if (sortCamp === "count") summaries.sort((a, b) => b.count - a.count);
    else if (sortCamp === "payout") summaries.sort((a, b) => {
      const diff = b.totalPayoutPlanck - a.totalPayoutPlanck;
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
    else summaries.sort((a, b) => b.lastSeen - a.lastSeen);
    return summaries;
  }, [log, sortCamp]);

  // ── Totals ────────────────────────────────────────────────────────────────
  const totalPayout = useMemo(() =>
    log.reduce((acc, e) => acc + BigInt(e.payoutPlanck ?? "0"), 0n), [log]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" }}>
      {/* Header */}
      <div style={{
        padding: "12px 20px",
        background: "rgba(28,25,23,0.9)",
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        backdropFilter: "blur(8px)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontWeight: 700, color: "var(--accent)", fontSize: 15, letterSpacing: "0.06em" }}>DATUM</span>
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Impression History</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {log.length > 0 && !cleared && (
            <button
              onClick={handleClear}
              style={{
                background: "rgba(248,113,113,0.07)", color: "var(--error)",
                border: "1px solid rgba(248,113,113,0.2)", borderRadius: "var(--radius-sm)",
                padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
              }}
            >
              Clear History
            </button>
          )}
          <button
            onClick={() => window.close()}
            style={{
              background: "var(--bg-raised)", color: "var(--text-muted)",
              border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
              padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            Close
          </button>
        </div>
      </div>

      {/* Summary strip */}
      {log.length > 0 && (
        <div style={{
          display: "flex", gap: 24, padding: "8px 20px",
          background: "var(--bg-raised)", borderBottom: "1px solid var(--border)",
          fontSize: 11, flexShrink: 0,
        }}>
          <span>
            <span style={{ color: "var(--text-muted)" }}>Impressions </span>
            <span style={{ color: "var(--text-strong)", fontWeight: 600 }}>{log.length}</span>
          </span>
          <span>
            <span style={{ color: "var(--text-muted)" }}>Est. Earnings </span>
            <span style={{ color: "var(--ok)", fontWeight: 600 }}>{fmtPlanck(totalPayout.toString())}</span>
          </span>
          <span>
            <span style={{ color: "var(--text-muted)" }}>Campaigns </span>
            <span style={{ color: "var(--text-strong)", fontWeight: 600 }}>{new Set(log.map((e) => e.campaignId)).size}</span>
          </span>
        </div>
      )}

      {/* View toggle + sort controls */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 20px", borderBottom: "1px solid var(--border)", flexShrink: 0,
        gap: 12,
      }}>
        {/* View toggle */}
        <div style={{ display: "flex", borderRadius: "var(--radius-sm)", overflow: "hidden", border: "1px solid var(--border)" }}>
          {(["impressions", "campaigns"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: "4px 12px", fontSize: 11, fontFamily: "inherit",
                background: view === v ? "var(--bg-raised)" : "transparent",
                color: view === v ? "var(--accent)" : "var(--text-muted)",
                border: "none", borderLeft: v === "campaigns" ? "1px solid var(--border)" : "none",
                fontWeight: view === v ? 600 : 400, cursor: "pointer",
              }}
            >
              {v === "impressions" ? "Impressions" : "By Campaign"}
            </button>
          ))}
        </div>

        {/* Sort controls */}
        {view === "impressions" && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 10 }}>Sort:</span>
            {(["time", "payout"] as SortImpression[]).map((s) => (
              <button
                key={s}
                onClick={() => setSortImp(s)}
                style={{
                  padding: "3px 8px", fontSize: 10, fontFamily: "inherit", cursor: "pointer",
                  background: sortImp === s ? "rgba(160,160,255,0.12)" : "var(--bg-raised)",
                  color: sortImp === s ? "var(--accent)" : "var(--text-muted)",
                  border: `1px solid ${sortImp === s ? "rgba(160,160,255,0.3)" : "var(--border)"}`,
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {s === "time" ? "Newest" : "Payout"}
              </button>
            ))}
          </div>
        )}

        {view === "campaigns" && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 10 }}>Sort:</span>
            {(["count", "payout", "time"] as SortCampaign[]).map((s) => (
              <button
                key={s}
                onClick={() => setSortCamp(s)}
                style={{
                  padding: "3px 8px", fontSize: 10, fontFamily: "inherit", cursor: "pointer",
                  background: sortCamp === s ? "rgba(160,160,255,0.12)" : "var(--bg-raised)",
                  color: sortCamp === s ? "var(--accent)" : "var(--text-muted)",
                  border: `1px solid ${sortCamp === s ? "rgba(160,160,255,0.3)" : "var(--border)"}`,
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {s === "count" ? "Impressions" : s === "payout" ? "Earnings" : "Recent"}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>Loading...</div>
        )}

        {!loading && log.length === 0 && (
          <div style={{ padding: 40, textAlign: "center" }}>
            <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 8 }}>No impressions recorded yet.</div>
            <div style={{ color: "rgba(255,255,255,0.2)", fontSize: 11, lineHeight: 1.6 }}>
              Impressions will appear here as you browse sites that serve DATUM ads.
            </div>
          </div>
        )}

        {/* ── Impressions view ── */}
        {!loading && log.length > 0 && view === "impressions" && (
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "15%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "30%" }} />
              <col style={{ width: "21%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={headCellStyle}>Campaign</th>
                <th style={headCellStyle}>Est. Payout</th>
                <th style={headCellStyle}>Type</th>
                <th style={headCellStyle}>Rate</th>
                <th style={headCellStyle}>Page</th>
                <th style={headCellStyle}>Time</th>
              </tr>
            </thead>
            <tbody>
              {sortedLog.map((e) => {
                const adv = campaignAdvertisers[e.campaignId];
                return (
                  <tr key={e.id} style={{ transition: "background 0.1s" }}
                    onMouseEnter={(el) => (el.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                    onMouseLeave={(el) => (el.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ ...cellStyle, fontSize: 11 }}>
                      <CampaignChip
                        campaignId={e.campaignId}
                        size="xs"
                        rpcUrl={settings.rpcUrl}
                        network={settings.network}
                        addresses={settings.contractAddresses}
                        ipfsGateway={settings.ipfsGateway || "https://dweb.link/ipfs/"}
                      />
                    </td>
                    <td style={{ ...cellStyle, color: "var(--ok)", fontWeight: 600, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                      {fmtPlanck(e.payoutPlanck)}
                    </td>
                    <td style={cellStyle}>
                      <span style={pill(ACTION_COLORS[e.actionType] ?? "var(--text-muted)")}>
                        {ACTION_LABELS[e.actionType] ?? "?"}
                      </span>
                    </td>
                    <td style={{ ...cellStyle, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>
                      {fmtPlanck(e.ratePlanck)}
                    </td>
                    <td style={{ ...cellStyle, fontSize: 11, overflow: "hidden" }} title={e.url}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {fmtUrl(e.url)}
                        </span>
                        <BrandChip
                          address={e.publisherAddress}
                          size="xs"
                          rpcUrl={settings.rpcUrl}
                          addresses={settings.contractAddresses}
                          ipfsGateway={settings.ipfsGateway || "https://dweb.link/ipfs/"}
                        />
                      </div>
                    </td>
                    <td style={{ ...cellStyle, color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                      {fmtTime(e.timestamp)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* ── Campaigns view ── */}
        {!loading && log.length > 0 && view === "campaigns" && (
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "18%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "24%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "28%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={headCellStyle}>Campaign</th>
                <th style={headCellStyle}>Impressions</th>
                <th style={headCellStyle}>Est. Earnings</th>
                <th style={headCellStyle}>Types</th>
                <th style={headCellStyle}>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {sortedCampaigns.map((c) => (
                <tr key={c.campaignId}
                  onMouseEnter={(el) => (el.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                  onMouseLeave={(el) => (el.currentTarget.style.background = "transparent")}
                >
                  <td style={{ ...cellStyle, fontSize: 11 }}>
                    <CampaignChip
                      campaignId={c.campaignId}
                      size="xs"
                      rpcUrl={settings.rpcUrl}
                      network={settings.network}
                      addresses={settings.contractAddresses}
                      ipfsGateway={settings.ipfsGateway || "https://dweb.link/ipfs/"}
                    />
                  </td>
                  <td style={{ ...cellStyle, color: "var(--text-strong)", fontWeight: 600 }}>
                    {c.count}
                  </td>
                  <td style={{ ...cellStyle, color: "var(--ok)", fontWeight: 600, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                    {fmtPlanck(c.totalPayoutPlanck.toString())}
                  </td>
                  <td style={cellStyle}>
                    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                      {[...c.actionTypes].sort().map((t) => (
                        <span key={t} style={pill(ACTION_COLORS[t] ?? "var(--text-muted)")}>
                          {ACTION_LABELS[t] ?? "?"}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ ...cellStyle, color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                    {fmtTime(c.lastSeen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: "6px 20px", borderTop: "1px solid var(--border)",
        fontSize: 10, color: "var(--text-muted)", flexShrink: 0,
        display: "flex", justifyContent: "space-between",
      }}>
        <span>Last {log.length} impressions (max 100 stored locally)</span>
        {cleared && <span style={{ color: "var(--ok)" }}>History cleared</span>}
      </div>
    </div>
  );
}
