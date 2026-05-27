import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "../../context/WalletContext";
import { useContracts } from "../../hooks/useContracts";
import { tagLabel } from "@shared/tagDictionary";
import { RequirePublisher } from "../../components/RequirePublisher";
import { StepTooltip } from "../../components/StepTooltip";
import { AD_FORMAT_SIZES, AdFormat } from "@shared/types";

type SlotMode = "single" | "multi";

export function SDKSetup() {
  const { address } = useWallet();
  const contracts = useContracts();
  const [tags, setTags] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  // Slot configuration: single-slot (with format picker) is the default;
  // power users can swap to multi-slot for layouts with multiple ad units.
  const [slotMode, setSlotMode] = useState<SlotMode>("single");
  const [slotFormat, setSlotFormat] = useState<AdFormat>("medium-rectangle");
  // Multi-slot: list of (id, format) pairs.
  const [multiSlots, setMultiSlots] = useState<{ id: string; format: AdFormat }[]>([
    { id: "datum-slot-header",  format: "leaderboard" },
    { id: "datum-slot-sidebar", format: "wide-skyscraper" },
  ]);

  useEffect(() => {
    if (!address || !contracts.campaigns) return;
    contracts.campaigns.getPublisherTags2(address)
      .then((hashes: string[]) => {
        setTags(hashes.map((h: string) => tagLabel(h) ?? "").filter(Boolean));
      })
      .catch(() => {});
  }, [address]);

  const pubAddr = address ?? "0xYOUR_PUBLISHER_ADDRESS";
  const tagStr = tags.length > 0 ? tags.join(",") : "crypto-web3,en";

  const size = AD_FORMAT_SIZES[slotFormat];
  const slotHtml = slotMode === "single"
    ? `<div id="datum-ad-slot" data-slot-format="${slotFormat}"
     style="width:${size.w}px;height:${size.h}px;"></div>`
    : multiSlots.map(s => {
        const sz = AD_FORMAT_SIZES[s.format];
        return `<div data-datum-slot="${s.format}" id="${s.id}"
     style="width:${sz.w}px;height:${sz.h}px;"></div>`;
      }).join("\n");

  const snippet = `<!-- DATUM Publisher SDK -->
<script src="https://datum.javcon.io/datum-sdk.js"
        data-publisher="${pubAddr}"
        data-tags="${tagStr}">
</script>
${slotHtml}`;

  function copySnippet() {
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <RequirePublisher>
    <div className="nano-fade" style={{ maxWidth: 640 }}>
      <Link to="/publisher" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0", display: "flex", alignItems: "center", gap: 8 }}>
        SDK Setup
        <StepTooltip
          required
          side="below"
          summary="Final step — drop the snippet on your site so the extension can detect your ad slots."
          details={
            <>
              The snippet has two parameters: <code>data-publisher</code> (your address, used by the extension to
              attribute claims) and <code>data-tags</code> (the tag set the extension matches against active
              campaigns). Without this snippet your publisher registration is on-chain but invisible — no
              impressions can be served.
            </>
          }
        />
      </h1>

      <p style={{ color: "var(--text)", fontSize: 13, marginBottom: 20 }}>
        Add this snippet to your site. The DATUM browser extension will detect it and inject ads into the declared slot(s).
        The slot's format determines which per-format creative an advertiser's metadata serves to your visitors.
      </p>

      {/* Slot configuration */}
      <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          Slot configuration
          <StepTooltip
            required
            summary="Declares which ad sizes your page accepts."
            details={
              <>
                Advertisers can upload one creative image per IAB format. Your slot's declared format is what the extension
                matches against — if you declare <code>leaderboard</code> and the advertiser has a 728×90 image, that's
                the one served. Without a format declaration the slot defaults to <code>medium-rectangle</code>, which
                means leaderboard / skyscraper / mobile-banner per-format images on campaigns are never picked for your site.
              </>
            }
          />
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            onClick={() => setSlotMode("single")}
            className={slotMode === "single" ? "nano-btn nano-btn-accent" : "nano-btn"}
            style={{ padding: "5px 12px", fontSize: 12 }}
          >
            Single slot
          </button>
          <button
            type="button"
            onClick={() => setSlotMode("multi")}
            className={slotMode === "multi" ? "nano-btn nano-btn-accent" : "nano-btn"}
            style={{ padding: "5px 12px", fontSize: 12 }}
          >
            Multi-slot
          </button>
        </div>

        {slotMode === "single" && (
          <div>
            <label style={{ color: "var(--text-muted)", fontSize: 11, display: "block", marginBottom: 4 }}>
              Slot format
            </label>
            <select
              value={slotFormat}
              onChange={(e) => setSlotFormat(e.target.value as AdFormat)}
              className="nano-input"
              style={{ width: "100%", fontSize: 12, cursor: "pointer" }}
            >
              {(Object.entries(AD_FORMAT_SIZES) as [AdFormat, { w: number; h: number }][]).map(([fmt, sz]) => (
                <option key={fmt} value={fmt}>{fmt} — {sz.w}×{sz.h}</option>
              ))}
            </select>
            <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 4 }}>
              Sets <code>data-slot-format</code> on the slot div. Advertisers who upload a per-format creative for this size
              will have their image picked over any generic fallback.
            </div>
          </div>
        )}

        {slotMode === "multi" && (
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 6 }}>
              Each slot is rendered as <code>&lt;div data-datum-slot=&quot;...&quot; id=&quot;...&quot;&gt;</code>. The extension fills each slot independently with the best-matching campaign.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {multiSlots.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    value={s.id}
                    onChange={(e) => setMultiSlots((prev) => prev.map((x, j) => j === i ? { ...x, id: e.target.value } : x))}
                    className="nano-input"
                    placeholder="slot id (DOM)"
                    style={{ flex: 1, fontSize: 11, fontFamily: "var(--font-mono)" }}
                  />
                  <select
                    value={s.format}
                    onChange={(e) => setMultiSlots((prev) => prev.map((x, j) => j === i ? { ...x, format: e.target.value as AdFormat } : x))}
                    className="nano-input"
                    style={{ flex: 1, fontSize: 11, cursor: "pointer" }}
                  >
                    {(Object.entries(AD_FORMAT_SIZES) as [AdFormat, { w: number; h: number }][]).map(([fmt, sz]) => (
                      <option key={fmt} value={fmt}>{fmt} — {sz.w}×{sz.h}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setMultiSlots((prev) => prev.filter((_, j) => j !== i))}
                    className="nano-btn"
                    style={{ padding: "4px 8px", fontSize: 11, color: "var(--error)" }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setMultiSlots((prev) => [...prev, { id: `datum-slot-${prev.length + 1}`, format: "medium-rectangle" }])}
                className="nano-btn"
                style={{ padding: "4px 10px", fontSize: 11, alignSelf: "flex-start" }}
              >
                + Add slot
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ position: "relative", marginBottom: 20 }}>
        <pre className="nano-card" style={{
          padding: 16, color: "var(--text)", fontSize: 13, overflowX: "auto",
          fontFamily: "var(--font-mono)", lineHeight: 1.6,
        }}>
          {snippet}
        </pre>
        <button
          onClick={copySnippet}
          className={copied ? "nano-btn" : "nano-btn nano-btn-accent"}
          style={{
            position: "absolute", top: 10, right: 10,
            padding: "4px 10px", fontSize: 11,
            color: copied ? "var(--ok)" : undefined,
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Section title="How It Works">
          <ol style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.8, paddingLeft: 20 }}>
            <li>User visits your page with the DATUM extension installed</li>
            <li>Extension detects the SDK script tag and verifies authenticity via challenge-response</li>
            <li>Extension runs a Vickrey second-price auction across active campaigns matching your tags</li>
            <li>Winning ad is rendered into the declared slot(s) via Shadow DOM, sized to match the slot's declared format</li>
            <li>User engagement is tracked locally (dwell time, viewability, scroll depth)</li>
            <li>Qualifying impressions build a cryptographic hash chain submitted on-chain</li>
            <li>You earn DOT proportional to your take rate on every settled claim</li>
          </ol>
        </Section>

        <Section title="Publisher Relay (Optional)">
          <p style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.6 }}>
            By default, users submit their own claims and pay gas. To offer zero-gas claims for users,
            run a publisher relay that co-signs claim batches and submits them on-chain.
          </p>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <div className="nano-card" style={{ padding: "10px 14px", flex: 1 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Attestation Endpoint</div>
              <code style={{ color: "var(--text)", fontSize: 12 }}>POST /.well-known/datum-attest</code>
            </div>
            <div className="nano-card" style={{ padding: "10px 14px", flex: 1 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Relay Submit</div>
              <code style={{ color: "var(--text)", fontSize: 12 }}>POST /relay/submit</code>
            </div>
          </div>
        </Section>
      </div>
    </div>
    </RequirePublisher>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="nano-card" style={{ padding: 16 }}>
      <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 14, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}
