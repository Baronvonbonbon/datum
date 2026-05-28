/** HowItWorks.tsx
 *  Customer-facing explainer page — no wallet or contract calls needed.
 *  Alpha-5 architecture: 53 production contracts + DATUM token plane, EVM-only
 *  execution on Polkadot Hub via pallet-revive. Collapsible sections so the
 *  page acts as a tour the reader can pace themselves through.
 */

import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";

const ROLE_ACCENT: Record<string, string> = {
  user:       "var(--role-user)",
  publisher:  "var(--role-publisher)",
  advertiser: "var(--role-advertiser)",
  voter:      "var(--role-voter)",
};

const ROLE_DIM: Record<string, string> = {
  user:       "var(--role-user-dim)",
  publisher:  "var(--role-publisher-dim)",
  advertiser: "var(--role-advertiser-dim)",
  voter:      "var(--role-voter-dim)",
};

function RoleBadge({ role, label }: { role: string; label: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: ROLE_ACCENT[role],
        border: `1px solid ${ROLE_ACCENT[role]}`,
        background: ROLE_DIM[role],
      }}
    >
      {label}
    </span>
  );
}

/* ── Collapsible Section ─────────────────────────────────────────────────
 * Smooth height-based expand/collapse with a chevron header.
 * Each section reports its own open state via local useState. First-load
 * defaults are controlled by the caller (defaultOpen).
 * ──────────────────────────────────────────────────────────────────────── */
