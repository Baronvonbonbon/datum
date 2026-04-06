/** HowItWorks.tsx
 *  Customer-facing explainer page — no wallet or contract calls needed.
 *  Covers the four participants, revenue streams, checks & balances,
 *  privacy architecture, and how honesty is maintained.
 */

const ROLE_ACCENT: Record<string, string> = {
  advertiser: "var(--accent)",
  publisher:  "var(--ok)",
  user:       "#a78bfa",
  voter:      "var(--warn)",
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
        background: `${ROLE_ACCENT[role]}18`,
      }}
    >
      {label}
    </span>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
        margin: "0 0 20px",
        paddingBottom: 8,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {children}
    </h2>
  );
}

function RoleCard({
  role,
  label,
  icon,
  what,
  earns,
  risks,
  children,
}: {
  role: string;
  label: string;
  icon: string;
  what: string;
  earns: string[];
  risks: string[];
  children?: React.ReactNode;
}) {
  const accent = ROLE_ACCENT[role];
  return (
    <div
      className="nano-fade"
      style={{
        background: "var(--bg-raised)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "20px 22px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <div>
          <RoleBadge role={role} label={label} />
        </div>
      </div>

      <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.65, margin: 0 }}>
        {what}
      </p>

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

      {children}
    </div>
  );
}

