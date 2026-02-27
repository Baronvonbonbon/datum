import { useState, useEffect } from "react";
import { Campaign, CampaignStatus } from "@shared/types";
import { formatDOT } from "@shared/dot";

export function CampaignList() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_CAMPAIGNS" });
      setCampaigns(response?.campaigns ?? []);
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
        <CampaignRow key={c.id.toString()} campaign={c} />
      ))}
    </div>
  );
}

function CampaignRow({ campaign: c }: { campaign: Campaign }) {
  return (
    <div style={{
      padding: "10px 16px",
      borderBottom: "1px solid #1a1a2e",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>Campaign #{c.id.toString()}</span>
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
      <div style={{ color: "#888", fontSize: 12 }}>
        Budget: {formatDOT(c.remainingBudget)} DOT remaining
      </div>
      <div style={{ color: "#888", fontSize: 12 }}>
        Bid: {formatDOT(c.bidCpmPlanck)} DOT / 1000 impressions
      </div>
      <div style={{ color: "#666", fontSize: 11, marginTop: 2, fontFamily: "monospace" }}>
        {c.publisher.slice(0, 10)}…
      </div>
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "#666",
};
