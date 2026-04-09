import { useEffect, useRef, useState } from "react";
import { ExtensionApplet } from "../components/ExtensionApplet";
import { runContentBridge, BridgeStatus } from "../lib/contentBridge";
import { getRelaySignerAddress, importRelaySignerKey, getCampaignCount, repollCampaigns } from "../lib/extensionDaemon";

const RELAY_URL = "https://relay.javcon.io";
const DEFAULT_PUBLISHER = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
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
  const [publisherAddress, setPublisherAddress] = useState(DEFAULT_PUBLISHER);
  const [publisherInput, setPublisherInput] = useState(DEFAULT_PUBLISHER);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ step: "idle" });
  const [daemonReady, setDaemonReady] = useState(false);
  const sdkScriptRef = useRef<HTMLScriptElement | null>(null);
  const [relaySignerAddress, setRelaySignerAddress] = useState<string>("");
  const [relayKeyInput, setRelayKeyInput] = useState("");
  const [relayKeyError, setRelayKeyError] = useState<string | null>(null);
  const [sdkTagsInput, setSdkTagsInput] = useState(PUBLISHER_TAGS);
  const [campaignCount, setCampaignCount] = useState<number | null>(null);
  const [repolling, setRepolling] = useState(false);

  // Load publisher SDK
  useEffect(() => {
    const existing = document.querySelector('script[data-datum-sdk]') as HTMLScriptElement | null;
    if (existing) { sdkScriptRef.current = existing; return; }
    const script = document.createElement("script");
    script.src = "/datum-sdk.js";
    script.setAttribute("data-datum-sdk", "1");
    script.setAttribute("data-publisher", publisherAddress);
    script.setAttribute("data-relay", RELAY_URL);
    script.setAttribute("data-tags", PUBLISHER_TAGS);
    document.body.appendChild(script);
    sdkScriptRef.current = script;
    return () => { script.remove(); sdkScriptRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // When daemon + SDK are both ready, auto-run the bridge once
  useEffect(() => {
    if (!daemonReady || !sdk.ready) return;
    runContentBridge(publisherAddress, setBridgeStatus).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonReady, sdk.ready]);

  // Relay heartbeat
  useEffect(() => {
    const check = () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      fetch(`${RELAY_URL}/health`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((data) => { clearTimeout(t); setRelay(data?.ok ? { online: true, uptime: data.uptime } : { online: false }); })
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
    <div className="nano-fade" style={{ maxWidth: 820 }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-strong)", letterSpacing: "0.08em", marginBottom: 12 }}>
          DATUM
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, maxWidth: 560, lineHeight: 1.7 }}>
          Decentralized advertising protocol on Polkadot Hub.
          On-chain settlement, privacy-preserving engagement, no intermediaries.
        </p>
      </div>

      {/* ── How It Works ───────────────────────────────────────────────────── */}
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

      {/* ── Interactive demo ───────────────────────────────────────────────── */}
      <Section label="Try It — No Install Required">
        <p style={p}>
          The panel below runs the full extension logic directly in your browser.
          Create a test wallet, browse the claim queue, adjust your ad filters,
          and watch campaigns load from Paseo testnet — all without installing anything.
        </p>

        <div style={{
          display: "flex",
          gap: 24,
          alignItems: "flex-start",
          flexWrap: "wrap",
          marginTop: 16,
        }}>
          {/* Left — extension popup */}
          <div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
              User View — Extension Popup
            </div>
            <ExtensionApplet onDaemonReady={() => {
              setDaemonReady(true);
              setRelaySignerAddress(getRelaySignerAddress());
              getCampaignCount().then(setCampaignCount);
            }} />
          </div>

          {/* Right — publisher view */}
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
              Publisher View — Ad Slot
            </div>

            {/* Publisher config + auction trigger */}
            <div style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
                SDK Configuration
              </div>

              {/* Publisher address */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>data-publisher</div>
                <input
                  value={publisherInput}
                  onChange={(e) => setPublisherInput(e.target.value)}
                  style={inputStyle}
                  placeholder="0x..."
                />
              </div>

              {/* SDK tags */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>data-tags</div>
                <input
                  value={sdkTagsInput}
                  onChange={(e) => setSdkTagsInput(e.target.value)}
                  style={inputStyle}
                  placeholder="topic:crypto-web3,topic:defi,locale:en"
                />
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.4 }}>
                  Comma-separated tags. Campaigns match when the publisher has all of the campaign's required tags.
                  Use the Tag Dictionary below for valid values.
                </div>
              </div>

              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => {
                    if (sdkScriptRef.current) {
                      sdkScriptRef.current.setAttribute("data-publisher", publisherInput);
                      sdkScriptRef.current.setAttribute("data-tags", sdkTagsInput);
                    }
                    setPublisherAddress(publisherInput);
                    runContentBridge(publisherInput, setBridgeStatus).catch(console.error);
                  }}
                  disabled={!daemonReady}
                  style={{
                    flex: 1,
                    background: daemonReady ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)",
                    border: "1px solid var(--border)", borderRadius: 4,
                    color: daemonReady ? "var(--text)" : "var(--text-muted)",
                    fontFamily: "var(--font-mono)", fontSize: 11, padding: "6px 10px",
                    cursor: daemonReady ? "pointer" : "not-allowed",
                  }}
                >
                  {daemonReady
                    ? `Run Auction${campaignCount != null ? ` (${campaignCount} campaigns)` : ""}`
                    : "Loading campaigns from Paseo..."}
                </button>
                {daemonReady && (
                  <button
                    onClick={async () => {
                      setRepolling(true);
                      try {
                        const n = await repollCampaigns();
                        setCampaignCount(n);
                      } finally {
                        setRepolling(false);
                      }
                    }}
                    disabled={repolling}
                    title="Clear poller cache and re-fetch all campaigns from chain"
                    style={{
                      background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)",
                      borderRadius: 4, color: repolling ? "var(--text-muted)" : "var(--text)",
                      fontFamily: "var(--font-mono)", fontSize: 11, padding: "6px 8px",
                      cursor: repolling ? "not-allowed" : "pointer", whiteSpace: "nowrap",
                    }}
                  >
                    {repolling ? "…" : "↺"}
                  </button>
                )}
              </div>
            </div>

            {/* Auction status */}
            {bridgeStatus.step !== "idle" && (
              <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: 11, marginBottom: 12 }}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 6 }}>Auction Status</div>
                {[
                  ["Step", stepLabel(bridgeStatus.step), stepColor(bridgeStatus.step)],
                  ...(bridgeStatus.totalCampaigns != null ? [["Campaigns", `${bridgeStatus.activeCampaigns} active / ${bridgeStatus.totalCampaigns} total`, "var(--text-muted)"]] : []),
                  ...(bridgeStatus.matchedPool != null ? [["Matched", `${bridgeStatus.matchedPool} in pool`, bridgeStatus.matchedPool > 0 ? "var(--ok)" : "var(--warn)"]] : []),
                  ...(bridgeStatus.campaignId ? [["Winner", `#${bridgeStatus.campaignId}`, "var(--ok)"]] : []),
                  ...(bridgeStatus.mechanism ? [["Mechanism", bridgeStatus.mechanism, "var(--text-muted)"]] : []),
                  ...(bridgeStatus.clearingCpmPlanck ? [["Clearing CPM", formatPlanck(bridgeStatus.clearingCpmPlanck), "var(--text-muted)"]] : []),
                  ...(bridgeStatus.participants != null ? [["Participants", String(bridgeStatus.participants), "var(--text-muted)"]] : []),
                  ...(bridgeStatus.error ? [["Error", bridgeStatus.error, "var(--error)"]] : []),
                ].map(([label, value, color]) => (
                  <div key={label} style={{ display: "flex", gap: 8, padding: "1px 0" }}>
                    <span style={{ color: "var(--text)", minWidth: 90 }}>{label}</span>
                    <span style={{ color }}>{value}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{
              border: "1px dashed rgba(255,255,255,0.12)", borderRadius: 8,
              padding: 20, marginBottom: 12, minHeight: 80,
            }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
                datum-ad-slot
              </div>
              <div id="datum-ad-slot" />
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.15)", marginTop: 8 }}>
                Ad appears here when extension is installed and connected.
                The applet on the left simulates that experience in-page.
              </div>
            </div>

            {/* SDK status */}
            <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 14px", fontFamily: "var(--font-mono)", fontSize: 12, marginBottom: 12 }}>
              {[
                ["Relay",      relayLabel, relay === null ? "var(--warn)" : relay.online ? "var(--ok)" : "var(--error)"],
                ["SDK",        sdk.ready ? `Ready (v${sdk.version})` : "Loading…", sdk.ready ? "var(--ok)" : "var(--warn)"],
                ["Publisher",  sdk.publisher ? sdk.publisher.slice(0, 10) + "…" : "—", "var(--text-muted)"],
                ["Handshake",  handshake.done ? `Complete (${handshake.sig}…)` : "Pending", handshake.done ? "var(--ok)" : "var(--warn)"],
              ].map(([label, value, color]) => (
                <div key={label} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
                  <span style={{ color: "var(--text)", minWidth: 90 }}>{label}</span>
                  <span style={{ color }}>{value}</span>
                </div>
              ))}
            </div>

            {/* Relay signer panel */}
            <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
                In-Page Relay Signer
              </div>
              {relaySignerAddress ? (
                <>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ok)", marginBottom: 6, wordBreak: "break-all" }}>
                    {relaySignerAddress}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.5 }}>
                    This wallet co-signs your impression claims in-browser.
                    Register this address as your campaign's relay signer on-chain to earn attestation rewards.
                    The key is stored locally and never sent anywhere.
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      value={relayKeyInput}
                      onChange={(e) => { setRelayKeyInput(e.target.value); setRelayKeyError(null); }}
                      placeholder="Paste a private key to use your own signer"
                      style={{
                        flex: 1, background: "var(--bg-surface)", border: `1px solid ${relayKeyError ? "var(--error)" : "var(--border)"}`,
                        borderRadius: 4, padding: "4px 8px", color: "var(--text)",
                        fontFamily: "var(--font-mono)", fontSize: 11, outline: "none", minWidth: 0,
                      }}
                    />
                    <button
                      onClick={() => {
                        if (!relayKeyInput.trim()) return;
                        const ok = importRelaySignerKey(relayKeyInput.trim());
                        if (ok) {
                          setRelaySignerAddress(getRelaySignerAddress());
                          setRelayKeyInput("");
                          setRelayKeyError(null);
                        } else {
                          setRelayKeyError("Invalid key");
                        }
                      }}
                      style={{
                        background: "rgba(255,255,255,0.06)", border: "1px solid var(--border)",
                        borderRadius: 4, color: "var(--text)", fontFamily: "var(--font-mono)",
                        fontSize: 11, padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap",
                      }}
                    >
                      Import
                    </button>
                  </div>
                  {relayKeyError && (
                    <div style={{ fontSize: 11, color: "var(--error)", marginTop: 4 }}>{relayKeyError}</div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Starting daemon...</div>
              )}
            </div>

            {/* What to try */}
            <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
                What to try
              </div>
              {[
                ["Set up wallet", "Generate or import a Paseo testnet key"],
                ["Claims tab", "See pending impression claims and submit on-chain"],
                ["Earnings tab", "Check your withdrawable balance"],
                ["Filters tab", "Toggle ad topic categories and opt-out of campaigns"],
                ["Settings tab", "Configure RPC endpoint and view interest profile"],
              ].map(([title, desc]) => (
                <div key={title} style={{ padding: "4px 0", fontSize: 12 }}>
                  <span style={{ color: "var(--text-strong)" }}>{title}</span>
                  <span style={{ color: "var(--text-muted)" }}> — {desc}</span>
                </div>
              ))}
            </div>
          </div>
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
          <code style={code}>data-tags</code> declares which tags describe your site.{" "}
          <code style={code}>data-publisher</code> is your registered on-chain address.{" "}
          <code style={code}>data-relay</code> is your publisher relay endpoint.{" "}
          <code style={code}>data-excluded-tags</code> is an optional publisher-side tag blocklist.
        </p>
      </Section>

      {/* ── Tag Dictionary ────────────────────────────────────────────────── */}
      <Section label="Tag Dictionary">
        <p style={p}>
          Publishers and campaigns declare targeting using tags from four dimensions.
          Tags are <code style={code}>keccak256("dimension:value")</code> hashes stored on-chain.
          Publishers can set up to 32 tags; campaigns can require up to 8.
          A campaign matches a publisher when the publisher has <em>all</em> of the campaign's
          required tags (AND-logic).
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

function stepLabel(step: string): string {
  return ({
    idle: "Idle",
    detecting: "Detecting SDK...",
    matching: "Matching campaigns...",
    auction: "Running auction...",
    handshake: "Handshaking...",
    injected: "Ad injected",
    "house-ad": "House ad (no match)",
    "no-match": "No campaigns",
    error: "Error",
  } as Record<string, string>)[step] ?? step;
}

function stepColor(step: string): string {
  if (step === "injected") return "var(--ok)";
  if (step === "error") return "var(--error)";
  if (step === "house-ad" || step === "no-match") return "var(--warn)";
  return "var(--text-muted)";
}

function formatPlanck(planck: string): string {
  try {
    const dot = Number(BigInt(planck)) / 1e10;
    return `${dot.toFixed(4)} DOT`;
  } catch { return planck; }
}

const inputStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg-surface)", border: "1px solid var(--border)",
  borderRadius: 4, padding: "5px 8px", color: "var(--text)",
  fontFamily: "var(--font-mono)", fontSize: 11, outline: "none",
  boxSizing: "border-box",
};

const p: React.CSSProperties = { color: "var(--text)", fontSize: 14, marginBottom: 10, lineHeight: 1.7 };
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
