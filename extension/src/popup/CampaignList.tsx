import { useState, useEffect } from "react";
import { Campaign, CampaignStatus, CampaignMetadata, CATEGORY_NAMES } from "@shared/types";
import { formatDOT } from "@shared/dot";

export function CampaignList() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [metadata, setMetadata] = useState<Record<string, CampaignMetadata>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_CAMPAIGNS" });
      const camps: Campaign[] = response?.campaigns ?? [];
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

      setLoading(false);
    }
    load();
  }, []);

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
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 0" }}>
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