function CheckRow({ check, detail, status }: { check: string; detail: string; status: "on-chain" | "off-chain" | "zk" }) {
  const statusColor = status === "on-chain" ? "var(--ok)" : status === "zk" ? "#a78bfa" : "var(--warn)";
  const statusLabel = status === "on-chain" ? "on-chain" : status === "zk" ? "ZK proof" : "off-chain";
  return (
    <div style={{ display: "flex", gap: 14, padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: "0 0 160px" }}>
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

export function HowItWorks() {
  return (
    <div style={{ maxWidth: 860, display: "flex", flexDirection: "column", gap: 40 }}>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="nano-fade" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text-strong)", margin: 0, letterSpacing: "-0.02em" }}>
          How Datum Works
        </h1>
        <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.7, margin: 0, maxWidth: 640 }}>
          Datum is a decentralised advertising protocol. Advertisers pay for verified impressions,
          publishers earn by embedding a lightweight SDK, and users are rewarded for the attention
          they give — all without revealing who they are. Claims are validated on-chain with
          optional zero-knowledge proof enforcement, and settled transparently on Polkadot.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          {["On-chain settlement", "Optional ZK proofs", "Privacy by default", "Polkadot / PolkaVM"].map(t => (
            <span key={t} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-muted)" }}>{t}</span>
          ))}
        </div>
      </div>

      {/* ── Roles ────────────────────────────────────────────────────────── */}
      <div className="nano-fade">
        <SectionHeader>The Four Participants</SectionHeader>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>

          <RoleCard
            role="advertiser"
            label="Advertiser"
            icon="📢"
            what="Creates campaigns with a DOT budget, a daily spend cap, and a per-impression bid (CPM). Optionally seeds an ERC-20 token budget so users earn project tokens alongside DOT. Targets publishers by topic tags — niche sites, categories, audience signals — instead of tracking individual users."
            earns={[
              "ROI through impressions that reach real audiences matched by tag, not identity.",
              "Predictable spend: daily cap prevents runaway costs; budget sits in escrow and is refunded if unspent.",
              "Optional ZK enforcement — a per-campaign flag that rejects claims without a valid cryptographic proof, filtering bot traffic at the contract level.",
            ]}
            risks={[
              "Budget is locked in escrow — cannot be drained without verified settlement.",
              "Publisher registration and tag overlap are verified before a campaign can be created.",
              "Governance voters can terminate campaigns that violate community standards.",
              "Slashing on governance rejection redistributes budget to the voter pool.",
            ]}
          />

          <RoleCard
            role="publisher"
            label="Publisher"
            icon="🖥"
            what="Embeds the Datum SDK on their site or app. Registers on-chain with a take-rate (the share of CPM they keep) and sets topic tags that describe their audience. Settlement is handled automatically — publishers don't need to manage gas or post transactions themselves."
            earns={[
              "A configurable take-rate on every CPM settled — negotiated at registration, locked per campaign.",
              "No ongoing gas cost: settlement batches are submitted via a co-signed relay path, so the publisher doesn't pay per-transaction fees.",
              "Reputation score grows as settlements are accepted, unlocking trust with future advertisers.",
            ]}
            risks={[
              "Rate limiting caps impression volume per window — sudden traffic spikes are rejected, preventing artificial inflation.",
              "Reputation tracking records each publisher's acceptance rate; anomaly detection flags publishers whose rejection rate is unusually high.",
              "Governance can slash a publisher's active campaign if fraud is voted through.",
              "Allowlists: publishers can whitelist specific advertisers, and advertisers can target specific publishers.",
            ]}
          />

          <RoleCard
            role="user"
            label="User"
            icon="👤"
            what="Installs the Datum browser extension. When an eligible ad loads, the extension records the impression locally and builds a sequential claim chain — a hash-linked sequence tied to the campaign and publisher. No personal data leaves the browser. When the queue fills or a timer fires, claims are submitted for settlement."
            earns={[
              "DOT settlement credit proportional to the impressions in each accepted batch.",
              "ERC-20 tokens if the advertiser seeded a token budget (e.g. a project's own governance token alongside DOT).",
              "Withdrawable at any time via a pull-payment vault — no push needed.",
            ]}
            risks={[
              "When ZK is enabled for a campaign, a cryptographic proof ties the claim to (impression count, nonce) — proves validity without revealing who the user is.",
              "Claim chain is sequential and non-replayable: each link binds to the prior hash, making replay attacks structurally impossible.",
              "Filters tab in the extension lets users block topics, silencing campaigns they dislike.",
            ]}
          />

          <RoleCard
            role="voter"
            label="Governance Voter"
            icon="⚖️"
            what="Stakes DOT with a conviction multiplier (0–8×, with matching time-lock). Votes aye or nay on active campaigns. Conviction voting means a committed voter with 4× conviction counts as much as four uncommitted ones — long-term stakeholders hold proportionally more influence."
            earns={[
              "When a campaign is slashed via governance, a portion of the remaining budget flows to the voter pool.",
              "Correct aye votes on campaigns that complete successfully increase staking yield.",
              "Governance parameters — quorum, slash %, grace periods — are publicly visible and transparently adjustable.",
            ]}
            risks={[
              "Voters who vote nay on campaigns that later succeed do not earn the slash distribution.",
              "Conviction time-lock: higher conviction = longer DOT is locked, preventing rapid exit after voting.",
              "Termination quorum is higher than approval quorum — removing a campaign is harder than approving it.",
            ]}
          />

        </div>
      </div>

      {/* ── Settlement flow ───────────────────────────────────────────────── */}
      <div className="nano-fade">
        <SectionHeader>Settlement Flow</SectionHeader>
        <div className="nano-card" style={{ padding: "22px 24px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
            <FlowStep n={1} label="Ad loads" sub="Extension detects a campaign matching the page's tags" accent="var(--accent)" />
            <Arrow />
            <FlowStep n={2} label="Impression recorded" sub="Hash chain updated locally in the browser" accent="var(--accent)" />
            <Arrow />
            <FlowStep n={3} label="Batch queued" sub="Queue flushes on fill or timer" accent="var(--accent)" />
            <Arrow />
            <FlowStep n={4} label="Validation" sub="Chain integrity, budget, rate limits, and optional ZK proof" accent="var(--ok)" />
            <Arrow />
            <FlowStep n={5} label="On-chain settlement" sub="DOT split: publisher take-rate + user share" accent="var(--ok)" />
            <Arrow />
            <FlowStep n={6} label="Rewards credited" sub="DOT to vault; ERC-20 tokens (if any) 100% to user" accent="var(--ok)" />
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "18px 0 0", lineHeight: 1.6 }}>
            Advertisers can enable ZK enforcement per campaign. When enabled, each claim must include a
            Groth16 cryptographic proof that the impression count is valid — without revealing the user's
            identity. Campaigns without ZK enabled still benefit from claim chain integrity, rate limiting,
            and all other on-chain checks.
          </p>
        </div>
      </div>

      {/* ── Token sidecar ─────────────────────────────────────────────────── */}
      <div className="nano-fade">
        <SectionHeader>ERC-20 Token Rewards</SectionHeader>
        <div className="nano-card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
            Advertisers can optionally pair a campaign with an ERC-20 token reward alongside DOT. This is useful for
            projects that want to distribute their own governance or utility token to users who engage
            with their ad — aligning the ad spend with protocol adoption. Token rewards go entirely to users.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
            {[
              { step: "1. Configure", text: "Advertiser creates a campaign with a reward token address and a per-impression token amount." },
              { step: "2. Fund", text: "Advertiser approves and deposits tokens into the reward vault before the campaign goes live." },
              { step: "3. Credit", text: "Each settlement automatically credits token rewards to users. If the token budget runs out, DOT settlement continues unaffected." },
              { step: "4. Withdraw", text: "Users withdraw accumulated token rewards from the vault at any time — pull-payment, on their own schedule." },
            ].map(({ step, text }) => (
              <div key={step} style={{ background: "var(--bg)", borderRadius: 8, padding: "12px 14px", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", marginBottom: 6, letterSpacing: "0.06em" }}>{step}</div>
                <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.55 }}>{text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Checks & Balances ─────────────────────────────────────────────── */}
      <div className="nano-fade">
        <SectionHeader>Checks &amp; Balances</SectionHeader>
        <div className="nano-card" style={{ padding: "0 22px" }}>
          <div style={{ padding: "12px 0 4px", display: "flex", gap: 14 }}>
            <div style={{ flex: "0 0 160px", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Check</div>
            <div style={{ flex: 1, fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>How It Works</div>
            <div style={{ flex: "0 0 80px", textAlign: "right", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Where</div>
          </div>
          <CheckRow
            check="Claim chain integrity"
            detail="Each impression batch links to the previous hash, anchored to the campaign. Any replay, reorder, or gap breaks the chain and the settlement reverts. The extension discards claims rejected on-chain and resets the chain state."
            status="on-chain"
          />
          <CheckRow
            check="ZK impression proof"
            detail="Optional per-campaign enforcement. When enabled, a Groth16 circuit proves the impression count is in a valid range and the nonce is known — without revealing the user's address or browsing history. Campaigns without ZK still benefit from all other checks."
            status="zk"
          />
          <CheckRow
            check="Rate limiter"
            detail="Enforces a per-publisher impression cap over a rolling window. Exceeding the cap reverts the settlement, preventing artificial volume inflation. Window size and cap are configurable per publisher."
            status="on-chain"
          />
          <CheckRow
            check="Reputation tracking"
            detail="Tracks each publisher's settlement acceptance-vs-rejection ratio. Publishers whose rejection rate significantly exceeds the network average are flagged for anomalous behaviour."
            status="on-chain"
          />
          <CheckRow
            check="Conviction voting"
            detail="Governance votes are weighted by stake multiplied by conviction (1–21×). Longer conviction time-locks give committed voters more weight, aligning incentives with protocol health."
            status="on-chain"
          />
          <CheckRow
            check="Termination quorum"
            detail="Removing a campaign requires a higher quorum than approving it. A grace period after quorum is met gives the advertiser time to respond before the slash executes."
            status="on-chain"
          />
          <CheckRow
            check="Time-locked governance"
            detail="All privileged protocol changes — parameter updates, role grants, fee adjustments — must pass through a time-lock, enforcing a minimum delay between proposal and execution."
            status="on-chain"
          />
          <CheckRow
            check="Emergency pause"
            detail="Settlement can be halted in an emergency. Pause cannot drain escrow — it only blocks new transactions until the situation is resolved."
            status="on-chain"
          />
          <div style={{ height: 8 }} />
        </div>
      </div>

      {/* ── Privacy model ──────────────────────────────────────────────────── */}
      <div className="nano-fade">
        <SectionHeader>Privacy vs. Valid Impressions</SectionHeader>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="nano-card" style={{ padding: "18px 20px", borderLeft: "3px solid #a78bfa", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#a78bfa" }}>User Privacy</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                "No wallet address is submitted with a claim — when ZK is enabled, the proof decouples identity from the impression count entirely.",
                "Browsing history never leaves the browser. The claim chain is built and stored locally in extension storage.",
                "Settlement infrastructure only receives the claim hash, proof, and impression count — not the pages visited.",
                "Users control their filter preferences and can silence any campaign or topic category.",
                "Token rewards use pull payments — users withdraw on their own schedule, not pushed to a known address mid-session.",
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
                "Sequential claim chains make replay structurally impossible — the same batch cannot be submitted twice.",
                "When ZK is enabled, a range check ensures impression count is never negative or astronomically large.",
                "Rate limiting enforces a per-publisher volume ceiling — compromised infrastructure cannot flood the system.",
                "Reputation scoring creates a persistent track record — sustained bad behaviour is detectable and flaggable.",
                "Governance provides a human-in-the-loop backstop: voters can terminate any campaign producing suspicious settlement patterns.",
              ].map((t, i) => (
                <li key={i} style={{ fontSize: 12, color: "var(--text)", display: "flex", gap: 8, lineHeight: 1.55 }}>
                  <span style={{ color: "var(--ok)", flexShrink: 0 }}>✓</span>
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 14, lineHeight: 1.7 }}>
          The core tension in any ad system is that proving a real human saw a real ad usually requires
          identifying the human. Datum resolves this with a layered approach: claim chains ensure that
          batches are consumed in order and cannot be reused, rate limiting caps volume, and for
          campaigns that opt in, a ZK proof attests to the existence and range of an impression count
          without any link to the user's address or browsing profile. Privacy does not weaken validity,
          and validity does not require deanonymisation.
        </p>
      </div>

      {/* ── Everyone wins ─────────────────────────────────────────────────── */}
      <div className="nano-fade">
        <SectionHeader>Why Everyone Wins</SectionHeader>
        <div className="nano-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14 }}>
            {[
              {
                role: "advertiser", label: "Advertisers", accent: ROLE_ACCENT.advertiser,
                text: "Pay only for verified impressions. Tag-based targeting reaches relevant audiences without surveillance. Optional ZK enforcement filters bots. Budget is escrowed — unspent funds are returned.",
              },
              {
                role: "publisher", label: "Publishers", accent: ROLE_ACCENT.publisher,
                text: "Earn DOT on every settled impression without running ad servers or managing bidding. The SDK is a lightweight JS snippet. Reputation grows passively and opens access to better campaigns.",
              },
              {
                role: "user", label: "Users", accent: ROLE_ACCENT.user,
                text: "Get paid for attention instead of having it extracted. Privacy is preserved by default — no tracking, no profiling. Filter controls give genuine agency over which ads appear.",
              },
              {
                role: "voter", label: "Governance Voters", accent: ROLE_ACCENT.voter,
                text: "Earn a share of slashed campaign budgets for correctly identifying bad actors. Long conviction locks align voter incentives with the protocol's long-term health.",
              },
            ].map(({ role, label, accent, text }) => (
              <div key={role} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <RoleBadge role={role} label={label} />
                <p style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.6, margin: 0 }}>{text}</p>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.7, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            The checks and balances are not incidental — they are the product. Each constraint on one
            participant is an assurance to another. The rate limiter that caps publishers is the guarantee
            that lets advertisers trust their CPM. The ZK proof option that protects users is the same
            proof that lets advertisers rule out bot traffic. Governance that can slash a campaign
            is the mechanism that gives the community a voice when automation is insufficient.
          </p>
        </div>
      </div>

    </div>
  );
}
