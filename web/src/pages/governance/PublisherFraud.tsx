import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { DOTAmount } from "../../components/DOTAmount";
import { TransactionStatus } from "../../components/TransactionStatus";
import { ConvictionSlider } from "../../components/ConvictionSlider";
import { AddressDisplay } from "../../components/AddressDisplay";
import { humanizeError } from "@shared/errorCodes";
import { parseDOTSafe, parseDOT } from "@shared/dot";
import { getCurrencySymbol } from "@shared/networks";
import { CONVICTION_WEIGHTS, formatBlockDelta } from "@shared/conviction";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { useBlock } from "../../hooks/useBlock";

interface Proposal {
  id: number;
  publisher: string;
  evidenceHash: string;
  createdBlock: bigint;
  resolved: boolean;
  ayeWeighted: bigint;
  nayWeighted: bigint;
  firstNayBlock: bigint;
}

interface MyVote {
  proposalId: number;
  direction: number;
  lockAmount: bigint;
  conviction: number;
  lockedUntilBlock: bigint;
}

type TxState = "idle" | "pending" | "success" | "error";

export function PublisherFraud() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { settings } = useSettings();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const { blockNumber } = useBlock();
  const sym = getCurrencySymbol(settings.network);

  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [myVotes, setMyVotes] = useState<MyVote[]>([]);
  const [loading, setLoading] = useState(true);
  const [params, setParams] = useState<{ quorum: bigint; bondBonusBps: bigint; slashBps: bigint } | null>(null);
  const [filter, setFilter] = useState<"active" | "all">("active");

  // Propose form
  const [propPublisher, setPropPublisher] = useState("");
  const [propEvidence, setPropEvidence] = useState("");
  const [propTxState, setPropTxState] = useState<TxState>("idle");
  const [propTxMsg, setPropTxMsg] = useState("");

  // Vote state per proposal (keyed by id)
  const [voteIsAye, setVoteIsAye] = useState<Record<number, boolean>>({});
  const [voteAmount, setVoteAmount] = useState<Record<number, string>>({});
  const [voteConviction, setVoteConviction] = useState<Record<number, number>>({});
  const [voteTxState, setVoteTxState] = useState<Record<number, TxState>>({});
  const [voteTxMsg, setVoteTxMsg] = useState<Record<number, string>>({});

  // Action state
  const [actionBusy, setActionBusy] = useState<number | null>(null);

  useEffect(() => { load(); }, [address, settings.contractAddresses.publisherGovernance]);

  async function load() {
    if (!contracts.publisherGovernance) return;
    setLoading(true);
    try {
      const nextId = Number(await contracts.publisherGovernance.nextProposalId().catch(() => 0n));

      // Load params
      try {
        const [quorum, bondBonusBps, slashBps] = await Promise.all([
          contracts.publisherGovernance.quorum?.().catch(() => 0n) ?? 0n,
          contracts.publisherGovernance.bondBonusBps?.().catch(() => 0n) ?? 0n,
          contracts.publisherGovernance.slashBps?.().catch(() => 0n) ?? 0n,
        ]);
        setParams({ quorum: BigInt(quorum), bondBonusBps: BigInt(bondBonusBps), slashBps: BigInt(slashBps) });
      } catch { /* params optional */ }

      const loaded: Proposal[] = [];
      for (let i = nextId - 1; i >= 0; i--) {
        try {
          const p = await contracts.publisherGovernance.proposals(BigInt(i));
          loaded.push({
            id: i,
            publisher: p.publisher ?? p[0] ?? "",
            evidenceHash: p.evidenceHash ?? p[1] ?? "",
            createdBlock: BigInt(p.createdBlock ?? p[2] ?? 0),
            resolved: Boolean(p.resolved ?? p[3] ?? false),
            ayeWeighted: BigInt(p.ayeWeighted ?? p[4] ?? 0),
            nayWeighted: BigInt(p.nayWeighted ?? p[5] ?? 0),
            firstNayBlock: BigInt(p.firstNayBlock ?? p[6] ?? 0),
          });
        } catch { /* skip */ }
      }
      setProposals(loaded);

      // Load my votes
      if (address) {
        const votes: MyVote[] = [];
        for (const p of loaded) {
          try {
            const v = await contracts.publisherGovernance.getVote(BigInt(p.id), address);
            const dir = Number(v.direction ?? v[0] ?? 0);
            if (dir > 0) {
              votes.push({
                proposalId: p.id,
                direction: dir,
                lockAmount: BigInt(v.lockAmount ?? v[1] ?? 0),
                conviction: Number(v.conviction ?? v[2] ?? 0),
                lockedUntilBlock: BigInt(v.lockedUntilBlock ?? v[3] ?? 0),
              });
            }
          } catch { /* no vote */ }
        }
        setMyVotes(votes);
      }

      // Initialize vote defaults
      const defaultAye: Record<number, boolean> = {};
      const defaultAmt: Record<number, string> = {};
      const defaultConv: Record<number, number> = {};
      for (const p of loaded) {
        defaultAye[p.id] = true;
        defaultAmt[p.id] = "0.1";
        defaultConv[p.id] = 1;
      }
      setVoteIsAye(defaultAye);
      setVoteAmount(defaultAmt);
      setVoteConviction(defaultConv);
    } finally {
      setLoading(false);
    }
  }

  async function handlePropose(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;
    setPropTxState("pending");
    setPropTxMsg("");
    try {
      const c = contracts.publisherGovernance.connect(signer);
      const evidenceBytes = propEvidence.startsWith("0x") && propEvidence.length === 66
        ? propEvidence
        : "0x" + "0".repeat(64);
      const tx = await c.propose(propPublisher.trim(), evidenceBytes);
      await confirmTx(tx);
      setPropTxState("success");
      setPropTxMsg("Proposal submitted.");
      setPropPublisher("");
      setPropEvidence("");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setPropTxMsg(humanizeError(err));
      setPropTxState("error");
    }
  }

  async function handleVote(proposalId: number, e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;
    setVoteTxState((s) => ({ ...s, [proposalId]: "pending" }));
    setVoteTxMsg((s) => ({ ...s, [proposalId]: "" }));
    try {
      const aye = voteIsAye[proposalId] ?? true;
      const conviction = voteConviction[proposalId] ?? 1;
      const planck = parseDOTSafe(voteAmount[proposalId] ?? "0.1");
      const c = contracts.publisherGovernance.connect(signer);
      const tx = await c.vote(BigInt(proposalId), aye, conviction, { value: planck });
      await confirmTx(tx);
      setVoteTxState((s) => ({ ...s, [proposalId]: "success" }));
      setVoteTxMsg((s) => ({ ...s, [proposalId]: `Voted ${aye ? "Aye" : "Nay"}.` }));
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setVoteTxMsg((s) => ({ ...s, [proposalId]: humanizeError(err) }));
      setVoteTxState((s) => ({ ...s, [proposalId]: "error" }));
    }
  }

  async function handleWithdrawVote(proposalId: number) {
    if (!signer) return;
    setActionBusy(proposalId);
    try {
      const c = contracts.publisherGovernance.connect(signer);
      const tx = await c.withdrawVote(BigInt(proposalId));
      await confirmTx(tx);
      push("Vote withdrawn.", "success");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setActionBusy(null);
    }
  }

  async function handleResolve(proposalId: number) {
    if (!signer) return;
    setActionBusy(proposalId);
    try {
      const c = contracts.publisherGovernance.connect(signer);
      const tx = await c.resolve(BigInt(proposalId));
      await confirmTx(tx);
      push(`Proposal #${proposalId} resolved.`, "success");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setActionBusy(null);
    }
  }

  async function handleCancel(proposalId: number) {
    if (!signer) return;
    setActionBusy(proposalId);
    try {
      const c = contracts.publisherGovernance.connect(signer);
      const tx = await c.cancel(BigInt(proposalId));
      await confirmTx(tx);
      push(`Proposal #${proposalId} cancelled.`, "success");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setActionBusy(null);
    }
  }

  if (!contracts.publisherGovernance) {
    return (
      <div className="nano-fade" style={{ maxWidth: 640 }}>
        <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
        <div className="nano-info nano-info--warn" style={{ marginTop: 16 }}>Publisher fraud governance contract not configured.</div>
      </div>
    );
  }

  const displayed = proposals.filter((p) => filter === "active" ? !p.resolved : true);

  return (
    <div className="nano-fade" style={{ maxWidth: 680 }}>
      <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 4px" }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Publisher Fraud Governance</h1>
        <button onClick={() => load()} className="nano-btn" style={{ padding: "5px 12px", fontSize: 12 }}>Refresh</button>
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 20 }}>
        Propose and vote on publisher fraud allegations. Aye majority + quorum → stake slashed, challenge bond bonus distributed.
        Nay majority → proposal dismissed.
      </p>

      {params && (
        <div style={{ marginBottom: 16, padding: "8px 12px", background: "var(--bg-raised)", borderRadius: "var(--radius)", fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>Quorum: <strong style={{ color: "var(--text)" }}><DOTAmount planck={params.quorum} /></strong></span>
          <span>Slash: <strong style={{ color: "var(--text)" }}>{(Number(params.slashBps) / 100).toFixed(0)}%</strong></span>
          <span>Bond bonus: <strong style={{ color: "var(--text)" }}>{(Number(params.bondBonusBps) / 100).toFixed(0)}%</strong></span>
        </div>
      )}

      {/* My Votes */}
      {myVotes.length > 0 && (
        <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>My Active Votes</div>
          {myVotes.map((v) => {
            const canWithdraw = blockNumber && v.lockedUntilBlock > 0n ? BigInt(blockNumber) >= v.lockedUntilBlock : v.lockedUntilBlock === 0n;
            return (
              <div key={v.proposalId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Proposal #{v.proposalId}</span>
                <span style={{ fontWeight: 600, fontSize: 12, color: v.direction === 1 ? "var(--ok)" : "var(--error)" }}>
                  {v.direction === 1 ? "Aye (Fraud)" : "Nay (Dismiss)"}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  <DOTAmount planck={v.lockAmount} /> · {CONVICTION_WEIGHTS[v.conviction]}x
                </span>
                {v.lockedUntilBlock > 0n && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {canWithdraw ? "Unlocked" : blockNumber ? `~${formatBlockDelta(Number(v.lockedUntilBlock) - blockNumber)} locked` : `Until #${v.lockedUntilBlock}`}
                  </span>
                )}
                {canWithdraw && (
                  <button
                    onClick={() => handleWithdrawVote(v.proposalId)}
                    disabled={actionBusy === v.proposalId}
                    className="nano-btn"
                    style={{ padding: "3px 8px", fontSize: 11 }}
                  >
                    Withdraw Vote
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Propose form */}
      {signer && (
        <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>Submit Fraud Proposal</div>
          <form onSubmit={handlePropose} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>Publisher Address</label>
              <input
                type="text"
                value={propPublisher}
                onChange={(e) => setPropPublisher(e.target.value)}
                placeholder="0x..."
                className="nano-input"
                required
              />
            </div>
            <div>
              <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>
                Evidence Hash <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(bytes32, 0x...)</span>
              </label>
              <input
                type="text"
                value={propEvidence}
                onChange={(e) => setPropEvidence(e.target.value)}
                placeholder="0x + 64 hex chars (IPFS CID hash or report reference)"
                className="nano-input"
                required
              />
            </div>
            <TransactionStatus state={propTxState} message={propTxMsg} />
            <button
              type="submit"
              disabled={propTxState === "pending" || !propPublisher || !propEvidence}
              className="nano-btn nano-btn-accent"
              style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600 }}
            >
              {propTxState === "pending" ? "Submitting..." : "Submit Proposal"}
            </button>
          </form>
        </div>
      )}

      {/* Filter */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button onClick={() => setFilter("active")} className={filter === "active" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12 }}>Active</button>
        <button onClick={() => setFilter("all")} className={filter === "all" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12 }}>All</button>
      </div>

      {loading && <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Loading proposals</div>}

      {!loading && displayed.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
          {filter === "active" ? "No active proposals." : "No proposals found."}
        </div>
      )}

      {displayed.map((p) => {
        const total = p.ayeWeighted + p.nayWeighted;
        const ayePct = total > 0n ? Number(p.ayeWeighted * 100n / total) : 0;
        const myVote = myVotes.find((v) => v.proposalId === p.id);
        const amountStr = voteAmount[p.id] ?? "0.1";
        const amountPlanck = (() => { try { return parseDOT(amountStr); } catch { return 0n; } })();
        const txState = voteTxState[p.id] ?? "idle";
        const txMsg = voteTxMsg[p.id] ?? "";

        return (
          <div key={p.id} className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
              <div>
                <span style={{ color: "var(--text-strong)", fontWeight: 700, fontSize: 15 }}>Proposal #{p.id}</span>
                {p.resolved && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-muted)", background: "var(--bg-raised)", padding: "1px 6px", borderRadius: 4 }}>Resolved</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {!p.resolved && signer && (
                  <>
                    <button onClick={() => handleResolve(p.id)} disabled={actionBusy === p.id} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12 }}>
                      {actionBusy === p.id ? "..." : "Resolve"}
                    </button>
                    <button onClick={() => handleCancel(p.id)} disabled={actionBusy === p.id} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12, color: "var(--error)" }}>
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 10, display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12 }}>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Publisher</div>
                <AddressDisplay address={p.publisher} chars={6} style={{ color: "var(--text-strong)", fontFamily: "var(--font-mono)" }} />
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Created</div>
                <div style={{ color: "var(--text)" }}>Block #{p.createdBlock.toString()}</div>
              </div>
              {p.evidenceHash && p.evidenceHash !== "0x" + "0".repeat(64) && (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Evidence</div>
                  <div style={{ color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {p.evidenceHash.slice(0, 14)}…{p.evidenceHash.slice(-8)}
                  </div>
                </div>
              )}
            </div>

            {total > 0n && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ position: "relative", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 3, height: 8, overflow: "hidden", display: "flex" }}>
                  <div style={{ width: `${ayePct}%`, height: "100%", background: "rgba(248,113,113,0.35)" }} />
                  <div style={{ width: `${100 - ayePct}%`, height: "100%", background: "rgba(74,222,128,0.35)" }} />
                  <div style={{ position: "absolute", left: "50%", top: 0, width: 1, height: "100%", background: "var(--text-muted)", opacity: 0.4 }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  <span style={{ color: "var(--error)" }}>Fraud (Aye) {ayePct}% · <DOTAmount planck={p.ayeWeighted} /></span>
                  <span style={{ color: "var(--ok)" }}>Dismiss (Nay) {100 - ayePct}% · <DOTAmount planck={p.nayWeighted} /></span>
                </div>
              </div>
            )}

            {myVote && (
              <div className="nano-info nano-info--ok" style={{ marginBottom: 10, fontSize: 12 }}>
                You voted <strong>{myVote.direction === 1 ? "Fraud (Aye)" : "Dismiss (Nay)"}</strong> ·{" "}
                <DOTAmount planck={myVote.lockAmount} /> · {CONVICTION_WEIGHTS[myVote.conviction]}x conviction
              </div>
            )}

            {!p.resolved && !myVote && address && (
              <form onSubmit={(e) => handleVote(p.id, e)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setVoteIsAye((s) => ({ ...s, [p.id]: true }))}
                    className="nano-btn"
                    style={{ flex: 1, padding: "8px", fontSize: 13, color: (voteIsAye[p.id] ?? true) ? "var(--error)" : undefined, border: (voteIsAye[p.id] ?? true) ? "1px solid rgba(248,113,113,0.3)" : undefined, background: (voteIsAye[p.id] ?? true) ? "rgba(248,113,113,0.08)" : undefined }}
                  >
                    Fraud (Aye)
                  </button>
                  <button
                    type="button"
                    onClick={() => setVoteIsAye((s) => ({ ...s, [p.id]: false }))}
                    className="nano-btn"
                    style={{ flex: 1, padding: "8px", fontSize: 13, color: !(voteIsAye[p.id] ?? true) ? "var(--ok)" : undefined, border: !(voteIsAye[p.id] ?? true) ? "1px solid rgba(74,222,128,0.3)" : undefined, background: !(voteIsAye[p.id] ?? true) ? "rgba(74,222,128,0.08)" : undefined }}
                  >
                    Dismiss (Nay)
                  </button>
                </div>
                <div>
                  <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>Stake Amount ({sym})</label>
                  <input
                    type="number"
                    value={amountStr}
                    onChange={(e) => setVoteAmount((s) => ({ ...s, [p.id]: e.target.value }))}
                    min="0.0001"
                    step="0.0001"
                    className="nano-input"
                    required
                  />
                </div>
                <div>
                  <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>Conviction</label>
                  <ConvictionSlider
                    value={voteConviction[p.id] ?? 1}
                    onChange={(v) => setVoteConviction((s) => ({ ...s, [p.id]: v }))}
                    amount={amountPlanck}
                    symbol={sym}
                  />
                </div>
                <TransactionStatus state={txState} message={txMsg} />
                <button
                  type="submit"
                  disabled={txState === "pending" || !signer}
                  className="nano-btn nano-btn-accent"
                  style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600 }}
                >
                  {txState === "pending" ? "Voting..." : `Vote ${(voteIsAye[p.id] ?? true) ? "Fraud (Aye)" : "Dismiss (Nay)"} with ${amountStr} ${sym}`}
                </button>
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
}
