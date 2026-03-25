import { useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "../../context/WalletContext";
import { useContracts } from "../../hooks/useContracts";
import { bitmaskToCategories } from "../../components/CategoryPicker";
import { useEffect } from "react";

export function SDKSetup() {
  const { address } = useWallet();
  const contracts = useContracts();
  const [categories, setCategories] = useState<number[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!address) return;
    contracts.publishers.getPublisher(address)
      .then((data: any) => {
        const bitmask = BigInt(data.categoryBitmask ?? data[2] ?? 0);
        setCategories([...bitmaskToCategories(bitmask)]);
      })
      .catch(() => {});
  }, [address]);

  const pubAddr = address ?? "0xYOUR_PUBLISHER_ADDRESS";
  const catStr = categories.length > 0 ? categories.join(",") : "1,6,26";

  const snippet = `<!-- DATUM Publisher SDK -->
<script src="https://datum.network/sdk/datum-sdk.js"
        data-publisher="${pubAddr}"
        data-categories="${catStr}">
</script>
<div id="datum-ad-slot"></div>`;

  function copySnippet() {
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <Link to="/publisher" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>SDK Setup</h1>

      <p style={{ color: "#666", fontSize: 13, marginBottom: 20 }}>
        Add this snippet to your site. The DATUM browser extension will detect it and inject ads into the <code style={{ color: "#a0a0ff" }}>#datum-ad-slot</code> div.
      </p>

      <div style={{ position: "relative", marginBottom: 20 }}>
        <pre style={{
          background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 6,
          padding: 16, color: "#c0d0c0", fontSize: 13, overflowX: "auto",
          fontFamily: "monospace", lineHeight: 1.6,
        }}>
          {snippet}
        </pre>
        <button
          onClick={copySnippet}
          style={{
            position: "absolute", top: 10, right: 10,
            padding: "4px 10px", background: copied ? "#0a2a0a" : "#1a1a3a",
            border: `1px solid ${copied ? "#2a5a2a" : "#4a4a8a"}`,
            borderRadius: 4, color: copied ? "#60c060" : "#a0a0ff",
            fontSize: 11, cursor: "pointer",
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Section title="How It Works">
          <ol style={{ color: "#666", fontSize: 13, lineHeight: 1.8, paddingLeft: 20 }}>
            <li>User visits your page with the DATUM extension installed</li>
            <li>Extension detects the SDK script tag and verifies authenticity via challenge-response</li>
            <li>Extension runs a Vickrey second-price auction across active campaigns matching your categories</li>
            <li>Winning ad is rendered into <code style={{ color: "#a0a0ff" }}>#datum-ad-slot</code> via Shadow DOM</li>
            <li>User engagement is tracked locally (dwell time, viewability, scroll depth)</li>
            <li>Qualifying impressions build a cryptographic hash chain submitted on-chain</li>
            <li>You earn DOT proportional to your take rate on every settled claim</li>
          </ol>
        </Section>

        <Section title="Publisher Relay (Optional)">
          <p style={{ color: "#666", fontSize: 13, lineHeight: 1.6 }}>
            By default, users submit their own claims and pay gas. To offer zero-gas claims for users,
            run a publisher relay that co-signs claim batches and submits them on-chain.
          </p>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <div style={{ padding: "10px 14px", background: "#111", border: "1px solid #1a1a2e", borderRadius: 6, flex: 1 }}>
              <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Attestation Endpoint</div>
              <code style={{ color: "#888", fontSize: 12 }}>POST /.well-known/datum-attest</code>
            </div>
            <div style={{ padding: "10px 14px", background: "#111", border: "1px solid #1a1a2e", borderRadius: 6, flex: 1 }}>
              <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Relay Submit</div>
              <code style={{ color: "#888", fontSize: 12 }}>POST /relay/submit</code>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, padding: 16 }}>
      <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 14, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}
