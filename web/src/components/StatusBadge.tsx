import { CampaignStatus } from "@shared/types";

const STATUS_CONFIG: Record<number, { label: string; color: string; bg: string }> = {
  [CampaignStatus.Pending]:    { label: "Pending",    color: "#c0c060", bg: "#1a1a0a" },
  [CampaignStatus.Active]:     { label: "Active",     color: "#60c060", bg: "#0a2a0a" },
  [CampaignStatus.Paused]:     { label: "Paused",     color: "#c09060", bg: "#1a1a0a" },
  [CampaignStatus.Completed]:  { label: "Completed",  color: "#60a0ff", bg: "#0a1a2a" },
  [CampaignStatus.Terminated]: { label: "Terminated", color: "#ff8080", bg: "#2a0a0a" },
  [CampaignStatus.Expired]:    { label: "Expired",    color: "#888888", bg: "#1a1a1a" },
};

interface Props {
  status: number;
  style?: React.CSSProperties;
}

export function StatusBadge({ status, style }: Props) {
  const cfg = STATUS_CONFIG[status] ?? { label: `Status ${status}`, color: "#888", bg: "#111" };
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 3,
      fontSize: 11,
      fontWeight: 600,
      background: cfg.bg,
      color: cfg.color,
      border: `1px solid ${cfg.color}40`,
      ...style,
    }}>
      {cfg.label}
    </span>
  );
}
