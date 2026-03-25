import { useParams, Link } from "react-router-dom";
import { CampaignDetail as ExplorerDetail } from "../explorer/CampaignDetail";

// Reuse the explorer detail page but with advertiser actions overlay
export function AdvertiserCampaignDetail() {
  const { id } = useParams<{ id: string }>();
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Link to="/advertiser" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← My Campaigns</Link>
      </div>
      <ExplorerDetail />
    </div>
  );
}
