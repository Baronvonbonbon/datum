// CampaignChip — render a campaign by title + advertiser brand instead
// of "#ID". Falls back to the ID only when nothing else can be loaded.
//
// Composition: title (bold primary), advertiser BrandChip below, optional
// status pill + CPM sublabel. Links to /campaigns/:id when `link` is true.
//
// Title is fetched from IPFS via campaignInfoCache (stale-while-revalidate
// with 1h TTL); the chip paints instantly with the cached title when
// available, otherwise renders a soft "Campaign #N" placeholder while
// the fetch is in flight.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useSettings } from "../context/SettingsContext";
import { useContracts } from "../hooks/useContracts";
import { fetchCampaignInfo, type CampaignInfo } from "../lib/campaignInfoCache";
import { BrandChip } from "./BrandChip";
import { formatDOT } from "@shared/dot";

type Size = "sm" | "md" | "lg";

interface Props {
  campaignId: string | number | bigint;
  /** "sm" = inline-ish; "md" = card row; "lg" = profile page heading. */
  size?: Size;
  /** When true, wraps the chip in a Link to /campaigns/:id. */
  link?: boolean;
  /** Hide the advertiser BrandChip — useful in contexts where the row
   *  already shows the advertiser elsewhere (e.g. the advertiser dashboard
   *  where every row is yours). */
  hideAdvertiser?: boolean;
  /** Show the optional CPM sublabel under the title. */
  showCpm?: boolean;
  /** Show the status pill (Pending/Active/Paused). */
  showStatus?: boolean;
}

const STATUS_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: "Pending",   color: "var(--warn)"      },
  1: { label: "Active",    color: "var(--ok)"        },
  2: { label: "Paused",    color: "var(--text-muted)" },
  3: { label: "Terminated", color: "var(--error)"    },
};

const SIZES: Record<Size, { title: number; sub: number; pill: number }> = {
  sm: { title: 12, sub: 10, pill: 9  },
  md: { title: 14, sub: 11, pill: 10 },
  lg: { title: 18, sub: 12, pill: 11 },
};

export function CampaignChip({
  campaignId,
  size = "md",
  link = true,
  hideAdvertiser = false,
  showCpm = false,
  showStatus = false,
}: Props) {
  const { settings } = useSettings();
  const contracts = useContracts();
  const s = SIZES[size];
  const cid = String(campaignId);

  const [info, setInfo] = useState<CampaignInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!cid || !settings.contractAddresses.campaigns) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchCampaignInfo({
      campaignId: cid,
      chainKey: settings.network,
      campaignsAddr: settings.contractAddresses.campaigns,
      provider: contracts.readProvider as any,
      ipfsGateway: settings.ipfsGateway || "https://ipfs.io",
    }).then((i) => {
      if (cancelled) return;
      setInfo(i);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [cid, settings.network, settings.contractAddresses.campaigns, settings.ipfsGateway, contracts.readProvider]);

  const title = info?.title?.trim() || `Campaign #${cid}`;
  const hasTitle = Boolean(info?.title);
  const status = info?.status ?? 0;
  const statusInfo = STATUS_LABELS[status];

  const body = (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, maxWidth: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span
          style={{
            color: hasTitle ? "var(--text-strong)" : "var(--text-muted)",
            fontSize: s.title,
            fontWeight: 600,
            lineHeight: 1.25,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 320,
            fontStyle: hasTitle ? "normal" : "italic",
          }}
          title={hasTitle ? title : `Untitled campaign (no metadata set)`}
        >
          {title}
        </span>
        {showStatus && statusInfo && (
          <span
            className="nano-badge"
            style={{
              fontSize: s.pill,
              padding: "1px 6px",
              color: statusInfo.color,
              border: `1px solid ${statusInfo.color}55`,
              background: `${statusInfo.color}1a`,
              flexShrink: 0,
            }}
          >
            {statusInfo.label}
          </span>
        )}
        {hasTitle && (
          <span style={{ fontSize: s.sub, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
            #{cid}
          </span>
        )}
      </div>
      {!hideAdvertiser && info?.advertiser && info.advertiser !== "0x0000000000000000000000000000000000000000" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: s.sub, color: "var(--text-muted)", minWidth: 0 }}>
          <span style={{ flexShrink: 0 }}>by</span>
          <BrandChip address={info.advertiser} size="sm" role="advertiser" />
        </div>
      )}
      {showCpm && info && info.viewBidPlanck && info.viewBidPlanck !== "0" && (
        <span style={{ fontSize: s.sub, color: "var(--text-muted)" }}>
          CPM {formatDOT(BigInt(info.viewBidPlanck))}
        </span>
      )}
      {loading && !hasTitle && (
        <span style={{ fontSize: s.sub - 1, color: "var(--text-muted)", opacity: 0.5 }}>
          loading…
        </span>
      )}
    </div>
  );

  if (link) {
    return (
      <Link to={`/campaigns/${cid}`} style={{ textDecoration: "none", color: "inherit", display: "inline-block", maxWidth: "100%" }}>
        {body}
      </Link>
    );
  }
  return body;
}
