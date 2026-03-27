import { CampaignStatus } from "@shared/types";

const STATUS_CONFIG: Record<number, { label: string; color: string; border: string }> = {
  [CampaignStatus.Pending]:    { label: "Pending",    color: "var(--warn)",   border: "rgba(252,211,77,0.3)" },
  [CampaignStatus.Active]:     { label: "Active",     color: "var(--ok)",     border: "rgba(110,231,183,0.3)" },
  [CampaignStatus.Paused]:     { label: "Paused",     color: "var(--warn)",   border: "rgba(252,211,77,0.3)" },
  [CampaignStatus.Completed]:  { label: "Completed",  color: "var(--accent)", border: "var(--accent-dim)" },
  [CampaignStatus.Terminated]: { label: "Terminated", color: "var(--error)",  border: "rgba(252,165,165,0.3)" },
  [CampaignStatus.Expired]:    { label: "Expired",    color: "var(--text-muted)", border: "var(--border)" },
};

interface Props {
  status: number;
  style?: React.CSSProperties;
}

export function StatusBadge({ status, style }: Props) {
  const cfg = STATUS_CONFIG[status] ?? { label: `Status ${status}`, color: "var(--text-muted)", border: "var(--border)" };
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 3,
      fontSize: 11,
      fontWeight: 600,
      background: "var(--bg-raised)",
      color: cfg.color,
      border: `1px solid ${cfg.border}`,
      ...style,
    }}>
      {cfg.label}
    </span>
  );
}
