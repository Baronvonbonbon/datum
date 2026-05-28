// CampaignChip — extension version. Title-first label with optional
// advertiser BrandChip. Falls back to "#N" only when nothing else can
// be loaded.
//
// Reads from activeCampaigns first (cheap), then chain + IPFS via
// campaignInfoCache. Caches results in chrome.storage so re-renders are
// instant after the first resolution.

import { useEffect, useState } from "react";
import { BrandChip } from "./BrandChip";
import { fetchCampaignDisplay, CampaignDisplayInfo } from "@shared/campaignInfoCache";
import type { ContractAddresses } from "@shared/types";

type Size = "xs" | "sm" | "md";

interface Props {
  campaignId: string;
  size?: Size;
  rpcUrl: string;
  network: string;
  addresses: ContractAddresses;
  ipfsGateway: string;
  /** Hide the advertiser sub-line. Useful when the row already shows the
   *  advertiser elsewhere. */
  hideAdvertiser?: boolean;
}

const STATUS_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: "Pending",   color: "var(--warn)" },
  1: { label: "Active",    color: "var(--ok)" },
  2: { label: "Paused",    color: "var(--text-muted)" },
  3: { label: "Terminated", color: "var(--error)" },
};

const SIZES: Record<Size, { title: number; sub: number }> = {
  xs: { title: 11, sub: 9  },
  sm: { title: 12, sub: 10 },
  md: { title: 13, sub: 11 },
};

export function CampaignChip({
  campaignId,
  size = "sm",
  rpcUrl,
  network,
  addresses,
  ipfsGateway,
  hideAdvertiser = false,
}: Props) {
  const s = SIZES[size];
  const [info, setInfo] = useState<CampaignDisplayInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    setLoading(true);
    fetchCampaignDisplay({
      campaignId,
      chainKey: network,
      campaignsAddr: addresses.campaigns,
      rpcUrl,
      ipfsGateway,
    }).then((i) => {
      if (cancelled) return;
      setInfo(i);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [campaignId, network, addresses.campaigns, rpcUrl, ipfsGateway]);

  const title = info?.title?.trim() || `Campaign #${campaignId}`;
  const hasTitle = Boolean(info?.title);
  const status = info?.status ?? 0;
  const statusInfo = STATUS_LABELS[status];

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2, minWidth: 0, maxWidth: "100%" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0 }}>
        <span
          style={{
            color: hasTitle ? "var(--text-strong)" : "var(--text-muted)",
            fontSize: s.title,
            fontWeight: 600,
            lineHeight: 1.2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            maxWidth: 220,
            fontStyle: hasTitle ? "normal" : "italic",
          }}
          title={hasTitle ? title : "Untitled campaign"}
        >
          {title}
        </span>
        {statusInfo && hasTitle && (
          <span style={{
            padding: "0 4px", borderRadius: 6, fontSize: 9,
            color: statusInfo.color, border: `1px solid ${statusInfo.color}55`,
            background: `${statusInfo.color}1a`, flexShrink: 0,
          }}>{statusInfo.label}</span>
        )}
        {hasTitle && (
          <span style={{ color: "var(--text-muted)", fontSize: s.sub, fontFamily: "monospace", flexShrink: 0 }}>
            #{campaignId}
          </span>
        )}
      </span>
      {!hideAdvertiser && info?.advertiser && info.advertiser !== "0x0000000000000000000000000000000000000000" && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: s.sub, color: "var(--text-muted)" }}>
          <span>by</span>
          <BrandChip
            address={info.advertiser}
            size="xs"
            rpcUrl={rpcUrl}
            addresses={addresses}
            ipfsGateway={ipfsGateway}
          />
        </span>
      )}
      {loading && !hasTitle && (
        <span style={{ fontSize: s.sub - 1, color: "var(--text-muted)", opacity: 0.5 }}>loading…</span>
      )}
    </span>
  );
}
