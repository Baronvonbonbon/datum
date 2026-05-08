import { useRef, useState } from "react";
import { Link } from "react-router-dom";

/**
 * Settings → House Ad Preview
 *
 * Loads /house-ad-preview.html in an iframe so the SDK runs in a clean,
 * sandboxed context and the no-extension fallback timer fires every time.
 * The "shuffle creatives" button reloads the iframe with a fresh cache-bust
 * key, which re-rolls every random pick (category, hook, body, CTA) in the
 * SDK's creative pool.
 */
export function HouseAdPreview() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [nonce, setNonce] = useState(0);

  function reroll() {
    setNonce((n) => n + 1);
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 920 }}>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "baseline", gap: 12 }}>
        <Link
          to="/settings"
          style={{ color: "var(--accent)", fontSize: 12, textDecoration: "none" }}
        >
          ← Settings
        </Link>
      </div>

      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
        House Ad Preview
      </h1>

      <p style={{ color: "var(--text-dim)", fontSize: 13, lineHeight: 1.55, maxWidth: 720, marginTop: 0, marginBottom: 16 }}>
        These are the inline house ads <code style={{ fontSize: 12 }}>datum-sdk.js</code> renders
        when no DATUM browser extension is detected on a publisher's page. Each render picks a
        random <em>category</em> (cypherpunk · p2p · privacy · sass) and an independently-random
        hook, body, and call-to-action from inside it. Hit shuffle to re-roll.
      </p>

      <div className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <button
            onClick={reroll}
            className="nano-btn nano-btn-accent"
            style={{ fontSize: 12, padding: "6px 14px" }}
          >
            ↻ shuffle creatives
          </button>
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            1,440 unique permutations — every reload re-rolls each slot independently.
          </span>
        </div>

        {/*
          The iframe key is bumped on every reroll so React unmounts and remounts the
          iframe (forcing a fresh navigation, not just a soft reload).
        */}
        <iframe
          key={nonce}
          ref={iframeRef}
          src={`/house-ad-preview.html?n=${nonce}`}
          title="DATUM house ad preview"
          style={{
            width: "100%",
            height: 1280,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "transparent",
            display: "block",
          }}
        />
      </div>

      <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
          How publishers wire it up
        </div>
        <p style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.55, margin: 0 }}>
          Publishers do nothing — the SDK already ships the fallback. If a visitor doesn't have
          the DATUM extension installed (or it doesn't respond to the handshake within 1.5s), the
          SDK fills the slot with one of these creatives, sized to the slot's IAB format. When
          the extension is present, its real ad replaces the fallback and the house ad is torn down.
        </p>
      </div>
    </div>
  );
}