function Section({
  title,
  kicker,
  defaultOpen = false,
  children,
}: {
  title: string;
  kicker?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const innerRef = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState<number | "none">(defaultOpen ? "none" : 0);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    if (open) {
      // measure and transition
      const h = el.scrollHeight;
      setMaxH(h);
      // after the transition, release the cap so nested content can grow
      const t = setTimeout(() => setMaxH("none"), 320);
      return () => clearTimeout(t);
    } else {
      // snap back to measured height first so transition has a starting frame
      const h = el.scrollHeight;
      setMaxH(h);
      // then on next frame collapse
      requestAnimationFrame(() => setMaxH(0));
    }
  }, [open]);

  return (
    <div
      className="nano-fade"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-raised)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "16px 22px",
          background: "transparent",
          border: "none",
          color: "var(--text-strong)",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 18,
            transition: "transform 0.22s ease",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            color: "var(--text-muted)",
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          ▸
        </span>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.10em",
              textTransform: "uppercase",
              color: "var(--text-strong)",
            }}
          >
            {title}
          </div>
          {kicker && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.02em" }}>
              {kicker}
            </div>
          )}
        </div>
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            flexShrink: 0,
          }}
        >
          {open ? "Hide" : "Show"}
        </span>
      </button>
      <div
        style={{
          maxHeight: maxH === "none" ? undefined : maxH,
          opacity: open ? 1 : 0,
          transition: "max-height 0.30s ease, opacity 0.22s ease",
          overflow: maxH === "none" ? "visible" : "hidden",
        }}
      >
        <div
          ref={innerRef}
          style={{
            padding: "4px 22px 22px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function RoleCard({
  role,
  label,
  icon,
  what,
  earns,
  risks,
}: {
  role: string;
  label: string;
  icon: string;
  what: string;
  earns: string[];
  risks: string[];
}) {
  const accent = ROLE_ACCENT[role];
  return (
    <div
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <RoleBadge role={role} label={label} />
      </div>
      <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.65, margin: 0 }}>{what}</p>

      <div>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 6 }}>
          Revenue &amp; Incentives
        </div>
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          {earns.map((e, i) => (
            <li key={i} style={{ fontSize: 12, color: "var(--text)", display: "flex", gap: 8, alignItems: "flex-start" }}>
              <span style={{ color: accent, flexShrink: 0, marginTop: 1 }}>▸</span>
              <span>{e}</span>
            </li>
          ))}
        </ul>
      </div>

      {risks.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 6 }}>
            Checks Applied
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
            {risks.map((r, i) => (
              <li key={i} style={{ fontSize: 12, color: "var(--text)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 1 }}>·</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CheckRow({ check, detail, status }: { check: string; detail: string; status: "on-chain" | "off-chain" | "zk" | "extension" }) {
  const statusColor = status === "on-chain" ? "var(--ok)" : status === "zk" ? "#60a5fa" : status === "extension" ? "var(--accent)" : "var(--warn)";
  const statusLabel = status === "on-chain" ? "on-chain" : status === "zk" ? "ZK proof" : status === "extension" ? "extension" : "off-chain";
  return (
    <div style={{ display: "flex", gap: 14, padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: "0 0 170px" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-strong)" }}>{check}</span>
      </div>
      <div style={{ flex: 1, fontSize: 12, color: "var(--text)", lineHeight: 1.6 }}>{detail}</div>
      <div style={{ flex: "0 0 80px", textAlign: "right" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: statusColor, letterSpacing: "0.06em", textTransform: "uppercase" }}>{statusLabel}</span>
      </div>
    </div>
  );
}

function FlowStep({ n, label, sub, accent }: { n: number; label: string; sub: string; accent?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: 1, minWidth: 100 }}>
      <div style={{
        width: 32, height: 32, borderRadius: "50%",
        background: accent ?? "var(--bg-raised)",
        border: `1px solid ${accent ?? "var(--border)"}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 13, fontWeight: 700, color: accent ? "var(--bg)" : "var(--text-strong)",
        flexShrink: 0,
      }}>
        {n}
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-strong)" }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>{sub}</div>
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div style={{ fontSize: 16, color: "var(--text-muted)", alignSelf: "flex-start", marginTop: 8, flexShrink: 0 }}>→</div>
  );
}

function TileGrid({ items, minWidth = 220 }: { items: { title: string; body: string; accent?: string }[]; minWidth?: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`, gap: 12 }}>
      {items.map((c) => (
        <div
          key={c.title}
          style={{
            background: "var(--bg)",
            borderRadius: 8,
            padding: "12px 14px",
            border: "1px solid var(--border)",
            borderLeft: c.accent ? `3px solid ${c.accent}` : undefined,
            transition: "border-color 0.18s ease, transform 0.18s ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; if (c.accent) e.currentTarget.style.borderLeftColor = c.accent; }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: c.accent ?? "var(--accent)", marginBottom: 6, letterSpacing: "0.06em" }}>
            {c.title}
          </div>
          <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.55 }}>{c.body}</div>
        </div>
      ))}
    </div>
  );
}

export function HowItWorks() {
  return (
    <div style={{ maxWidth: 860, display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="nano-fade" style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 8 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text-strong)", margin: 0, letterSpacing: "-0.02em" }}>
          How Datum Works
        </h1>
        <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.7, margin: 0, maxWidth: 640 }}>
          Datum is a decentralised advertising protocol on Polkadot Hub.
          Advertisers pay for verified impressions, publishers earn by
          embedding a lightweight SDK, and users are rewarded for the
          attention they give — all without revealing who they are. Claims
          are validated on-chain across 53 production contracts with a
          configurable trust gradient (L0 open → L2 dual-sig → L3 ZK-only)
          and settled transparently in DOT plus the protocol's own DATUM
          token.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          {[
            "On-chain settlement",
            "Optional ZK proofs",
            "Privacy by default",
            "DOT + DATUM rewards",
            "User self-sovereignty",
          ].map((t) => (
            <span
              key={t}
              style={{
                fontSize: 11,
                padding: "3px 10px",
                borderRadius: 999,
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
        <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0 0", lineHeight: 1.55 }}>
          Tap each section to expand. The flow follows the lifecycle of a single impression from page-load to settlement.
        </p>
      </div>

      {/* ── Chain access ──────────────────────────────────────────────── */}
      <Section
        title="How the App Reaches the Chain"
        kicker="Pine light client + opt-in RPC fallback"
        defaultOpen
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
          DATUM ships a smoldot light-client (the <code>pine</code> runtime) directly in the webapp. Every public page
          reads chain state via pine — your queries are validated against a full consensus proof inside the browser,
          never relayed through a centralized RPC gateway. No third party sees what you look up.
        </p>
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
          Pine indexes from the moment you connect. Any historical lookup older than that requires reaching back to a
          centralized RPC endpoint, which would expose query metadata to that gateway. So <strong>RPC is opt-in</strong>:
          a header toggle (default off) gates the historical fallback. End-user pages never reach for it; operator pages
          prompt you with an "Enable RPC" CTA when they need it.
        </p>
        <TileGrid
          items={[
            { title: "Pine (default)", body: "Validates blocks in-browser. Trustless. Metadata-private. Live data only — no history before you connected." },
            { title: "RPC fallback (opt-in)", body: "Public Paseo gateway, off by default. Toggle exposes the gateway to your query metadata in exchange for older history." },
            { title: "Extension-owned writes", body: "Wallet signs via the extension; transactions ride the user's own provider. The webapp never holds a private key." },
          ]}
        />
      </Section>

      {/* ── Roles ────────────────────────────────────────────────────────── */}
      <Section
        title="The Four Participants"
        kicker="Advertisers, publishers, users, governance voters"
        defaultOpen
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>
          <RoleCard
            role="advertiser"
            label="Advertiser"
            icon="📢"
            what="Creates campaigns with a DOT budget, a daily spend cap, and a per-impression bid (CPM). Optionally seeds an ERC-20 token side-reward so users earn project tokens alongside DOT. Targets publishers by topic tags — niche sites, categories, audience signals — instead of tracking individual users. Picks an AssuranceLevel (L0–L2) that gates which settlement paths are valid."
            earns={[
              "ROI through impressions that reach real audiences matched by tag, not identity.",
              "Predictable spend: daily cap prevents runaway costs; budget sits in escrow and is refunded if unspent.",
              "Optional ZK enforcement per campaign — rejects claims without a valid cryptographic proof at the contract level.",
              "Optional ERC-20 side-reward — pair a campaign with a project token, distributed automatically per impression.",
            ]}
            risks={[
              "AdvertiserStake bond required; slashable via AdvertiserGovernance on upheld fraud claims.",
              "Budget is locked in escrow — cannot be drained without verified settlement.",
              "ChallengeBonds + ActivationBonds gate campaign creation; bonds returned on clean completion.",
              "Publishers can file fraud claims against advertisers (G-3 mirror); Council resolves on-chain.",
            ]}
          />

          <RoleCard
            role="publisher"
            label="Publisher"
            icon="🖥"
            what="Embeds the Datum SDK on their site or app (or uses the WordPress plugin). Registers on-chain with a take-rate (30–80%) and topic tags. Picks one of three settlement paths — publisher-direct, dual-sig, or bonded DatumRelay — via a single SDK attribute."
            earns={[
              "A configurable take-rate on every CPM settled — negotiated at registration, locked per campaign at creation.",
              "Reputation score grows as settlements are accepted, unlocking trust with future advertisers and reducing fraud-flag risk.",
              "DATUM token emission per claim from the MintCoordinator; stakeable in FeeShare for DOT yield.",
            ]}
            risks={[
              "PublisherStake bonding curve required; settlement rejects under-staked publishers.",
              "Rate limiter caps per-window impression volume — spikes are rejected, preventing artificial inflation.",
              "Reputation tracking + anomaly detection: outlier rejection rates flag suspicious publishers.",
              "PublisherGovernance conviction-vote fraud track; CouncilBlocklistCurator can blocklist (bonded appeal available).",
            ]}
          />

          <RoleCard
            role="user"
            label="User"
            icon="👤"
            what="Installs the Datum browser extension. The extension records impressions locally, builds a sequential hash-linked claim chain per (user, campaign), and submits in batches. No browsing data leaves the browser. Self-sovereignty controls live on-chain — you can pause settlement, block counterparties, or demand a ZK-only floor."
            earns={[
              "DOT settlement credit proportional to impressions in each accepted batch (75% of advertiser-net after publisher take).",
              "DATUM token emission via MintCoordinator + one-time WDATUM bootstrap grant from BootstrapPool on first claim.",
              "ERC-20 side-rewards in full if the advertiser seeded a token budget; pull-payment, withdrawable on your schedule.",
              "Stake WDATUM in FeeShare to earn DOT yield from protocol-fee sweeps.",
            ]}
            risks={[
              "userPaused / userBlocksPublisher / userBlocksAdvertiser / userMinAssurance — on-chain self-sovereignty mappings, set by you.",
              "Recovery address: pre-register a cold wallet on PaymentVault; after the delay, anyone can sweep your balances there if your hot key is lost.",
              "Claim chain is sequential and non-replayable — each link binds to the prior hash, making replay structurally impossible.",
              "Optional ZK identity commitment (single-input Groth16) lets you prove uniqueness without revealing the underlying address.",
              "Filters tab in the extension lets you block topics, silencing campaigns you dislike.",
            ]}
          />

          <RoleCard
            role="voter"
            label="Governance Voter"
            icon="⚖️"
            what="Stakes DOT with a conviction multiplier (0–8, nine levels, 1× to 21× weight, matching time-lock). Votes aye or nay on active campaigns and protocol parameters across three governance objects — GovernanceV2 (campaigns), ParameterGovernance (20 governable parameters), and PublisherGov / AdvertiserGov / RelayGov (fraud tracks)."
            earns={[
              "When a campaign is slashed via governance, a portion of the remaining budget flows to the voter pool.",
              "Correct aye votes on campaigns that complete successfully increase staking yield.",
              "ParameterRetuneGuard cooldowns prevent rapid-fire economic exploitation between votes.",
            ]}
            risks={[
              "Conviction time-lock: higher conviction = longer DOT lock, preventing rapid exit after voting.",
              "Termination quorum is higher than approval quorum — removing a campaign is harder than approving it.",
              "Commit-reveal for contested optimistic activations — prevents last-second swing voting.",
              "Voters who vote nay on campaigns that later succeed do not earn the slash distribution.",
            ]}
          />
        </div>
      </Section>

      {/* ── Settlement flow ───────────────────────────────────────────────── */}
      <Section
        title="Settlement Flow"
        kicker="From page-load to on-chain DOT split"
        defaultOpen
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
          <FlowStep n={1} label="Ad loads" sub="Extension detects a campaign matching the page's tags" accent="var(--accent)" />
          <Arrow />
          <FlowStep n={2} label="Impression recorded" sub="Hash chain + PoW solved locally" accent="var(--accent)" />
          <Arrow />
          <FlowStep n={3} label="Batch queued" sub="Queue flushes on fill or timer" accent="var(--accent)" />
          <Arrow />
          <FlowStep n={4} label="Validation" sub="Chain, PoW, stake, rate-limit, optional ZK" accent="var(--ok)" />
          <Arrow />
          <FlowStep n={5} label="On-chain settlement" sub="DOT split via PaymentVault" accent="var(--ok)" />
          <Arrow />
          <FlowStep n={6} label="Rewards credited" sub="DOT + DATUM emission + optional side-reward" accent="var(--ok)" />
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "8px 0 0", lineHeight: 1.6 }}>
          All three settlement paths (publisher-direct / dual-sig / bonded DatumRelay) converge on the same
          <code style={{ margin: "0 4px" }}>_processBatch</code> entry inside <code>DatumSettlementLogicB</code>.
          The on-chain checks are identical regardless of how the batch arrived.
        </p>
      </Section>

      {/* ── Three settlement paths ───────────────────────────────────────── */}
      <Section
        title="Three Settlement Paths"
        kicker="Pick one in the SDK — same on-chain checks for all"
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
          {[
            {
              title: "Publisher direct",
              accent: "var(--role-publisher)",
              body: "Publisher operates a relay endpoint. Users hand signed claim batches to the publisher's relay; publisher cosigns and submits to Settlement. Publisher pays gas; take-rate covers it for any reasonable batch. Satisfies AssuranceLevel ≤ 1.",
            },
            {
              title: "Dual-sig (advertiser cosig)",
              accent: "var(--role-advertiser)",
              body: "Advertiser and publisher both cosign the batch under a single EIP-712 envelope; anyone submits via DatumDualSigSettlement. Either party can refute by withholding their sig. Only path that satisfies AssuranceLevel = 2.",
            },
            {
              title: "Bonded DatumRelay",
              accent: "var(--accent)",
              body: "Independent relay operators post a bond in DatumRelayStake (or sit on the Council-curated allowlist), take on gas, and submit batches for users. Slashable via RelayGovernance on censorship / front-run / MEV / collusion.",
            },
          ].map((p) => (
            <div
              key={p.title}
              className="nano-card"
              style={{
                padding: "18px 20px",
                borderLeft: `3px solid ${p.accent}`,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: p.accent }}>
                {p.title}
              </div>
              <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.6 }}>{p.body}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Assurance gradient ──────────────────────────────────────────── */}
      <Section
        title="AssuranceLevel Gradient — L0 to L3"
        kicker="Per-campaign trust tier + per-user floor"
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
          Every campaign declares an <code>AssuranceLevel</code> at creation. Every user can declare a
          <code style={{ margin: "0 4px" }}>userMinAssurance</code> floor on-chain. Settlement only happens when the campaign's
          level ≥ the user's floor and the entry path is valid for that level. This is how Datum tunes the
          privacy/validity trade-off case-by-case rather than globally.
        </p>
        <TileGrid
          minWidth={200}
          items={[
            { title: "L0 — Open", body: "User signature only. Any relay path is fine. Lightest tier — for low-stakes campaigns where the claim chain + rate limiter are sufficient.", accent: "var(--text-muted)" },
            { title: "L1 — Relay-mediated", body: "Sig + liveness check via DatumRelay. Most production campaigns sit here.", accent: "var(--accent)" },
            { title: "L2 — Dual-sig", body: "Publisher + advertiser EIP-712 cosig required. Only DatumDualSigSettlement entry satisfies this tier.", accent: "var(--role-advertiser)" },
            { title: "L3 — ZK-only floor", body: "User demands a valid Groth16 impression proof regardless of the campaign's declared tier. Reject reason 26 fires otherwise.", accent: "#60a5fa" },
          ]}
        />
      </Section>

      {/* ── User self-sovereignty ────────────────────────────────────────── */}
      <Section
        title="User Self-Sovereignty Controls"
        kicker="Pause, block, gate, recover — all on-chain, all yours"
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
          Datum treats the user wallet as the unit of consent. Four on-chain mappings let you intervene without trusting
          the relay, the publisher, or the protocol team. Setting any of them takes a single transaction from your own wallet.
        </p>
        <TileGrid
          minWidth={220}
          items={[
            { title: "userPaused", body: "Halts all settlement involving your address protocol-wide. Set/clear at will. Useful before traveling, debugging, or rotating keys." },
            { title: "userBlocksPublisher / Advertiser", body: "Refuses any settlement involving a named counterparty. Operates at the per-address level — granular, additive, fully under your control." },
            { title: "userMinAssurance (L0–L3)", body: "Declares the minimum AssuranceLevel you'll accept. Claims below your floor are rejected at the contract level — neither you nor the relay can bypass it." },
            { title: "Recovery address", body: "Pre-register a cold wallet on PaymentVault. After a delay (~24h default, bounded 6h–30d) anyone can sweep your DOT balance there. Resets the timer on overwrite — even a compromised hot key can't shortcut the delay." },
          ]}
        />
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.6 }}>
          You can also file a bonded blocklist appeal via <code>CouncilBlocklistCurator.fileBlocklistAppeal</code> if your
          address is wrongly blocked — Council resolves on-chain; upheld appeals refund the bond.
        </p>
      </Section>

      {/* ── DATUM token plane ────────────────────────────────────────────── */}
      <Section
        title="DATUM Token Plane"
        kicker="Mint authority, WDATUM wrapper, bootstrap grants, fee share, vesting"
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
          Beyond the per-impression DOT split, Datum mints its own ERC-20 reward token. The token plane is five
          single-purpose contracts that together form the protocol's economic flywheel — issuance, wrapping, onboarding,
          yield, and team vesting are all separately upgradable until OpenGov fires their lock-once functions.
        </p>
        <TileGrid
          minWidth={220}
          items={[
            { title: "MintAuthority", body: "Sole bridge contract for DATUM mints. Hard cap 95M (95% of supply). Per-claim emission, bootstrap grants, and vesting releases all route through here." },
            { title: "Wrapper (WDATUM)", body: "EVM-side ERC-20 wrapper over canonical Asset Hub DATUM. wrap / unwrap against the precompile. WDATUM is the stakeable form." },
            { title: "BootstrapPool", body: "One-time onboarding grant of WDATUM the first time the protocol settles a claim for your address. Lowers the cold-start cost of joining." },
            { title: "FeeShare", body: "Stake WDATUM to earn DOT yield from protocol-fee sweeps. Single-token MasterChef pattern — your share scales with stake × duration." },
            { title: "Vesting", body: "Single-beneficiary linear vesting with cliff. Used for team / contributor allocations. Publicly readable on-chain." },
            { title: "MintCoordinator + EmissionEngine", body: "Per-claim orchestration: dust gate, split bps, schedule. Decoupled from Settlement so emission policy can evolve without touching the settlement hot path." },
          ]}
        />
      </Section>

      {/* ── ERC-20 side-rewards ──────────────────────────────────────────── */}
      <Section
        title="ERC-20 Side-Rewards"
        kicker="Advertisers can pair a campaign with their own token"
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
          Independent of the DATUM token plane, advertisers can pair a campaign with any ERC-20 (or Asset Hub native asset
          via precompile) as a per-impression side-reward. Useful for projects distributing their own governance or utility
          token aligned with ad spend. Side-rewards go entirely to users.
        </p>
        <TileGrid
          minWidth={200}
          items={[
            { title: "1. Configure", body: "Advertiser sets rewardToken + rewardPerImpression at campaign creation." },
            { title: "2. Fund", body: "Advertiser approves and deposits tokens into DatumTokenRewardVault before the campaign goes live." },
            { title: "3. Credit", body: "Each settlement credits the reward non-critically. If the token budget runs out, DOT settlement continues unaffected." },
            { title: "4. Withdraw", body: "Users withdraw accumulated tokens from the vault any time. Pull-payment, on their schedule." },
          ]}
        />
      </Section>

      {/* ── Governance ladder ────────────────────────────────────────────── */}
      <Section
        title="Governance Ladder — Phase 0 → 1 → 2"
        kicker="Upgradable today, locked tomorrow"
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
          Every contract is registered behind a stable <code>DatumGovernanceRouter</code> address. Upgrades happen by
          re-pointing the router to a new implementation. <strong>Who can fire that upgrade</strong> depends on the
          contract's phase. ~36 contracts inherit <code>DatumUpgradable</code>; the rest are immutable by design.
        </p>
        <TileGrid
          minWidth={240}
          items={[
            { title: "Phase 0 — Admin", body: "Deployer is the governor. Upgrades are instant. Used during initial bring-up only.", accent: "var(--warn)" },
            { title: "Phase 1 — Council", body: "Council N-of-M votes gate upgrades, with execution delay and bicameral veto window. Fast enough to ship fixes during beta; bounded by a multi-party check.", accent: "var(--accent)" },
            { title: "Phase 2 — OpenGov", body: "Conviction-voted referenda gate upgrades through a 48h Timelock. Decentralized end-state. Council retains a veto window (CB5).", accent: "var(--ok)" },
          ]}
        />
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
          Each contract also has <code>lock*()</code> functions that revert <code>not-opengov</code> until Phase 2 is
          reached. Once OpenGov fires the lock, that surface is permanently frozen — no upgrade path remains. The
          transition is <strong>upgradable today, locked tomorrow</strong>: original "code-is-law" guarantees become
          OpenGov-choice commitments, one contract at a time. Live phase status:{" "}
          <Link to="/governance/phase-ladder">Phase Ladder</Link>.
        </p>
      </Section>

      {/* ── Identity layer ───────────────────────────────────────────────── */}
      <Section
        title="Identity Layer (Optional)"
        kicker="People Chain XCM bridge, bonded reporter, ZK identity, interest commitments"
      >
        <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
          Datum does not roll its own identity. It reads from <strong>Polkadot People Chain</strong> via XCM. Verified
          identities anchor the highest assurance tiers; ZK proofs let users prove uniqueness without revealing which
          human; a bonded fast-path reporter handles latency between XCM refresh and real-time settlement; and interest
          commitments let users prove category membership for targeting without disclosing their interest set.
        </p>
        <TileGrid
          items={[
            { title: "PeopleChainXcmBridge", body: "XCM-asynchronous bridge state machine. Pulls People Chain judgements into Datum's local cache. Currently oracle-mode on Paseo; mainnet trustless return-leg is a research-blocked item." },
            { title: "BondedIdentityReporter", body: "Bonded fast-path reporter for low-latency identity updates. Slashable on misreport. Alternative pattern to the oracle reporter, currently deployed but not wired." },
            { title: "IdentityVerifier (Groth16)", body: "ZK circuit proving People-Chain-anchored uniqueness without revealing the underlying address. Single-input commitment; pre-image stays in the browser." },
            { title: "InterestCommitments", body: "Per-user Merkle commitments over interest-category leaves. Lets advertisers run ZK-targeted campaigns where you prove category membership without disclosing the rest of your interest set." },
          ]}
        />
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.6 }}>
          All four are <strong>opt-in</strong>. If you never publish a commitment or a People Chain judgement, none of
          this data is created and the protocol still works at L0/L1.
        </p>
      </Section>

      {/* ── Checks & Balances ─────────────────────────────────────────────── */}
      <Section
        title="Checks & Balances"
        kicker="Where each on-chain protection lives"
      >
        <div className="nano-card" style={{ padding: "0 22px" }}>
          <div style={{ padding: "12px 0 4px", display: "flex", gap: 14 }}>
            <div style={{ flex: "0 0 170px", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Check</div>
            <div style={{ flex: 1, fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>How It Works</div>
            <div style={{ flex: "0 0 80px", textAlign: "right", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Where</div>
          </div>
          <CheckRow
            check="Claim chain integrity"
            detail="Each impression batch links to the previous hash, anchored to the campaign. Any replay, reorder, or gap breaks the chain and the settlement reverts. The extension discards claims rejected on-chain and resets the chain state."
            status="on-chain"
          />
          <CheckRow
            check="Proof-of-work (PoW)"
            detail="DatumPowEngine enforces per-impression PoW with a leaky-bucket per-publisher difficulty. Cheap on a real browser, expensive at scale — taxes bot traffic without taxing real users."
            status="on-chain"
          />
          <CheckRow
            check="ZK impression proof"
            detail="Optional per-campaign enforcement. Groth16 / BN254 circuit with 7 public inputs proves the impression count is in a valid range and the nullifier is correctly derived — without revealing the user's address or browsing history. nullifier = Poseidon(userSecret, campaignId, windowId)."
            status="zk"
          />
          <CheckRow
            check="ZK identity proof"
            detail="Separate Groth16 circuit (single public input) lets users prove uniqueness against a People-Chain-anchored commitment without revealing the underlying address. Required at higher assurance tiers."
            status="zk"
          />
          <CheckRow
            check="Nullifier registry"
            detail="DatumNullifierRegistry records each (user, campaign, window) nullifier exactly once. Replay attempts revert with E73 — even cryptographically valid duplicate proofs are rejected."
            status="on-chain"
          />
          <CheckRow
            check="Second-price auction"
            detail="When multiple campaigns match a page, the extension runs a Vickrey second-price auction — highest bidder wins but pays the second-highest bid. Removes the incentive to overbid; makes selection deterministic and verifiable."
            status="extension"
          />
          <CheckRow
            check="Publisher + advertiser stake"
            detail="Both sides post bonds on a bonding curve (PublisherStake, AdvertiserStake). Settlement rejects under-staked counterparties. Slashable via the corresponding governance contract on upheld fraud."
            status="on-chain"
          />
          <CheckRow
            check="Rate limiter"
            detail="Enforces a per-publisher impression cap over a rolling window. Exceeding the cap reverts the settlement. Window size and cap are governance-tunable."
            status="on-chain"
          />
          <CheckRow
            check="Reputation tracking"
            detail="Tracks each publisher's settlement acceptance-vs-rejection ratio. Outlier rejection rates (campaign-level rate > 2× global rate with MIN_SAMPLE=10) flag anomalous behaviour."
            status="on-chain"
          />
          <CheckRow
            check="Community reporting"
            detail="Anyone can flag a campaign or publisher. Reports are recorded on-chain (DatumReports) and surface the flagged party for governance review. A reported campaign becomes an easier target for conviction voters; a reported publisher takes a reputation hit."
            status="on-chain"
          />
          <CheckRow
            check="Conviction voting"
            detail="Governance votes are weighted by stake × conviction (1× to 21× across 9 levels). Longer conviction time-locks give committed voters more weight, aligning incentives with protocol health."
            status="on-chain"
          />
          <CheckRow
            check="Commit-reveal voting"
            detail="Contested optimistic-activation votes use commit-reveal. Voters commit a hashed ballot; reveal opens after the commit window. Prevents last-minute swing voting on visible tallies."
            status="on-chain"
          />
          <CheckRow
            check="Termination quorum"
            detail="Removing a campaign requires a higher quorum than approving it. Grace period after quorum is met gives the advertiser time to respond before the slash executes."
            status="on-chain"
          />
          <CheckRow
            check="Parameter retune guard"
            detail="Per-key cooldown on high-impact economic setters (slash bps, treasury bps, conviction curve). Even compromised governance cannot snap-retune faster than the cooldown — defense-in-depth on top of the Timelock."
            status="on-chain"
          />
          <CheckRow
            check="Time-locked governance"
            detail="All privileged protocol changes — parameter updates, role grants, fee adjustments, contract upgrades — pass through a 48h DatumTimelock between proposal and execution."
            status="on-chain"
          />
          <CheckRow
            check="Bonded blocklist appeal"
            detail="If your address is blocklisted, post the appealBond and submit evidence. Council resolves on-chain. Upheld → unblocked + bond refunded. Dismissed → bond forfeited to treasury."
            status="on-chain"
          />
          <CheckRow
            check="Symmetric fraud tracks"
            detail="Publishers can file fraud claims against advertisers (G-3); advertisers against publishers; either against relays. Council-arbitrated and conviction-voted tracks coexist. Filer bonds anti-grief."
            status="on-chain"
          />
          <CheckRow
            check="Granular emergency pause"
            detail="Per-category pause (settlement / campaigns / mint / etc) by 3 guardians (any 1 fast-pauses, 2-of-3 unpause). Per-category extension caps, re-engagement cooldown, lock-once posture for production."
            status="on-chain"
          />
          <div style={{ height: 8 }} />
        </div>
      </Section>

      {/* ── Privacy model ──────────────────────────────────────────────────── */}
      <Section
        title="Privacy vs. Valid Impressions"
        kicker="How Datum resolves the core tension"
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="nano-card" style={{ padding: "18px 20px", borderLeft: "3px solid #a78bfa", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#a78bfa" }}>User Privacy</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                "Browsing history never leaves the browser. The interest profile, claim chain, and ZK secrets are all stored locally.",
                "When ZK is enabled, the proof decouples identity from the impression count — only the claim hash, the proof, and the nullifier reach the chain.",
                "Click events are reported per (publisher, campaignId) without a user wallet address.",
                "Interest and identity commitments publish only Merkle roots / Poseidon hashes; pre-images stay on your device.",
                "Token rewards use pull payments — users withdraw on their own schedule, not pushed to a known address mid-session.",
                "userBlocksPublisher / userBlocksAdvertiser / userPaused — refuse any counterparty or pause settlement at the wallet level.",
              ].map((t, i) => (
                <li key={i} style={{ fontSize: 12, color: "var(--text)", display: "flex", gap: 8, lineHeight: 1.55 }}>
                  <span style={{ color: "#a78bfa", flexShrink: 0 }}>✓</span>
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div className="nano-card" style={{ padding: "18px 20px", borderLeft: "3px solid var(--ok)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ok)" }}>Impression Validity</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                "Sequential claim chains make replay structurally impossible — same batch cannot be submitted twice.",
                "Per-impression PoW + leaky-bucket per-publisher difficulty taxes bot traffic without taxing humans.",
                "Range checks inside the ZK circuit ensure impression count is never negative or astronomically large.",
                "Nullifier registry rejects duplicate proofs — even cryptographically valid ones — at the (user, campaign, window) level.",
                "Rate limiter enforces per-publisher volume ceilings — compromised infrastructure cannot flood the system.",
                "Reputation scoring creates a persistent track record — sustained bad behaviour is detectable and slashable.",
                "Three independent governance tracks (publisher / advertiser / relay) provide human backstops where automation falls short.",
              ].map((t, i) => (
                <li key={i} style={{ fontSize: 12, color: "var(--text)", display: "flex", gap: 8, lineHeight: 1.55 }}>
                  <span style={{ color: "var(--ok)", flexShrink: 0 }}>✓</span>
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.7 }}>
          The core tension in any ad system is that proving a real human saw a real ad usually requires identifying the
          human. Datum resolves this with a layered approach: claim chains ensure batches are consumed in order and
          cannot be reused; PoW + rate limiting cap volume; and for campaigns that opt in, a ZK proof attests to the
          existence and range of an impression count without any link to the user's address or browsing profile. Privacy
          does not weaken validity, and validity does not require deanonymisation.
        </p>
      </Section>

      {/* ── Everyone wins ─────────────────────────────────────────────────── */}
      <Section
        title="Why Everyone Wins"
        kicker="Each constraint on one participant is an assurance to another"
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14 }}>
          {[
            {
              role: "advertiser", label: "Advertisers",
              text: "Pay only for verified impressions. Tag-based targeting reaches relevant audiences without surveillance. Optional ZK + dual-sig enforcement filters bots and disputes. Budget is escrowed — unspent funds are returned. Publishers and relays they engage with are stake-bonded.",
            },
            {
              role: "publisher", label: "Publishers",
              text: "Earn DOT + DATUM on every settled impression without running ad servers or managing bidding. SDK is a lightweight JS snippet. Reputation grows passively. Three settlement paths let you pick the gas/control trade-off that fits.",
            },
            {
              role: "user", label: "Users",
              text: "Get paid in DOT, DATUM, and optional ERC-20 side-rewards for attention instead of having it extracted. Privacy is preserved by default. On-chain self-sovereignty controls (pause / block / minAssurance / recovery) give genuine agency.",
            },
            {
              role: "voter", label: "Governance Voters",
              text: "Earn a share of slashed campaign budgets for correctly identifying bad actors. Long conviction locks align voter incentives with the protocol's long-term health. ParameterGov + symmetric fraud tracks give voters real economic levers.",
            },
          ].map(({ role, label, text }) => (
            <div key={role} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <RoleBadge role={role} label={label} />
              <p style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.6, margin: 0 }}>{text}</p>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.7, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          The checks and balances are not incidental — they are the product. Each constraint on one participant is an
          assurance to another. The rate limiter that caps publishers is the guarantee that lets advertisers trust their
          CPM. The ZK proof option that protects users is the same proof that lets advertisers rule out bot traffic.
          Symmetric fraud tracks across publishers, advertisers, and relays mean no single role accumulates unilateral
          leverage. Governance that can slash a campaign is the mechanism that gives the community a voice when
          automation is insufficient.
        </p>
      </Section>

    </div>
  );
}
