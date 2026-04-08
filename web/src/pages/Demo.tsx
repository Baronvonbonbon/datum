import { useEffect, useState } from "react";

const RELAY_URL = "https://relay.javcon.io";
const PUBLISHER_ADDRESS = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
const PUBLISHER_TAGS = "topic:crypto-web3,topic:defi,topic:computers-electronics,locale:en";

const TAG_DICTIONARY: Record<string, string[]> = {
  Topic: [
    "topic:arts-entertainment", "topic:autos-vehicles", "topic:beauty-fitness",
    "topic:books-literature", "topic:business-industrial", "topic:computers-electronics",
    "topic:finance", "topic:food-drink", "topic:gaming", "topic:health",
    "topic:hobbies-leisure", "topic:home-garden", "topic:internet-telecom",
    "topic:jobs-education", "topic:law-government", "topic:news",
    "topic:online-communities", "topic:people-society", "topic:pets-animals",
    "topic:real-estate", "topic:reference", "topic:science", "topic:shopping",
    "topic:sports", "topic:travel", "topic:crypto-web3", "topic:defi",
    "topic:nfts", "topic:polkadot", "topic:daos-governance",
  ],
  Locale: [
    "locale:en", "locale:en-US", "locale:en-GB", "locale:es", "locale:fr",
    "locale:de", "locale:ja", "locale:ko", "locale:zh", "locale:pt", "locale:ru",
  ],
  Platform: ["platform:desktop", "platform:mobile", "platform:tablet"],
  Audience: [
    "audience:developer", "audience:student", "audience:professional",
    "audience:creator", "audience:investor",
  ],
};

interface RelayStatus { online: boolean; uptime?: number }
interface SdkStatus { ready: boolean; version?: string; publisher?: string; tags?: string[] }
interface HandshakeStatus { done: boolean; sig?: string }

