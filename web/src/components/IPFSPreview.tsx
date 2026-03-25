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

    const url = metadataUrl(metadataHash, settings.ipfsGateway);
    if (!url) { setLoading(false); return; }

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((raw) => {
        const validated = validateAndSanitize(raw);
        if (!validated) throw new Error("Invalid metadata schema");
        setMetadata(validated);
      })
      .catch((err) => setError(String(err).slice(0, 100)))
      .finally(() => setLoading(false));
  }, [metadataHash, settings.ipfsGateway]);

  if (!metadataHash || metadataHash === ZERO_HASH) {
    return <span style={{ color: "#555", fontSize: 12 }}>No metadata</span>;
  }

  if (loading) return <span style={{ color: "#555", fontSize: 12 }}>Loading metadata...</span>;
  if (error) return <span style={{ color: "#ff8080", fontSize: 12 }}>Metadata error: {error}</span>;
  if (!metadata) return null;

  const safeUrl = sanitizeCtaUrl(metadata.creative.ctaUrl);

  if (compact) {
    return (
      <span style={{ color: "#a0a0ff", fontSize: 12 }}>
        {metadata.title}
      </span>
    );
  }

  return (
    <div style={{
      background: "#111",
      border: "1px solid #2a2a4a",
      borderRadius: 6,
      padding: 12,
    }}>
      <div style={{ color: "#e0e0e0", fontWeight: 600, marginBottom: 4 }}>{metadata.title}</div>
      <div style={{ color: "#888", fontSize: 12, marginBottom: 8 }}>{metadata.description}</div>
      <div style={{
        background: "#1a1a2e",
        border: "1px solid #2a2a4a",
        borderRadius: 4,
        padding: "8px 12px",
        marginBottom: 8,
      }}>
        <div style={{ color: "#ccc", fontSize: 13, marginBottom: 6 }}>{metadata.creative.text}</div>
        {safeUrl ? (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-block",
              padding: "4px 12px",
              background: "#2a2a5a",
              color: "#a0a0ff",
              border: "1px solid #4a4a8a",
              borderRadius: 4,
              fontSize: 12,
              textDecoration: "none",
            }}
          >
            {metadata.creative.cta}
          </a>
        ) : (
          <span style={{ color: "#555", fontSize: 12 }}>{metadata.creative.cta}</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "#555" }}>
        Category: {metadata.category}
        {" · "}
        <a
          href={metadataUrl(metadataHash, settings.ipfsGateway) ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#4a4a8a" }}
        >
          View on IPFS
        </a>
      </div>
    </div>
  );
}
