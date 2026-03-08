import { useState, useEffect } from "react";
import { CampaignStatus, CampaignMetadata, CATEGORY_NAMES, UserPreferences, buildCategoryHierarchy, getCategoryParent } from "@shared/types";
import { formatDOT } from "@shared/dot";

interface CampaignRow {
  id: string;
  advertiser: string;
  publisher: string;
  remainingBudget: bigint;
  dailyCap: bigint;
  bidCpmPlanck: bigint;
  snapshotTakeRateBps: number;
  status: CampaignStatus;
  categoryId: number;
}

export function CampaignList() {
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [metadata, setMetadata] = useState<Record<string, CampaignMetadata>>({});
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);
  const [showBlocked, setShowBlocked] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  async function loadPrefs() {
    const response = await chrome.runtime.sendMessage({ type: "GET_USER_PREFERENCES" });
    if (response?.preferences) setPrefs(response.preferences);
  }

  async function loadCampaigns() {
    const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_CAMPAIGNS" });
    const raw: Record<string, string>[] = response?.campaigns ?? [];
    const camps: CampaignRow[] = raw.map((c) => ({
      id: c.id,
      advertiser: c.advertiser,
      publisher: c.publisher,
      remainingBudget: BigInt(c.remainingBudget),
      dailyCap: BigInt(c.dailyCap),
      bidCpmPlanck: BigInt(c.bidCpmPlanck),
      snapshotTakeRateBps: Number(c.snapshotTakeRateBps),
      status: Number(c.status) as CampaignStatus,
      categoryId: Number(c.categoryId ?? 0),
    }));
    setCampaigns(camps);

    const metaKeys = camps.map((c) => `metadata:${c.id}`);
    if (metaKeys.length > 0) {
      const stored = await chrome.storage.local.get(metaKeys);
      const meta: Record<string, CampaignMetadata> = {};
      for (const c of camps) {
        const key = `metadata:${c.id}`;
        if (stored[key]) meta[c.id] = stored[key];
      }
      setMetadata(meta);
    }
  }

  useEffect(() => {
    Promise.all([loadCampaigns(), loadPrefs()]).finally(() => setLoading(false));
  }, []);

  async function manualPoll() {
    setPolling(true);
    try {
      await chrome.runtime.sendMessage({ type: "POLL_CAMPAIGNS" });
      await loadCampaigns();
    } catch (err) {
      console.error("[DATUM] Manual poll failed:", err);
    }
    setPolling(false);
  }

  async function blockCampaign(id: string) {
    await chrome.runtime.sendMessage({ type: "BLOCK_CAMPAIGN", campaignId: id });
    await loadPrefs();
  }

  async function unblockCampaign(id: string) {
    await chrome.runtime.sendMessage({ type: "UNBLOCK_CAMPAIGN", campaignId: id });
    await loadPrefs();
  }

  if (loading) {
    return <div style={emptyStyle}>Loading campaigns...</div>;
  }

  const blockedIds = new Set(prefs?.blockedCampaigns ?? []);
  const silencedCats = new Set(prefs?.silencedCategories ?? []);

  // Filter campaigns — parent filter matches subcategories too
  let visible = campaigns.filter((c) => {
    if (blockedIds.has(c.id)) return false;
    const catName = CATEGORY_NAMES[c.categoryId];
    if (catName && silencedCats.has(catName)) return false;
    if (categoryFilter !== null) {
      if (c.categoryId !== categoryFilter && getCategoryParent(c.categoryId) !== categoryFilter) return false;
    }
    return true;
  });

  const blockedCampaigns = campaigns.filter((c) => blockedIds.has(c.id));

  if (campaigns.length === 0) {
    return (
      <div style={emptyStyle}>
        <div>No active campaigns</div>
        <div style={{ color: "#555", fontSize: 12, marginTop: 4 }}>
          Campaigns are polled every 5 minutes.
        </div>
        <button onClick={manualPoll} disabled={polling} style={{ ...refreshBtn, marginTop: 8 }}>
          {polling ? "Polling..." : "Poll Now"}
        </button>
      </div>
    );
  }

  // Collect unique top-level categories for filter (map subcats to parents)
  const usedParents = new Set<number>();
  for (const c of campaigns) {
    const parent = getCategoryParent(c.categoryId);
    usedParents.add(parent > 0 ? parent : c.categoryId);
  }
  const hierarchy = buildCategoryHierarchy().filter((g) => usedParents.has(g.id));

  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ padding: "4px 16px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setFilterOpen(!filterOpen)}
            style={{ ...filterSelect, display: "flex", alignItems: "center", gap: 4 }}
          >
            <span>{categoryFilter !== null ? (CATEGORY_NAMES[categoryFilter] ?? "Unknown") : "All categories"}</span>
            <span style={{ fontSize: 8 }}>{filterOpen ? "v" : ">"}</span>
          </button>
          {filterOpen && (
            <div style={{
              position: "absolute", top: "100%", left: 0, zIndex: 10, minWidth: 180,
              background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 4,
              maxHeight: 200, overflowY: "auto", marginTop: 2,
            }}>
              <button
                onClick={() => { setCategoryFilter(null); setFilterOpen(false); }}
                style={{ ...filterItem, fontWeight: categoryFilter === null ? 600 : 400, color: categoryFilter === null ? "#a0a0ff" : "#aaa" }}
              >All categories</button>
              {hierarchy.map((group) => (
                <button
                  key={group.id}
                  onClick={() => { setCategoryFilter(group.id); setFilterOpen(false); }}
                  style={{ ...filterItem, fontWeight: categoryFilter === group.id ? 600 : 400, color: categoryFilter === group.id ? "#a0a0ff" : "#aaa" }}
                >{group.name}</button>
              ))}
            </div>
          )}
        </div>
        <button onClick={manualPoll} disabled={polling} style={refreshBtn}>
          {polling ? "Polling..." : "Refresh"}
        </button>
      </div>

      {visible.map((c) => {
        const categoryName = CATEGORY_NAMES[c.categoryId] ?? "Unknown";
        const meta = metadata[c.id];
        const isExpanded = expandedId === c.id;
        return (
          <div key={c.id} style={{ padding: "10px 16px", borderBottom: "1px solid #1a1a2e" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: "#a0a0ff", fontWeight: 600 }}>
                {meta?.title ?? `Campaign #${c.id}`}
              </span>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button
                  onClick={() => setExpandedId(isExpanded ? null : c.id)}
                  style={iconBtn}
                  title="Details"
                >i</button>
                <button
                  onClick={() => blockCampaign(c.id)}
                  style={{ ...iconBtn, color: "#ff8080" }}
                  title="Block campaign"
                >x</button>
                <span style={{
                  fontSize: 11, padding: "2px 6px", borderRadius: 3,
                  background: "#0a2a0a", color: "#60c060",
                }}>Active</span>
              </div>
            </div>
            {meta?.description && (
              <div style={{ color: "#aaa", fontSize: 12, marginBottom: 4 }}>{meta.description}</div>
            )}
            <div style={{ color: "#888", fontSize: 12 }}>
              Budget: {formatDOT(c.remainingBudget)} DOT remaining
            </div>
            <div style={{ color: "#888", fontSize: 12 }}>
              Bid: {formatDOT(c.bidCpmPlanck)} DOT / 1000 impressions
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ color: "#666", fontSize: 11, fontFamily: "monospace" }}>
                {c.publisher.slice(0, 10)}...
              </span>
              <span style={{ color: "#666", fontSize: 11 }}>{categoryName}</span>
            </div>

            {/* Expanded info */}
            {isExpanded && (
              <div style={{ marginTop: 8, padding: 8, background: "#111122", borderRadius: 4, fontSize: 11, color: "#888" }}>
                <div>Advertiser: <span style={{ fontFamily: "monospace", color: "#aaa" }}>{c.advertiser}</span></div>
                <div>Publisher: <span style={{ fontFamily: "monospace", color: "#aaa" }}>{c.publisher}</span></div>
                <div>Take rate: {(c.snapshotTakeRateBps / 100).toFixed(2)}%</div>
                <div>Daily cap: {formatDOT(c.dailyCap)} DOT</div>
                <div>Category: {categoryName} (ID: {c.categoryId})</div>
              </div>
            )}
          </div>
        );
      })}

      {/* Blocked campaigns list */}
      {blockedCampaigns.length > 0 && (
        <div style={{ padding: "8px 16px" }}>
          <button
            onClick={() => setShowBlocked(!showBlocked)}
            style={{ ...refreshBtn, marginBottom: 4, width: "100%", textAlign: "left" }}
          >
            {showBlocked ? "Hide" : "Show"} {blockedCampaigns.length} blocked campaign{blockedCampaigns.length !== 1 ? "s" : ""}
          </button>
          {showBlocked && blockedCampaigns.map((c) => (
            <div key={c.id} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "4px 8px", background: "#1a0a0a", borderRadius: 3, marginBottom: 2,
            }}>
              <span style={{ color: "#888", fontSize: 11 }}>#{c.id}</span>
              <button
                onClick={() => unblockCampaign(c.id)}
                style={{ ...iconBtn, fontSize: 10, color: "#60c060" }}
              >Unblock</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "#666",
};

const refreshBtn: React.CSSProperties = {
  background: "#1a1a2e",
  color: "#a0a0ff",
  border: "1px solid #2a2a4a",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 11,
  cursor: "pointer",
};

const filterSelect: React.CSSProperties = {
  background: "#1a1a2e",
  color: "#e0e0e0",
  border: "1px solid #2a2a4a",
  borderRadius: 4,
  padding: "3px 8px",
  fontSize: 11,
  cursor: "pointer",
  outline: "none",
};

const filterItem: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  borderBottom: "1px solid #1a1a2e",
  color: "#aaa",
  fontSize: 11,
  padding: "4px 8px",
  cursor: "pointer",
};

const iconBtn: React.CSSProperties = {
  background: "none",
  border: "1px solid #2a2a4a",
  borderRadius: 3,
  color: "#a0a0ff",
  fontSize: 11,
  padding: "1px 6px",
  cursor: "pointer",
  lineHeight: 1,
};
