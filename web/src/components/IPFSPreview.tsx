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
    // Only include localhost when the page itself is served from localhost —
    // on remote devices localhost:8080 is that device's own machine (empty).
    const isLocalOrigin =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    const FALLBACK_GATEWAYS = [
      ...(isLocalOrigin ? ["http://localhost:8080/ipfs/"] : []),
      "https://ipfs.io/ipfs/",
      "https://dweb.link/ipfs/",
      "https://cloudflare-ipfs.com/ipfs/",
      "https://w3s.link/ipfs/",
      "https://4everland.io/ipfs/",
    ];

    // IPFS gateways may wait 30–60 s probing the DHT before returning 404.
    // Cap each gateway attempt at 8 s using a per-request AbortController,
    // and track unmount separately so we don't call setState after cleanup.
    const TIMEOUT_MS = 8000;
    let unmounted = false;

    // When the page is on a secure origin (HTTPS or localhost), the browser
    // blocks HTTP gateway URLs as mixed content — they fail with "Failed to fetch"
    // before any network request is made. Skip them entirely.
    const pageIsSecure =
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    function isAllowedUrl(url: string): boolean {
      try {
        return !pageIsSecure || new URL(url).protocol === "https:";
      } catch {
        return false;
      }
    }

    async function fetchWithFallback() {
      const candidates: string[] = [primaryUrl!];
      for (const gw of FALLBACK_GATEWAYS) {
        if (!gw.startsWith(settings.ipfsGateway.replace(/\/$/, ""))) {
          const fb = metadataUrl(metadataHash, gw);
          if (fb) candidates.push(fb);
        }
      }
      const urls = candidates.filter(isAllowedUrl);

      if (urls.length === 0) {
        setError("No reachable gateway — configure an HTTPS gateway in Settings");
        return;
      }

      const tried: string[] = [];
      let lastErr = "";
      for (const url of urls) {
        if (unmounted) return;
        const host = new URL(url).hostname;
        tried.push(host);
        // Fresh controller per URL so a timeout on one doesn't cancel the rest.
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
          const r = await fetch(url, { signal: ctl.signal });
          clearTimeout(timer);
          if (r.status === 404) { lastErr = "not found"; continue; }
          if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
          const raw = await r.json();
          const validated = validateAndSanitize(raw);
          if (!validated) { lastErr = "invalid metadata schema"; continue; }
          if (!unmounted) setMetadata(validated);
          return;
        } catch (err) {
          clearTimeout(timer);
          if (unmounted) return;
          lastErr = ctl.signal.aborted ? "timed out" : "fetch error";
        }
      }
      if (!unmounted) setError(`Not found on any gateway (tried: ${tried.join(", ")}) — last error: ${lastErr}`);
    }

    fetchWithFallback().finally(() => { if (!unmounted) setLoading(false); });
    return () => { unmounted = true; };
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
