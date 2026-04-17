import { useState, useEffect } from "react";
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

interface MyVote {
  campaignId: number;
  direction: number; // 1=aye, 2=nay
  lockAmount: bigint;
  conviction: number;
  unlockBlock: number;
  campaignStatus: number;
  campaignResolved: boolean;
  slashFinalized: boolean;
  claimable: bigint;
}

type StatusFilter = "all" | "active" | "resolved";

const BATCH_SIZE = 20;

export function MyVotes() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { blockNumber } = useBlock();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [votes, setVotes] = useState<MyVote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    setVotes([]);
    try {
      const nextId = Number(await contracts.campaigns.nextCampaignId().catch(() => 0));
      const results: MyVote[] = [];

      // Scan all campaign IDs directly — event filters unreliable on Paseo
      for (let i = 0; i < nextId; i += BATCH_SIZE) {
        const ids = Array.from({ length: Math.min(BATCH_SIZE, nextId - i) }, (_, j) => i + j);
        await Promise.all(ids.map(async (cid) => {
          try {
            const v = await contracts.governanceV2.getVote(BigInt(cid), address);
            const dir = Number(v.direction ?? v[0] ?? 0);
            if (dir === 0) return;

            const lockAmt = BigInt(v.lockAmount ?? v[1] ?? 0);
            const conv = Number(v.conviction ?? v[2] ?? 0);
            const unlockBlk = Number(v.lockedUntilBlock ?? v[3] ?? 0);

            const [c, resolved] = await Promise.all([
              contracts.campaigns.getCampaignForSettlement(BigInt(cid)),
              contracts.governanceV2.resolved(BigInt(cid)).catch(() => false),
            ]);

            let slashFinalized = false;
            let claimable = 0n;
            if (Boolean(resolved)) {
              try {
                slashFinalized = Boolean(await contracts.governanceSlash.finalized(BigInt(cid)));
              } catch { /* no slash contract */ }
              if (slashFinalized) {
                try {
                  claimable = BigInt(await contracts.governanceSlash.getClaimable(BigInt(cid), address));
                } catch { /* no claimable */ }
              }
            }

            results.push({
              campaignId: cid,
              direction: dir,
              lockAmount: lockAmt,
              conviction: conv,
              unlockBlock: unlockBlk,
              campaignStatus: Number(c[0]),
              campaignResolved: Boolean(resolved),
              slashFinalized,
              claimable,
            });
          } catch { /* skip */ }
        }));
      }

      setVotes(results.sort((a, b) => b.campaignId - a.campaignId));
    } finally {
      setLoading(false);
    }
  }

  async function handleWithdraw(campaignId: number) {
    if (!signer) return;
    setBusyId(campaignId);
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.governanceV2.connect(signer);
      const tx = await c.withdraw(BigInt(campaignId));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Withdrawal for campaign #${campaignId} complete.`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleFinalizeSlash(campaignId: number) {
    if (!signer) return;
    setBusyId(campaignId);
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.governanceSlash.connect(signer);
      const tx = await c.finalizeSlash(BigInt(campaignId));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Slash finalized for campaign #${campaignId}. You can now claim rewards.`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleClaimSlashReward(campaignId: number) {
    if (!signer) return;
    setBusyId(campaignId);
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.governanceSlash.connect(signer);
      const tx = await c.claimSlashReward(BigInt(campaignId));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Slash reward claimed for campaign #${campaignId}.`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  if (!address) {
    return (
      <div className="nano-fade" style={{ maxWidth: 640 }}>
        <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>My Votes</h1>
        <div style={{ color: "var(--text)", padding: 20 }}>Connect your wallet to view your votes.</div>
      </div>
    );
  }

  const filtered = votes.filter((v) => {
    if (statusFilter === "active") return !v.campaignResolved && v.campaignStatus <= 2;
    if (statusFilter === "resolved") return v.campaignResolved || v.campaignStatus >= 3;
    return true;
  });

  return (
    <div className="nano-fade" style={{ maxWidth: 640 }}>
      <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0" }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>My Votes</h1>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => load()} className="nano-btn" style={{ fontSize: 12 }}>Refresh</button>
          {votes.length > 0 && (
            <button
              onClick={() => {
                const rows = votes.map((v) => ({
                  Campaign: v.campaignId,
                  Direction: v.direction === 1 ? "Aye" : "Nay",
                  Staked: formatDOT(v.lockAmount),
                  Conviction: v.conviction,
                  Weight: CONVICTION_WEIGHTS[v.conviction],
                  "Effective Stake": formatDOT(v.lockAmount * BigInt(CONVICTION_WEIGHTS[v.conviction])),
                  "Unlock Block": v.unlockBlock,
                  Status: v.campaignResolved ? "Resolved" : "Active",
                  Claimable: v.claimable > 0n ? formatDOT(v.claimable) : "",
                }));
                downloadCSV("my-votes.csv", toCSV(["Campaign", "Direction", "Staked", "Conviction", "Weight", "Effective Stake", "Unlock Block", "Status", "Claimable"], rows));
              }}
              className="nano-btn"
              style={{ fontSize: 12 }}
            >
              Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Status filter */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        <button onClick={() => setStatusFilter("all")} className={statusFilter === "all" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12 }}>All</button>
        <button onClick={() => setStatusFilter("active")} className={statusFilter === "active" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12 }}>Active / Pending</button>
        <button onClick={() => setStatusFilter("resolved")} className={statusFilter === "resolved" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12 }}>Resolved</button>
      </div>

      <TransactionStatus state={txState} message={txMsg} />

      {loading ? (
        <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Scanning campaigns for your votes</div>
      ) : votes.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: 20, textAlign: "center" }}>
          You haven't voted on any campaigns yet.{" "}
          <Link to="/governance" style={{ color: "var(--accent)" }}>Browse governance →</Link>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: 20, textAlign: "center" }}>
          No votes match this filter.
        </div>
      ) : (
        <div>
          {filtered.map((v) => {
            const lockup = CONVICTION_LOCKUP_BLOCKS[v.conviction];
            const weight = CONVICTION_WEIGHTS[v.conviction];
            const canWithdraw = lockup === 0 || (blockNumber !== null && blockNumber >= v.unlockBlock);
            const blocksLeft = blockNumber && v.unlockBlock > 0 ? Math.max(0, v.unlockBlock - blockNumber) : 0;

            return (
              <div key={v.campaignId} className="nano-card" style={{ padding: 14, marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Link to={`/campaigns/${v.campaignId}`} style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "none" }}>
                      Campaign #{v.campaignId}
                    </Link>
                    <StatusBadge status={v.campaignStatus} />
                    {v.campaignResolved && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Resolved</span>}
                  </div>
                  <span className="nano-badge" style={{
                    color: v.direction === 1 ? "var(--ok)" : "var(--error)",
                    border: `1px solid ${v.direction === 1 ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`,
                    borderRadius: 10,
                    fontSize: 12,
                    fontWeight: 600,
                  }}>
                    {v.direction === 1 ? "Aye" : "Nay"}
                  </span>
                </div>

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

                {/* Slash info for resolved campaigns */}
                {v.campaignResolved && v.lockAmount > 0n && (
                  <div className="nano-card" style={{ padding: "8px 10px", fontSize: 12, marginBottom: 10 }}>
                    {!v.slashFinalized ? (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ color: "var(--text)" }}>Slash not yet finalized for this campaign.</span>
                        {signer && (
                          <button
                            onClick={() => handleFinalizeSlash(v.campaignId)}
                            disabled={busyId === v.campaignId}
                            className="nano-btn"
                            style={{ padding: "4px 10px", fontSize: 12 }}
                          >
                            {busyId === v.campaignId ? "Finalizing..." : "Finalize Slash"}
                          </button>
                        )}
                      </div>
                    ) : v.claimable > 0n ? (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ color: "var(--ok)" }}>
                          Slash reward: <DOTAmount planck={v.claimable} />
                        </span>
                        {signer && (
                          <button
                            onClick={() => handleClaimSlashReward(v.campaignId)}
                            disabled={busyId === v.campaignId}
                            className="nano-btn"
                            style={{ padding: "4px 10px", fontSize: 12, color: "var(--ok)", border: "1px solid rgba(74,222,128,0.3)" }}
                          >
                            {busyId === v.campaignId ? "Claiming..." : "Claim Reward"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>Slash finalized — no reward (losing side penalized).</span>
                    )}
                  </div>
                )}

                {/* Withdraw button */}
                {signer && v.lockAmount > 0n && (
                  <button
                    onClick={() => handleWithdraw(v.campaignId)}
                    disabled={busyId === v.campaignId || !canWithdraw}
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
                    {busyId === v.campaignId ? "Withdrawing..." : "Withdraw Stake"}
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
