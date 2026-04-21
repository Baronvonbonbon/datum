import { useState, useEffect } from "react";
import { bytes32ToCid, metadataUrl } from "@shared/ipfs";
import { validateAndSanitize } from "@shared/contentSafety";
import { CampaignMetadata } from "@shared/types";
import { useSettings } from "../context/SettingsContext";
import { sanitizeCtaUrl } from "@shared/contentSafety";

interface Props {
  metadataHash: string; // bytes32 hex
  compact?: boolean;
}

const ZERO_HASH = "0x" + "0".repeat(64);

export function IPFSPreview({ metadataHash, compact = false }: Props) {
  const { settings } = useSettings();
  const [metadata, setMetadata] = useState<CampaignMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!metadataHash || metadataHash === ZERO_HASH) return;
    setLoading(true);
    setError(null);

    const primaryUrl = metadataUrl(metadataHash, settings.ipfsGateway);
    if (!primaryUrl) { setLoading(false); return; }

    // Fallback gateways tried in order when the primary returns 404.
    // Local Kubo gateway first (handles locally-pinned testnet metadata).
    const FALLBACK_GATEWAYS = [
      "http://localhost:8080/ipfs/",
      "https://ipfs.io/ipfs/",
      "https://cloudflare-ipfs.com/ipfs/",
    ];

    async function fetchWithFallback() {
      const urls: string[] = [primaryUrl!];
      for (const gw of FALLBACK_GATEWAYS) {
        if (!gw.startsWith(settings.ipfsGateway.replace(/\/$/, ""))) {
          const fb = metadataUrl(metadataHash, gw);
          if (fb) urls.push(fb);
        }
      }

      let lastErr = "";
      for (const url of urls) {
        try {
          const r = await fetch(url);
          if (r.status === 404) { lastErr = "Not pinned to gateway"; continue; }
          if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
          const raw = await r.json();
          const validated = validateAndSanitize(raw);
          if (!validated) { lastErr = "Invalid metadata schema"; continue; }
          setMetadata(validated);
          return;
        } catch (err) {
          lastErr = String(err).slice(0, 80);
        }
      }
      setError(lastErr);
    }

    fetchWithFallback().finally(() => setLoading(false));
  }, [metadataHash, settings.ipfsGateway]);

  if (!metadataHash || metadataHash === ZERO_HASH) {
    return <span style={{ color: "var(--text-muted)", fontSize: 12 }}>No metadata</span>;
  }

  if (loading) return <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Loading metadata...</span>;
  if (error) return <span style={{ color: "var(--error)", fontSize: 12 }}>Metadata error: {error}</span>;
  if (!metadata) return null;

  const safeUrl = sanitizeCtaUrl(metadata.creative.ctaUrl);

  if (compact) {
    return (
      <span style={{ color: "var(--accent)", fontSize: 12 }}>
        {metadata.title}
      </span>
    );
  }

  return (
    <div className="nano-card" style={{ padding: 12 }}>
      <div style={{ color: "var(--text-strong)", fontWeight: 600, marginBottom: 4 }}>{metadata.title}</div>
      <div style={{ color: "var(--text)", fontSize: 12, marginBottom: 8 }}>{metadata.description}</div>
      <div style={{
        background: "var(--bg-raised)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: "8px 12px",
        marginBottom: 8,
      }}>
        <div style={{ color: "var(--text)", fontSize: 13, marginBottom: 6 }}>{metadata.creative.text}</div>
        {safeUrl ? (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="nano-btn nano-btn-accent"
            style={{ display: "inline-block", padding: "4px 12px", fontSize: 12, textDecoration: "none" }}
          >
            {metadata.creative.cta}
          </a>
        ) : (
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{metadata.creative.cta}</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        Category: {metadata.category}
        {" · "}
        <a
          href={metadataUrl(metadataHash, settings.ipfsGateway) ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--accent-dim)" }}
        >
          View on IPFS
        </a>
      </div>
    </div>
  );
}
