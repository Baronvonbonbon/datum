import { useState, useEffect, useCallback } from "react";
import { bytes32ToCid, metadataUrl } from "@shared/ipfs";
import { validateAndSanitize } from "@shared/contentSafety";
import { CampaignMetadata, AD_FORMAT_SIZES, AdFormat } from "@shared/types";
import { useSettings } from "../context/SettingsContext";
import { sanitizeCtaUrl } from "@shared/contentSafety";

interface ImageEntry {
  url: string;
  format?: AdFormat;
  alt?: string;
}

const IMAGE_FALLBACK_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://w3s.link/ipfs/",
];

function buildImageCandidates(url: string, gateway: string): string[] {
  if (url.startsWith("https://")) return [url];
  if (!(url.startsWith("Qm") && url.length >= 46)) return [url];

  const isLocal =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const gw = gateway.endsWith("/") ? gateway : gateway + "/";
  const primary = gw + url;

  const seen = new Set<string>();
  const out: string[] = [];
  const push = (u: string) => { if (!seen.has(u)) { seen.add(u); out.push(u); } };

  // On localhost, try the local Kubo gateway first (where the content was pinned)
  if (isLocal) push(`http://localhost:8080/ipfs/${url}`);
  push(primary);
  for (const fb of IMAGE_FALLBACK_GATEWAYS) {
    if (!fb.startsWith(gw.replace(/\/$/, ""))) push(fb + url);
  }
  return out;
}

// Tries gateway candidates in order via onError fallback
function ImageWithFallback({
  candidates,
  alt,
  style,
}: {
  candidates: string[];
  alt: string;
  style?: React.CSSProperties;
}) {
  const [idx, setIdx] = useState(0);
  if (candidates.length === 0) return <span style={{ color: "var(--error)", fontSize: 12 }}>No image URL</span>;
  if (idx >= candidates.length) return <span style={{ color: "var(--error)", fontSize: 12 }}>Image unavailable on all gateways</span>;
  return (
    <img
      key={candidates[idx]}
      src={candidates[idx]}
      alt={alt}
      style={style}
      onError={() => setIdx((i) => i + 1)}
    />
  );
}

function ImageViewerModal({
  images,
  initialIndex,
  gateway,
  onClose,
}: {
  images: ImageEntry[];
  initialIndex: number;
  gateway: string;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(initialIndex);
  const entry = images[idx];
  const size = entry.format ? AD_FORMAT_SIZES[entry.format] : null;

  const prev = useCallback(() => setIdx((i) => (i - 1 + images.length) % images.length), [images.length]);
  const next = useCallback(() => setIdx((i) => (i + 1) % images.length), [images.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && images.length > 1) prev();
      if (e.key === "ArrowRight" && images.length > 1) next();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next, images.length]);

  const candidates = buildImageCandidates(entry.url, gateway);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.72)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "16px 16px 12px",
          maxWidth: "min(92vw, 800px)",
          width: "fit-content",
          boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 16 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {entry.format ? (
              <>
                <span style={{ color: "var(--text)", fontWeight: 600 }}>{entry.format}</span>
                {size && <span style={{ marginLeft: 6 }}>{size.w}×{size.h}</span>}
              </>
            ) : (
              <span style={{ color: "var(--text)" }}>Image</span>
            )}
            {entry.alt && <span style={{ marginLeft: 8, fontStyle: "italic" }}>{entry.alt}</span>}
            {images.length > 1 && (
              <span style={{ marginLeft: 10, color: "var(--accent-dim)" }}>{idx + 1} / {images.length}</span>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--text-muted)", fontSize: 18, lineHeight: 1,
              padding: "0 2px", flexShrink: 0,
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Image */}
        <div style={{ display: "flex", justifyContent: "center", background: "var(--bg-raised)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
          <ImageWithFallback
            candidates={candidates}
            alt={entry.alt ?? entry.format ?? "ad creative"}
            style={{ maxWidth: "min(80vw, 760px)", maxHeight: "65vh", display: "block", objectFit: "contain" }}
          />
        </div>

        {/* Prev / Next */}
        {images.length > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
            <button onClick={prev} className="nano-btn" style={{ fontSize: 12, padding: "4px 14px" }}>← Prev</button>
            <div style={{ display: "flex", gap: 4 }}>
              {images.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setIdx(i)}
                  style={{
                    width: 8, height: 8, borderRadius: "50%", border: "none", cursor: "pointer", padding: 0,
                    background: i === idx ? "var(--accent)" : "var(--border)",
                    transition: "background 150ms",
                  }}
                  aria-label={`Image ${i + 1}`}
                />
              ))}
            </div>
            <button onClick={next} className="nano-btn" style={{ fontSize: 12, padding: "4px 14px" }}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}

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
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const [imageViewerStart, setImageViewerStart] = useState(0);

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

  // Build unified image list: prefer creative.images[], fall back to single imageUrl
  const imageList: ImageEntry[] = (() => {
    if (metadata.creative.images && metadata.creative.images.length > 0) {
      return metadata.creative.images.map((img) => ({
        url: img.url,
        format: img.format,
        alt: img.alt,
      }));
    }
    if (metadata.creative.imageUrl) {
      return [{ url: metadata.creative.imageUrl }];
    }
    return [];
  })();

  if (compact) {
    return (
      <span style={{ color: "var(--accent)", fontSize: 12 }}>
        {metadata.title}
      </span>
    );
  }

  return (
    <>
      {imageViewerOpen && imageList.length > 0 && (
        <ImageViewerModal
          images={imageList}
          initialIndex={imageViewerStart}
          gateway={settings.ipfsGateway}
          onClose={() => setImageViewerOpen(false)}
        />
      )}
      <div className="nano-card" style={{ padding: 12 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <div style={{ color: "var(--text-strong)", fontWeight: 600 }}>{metadata.title}</div>
          {imageList.length > 0 && (
            <button
              onClick={() => { setImageViewerStart(0); setImageViewerOpen(true); }}
              className="nano-btn"
              style={{ fontSize: 11, padding: "3px 10px", flexShrink: 0, whiteSpace: "nowrap" }}
            >
              {imageList.length === 1 ? "View Image" : `View Images (${imageList.length})`}
            </button>
          )}
        </div>
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
    </>
  );
}
