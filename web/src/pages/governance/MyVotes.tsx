// Unified governance votes view.
//
// Aggregates votes from DatumGovernanceV2 (campaign termination),
// DatumParameterGovernance (protocol params), and DatumPublisherGovernance
// (fraud) into one list. Discovery uses indexed VoteCast / Voted events
// filtered by the connected wallet — no full-corpus scan.

import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { DOTAmount } from "../../components/DOTAmount";
import { StatusBadge } from "../../components/StatusBadge";
import { TransactionStatus } from "../../components/TransactionStatus";
import { CONVICTION_WEIGHTS, CONVICTION_LOCKUP_BLOCKS, formatBlockDelta } from "@shared/conviction";
import { humanizeError } from "@shared/errorCodes";
import { useBlock } from "../../hooks/useBlock";
import { useTx } from "../../hooks/useTx";
import { toCSV, downloadCSV } from "@shared/csvExport";
import { formatDOT } from "@shared/dot";
import { useToast } from "../../context/ToastContext";
import { queryFilterAll } from "@shared/eventQuery";

type GovKind = "campaign" | "param" | "publisher";

interface UnifiedVote {
  kind: GovKind;
  id: number;                  // campaignId for V2, proposalId otherwise
  aye: boolean;                // direction
  lockAmount: bigint;
  conviction: number;
  unlockBlock: number;
  resolved: boolean;
  // Campaign-only
  campaignStatus?: number;
  slashFinalized?: boolean;
  claimable?: bigint;
  // Param/publisher proposal display
  description?: string;
  publisherTarget?: string;
}

type StatusFilter = "all" | "active" | "resolved";
type KindFilter = "all" | GovKind;

const KIND_LABELS: Record<GovKind, string> = {
  campaign: "Campaign",
  param: "Param",
  publisher: "Publisher",
};
const KIND_COLORS: Record<GovKind, string> = {
  campaign: "var(--accent)",
  param: "var(--warn)",
  publisher: "var(--error)",
};

