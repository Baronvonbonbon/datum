import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "../../context/WalletContext";
import { useContracts } from "../../hooks/useContracts";
import { tagLabel } from "@shared/tagDictionary";

export function SDKSetup() {
  const { address } = useWallet();
  const contracts = useContracts();
  const [tags, setTags] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!address || !contracts.targetingRegistry) return;
    contracts.targetingRegistry.getTags(address)
      .then((hashes: string[]) => {
        setTags(hashes.map((h: string) => tagLabel(h) ?? "").filter(Boolean));
      })
      .catch(() => {});
  }, [address]);

  const pubAddr = address ?? "0xYOUR_PUBLISHER_ADDRESS";
  const tagStr = tags.length > 0 ? tags.join(",") : "crypto-web3,en";

  const snippet = `<!-- DATUM Publisher SDK -->
<script src="https://datum.network/sdk/datum-sdk.js"
        data-publisher="${pubAddr}"
        data-tags="${tagStr}">
</script>
<div id="datum-ad-slot"></div>`;

  function copySnippet() {
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 640 }}>
      <Link to="/publisher" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>SDK Setup</h1>

      <p style={{ color: "var(--text)", fontSize: 13, marginBottom: 20 }}>
        Add this snippet to your site. The DATUM browser extension will detect it and inject ads into the <code style={{ color: "var(--accent)" }}>#datum-ad-slot</code> div.
      </p>

      <div style={{ position: "relative", marginBottom: 20 }}>
        <pre className="nano-card" style={{
          padding: 16, color: "var(--text)", fontSize: 13, overflowX: "auto",
          fontFamily: "monospace", lineHeight: 1.6,
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
            <li>Winning ad is rendered into <code style={{ color: "var(--accent)" }}>#datum-ad-slot</code> via Shadow DOM</li>
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