export function Demo() {
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [sdk, setSdk] = useState<SdkStatus>({ ready: false });
  const [handshake, setHandshake] = useState<HandshakeStatus>({ done: false });

  // Load SDK script with publisher config
  useEffect(() => {
    const existing = document.querySelector('script[data-datum-sdk]');
    if (existing) return; // already loaded (e.g. StrictMode double-mount)
    const script = document.createElement("script");
    script.src = "/datum-sdk.js";
    script.setAttribute("data-datum-sdk", "1");
    script.setAttribute("data-publisher", PUBLISHER_ADDRESS);
    script.setAttribute("data-relay", RELAY_URL);
    script.setAttribute("data-tags", PUBLISHER_TAGS);
    document.body.appendChild(script);
    return () => { script.remove(); };
  }, []);

  // SDK events
  useEffect(() => {
    const onReady = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      setSdk({ ready: true, version: d.version, publisher: d.publisher, tags: d.tags });
    };
    const onResponse = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      setHandshake({ done: true, sig: (d.signature || "").slice(0, 18) });
    };
    document.addEventListener("datum:sdk-ready", onReady);
    document.addEventListener("datum:response", onResponse);
    return () => {
      document.removeEventListener("datum:sdk-ready", onReady);
      document.removeEventListener("datum:response", onResponse);
    };
  }, []);

  // Relay heartbeat
  useEffect(() => {
    const check = () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      fetch(`${RELAY_URL}/health`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((data) => {
          clearTimeout(t);
          if (data?.ok) setRelay({ online: true, uptime: data.uptime });
          else setRelay({ online: false });
        })
        .catch(() => { clearTimeout(t); setRelay({ online: false }); });
    };
    check();
    const id = setInterval(check, 30000);
    return () => clearInterval(id);
  }, []);

  const relayLabel = relay === null
    ? "Checking..."
    : relay.online
      ? `Online (uptime ${Math.floor((relay.uptime ?? 0) / 3600)}h ${Math.floor(((relay.uptime ?? 0) % 3600) / 60)}m)`
      : "Offline";

  return (
    <div className="nano-fade" style={{ maxWidth: 800 }}>

      {/* ── Mission ───────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-strong)", letterSpacing: "0.08em", marginBottom: 12 }}>
          DATUM
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, maxWidth: 560, lineHeight: 1.7 }}>
          Decentralized advertising protocol on Polkadot Hub.
          On-chain settlement, privacy-preserving engagement, no intermediaries.
        </p>
      </div>

      <Section label="Mission">
        <p style={p}>
          The web already works. People publish content, others read it, and advertising
          connects the two. What isn't necessary is the centralized intermediary extracting
          rent from every interaction.
        </p>
        <p style={p}>
          DATUM explores how familiar web experiences — publishing, browsing, advertising,
          content discovery — can continue to function as they always have, but with on-chain
          settlement replacing opaque middlemen. Publishers keep their sites. Advertisers keep
          their campaigns. Users keep their data. The protocol handles settlement, governance,
          and trust — without a dedicated service provider in the middle.
        </p>
        <p style={{ ...p, marginBottom: 0 }}>
          No platform lock-in. No data extraction. Just the existing web, with transparent
          on-chain infrastructure underneath.
        </p>
      </Section>

      {/* ── How It Works ──────────────────────────────────────────────────── */}
      <Section label="How It Works">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginTop: 4 }}>
          {[
            { n: "1", title: "Publish", desc: "Add the SDK tag to your site. Declare your content tags and publisher address. No ad server needed." },
            { n: "2", title: "Campaign", desc: "Advertisers deposit DOT into on-chain escrow, set a CPM bid and required tags. Governance votes to activate or reject." },
            { n: "3", title: "Engage", desc: "Users browse with the DATUM extension. Impressions tracked locally with engagement scoring. Data never leaves the browser." },
            { n: "4", title: "Settle", desc: "Claim hash chains submitted on-chain. Revenue splits automatically — publisher, user, protocol. All verifiable." },
          ].map((step) => (
            <div key={step.n} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 20 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-strong)", fontFamily: "var(--font-mono)", marginBottom: 6 }}>{step.n}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)", marginBottom: 6 }}>{step.title}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{step.desc}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Architecture ──────────────────────────────────────────────────── */}
      <Section label="Protocol Architecture">
        <p style={p}>Seventeen smart contracts deployed on Polkadot Hub (PolkaVM / pallet-revive):</p>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {[
            ["PauseRegistry", "Emergency circuit breaker"],
            ["Timelock", "Governance-delayed parameter changes"],
            ["Publishers", "Publisher registration, take rates, blocklist/allowlists"],
            ["Campaigns", "Campaign lifecycle, metadata, status management"],
            ["BudgetLedger", "Campaign escrow, daily caps, settlement tracking"],
            ["PaymentVault", "Pull-payment vault (publisher/user/protocol balances)"],
            ["CampaignLifecycle", "Complete/terminate/expire, inactivity timeout"],
            ["AttestationVerifier", "Mandatory publisher co-signature for all settlements"],
            ["GovernanceV2", "Conviction-weighted voting (9 levels), anti-grief termination protection"],
            ["GovernanceSlash", "Symmetric slash on losing voters"],
            ["Settlement", "Blake2-256 hash-chain validation, three-way revenue split"],
            ["Relay", "EIP-712 gasless settlement with publisher co-signature"],
            ["ZKVerifier", "Engagement proof verification (stub, Groth16 post-alpha)"],
            ["TargetingRegistry", "Tag-based publisher/campaign targeting (AND-logic matching)"],
            ["CampaignValidator", "Campaign creation validation satellite"],
            ["ClaimValidator", "Claim validation satellite (Blake2-256 on PolkaVM)"],
            ["GovernanceHelper", "Slash computation + dust guard satellite"],
          ].map(([name, desc]) => (
            <li key={name} style={{ padding: "3px 0", fontSize: 13, color: "var(--text)" }}>
              <span style={{ color: "var(--text-strong)", fontFamily: "var(--font-mono)" }}>{name}</span>
              <span style={{ color: "var(--text-muted)" }}> — {desc}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* ── Live Ad Slot ──────────────────────────────────────────────────── */}
      <Section label="Live Ad Slot">
        <p style={p}>
          This page runs the DATUM Publisher SDK with Diana's testnet publisher address.
          If you have the DATUM extension installed and connected to Paseo, an ad from an
          active campaign will appear below.
        </p>
        <div style={{
          border: "1px dashed rgba(255,255,255,0.15)", borderRadius: 8,
          padding: 20, margin: "16px 0", minHeight: 80,
        }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
            DATUM Ad Slot
          </div>
          <div id="datum-ad-slot" />
        </div>
        <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 14px", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {[
            ["Publisher Relay", relay === null ? "Checking..." : relayLabel, relay === null ? "var(--warn)" : relay.online ? "var(--ok)" : "var(--error)"],
            ["SDK", sdk.ready ? `Ready (v${sdk.version})` : "Loading...", sdk.ready ? "var(--ok)" : "var(--warn)"],
            ["Publisher", sdk.publisher ?? "—", "var(--text-muted)"],
            ["Tags", sdk.tags?.join(", ") ?? "—", "var(--text-muted)"],
            ["Handshake", handshake.done ? `Complete (sig: ${handshake.sig}...)` : "Pending", handshake.done ? "var(--ok)" : "var(--warn)"],
          ].map(([label, value, color]) => (
            <div key={label} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
              <span style={{ color: "var(--text)", minWidth: 140 }}>{label}</span>
              <span style={{ color }}>{value}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Publisher Integration ──────────────────────────────────────────── */}
      <Section label="Publisher Integration">
        <p style={p}>Add the SDK to any page with two lines:</p>
        <pre style={pre}>{`<script src="https://your-cdn/datum-sdk.js"
  data-tags="topic:crypto-web3,topic:defi,locale:en"
  data-publisher="0xYOUR_PUBLISHER_ADDRESS"
  data-relay="https://your-relay.example.com"
  data-excluded-tags="topic:gambling,topic:adult"></script>
<div id="datum-ad-slot"></div>`}</pre>
        <p style={p}>
          <code style={code}>data-tags</code> declares which tags describe your site
          (comma-separated <code style={code}>dimension:value</code> strings from the tag dictionary below).
          Short-form values are also accepted — <code style={code}>"defi"</code> resolves to <code style={code}>"topic:defi"</code>.{" "}
          <code style={code}>data-publisher</code> is your registered on-chain address.{" "}
          <code style={code}>data-relay</code> is your publisher relay endpoint.{" "}
          <code style={code}>data-excluded-tags</code> is an optional publisher-side tag blocklist.
        </p>
        <p style={{ ...p, marginBottom: 0 }}>
          The extension matches campaigns by tag overlap (AND-logic), filters against excluded tags,
          runs a Vickrey auction weighted by user interest profile, and injects the winning ad into
          the slot.
        </p>
      </Section>

      {/* ── Tag Dictionary ────────────────────────────────────────────────── */}
      <Section label="Tag Dictionary">
        <p style={p}>
          Publishers and campaigns declare targeting using tags from four dimensions.
          Tags are <code style={code}>keccak256("dimension:value")</code> hashes stored on-chain
          via the TargetingRegistry contract. Publishers can set up to 32 tags; campaigns can
          require up to 8. A campaign matches a publisher when the publisher has{" "}
          <em>all</em> of the campaign's required tags (AND-logic). Custom tags beyond the
          dictionary are supported.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10, marginTop: 12 }}>
          {Object.entries(TAG_DICTIONARY).map(([dim, tags]) => (
            <div key={dim} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
                {dim} ({tags.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {tags.map((tag) => (
                  <span key={tag} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)", borderRadius: 3, fontSize: 11, padding: "2px 6px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Publisher Relay ───────────────────────────────────────────────── */}
      <Section label="Publisher Relay">
        <p style={p}>
          Publishers run a relay that co-signs user claim batches (EIP-712) and submits them
          on-chain via <code style={code}>DatumRelay.settleClaimsFor()</code>. The relay pays
          gas so users don't need to — the publisher is reimbursed from the campaign budget's
          take-rate share.
        </p>

        <h3 style={h3}>Demo Relay</h3>
        <p style={p}>This page connects to Diana's testnet relay. Each publisher declares their relay via <code style={code}>data-relay</code>.</p>
        <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 14px", fontFamily: "var(--font-mono)", fontSize: 12, margin: "8px 0" }}>
          <div style={{ padding: "2px 0" }}><span style={{ color: "var(--text)" }}>Network: </span><span style={{ color: "var(--text-muted)" }}>Paseo Testnet (Chain ID 420420417)</span></div>
          <div style={{ padding: "2px 0" }}><span style={{ color: "var(--text)" }}>Endpoints:</span></div>
          {[
            ["POST", "/.well-known/datum-attest", "publisher co-signature"],
            ["POST", "/relay/submit", "queue signed claim batches"],
            ["GET",  "/relay/status", "queue depth + stats"],
            ["GET",  "/health", "heartbeat"],
          ].map(([method, path, desc]) => (
            <div key={path} style={{ paddingLeft: 16, padding: "1px 0 1px 16px", color: "var(--text-muted)" }}>
              <span style={{ color: "var(--text)" }}>{method}</span> {path} — {desc}
            </div>
          ))}
        </div>

        <h3 style={h3}>Security</h3>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {[
            ["No key exposure", "Users sign locally via EIP-712 — only the signature is sent"],
            ["Signature verification", "Every signature verified before queuing — forgeries rejected"],
            ["Rate limiting", "Per-IP sliding-window (10 attestations/min, 5 submits/min)"],
            ["HTTPS only", "Extension rejects HTTP relay URLs for non-local domains"],
          ].map(([title, desc]) => (
            <li key={title} style={{ padding: "3px 0", fontSize: 13, color: "var(--text)" }}>
              <span style={{ color: "var(--text-strong)" }}>{title}</span>
              <span style={{ color: "var(--text-muted)" }}> — {desc}</span>
            </li>
          ))}
        </ul>

        <h3 style={h3}>Relay Downtime</h3>
        <p style={p}>
          If the publisher relay is offline, claims still accumulate in the extension and can be
          submitted when the relay comes back online, or the user can submit claims directly
          on-chain. No claims or earnings are lost due to relay downtime.
        </p>

        <h3 style={h3}>Run Your Own</h3>
        <p style={p}>Reference implementation: <a href="https://github.com/Baronvonbonbon/datum/tree/main/docs/relay-bot-template" style={{ color: "var(--text)", textDecoration: "underline", textDecorationColor: "var(--border-hover)" }}><code style={code}>docs/relay-bot-template/</code></a></p>
        <pre style={pre}>{`# Copy template
cp -r docs/relay-bot-template my-relay && cd my-relay
npm install

# Configure
export PUBLISHER_KEY="0xYOUR_PRIVATE_KEY"
export RPC_URL="https://eth-rpc-testnet.polkadot.io/"

# Run
node relay-bot.mjs

# Expose publicly via reverse proxy, tunnel, or cloud hosting`}</pre>
      </Section>

      {/* ── Resources ─────────────────────────────────────────────────────── */}
      <Section label="Resources">
        <ul style={{ listStyle: "none", padding: 0 }}>
          {[
            ["GitHub Repository", "https://github.com/Baronvonbonbon/datum"],
            ["Publisher Relay Template", "https://github.com/Baronvonbonbon/datum/tree/main/docs/relay-bot-template"],
            ["Paseo Explorer", "https://blockscout-testnet.polkadot.io/"],
            ['Testnet Faucet (select "Paseo")', "https://faucet.polkadot.io/"],
          ].map(([label, href]) => (
            <li key={href} style={{ padding: "3px 0", fontSize: 13 }}>
              <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text)", textDecoration: "underline", textDecorationColor: "var(--border-hover)" }}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </Section>

    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="nano-fade" style={{ marginBottom: 24 }}>
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "20px 24px" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14, fontFamily: "var(--font-mono)" }}>
          {label}
        </div>
        {children}
      </div>
    </div>
  );
}

const p: React.CSSProperties = { color: "var(--text)", fontSize: 14, marginBottom: 10, lineHeight: 1.7 };
const h3: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--text-strong)", margin: "16px 0 6px" };
const pre: React.CSSProperties = {
  background: "var(--bg-surface)", border: "1px solid var(--border)",
  borderRadius: 6, padding: 14, overflow: "auto",
  fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)",
  lineHeight: 1.6, margin: "10px 0", whiteSpace: "pre",
};
const code: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)",
  borderRadius: 3, padding: "1px 5px",
  fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-strong)",
};
