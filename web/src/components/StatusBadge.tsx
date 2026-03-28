import { CampaignStatus } from "@shared/types";

const STATUS_CONFIG: Record<number, { label: string; cls: string }> = {
  [CampaignStatus.Pending]:    { label: "Pending",    cls: "nano-badge nano-badge--warn" },
  [CampaignStatus.Active]:     { label: "Active",     cls: "nano-badge nano-badge--ok" },
  [CampaignStatus.Paused]:     { label: "Paused",     cls: "nano-badge nano-badge--warn" },
  [CampaignStatus.Completed]:  { label: "Completed",  cls: "nano-badge nano-badge--accent" },
  [CampaignStatus.Terminated]: { label: "Terminated", cls: "nano-badge nano-badge--error" },
  [CampaignStatus.Expired]:    { label: "Expired",    cls: "nano-badge" },
};

interface Props {
  status: number;
  style?: React.CSSProperties;
}

export function StatusBadge({ status, style }: Props) {
  const cfg = STATUS_CONFIG[status] ?? { label: `Status ${status}`, cls: "nano-badge" };
  return (
    <span className={cfg.cls} style={style}>
      {cfg.label}
    </span>
  );
}