export function MyVotes() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { blockNumber } = useBlock();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [votes, setVotes] = useState<UnifiedVote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setVotes([]);

    const merged: UnifiedVote[] = [];

    // ── DatumGovernanceV2 (campaign termination) ──────────────────────────
    try {
      const filter = contracts.governanceV2.filters.VoteCast(null, address);
      const logs = await queryFilterAll(contracts.governanceV2, filter);
      const ids = Array.from(new Set(logs.map((l: any) => Number(l.args?.campaignId ?? l.args?.[0])).filter(Number.isFinite)));
      await Promise.all(ids.map(async (cid) => {
        try {
          const [v, c, resolved] = await Promise.all([
            contracts.governanceV2.getVote(BigInt(cid), address),
            contracts.campaigns.getCampaignForSettlement(BigInt(cid)),
            contracts.governanceV2.resolved(BigInt(cid)).catch(() => false),
          ]);
          const dir = Number(v.direction ?? v[0] ?? 0);
          if (dir === 0) return;
          const lockAmt = BigInt(v.lockAmount ?? v[1] ?? 0);
          const conv = Number(v.conviction ?? v[2] ?? 0);
          const unlockBlk = Number(v.lockedUntilBlock ?? v[3] ?? 0);
          let slashFinalized = false;
          let claimable = 0n;
          if (Boolean(resolved)) {
            try { slashFinalized = Boolean(await contracts.governanceV2.slashFinalized(BigInt(cid))); } catch { /* */ }
            if (slashFinalized) {
              try { claimable = BigInt(await contracts.governanceV2.getClaimable(BigInt(cid), address)); } catch { /* */ }
            }
          }
          merged.push({
            kind: "campaign", id: cid,
            aye: dir === 1, lockAmount: lockAmt, conviction: conv, unlockBlock: unlockBlk,
            resolved: Boolean(resolved),
            campaignStatus: Number(c[0]),
            slashFinalized, claimable,
          });
        } catch { /* skip */ }
      }));
    } catch { /* governanceV2 unavailable */ }

    // ── DatumParameterGovernance ──────────────────────────────────────────
    if (contracts.parameterGovernance) {
      try {
        const filter = contracts.parameterGovernance.filters.Voted(null, address);
        const logs = await queryFilterAll(contracts.parameterGovernance, filter);
        const ids = Array.from(new Set(logs.map((l: any) => Number(l.args?.proposalId ?? l.args?.[0])).filter(Number.isFinite)));
        await Promise.all(ids.map(async (pid) => {
          try {
            const [v, p] = await Promise.all([
              contracts.parameterGovernance.getVote(BigInt(pid), address),
              contracts.parameterGovernance.proposals(BigInt(pid)),
            ]);
            const lockAmt = BigInt(v.lockAmount ?? v[2] ?? 0);
            if (lockAmt === 0n) return;
            merged.push({
              kind: "param", id: pid,
              aye: Boolean(v.aye ?? v[0] ?? false),
              lockAmount: lockAmt,
              conviction: Number(v.conviction ?? v[1] ?? 0),
              unlockBlock: Number(v.lockUntil ?? v[3] ?? 0),
              resolved: Number(p.state ?? p[10] ?? 0) >= 2,  // Executed/Rejected/Cancelled
              description: String(p.description ?? p[3] ?? ""),
            });
          } catch { /* skip */ }
        }));
      } catch { /* parameterGovernance unavailable */ }
    }

    // ── DatumPublisherGovernance ──────────────────────────────────────────
    if (contracts.publisherGovernance) {
      try {
        const filter = contracts.publisherGovernance.filters.VoteCast(null, address);
        const logs = await queryFilterAll(contracts.publisherGovernance, filter);
        const ids = Array.from(new Set(logs.map((l: any) => Number(l.args?.proposalId ?? l.args?.[0])).filter(Number.isFinite)));
        await Promise.all(ids.map(async (pid) => {
          try {
            const [v, p] = await Promise.all([
              contracts.publisherGovernance.getVote(BigInt(pid), address),
              contracts.publisherGovernance.proposals(BigInt(pid)),
            ]);
            const dir = Number(v.direction ?? v[0] ?? 0);
            if (dir === 0) return;
            merged.push({
              kind: "publisher", id: pid,
              aye: dir === 1,
              lockAmount: BigInt(v.lockAmount ?? v[1] ?? 0),
              conviction: Number(v.conviction ?? v[2] ?? 0),
              unlockBlock: Number(v.lockedUntilBlock ?? v[3] ?? 0),
              resolved: Boolean(p.resolved ?? p[3] ?? false),
              publisherTarget: String(p.publisher ?? p[0] ?? ""),
            });
          } catch { /* skip */ }
        }));
      } catch { /* publisherGovernance unavailable */ }
    }

    // Newest first per kind, then by id
    merged.sort((a, b) => (a.kind === b.kind ? b.id - a.id : a.kind.localeCompare(b.kind)));
    setVotes(merged);
    setLoading(false);
  }, [address, contracts]);

  useEffect(() => { if (address) load(); }, [address, load]);

  // ── Action handlers ─────────────────────────────────────────────────────

  function busy(kind: GovKind, id: number) { return `${kind}:${id}`; }

  async function handleWithdraw(v: UnifiedVote) {
    if (!signer) return;
    setBusyKey(busy(v.kind, v.id));
    setTxState("pending"); setTxMsg("");
    try {
      let tx;
      if (v.kind === "campaign") {
        tx = await contracts.governanceV2.connect(signer).withdraw(BigInt(v.id));
      } else if (v.kind === "param") {
        tx = await contracts.parameterGovernance.connect(signer).withdrawVote(BigInt(v.id));
      } else {
        tx = await contracts.publisherGovernance.connect(signer).withdrawVote(BigInt(v.id));
      }
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Withdrew vote on ${v.kind} #${v.id}.`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleFinalizeSlash(id: number) {
    if (!signer) return;
    setBusyKey(busy("campaign", id));
    setTxState("pending"); setTxMsg("");
    try {
      const tx = await contracts.governanceV2.connect(signer).finalizeSlash(BigInt(id));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Slash finalized for campaign #${id}.`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleClaimSlash(id: number) {
    if (!signer) return;
    setBusyKey(busy("campaign", id));
    setTxState("pending"); setTxMsg("");
    try {
      const tx = await contracts.governanceV2.connect(signer).claimSlashReward(BigInt(id));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Slash reward claimed for campaign #${id}.`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyKey(null);
    }
  }

  if (!address) {
    return (
      <div className="nano-fade" style={{ maxWidth: 720 }}>
        <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>My Votes</h1>
        <div style={{ color: "var(--text)", padding: 20 }}>Connect your wallet to view your votes.</div>
      </div>
    );
  }

  const filtered = votes.filter((v) => {
    if (kindFilter !== "all" && v.kind !== kindFilter) return false;
    if (statusFilter === "active") return !v.resolved && (v.kind !== "campaign" || (v.campaignStatus ?? 0) <= 2);
    if (statusFilter === "resolved") return v.resolved || (v.kind === "campaign" && (v.campaignStatus ?? 0) >= 3);
    return true;
  });

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0" }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>My Votes</h1>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => load()} className="nano-btn" style={{ fontSize: 12 }}>Refresh</button>
          {votes.length > 0 && (
            <button
              onClick={() => {
                const rows = votes.map((v) => ({
                  Kind: KIND_LABELS[v.kind],
                  ID: v.id,
                  Direction: v.aye ? "Aye" : "Nay",
                  Staked: formatDOT(v.lockAmount),
                  Conviction: v.conviction,
                  Weight: CONVICTION_WEIGHTS[v.conviction] ?? "",
                  "Unlock Block": v.unlockBlock,
                  Status: v.resolved ? "Resolved" : "Active",
                  Claimable: v.claimable && v.claimable > 0n ? formatDOT(v.claimable) : "",
                }));
                downloadCSV("my-votes.csv", toCSV(["Kind", "ID", "Direction", "Staked", "Conviction", "Weight", "Unlock Block", "Status", "Claimable"], rows));
              }}
              className="nano-btn"
              style={{ fontSize: 12 }}
            >
              Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Kind filter */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {(["all", "campaign", "param", "publisher"] as KindFilter[]).map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            className={kindFilter === k ? "nano-btn nano-btn-accent" : "nano-btn"}
            style={{ padding: "5px 12px", fontSize: 12 }}
          >
            {k === "all" ? "All kinds" : KIND_LABELS[k as GovKind]}
          </button>
        ))}
      </div>

      {/* Status filter */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        <button onClick={() => setStatusFilter("all")} className={statusFilter === "all" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12 }}>All</button>
        <button onClick={() => setStatusFilter("active")} className={statusFilter === "active" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12 }}>Active</button>
        <button onClick={() => setStatusFilter("resolved")} className={statusFilter === "resolved" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12 }}>Resolved</button>
      </div>

      <TransactionStatus state={txState} message={txMsg} />

      {loading ? (
        <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Discovering your votes via event filters</div>
      ) : votes.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: 20, textAlign: "center" }}>
          You haven't cast any governance votes yet.{" "}
          <Link to="/governance" style={{ color: "var(--accent)" }}>Browse governance →</Link>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: 20, textAlign: "center" }}>
          No votes match this filter.
        </div>
      ) : (
        <div>
          {filtered.map((v) => {
            const lockup = CONVICTION_LOCKUP_BLOCKS[v.conviction] ?? 0;
            const weight = CONVICTION_WEIGHTS[v.conviction] ?? 1;
            const canWithdraw = lockup === 0 || (blockNumber !== null && blockNumber >= v.unlockBlock);
            const blocksLeft = blockNumber && v.unlockBlock > 0 ? Math.max(0, v.unlockBlock - blockNumber) : 0;
            const detailLink =
              v.kind === "campaign" ? `/campaigns/${v.id}`
              : v.kind === "param" ? "/governance/protocol"
              : "/governance/publisher-fraud";
            const titleLabel =
              v.kind === "campaign" ? `Campaign #${v.id}`
              : v.kind === "param" ? `Param proposal #${v.id}`
              : `Fraud proposal #${v.id}`;

            return (
              <div key={`${v.kind}:${v.id}`} className="nano-card" style={{ padding: 14, marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span className="nano-badge" style={{ color: KIND_COLORS[v.kind], borderColor: KIND_COLORS[v.kind], fontSize: 10 }}>
                      {KIND_LABELS[v.kind]}
                    </span>
                    <Link to={detailLink} style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "none" }}>
                      {titleLabel}
                    </Link>
                    {v.kind === "campaign" && v.campaignStatus !== undefined && (
                      <StatusBadge status={v.campaignStatus} />
                    )}
                    {v.resolved && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Resolved</span>}
                  </div>
                  <span className="nano-badge" style={{
                    color: v.aye ? "var(--ok)" : "var(--error)",
                    border: `1px solid ${v.aye ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`,
                    borderRadius: 10,
                    fontSize: 12,
                    fontWeight: 600,
                  }}>
                    {v.aye ? "Aye" : "Nay"}
                  </span>
                </div>

                {v.description && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {v.description}
                  </div>
                )}
                {v.publisherTarget && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 8 }}>
                    Target: {v.publisherTarget}
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12, fontSize: 12 }}>
                  <div style={{ color: "var(--text-muted)" }}>
                    Staked: <span style={{ color: "var(--text)" }}><DOTAmount planck={v.lockAmount} /></span>
                  </div>
                  <div style={{ color: "var(--text-muted)" }}>
                    Conviction: <span style={{ color: "var(--text)" }}>{v.conviction} ({weight}x weight)</span>
                  </div>
                  <div style={{ color: "var(--text-muted)" }}>
                    Effective: <span style={{ color: "var(--text)" }}><DOTAmount planck={v.lockAmount * BigInt(weight)} /></span>
                  </div>
                  <div style={{ color: "var(--text-muted)" }}>
                    {lockup === 0 ? (
                      <span style={{ color: "var(--ok)" }}>No lockup</span>
                    ) : canWithdraw ? (
                      <span style={{ color: "var(--ok)" }}>Unlocked</span>
                    ) : (
                      <span>Locked: <span style={{ color: "var(--text)" }}>{formatBlockDelta(blocksLeft)} left</span></span>
                    )}
                  </div>
                </div>

                {/* Campaign-only: slash finalize / claim flow */}
                {v.kind === "campaign" && v.resolved && v.lockAmount > 0n && (
                  <div className="nano-card" style={{ padding: "8px 10px", fontSize: 12, marginBottom: 10 }}>
                    {!v.slashFinalized ? (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ color: "var(--text)" }}>Slash not yet finalized for this campaign.</span>
                        {signer && (
                          <button
                            onClick={() => handleFinalizeSlash(v.id)}
                            disabled={busyKey === busy("campaign", v.id)}
                            className="nano-btn"
                            style={{ padding: "4px 10px", fontSize: 12 }}
                          >
                            {busyKey === busy("campaign", v.id) ? "Finalizing…" : "Finalize Slash"}
                          </button>
                        )}
                      </div>
                    ) : v.claimable && v.claimable > 0n ? (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ color: "var(--ok)" }}>
                          Slash reward: <DOTAmount planck={v.claimable} />
                        </span>
                        {signer && (
                          <button
                            onClick={() => handleClaimSlash(v.id)}
                            disabled={busyKey === busy("campaign", v.id)}
                            className="nano-btn"
                            style={{ padding: "4px 10px", fontSize: 12, color: "var(--ok)", border: "1px solid rgba(74,222,128,0.3)" }}
                          >
                            {busyKey === busy("campaign", v.id) ? "Claiming…" : "Claim Reward"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>Slash finalized — no reward (losing side penalized).</span>
                    )}
                  </div>
                )}

                {/* Withdraw vote button — works across all 3 kinds */}
                {signer && v.lockAmount > 0n && (
                  <button
                    onClick={() => handleWithdraw(v)}
                    disabled={busyKey === busy(v.kind, v.id) || !canWithdraw}
                    title={!canWithdraw ? `Locked for ${formatBlockDelta(blocksLeft)}` : ""}
                    className="nano-btn"
                    style={{
                      padding: "6px 14px",
                      fontSize: 12,
                      color: canWithdraw ? "var(--accent)" : "var(--text-muted)",
                      cursor: canWithdraw ? "pointer" : "not-allowed",
                      opacity: canWithdraw ? 1 : 0.5,
                    }}
                  >
                    {busyKey === busy(v.kind, v.id) ? "Withdrawing…" : "Withdraw Stake"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
