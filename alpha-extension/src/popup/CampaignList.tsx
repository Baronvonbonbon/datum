import { useState, useEffect } from "react";
import { Campaign, CampaignStatus, CampaignMetadata, CATEGORY_NAMES } from "@shared/types";
import { formatDOT } from "@shared/dot";

export function CampaignList() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [metadata, setMetadata] = useState<Record<string, CampaignMetadata>>({});
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);

  async function loadCampaigns() {
    const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_CAMPAIGNS" });
    // Background returns serialized form (strings) — deserialize to Campaign
    const raw: Record<string, string>[] = response?.campaigns ?? [];
    const camps: Campaign[] = raw.map((c) => ({
      id: BigInt(c.id),
      advertiser: c.advertiser,
      publisher: c.publisher,
      budget: BigInt(c.budget),
      remainingBudget: BigInt(c.remainingBudget),
      dailyCap: BigInt(c.dailyCap),
      bidCpmPlanck: BigInt(c.bidCpmPlanck),
      snapshotTakeRateBps: Number(c.snapshotTakeRateBps),
      status: Number(c.status) as CampaignStatus,
      categoryId: Number(c.categoryId ?? 0),
      pendingExpiryBlock: BigInt(c.pendingExpiryBlock),
      terminationBlock: BigInt(c.terminationBlock),
    }));
    setCampaigns(camps);

    // Load cached metadata for all campaigns
    const metaKeys = camps.map((c) => `metadata:${c.id.toString()}`);
    if (metaKeys.length > 0) {
      const stored = await chrome.storage.local.get(metaKeys);
      const meta: Record<string, CampaignMetadata> = {};
      for (const c of camps) {
        const key = `metadata:${c.id.toString()}`;
        if (stored[key]) meta[c.id.toString()] = stored[key];
      }
      setMetadata(meta);
    }
  }

  useEffect(() => {
    loadCampaigns().finally(() => setLoading(false));
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

  if (loading) {
    return <div style={emptyStyle}>Loading campaigns…</div>;
  }

  if (campaigns.length === 0) {
    return (
      <div style={emptyStyle}>
        <div>No active campaigns</div>
        <div style={{ color: "#555", fontSize: 12, marginTop: 4 }}>
          Campaigns are polled every 5 minutes.
        </div>
        <button
          onClick={manualPoll}
          disabled={polling}
          style={{ ...refreshBtn, marginTop: 8 }}
        >
          {polling ? "Polling…" : "Poll Now"}
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ padding: "4px 16px 8px", textAlign: "right" }}>
        <button
          onClick={manualPoll}
          disabled={polling}
          style={refreshBtn}
        >
          {polling ? "Polling…" : "Refresh"}
        </button>
      </div>
      {campaigns.map((c) => (
        <CampaignRow key={c.id.toString()} campaign={c} meta={metadata[c.id.toString()]} />
      ))}
    </div>
  );
}

function CampaignRow({ campaign: c, meta }: { campaign: Campaign; meta?: CampaignMetadata }) {
  const categoryName = CATEGORY_NAMES[c.categoryId] ?? "Unknown";
  return (
    <div style={{
      padding: "10px 16px",
      borderBottom: "1px solid #1a1a2e",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>
          {meta?.title ?? `Campaign #${c.id.toString()}`}
        </span>
        <span style={{
          fontSize: 11,
          padding: "2px 6px",
          borderRadius: 3,
          background: "#0a2a0a",
          color: "#60c060",
        }}>
          Active
        </span>
      </div>
      {meta?.description && (
        <div style={{ color: "#aaa", fontSize: 12, marginBottom: 4 }}>
          {meta.description}
        </div>
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
        <span style={{ color: "#666", fontSize: 11 }}>
          {categoryName}
        </span>
      </div>
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
