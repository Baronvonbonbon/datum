import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useBlock } from "../../hooks/useBlock";
import { useSettings } from "../../context/SettingsContext";
import { getCurrencySymbol, getNetworkDisplayName } from "@shared/networks";
import { queryFilterBounded } from "@shared/eventQuery";

interface Stats {
  totalCampaigns: number;
  activeCampaigns: number;
  pendingCampaigns: number;
  totalImpressions: number;
  paused: boolean;
}

export function Overview() {
  const contracts = useContracts();
  const { blockNumber, connected } = useBlock();
  const { settings } = useSettings();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sym = getCurrencySymbol(settings.network);

  useEffect(() => {
    if (!settings.contractAddresses.campaigns) return;
    load();
  }, [settings.contractAddresses.campaigns]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextId, paused] = await Promise.all([
        contracts.campaigns.nextCampaignId().catch(() => 0n),
        contracts.pauseRegistry.paused().catch(() => false),
      ]);

      const total = Number(nextId);
      let active = 0;
      let pending = 0;

      const scanCount = Math.min(total, 50);
      const ids = Array.from({ length: scanCount }, (_, i) => total - 1 - i).filter((i) => i >= 0);

      await Promise.all(ids.map(async (id) => {
        try {
          const c = await contracts.campaigns.getCampaignForSettlement(BigInt(id));
          const status = Number(c[0]);
          if (status === 1) active++;
          if (status === 0) pending++;
        } catch { /* skip */ }
      }));

      // Count total impressions from ClaimSettled events
      let totalImpressions = 0;
      try {
        const filter = contracts.settlement.filters.ClaimSettled();
        const logs = await queryFilterBounded(contracts.settlement, filter);
        totalImpressions = logs.reduce((s: number, log: any) => s + Number(log.args?.impressionCount ?? 0), 0);
      } catch { /* settlement not configured */ }

      setStats({ totalCampaigns: total, activeCampaigns: active, pendingCampaigns: pending, totalImpressions, paused: Boolean(paused) });
    } catch (err) {
      setError(String(err).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 800 }}>
      {/* Hero */}
      <div className="nano-fade" style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, marginBottom: 6 }}>DATUM Protocol</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Decentralized advertising on Polkadot Hub — on-chain settlement, no intermediaries.
        </p>
      </div>

      {/* Status banner — always rendered, content swaps */}
      <div className="nano-fade" style={{ marginBottom: 28 }}>
        {stats ? (
          <div className="nano-info" style={{
            borderColor: stats.paused ? "rgba(252,165,165,0.3)" : "rgba(110,231,183,0.3)",
            background: stats.paused ? "rgba(252,165,165,0.06)" : "rgba(110,231,183,0.06)",
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%", display: "inline-block",
              background: stats.paused ? "var(--error)" : "var(--ok)",
              boxShadow: stats.paused ? "none" : "0 0 6px var(--ok)",
            }} />
            <span style={{ color: stats.paused ? "var(--error)" : "var(--ok)", fontWeight: 600 }}>
              Protocol {stats.paused ? "Paused" : "Active"}
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              · {getNetworkDisplayName(settings.network)} · {connected ? `block #${blockNumber}` : "connecting…"}
            </span>
          </div>
        ) : error ? (
          <div className="nano-info nano-info--error">
            {settings.contractAddresses.campaigns
              ? `Error: ${error}`
              : <>No contracts configured. Go to <Link to="/settings">Settings</Link>.</>}
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
        )}
      </div>

      {/* Stat cards — always rendered, values swap */}
      <div className="nano-fade" style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
        gap: 12,
        marginBottom: 36,
      }}>
        <StatCard label="Total Campaigns" value={stats?.totalCampaigns ?? "—"} />
        <StatCard label="Active" value={stats?.activeCampaigns ?? "—"} color={stats ? "var(--ok)" : undefined} />
        <StatCard label="Pending Votes" value={stats?.pendingCampaigns ?? "—"} color={stats ? "var(--warn)" : undefined} />
        <StatCard label="Impressions Settled" value={stats ? stats.totalImpressions.toLocaleString() : "—"} color={stats && stats.totalImpressions > 0 ? "var(--ok)" : undefined} />
        <StatCard label="Network" value={getNetworkDisplayName(settings.network)} />
      </div>

      {/* How Does This Work */}
      <HowItWorks />

      {/* Browse */}
      <div className="nano-fade" style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Browse</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <QuickLink to="/campaigns" label="Campaigns" desc="Browse all campaigns" />
          <QuickLink to="/publishers" label="Publishers" desc="Registered publisher directory" />
          <QuickLink to="/governance" label="Governance" desc="Vote on active campaigns" />
        </div>
      </div>

      {/* Participate */}
      <div className="nano-fade">
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Participate</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <QuickLink to="/advertiser/create" label="Create Campaign" desc="Launch a new ad campaign" />
          <QuickLink to="/publisher/register" label="Become a Publisher" desc="Register and serve ads" />
          <QuickLink to="/governance" label="Vote" desc="Stake DOT to approve campaigns" />
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="nano-card" style={{ padding: "16px 18px" }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
      <div style={{ color: color ?? "var(--text-strong)", fontSize: 22, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function QuickLink({ to, label, desc }: { to: string; label: string; desc: string }) {
  return (
    <Link to={to} style={{ textDecoration: "none" }}>
      <div
        className="nano-card"
        style={{ padding: "12px 16px", minWidth: 148, cursor: "pointer" }}
      >
        <div style={{ color: "var(--text-strong)", fontWeight: 600, fontSize: 13, marginBottom: 3 }}>{label} →</div>
        <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{desc}</div>
      </div>
    </Link>
  );
}

// ── "How Does This Work?" expandable role walkthroughs ────────────────────────

interface RoleWalkthrough {
  icon: string;
  role: string;
  tagline: string;
  color: string;
  steps: string[];
  cta: { label: string; to: string };
}

const WALKTHROUGHS: RoleWalkthrough[] = [
  {
    icon: "👤",
    role: "I'm a User",
    tagline: "I browse the web and get paid for my attention.",
    color: "var(--ok)",
    steps: [
      "Install the DATUM browser extension. It comes with a built-in wallet — no MetaMask needed.",
      "Browse the web like you normally do. When you visit a site running the DATUM SDK, the extension quietly matches you with a relevant ad campaign.",
      "Ads appear inline on the page (or as a subtle overlay). Your browsing data never leaves your device — only a cryptographic receipt that says \"yes, I saw this.\"",
      "The extension tracks your impressions locally and builds hash-chain claims. Think of it like a tamper-proof receipt book.",
      "When you're ready, hit Submit Claims from the extension (or let auto-submit handle it). The smart contract verifies your receipts and credits your balance.",
      "Withdraw your earnings anytime from the Earnings tab. The DOT goes straight to your wallet — no middlemen, no minimum thresholds.",
    ],
    cta: { label: "Get the Extension", to: "/settings" },
  },
  {
    icon: "📢",
    role: "I'm an Advertiser",
    tagline: "I want real humans to see my ads, and I want proof it happened.",
    color: "var(--accent)",
    steps: [
      "Connect your wallet on this web app. You'll need some PAS (testnet DOT) — grab some from the faucet if you're on Paseo.",
      "Head to the Advertiser section and create a campaign. Set your budget, daily spend cap, and bid CPM (cost per 1,000 impressions).",
      "Choose whether to target a specific publisher or go open (any publisher whose categories match can serve your ad).",
      "Write your ad creative — title, body, call-to-action button, and landing URL. It gets pinned to IPFS so it's tamper-proof and decentralized.",
      "Your campaign starts in Pending status. Governance voters review your creative and vote to activate it. Think of it as community-powered ad approval.",
      "Once activated, your ads start appearing to real users. Settlement happens on-chain — you can see exactly where every planck went in the campaign detail page.",
      "When your budget runs out (or you're done), complete the campaign and any remaining balance is refunded to your wallet.",
    ],
    cta: { label: "Create a Campaign", to: "/advertiser/create" },
  },
  {
    icon: "🌐",
    role: "I'm a Publisher",
    tagline: "I have a website and I'd like to earn by serving relevant ads to my visitors.",
    color: "var(--warn)",
    steps: [
      "Register as a publisher from the Publisher section. Pick your take rate (the percentage you keep from each impression — between 30% and 80%).",
      "Select your content categories from 26 options (tech, finance, gaming, etc.). This tells the system which campaigns are a good fit for your audience.",
      "Copy the SDK snippet and add it to your site — it's one script tag and one div. That's it. No ad server, no tracking pixels, no cookie banners.",
      "When a DATUM user visits your site, the extension and your SDK do a cryptographic handshake to prove the impression is real. Two-party attestation, no trust required.",
      "As impressions settle on-chain, your share accumulates in the PaymentVault. Withdraw whenever you want from the Publisher Earnings page.",
      "Want more control? Enable your per-publisher allowlist to approve specific advertisers, or let the open marketplace match you automatically.",
    ],
    cta: { label: "Register as Publisher", to: "/publisher/register" },
  },
  {
    icon: "⚖️",
    role: "I'm a Governance Voter",
    tagline: "I review campaigns and help keep the network honest. (And earn rewards for it.)",
    color: "var(--accent)",
    steps: [
      "Browse pending campaigns on the Governance page. Each one shows the ad creative, bid, and advertiser address.",
      "Found one you trust? Vote Aye with some DOT. Choose your conviction level (0–8) — higher conviction means more voting power but a longer lockup. Conviction 0 has no lockup at all, so you can dip a toe in risk-free.",
      "Think a campaign is sketchy? Vote Nay. If enough weighted nay votes hit the termination quorum, the campaign gets shut down and 10% of the budget goes to nay voters as a reward.",
      "Once a campaign has enough aye votes above quorum, anyone can call Evaluate to activate it. You can do this from the Governance dashboard — it's a public service action.",
      "After a campaign ends, the losing side's voters pay a 10% slash. Winners can claim their share of the slash pool. Fortune favors the diligent reviewer.",
      "Your vote stake unlocks after your chosen lockup period. Conviction 1 is just one day. Conviction 8 is a full year — but with 21x voting power. Choose wisely.",
    ],
    cta: { label: "Start Voting", to: "/governance" },
  },
];

function HowItWorks() {
  const [open, setOpen] = useState<number | null>(null);

  const toggle = useCallback((idx: number) => {
    setOpen((prev) => prev === idx ? null : idx);
  }, []);

  return (
    <div className="nano-fade" style={{ marginBottom: 32 }}>
      <h2 style={{
        fontSize: 14, fontWeight: 600, color: "var(--text-muted)",
        letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12,
      }}>
        How Does This Work?
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {WALKTHROUGHS.map((w, i) => (
          <RoleTile key={w.role} walkthrough={w} isOpen={open === i} onToggle={() => toggle(i)} />
        ))}
      </div>
    </div>
  );
}

function RoleTile({ walkthrough: w, isOpen, onToggle }: {
  walkthrough: RoleWalkthrough;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="nano-card" style={{
      borderColor: isOpen ? w.color : undefined,
      transition: "border-color 300ms ease-in-out",
    }}>
      {/* Header — always visible, clickable */}
      <button
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 12,
          width: "100%", padding: "14px 16px",
          background: "none", border: "none", cursor: "pointer",
          textAlign: "left", fontFamily: "inherit",
        }}
      >
        <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>{w.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--text-strong)", fontWeight: 600, fontSize: 14 }}>{w.role}</div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>{w.tagline}</div>
        </div>
        <span style={{
          color: "var(--text-muted)", fontSize: 12, flexShrink: 0,
          transition: "transform 300ms ease-in-out",
          transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
          display: "inline-block",
        }}>
          ▶
        </span>
      </button>

      {/* Expandable body */}
      <div style={{
        maxHeight: isOpen ? 600 : 0,
        overflow: "hidden",
        transition: "max-height 400ms ease-in-out",
      }}>
        <div style={{ padding: "0 16px 16px 50px" }}>
          <ol style={{
            listStyle: "none", counterReset: "step", padding: 0, margin: 0,
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            {w.steps.map((step, i) => (
              <li key={i} style={{
                counterIncrement: "step",
                display: "flex", gap: 10, alignItems: "flex-start",
                fontSize: 13, color: "var(--text)", lineHeight: 1.55,
              }}>
                <span style={{
                  color: w.color, fontWeight: 700, fontSize: 12,
                  minWidth: 20, paddingTop: 1, opacity: 0.7,
                  fontFamily: "monospace",
                }}>
                  {i + 1}.
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <div style={{ marginTop: 14 }}>
            <Link
              to={w.cta.to}
              className="nano-btn nano-btn-accent"
              style={{ fontSize: 12, padding: "6px 14px", textDecoration: "none" }}
            >
              {w.cta.label} →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
