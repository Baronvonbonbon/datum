/** HowItWorks.tsx
 *  Static explainer page — no wallet or contract calls needed.
 *  Covers all six roles, revenue streams, checks & balances,
 *  privacy architecture, and the ZK + claim-chain integrity model.
 */

const ROLE_ACCENT: Record<string, string> = {
  advertiser: "var(--accent)",
  publisher:  "var(--ok)",
  user:       "#a78bfa",
  voter:      "var(--warn)",
  relay:      "#67e8f9",
  protocol:   "var(--error)",
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
          they give — all without revealing who they are. Every claim is validated by a
          zero-knowledge proof and settled on Polkadot.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          {["On-chain settlement", "ZK impression proofs", "21 smart contracts", "Polkadot / PolkaVM"].map(t => (
            <span key={t} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-muted)" }}>{t}</span>
          ))}
        </div>
      </div>

      {/* ── Roles ────────────────────────────────────────────────────────── */}
      <div className="nano-fade">
        <SectionHeader>The Six Roles</SectionHeader>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>

          <RoleCard
            role="advertiser"
            label="Advertiser"
            icon="📢"
            what="Creates campaigns with a DOT budget, a daily spend cap, and a per-impression bid (CPM). Optionally seeds an ERC-20 sidecar token budget so users earn protocol tokens alongside DOT. Targets publishers by tag — niche sites, categories, audience signals — instead of tracking individual users."
            earns={[
              "ROI through impressions that reach real audiences matched by tag, not identity.",
              "Predictable spend: daily cap prevents runaway costs; budget sits in escrow and is refunded if unspent.",
              "Optional ZK enforcement — enables a flag that rejects claims without a valid Groth16 proof, filtering bot traffic at the contract level.",
            ]}
            risks={[
              "Budget locked in DatumBudgetLedger — cannot be drained without settlement.",
              "CampaignValidator checks publisher is registered and tags overlap before creation.",
              "Governance voters can terminate campaigns violating community standards.",
              "Slashing on governance rejection redistributes budget to voter pool.",
            ]}
          />

          <RoleCard
            role="publisher"
            label="Publisher"
            icon="🖥"
            what="Embeds the Datum SDK on their site or app. Registers on-chain with a take-rate (the share of CPM they keep) and sets topic tags that describe their audience. Sets an optional relay signer — a delegated EOA that the relay bot uses to post batched settlements on behalf of the publisher's campaign."
            earns={[
              "A configurable take-rate on every CPM settled — negotiated at registration.",
              "No ongoing gas cost: the relay bot batches and posts settlements, publisher only pays to register and update settings.",
              "Reputation score grows as settlements are accepted, unlocking trust with future advertisers.",
            ]}
            risks={[
              "SettlementRateLimiter caps impression volume per window — sudden traffic spikes are rejected, preventing artificial inflation.",
              "PublisherReputation tracks acceptance rate; anomaly detection flags publishers whose rejection rate is more than 2× the global average.",
              "Governance can slash a publisher's active campaign if fraud is voted through.",
              "Allowlist: publishers can whitelist specific advertisers, and advertisers can target specific publishers.",
            ]}
          />

          <RoleCard
            role="user"
            label="User"
            icon="👤"
            what="Installs the Datum browser extension. When an eligible ad loads, the extension records the impression locally and builds a sequential claim chain — a hash-linked sequence tied to the campaign and publisher. No personal data leaves the browser. When the queue fills or a timer fires, the extension sends claims to the relay bot."
            earns={[
              "DOT settlement credit proportional to the impressions in each accepted batch.",
              "ERC-20 sidecar tokens if the advertiser seeded a token budget (e.g. a project's own governance token alongside DOT).",
              "Withdrawable at any time via the pull-payment contract — no push needed.",
            ]}
            risks={[
              "ZK proof ties the claimHash to (impressionCount, nonce) via a Groth16 circuit — proves validity without revealing who the user is.",
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
              "Governance parameters — quorum, slash bps, grace periods — are set by the protocol owner and visible on the Parameters page.",
            ]}
            risks={[
              "Voters who vote nay on campaigns that later succeed do not earn the slash distribution.",
              "Conviction time-lock: higher conviction = longer DOT is locked, preventing rapid exit after voting.",
              "Termination quorum is higher than approval quorum — removing a campaign is harder than approving it.",
            ]}
          />

          <RoleCard
            role="relay"
            label="Relay Bot"
            icon="🤖"
            what="An off-chain service run by publishers (or delegated to a shared operator). Receives batched claim submissions from the extension, verifies the ZK proof and claim chain integrity, then posts the settlement transaction on-chain. After settlement, records per-publisher acceptance and rejection counts to the reputation contract."
            earns={[
              "Gas costs are covered by the publisher's relay signer account — publishers fund the bot to avoid settlement latency.",
              "Shared relay operators may charge publishers a small fee for managed relay service (protocol-level mechanism; not enforced on-chain).",
            ]}
            risks={[
              "Relay cannot forge claims — every settlement must include a valid ZK proof and a claim chain rooted in the on-chain campaign hash.",
              "A relay that submits invalid proofs simply pays gas and gets nothing; the contract rejects without slashing the publisher.",
              "Claim sequence is checked on-chain: out-of-order or replayed batches are rejected.",
            ]}
          />

          <RoleCard
            role="protocol"
            label="Protocol / Admin"
            icon="🔧"
            what="The protocol owner (initially the deployer, later a governance timelock) sets global parameters: minimum CPM, slash basis points, quorum thresholds, rate-limiter windows, and pause controls. All privileged actions have a time-lock delay, giving the community time to react before changes take effect."
            earns={[
              "A protocol fee (bps, set in ProtocolFees contract) on each settled impression — funds ongoing development.",
              "Slash proceeds flow to the governance treasury, not the admin, preventing admin incentive to trigger false slashes.",
            ]}
            risks={[
              "All admin operations go through DatumTimelock — no immediate execution of privileged calls.",
              "DatumPauseRegistry allows emergency pause of settlement, but pause cannot drain funds.",
              "GovernanceHelper's dust guard prevents micro-campaigns that would game the system with negligible stakes.",
            ]}
          />

        </div>
      </div>

      {/* ── Settlement flow ───────────────────────────────────────────────── */}
      <div className="nano-fade">
        <SectionHeader>Settlement Flow</SectionHeader>
        <div className="nano-card" style={{ padding: "22px 24px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
            <FlowStep n={1} label="Ad loads" sub="Extension detects campaign tag in page" accent="var(--accent)" />
            <Arrow />
            <FlowStep n={2} label="Impression recorded" sub="Hash chain updated locally, ZK witness captured" accent="var(--accent)" />
            <Arrow />
            <FlowStep n={3} label="Batch queued" sub="Queue flushes on fill or timer" accent="var(--accent)" />
            <Arrow />
            <FlowStep n={4} label="ZK proof generated" sub="Groth16 fullProve() in extension offscreen" accent="var(--accent)" />
            <Arrow />
            <FlowStep n={5} label="Relay receives" sub="Validates proof + chain before submitting" accent="var(--ok)" />
            <Arrow />
            <FlowStep n={6} label="Settlement TX" sub="DatumSettlement.settle() on Polkadot" accent="var(--ok)" />
            <Arrow />
            <FlowStep n={7} label="Rewards credited" sub="DOT to user + publisher; token sidecar credited" accent="var(--ok)" />
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "18px 0 0", lineHeight: 1.6 }}>
            The ZK circuit has one public input (claimHash) and two private witnesses: impressionCount
            range-checked to 32 bits, and a nonce with a quadratic binding. This proves the count is
            in range and the nonce is known — without revealing the user's identity or history.
          </p>
        </div>
      </div>

      {/* ── Token sidecar ─────────────────────────────────────────────────── */}
      <div className="nano-fade">
        <SectionHeader>ERC-20 Sidecar Tokens</SectionHeader>
        <div className="nano-card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
            Advertisers can optionally seed a secondary ERC-20 budget alongside DOT. This is useful for
            projects that want to distribute their own governance or utility token to users who engage
            with their ad — aligning the ad spend with protocol adoption.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
            {[
              { step: "1. Configure", text: "Advertiser calls createCampaign() with rewardToken and rewardPerImpression (in token base units)." },
              { step: "2. Approve & Deposit", text: "Advertiser calls ERC-20.approve() then depositCampaignBudget() on DatumTokenRewardVault." },
              { step: "3. Credit (non-critical)", text: "Each settle() call attempts creditReward(). If token budget is exhausted, DOT settlement still succeeds — no revert." },
              { step: "4. Withdraw (pull)", text: "Users call withdraw(token) on the vault at any time to claim accumulated token rewards." },
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
            detail="Groth16 circuit proves impressionCount is in [0, 2³²) and nonce knowledge, without revealing the user address or browsing history. The verifying key is stored in DatumZKVerifier and was set after trusted setup."
            status="zk"
          />
          <CheckRow
            check="Rate limiter"
            detail="DatumSettlementRateLimiter enforces a per-publisher impression cap over a rolling window. Exceeding the cap reverts the settlement. Window size and cap are admin-configurable per publisher."
            status="on-chain"
          />
          <CheckRow
            check="Reputation & anomaly detection"
            detail="DatumPublisherReputation tracks each publisher's acceptance-vs-rejection ratio in basis points. Publishers whose rejection rate exceeds 2× the global average with ≥ 10 samples trigger an anomaly flag."
            status="on-chain"
          />
          <CheckRow
            check="Conviction voting"
            detail="Governance votes are weighted by stake × conviction multiplier (1–21×). Longer conviction time-locks give committed voters more weight, aligning incentives with protocol health."
            status="on-chain"
          />
          <CheckRow
            check="Termination quorum"
            detail="Removing a campaign requires a higher quorum than approving it. A grace period after quorum is met gives the advertiser time to respond before the slash executes."
            status="on-chain"
          />
          <CheckRow
            check="Timelock on admin ops"
            detail="All privileged protocol changes (parameter updates, role grants) must pass through DatumTimelock, enforcing a minimum delay between proposal and execution."
            status="on-chain"
          />
          <CheckRow
            check="Pause registry"
            detail="Any registered pauser can halt settlement in an emergency. Pause cannot drain escrow — it only blocks new transactions. Unpausing requires the admin."
            status="on-chain"
          />
          <CheckRow
            check="Relay-side proof validation"
            detail="Before posting a settlement TX, the relay bot re-verifies the ZK proof and claim chain locally. Invalid batches are dropped before gas is spent, protecting publisher's relay account."
            status="off-chain"
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
                "No wallet address is submitted with a claim — the ZK proof decouples identity from the impression count.",
                "Browsing history never leaves the browser. The claim chain is built and stored locally in extension storage.",
                "The relay only receives the claim hash, proof, and impression count — not the pages visited.",
                "Users control their filter preferences and can silence any campaign or topic category.",
                "ERC-20 rewards use pull payments — users withdraw on their own schedule, not pushed to a known address mid-session.",
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
                "ZK range check ensures impressionCount is never negative or astronomically large (capped at 2³² − 1).",
                "Rate limiter enforces a per-publisher volume ceiling — a compromised relay cannot flood the system.",
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
          identifying the human. Datum resolves this with the ZK circuit: the proof attests to the
          existence and range of an impression count, and the nonce binding ties it to a specific
          relay submission — without any link to the user's address or browsing profile.
          The claim chain then ensures that batches are consumed in order and cannot be reused.
          Both properties hold independently: privacy does not weaken validity, and validity
          does not require deanonymisation.
        </p>
      </div>

      {/* ── Everyone wins ─────────────────────────────────────────────────── */}
      <div className="nano-fade">
        <SectionHeader>Why Every Role Wins</SectionHeader>
        <div className="nano-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14 }}>
            {[
              {
                role: "advertiser", label: "Advertisers", accent: ROLE_ACCENT.advertiser,
                text: "Pay only for verified impressions. Tag-based targeting reaches relevant audiences without surveillance. ZK enforcement filters bots. Budget is escrowed — unspent funds are returned.",
              },
              {
                role: "publisher", label: "Publishers", accent: ROLE_ACCENT.publisher,
                text: "Earn DOT on every settled impression without running ad servers or managing bidding. The SDK is a lightweight JS snippet. Reputation grows passively and opens access to better campaigns.",
              },
              {
                role: "user", label: "Users", accent: ROLE_ACCENT.user,
                text: "Get paid for attention instead of having it extracted. Privacy is preserved by design — no tracking, no profiling. Filter controls give genuine agency over the ads that appear.",
              },
              {
                role: "voter", label: "Governance Voters", accent: ROLE_ACCENT.voter,
                text: "Earn a share of slashed campaign budgets for correctly identifying bad actors. Long conviction locks align voter incentives with the protocol's long-term health.",
              },
              {
                role: "relay", label: "Relay Operators", accent: ROLE_ACCENT.relay,
                text: "Run a lightweight off-chain service with a clear, auditable job: receive, verify, submit. No custody of funds, no privileged keys — just a relay signer with enough gas.",
              },
              {
                role: "protocol", label: "Protocol", accent: ROLE_ACCENT.protocol,
                text: "Earns a fee on settled impressions. All parameters are transparently adjustable via timelock. Protocol health is maintained by the same governance that polices individual campaigns.",
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
            role is an assurance to another. The rate limiter that caps publishers is the guarantee
            that lets advertisers trust their CPM. The ZK proof that protects users is the same
            proof that lets advertisers rule out bot traffic. Governance that can slash a campaign
            is the mechanism that gives the community a voice when automation is insufficient.
          </p>
        </div>
      </div>

    </div>
  );
}
