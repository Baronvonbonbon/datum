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
import { parseDOTSafe, parseDOT, formatDOT } from "@shared/dot";
import { getCurrencySymbol } from "@shared/networks";
import { CONVICTION_WEIGHTS, formatBlockDelta } from "@shared/conviction";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { useBlock } from "../../hooks/useBlock";

const STATE_LABELS = ["Active", "Passed", "Executed", "Rejected", "Cancelled"];
const STATE_COLORS = ["var(--accent)", "var(--ok)", "var(--ok)", "var(--error)", "var(--text-muted)"];

interface Proposal {
  id: number;
  proposer: string;
  target: string;
  description: string;
  startBlock: bigint;
  endBlock: bigint;
  executeAfter: bigint;
  ayeWeight: bigint;
  nayWeight: bigint;
  bond: bigint;
  state: number;
}

interface MyVote {
  proposalId: number;
  aye: boolean;
  conviction: number;
  lockAmount: bigint;
  lockUntil: bigint;
}

type TxState = "idle" | "pending" | "success" | "error";

export function ProtocolParams() {
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
  const [govParams, setGovParams] = useState<{ proposeBond: bigint; quorum: bigint; votingPeriodBlocks: bigint; timelockBlocks: bigint } | null>(null);
  const [filter, setFilter] = useState<"active" | "all">("active");

  // Propose form
  const [propTarget, setPropTarget] = useState("");
  const [propPayload, setPropPayload] = useState("");
  const [propDescription, setPropDescription] = useState("");
  const [propTxState, setPropTxState] = useState<TxState>("idle");
  const [propTxMsg, setPropTxMsg] = useState("");

  // Vote state per proposal
  const [voteIsAye, setVoteIsAye] = useState<Record<number, boolean>>({});
  const [voteAmount, setVoteAmount] = useState<Record<number, string>>({});
  const [voteConviction, setVoteConviction] = useState<Record<number, number>>({});
  const [voteTxState, setVoteTxState] = useState<Record<number, TxState>>({});
  const [voteTxMsg, setVoteTxMsg] = useState<Record<number, string>>({});

  const [actionBusy, setActionBusy] = useState<number | null>(null);

  useEffect(() => { load(); }, [address, settings.contractAddresses.parameterGovernance]);

  async function load() {
    if (!contracts.parameterGovernance) return;
    setLoading(true);
    try {
      const nextId = Number(await contracts.parameterGovernance.nextProposalId().catch(() => 0n));

      try {
        const [bond, quorum, votingPeriod, timelock] = await Promise.all([
          contracts.parameterGovernance.proposeBond().catch(() => 0n),
          contracts.parameterGovernance.quorum().catch(() => 0n),
          contracts.parameterGovernance.votingPeriodBlocks().catch(() => 0n),
          contracts.parameterGovernance.timelockBlocks().catch(() => 0n),
        ]);
        setGovParams({
          proposeBond: BigInt(bond),
          quorum: BigInt(quorum),
          votingPeriodBlocks: BigInt(votingPeriod),
          timelockBlocks: BigInt(timelock),
        });
      } catch { /* params optional */ }

      const loaded: Proposal[] = [];
      for (let i = nextId - 1; i >= 0; i--) {
        try {
          const p = await contracts.parameterGovernance.proposals(BigInt(i));
          loaded.push({
            id: i,
            proposer: p.proposer ?? p[0] ?? "",
            target: p.target ?? p[1] ?? "",
            description: p.description ?? p[3] ?? "",
            startBlock: BigInt(p.startBlock ?? p[4] ?? 0),
            endBlock: BigInt(p.endBlock ?? p[5] ?? 0),
            executeAfter: BigInt(p.executeAfter ?? p[6] ?? 0),
            ayeWeight: BigInt(p.ayeWeight ?? p[7] ?? 0),
            nayWeight: BigInt(p.nayWeight ?? p[8] ?? 0),
            bond: BigInt(p.bond ?? p[9] ?? 0),
            state: Number(p.state ?? p[10] ?? 0),
          });
        } catch { /* skip */ }
      }
      setProposals(loaded);

      if (address) {
        const votes: MyVote[] = [];
        for (const p of loaded) {
          try {
            const v = await contracts.parameterGovernance.getVote(BigInt(p.id), address);
            const lockAmt = BigInt(v.lockAmount ?? v[2] ?? 0);
            if (lockAmt > 0n) {
              votes.push({
                proposalId: p.id,
                aye: Boolean(v.aye ?? v[0] ?? false),
                conviction: Number(v.conviction ?? v[1] ?? 0),
                lockAmount: lockAmt,
                lockUntil: BigInt(v.lockUntil ?? v[3] ?? 0),
              });
            }
          } catch { /* no vote */ }
        }
        setMyVotes(votes);
      }

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
    if (!signer || !govParams) return;
    setPropTxState("pending");
    setPropTxMsg("");
    try {
      const c = contracts.parameterGovernance.connect(signer);
      const payload = propPayload.startsWith("0x") ? propPayload : "0x";
      const tx = await c.propose(propTarget.trim(), payload, propDescription.trim(), { value: govParams.proposeBond });
      await confirmTx(tx);
      setPropTxState("success");
      setPropTxMsg("Proposal submitted.");
      setPropTarget("");
      setPropPayload("");
      setPropDescription("");
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
      const c = contracts.parameterGovernance.connect(signer);
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
      const c = contracts.parameterGovernance.connect(signer);
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
      const c = contracts.parameterGovernance.connect(signer);
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

  async function handleExecute(proposalId: number) {
    if (!signer) return;
    setActionBusy(proposalId);
    try {
      const c = contracts.parameterGovernance.connect(signer);
      const tx = await c.execute(BigInt(proposalId));
      await confirmTx(tx);
      push(`Proposal #${proposalId} executed.`, "success");
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
      const c = contracts.parameterGovernance.connect(signer);
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

  if (!contracts.parameterGovernance) {
    return (
      <div className="nano-fade" style={{ maxWidth: 640 }}>
        <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
        <div className="nano-info nano-info--warn" style={{ marginTop: 16 }}>Parameter governance contract not configured.</div>
      </div>
    );
  }

  const displayed = proposals.filter((p) => filter === "active" ? p.state === 0 : true);

  return (
    <div className="nano-fade" style={{ maxWidth: 680 }}>
      <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 4px" }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Protocol Parameter Governance</h1>
        <button onClick={() => load()} className="nano-btn" style={{ padding: "5px 12px", fontSize: 12 }}>Refresh</button>
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 20 }}>
        Propose and vote on protocol parameter changes. Passed proposals enter a timelock before execution.
        The proposer must lock a bond that is returned on passage or slash on rejection.
      </p>

      {govParams && (
        <div style={{ marginBottom: 16, padding: "8px 12px", background: "var(--bg-raised)", borderRadius: "var(--radius)", fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>Bond: <strong style={{ color: "var(--text)" }}><DOTAmount planck={govParams.proposeBond} /></strong></span>
          <span>Quorum: <strong style={{ color: "var(--text)" }}><DOTAmount planck={govParams.quorum} /></strong></span>
          <span>Voting period: <strong style={{ color: "var(--text)" }}>{formatBlockDelta(Number(govParams.votingPeriodBlocks))}</strong></span>
          <span>Timelock: <strong style={{ color: "var(--text)" }}>{formatBlockDelta(Number(govParams.timelockBlocks))}</strong></span>
        </div>
      )}

      {/* My Votes */}
      {myVotes.length > 0 && (
        <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>My Active Votes</div>
          {myVotes.map((v) => {
            const canWithdraw = blockNumber && v.lockUntil > 0n ? BigInt(blockNumber) >= v.lockUntil : v.lockUntil === 0n;
            return (
              <div key={v.proposalId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Proposal #{v.proposalId}</span>
                <span style={{ fontWeight: 600, fontSize: 12, color: v.aye ? "var(--ok)" : "var(--error)" }}>
                  {v.aye ? "Aye" : "Nay"}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  <DOTAmount planck={v.lockAmount} /> · {CONVICTION_WEIGHTS[v.conviction]}x
                </span>
                {v.lockUntil > 0n && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {canWithdraw ? "Unlocked" : blockNumber ? `~${formatBlockDelta(Number(v.lockUntil) - blockNumber)} locked` : `Until #${v.lockUntil}`}
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
          <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>Submit Parameter Proposal</div>
          {govParams && govParams.proposeBond > 0n && (
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
              Bond required: <strong style={{ color: "var(--warn)" }}><DOTAmount planck={govParams.proposeBond} /></strong> — returned if proposal passes, slashed if rejected.
            </div>
          )}
          <form onSubmit={handlePropose} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>Target Contract Address</label>
              <input
                type="text"
                value={propTarget}
                onChange={(e) => setPropTarget(e.target.value)}
                placeholder="0x..."
                className="nano-input"
                required
              />
            </div>
            <div>
              <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>
                Call Payload <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(hex-encoded calldata, e.g. 0x...)</span>
              </label>
              <input
                type="text"
                value={propPayload}
                onChange={(e) => setPropPayload(e.target.value)}
                placeholder="0x..."
                className="nano-input"
                required
              />
            </div>
            <div>
              <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>Description</label>
              <input
                type="text"
                value={propDescription}
                onChange={(e) => setPropDescription(e.target.value)}
                placeholder="Describe what this change does and why"
                className="nano-input"
                required
              />
            </div>
            <TransactionStatus state={propTxState} message={propTxMsg} />
            <button
              type="submit"
              disabled={propTxState === "pending" || !propTarget || !propPayload || !propDescription}
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
        const total = p.ayeWeight + p.nayWeight;
        const ayePct = total > 0n ? Number(p.ayeWeight * 100n / total) : 0;
        const myVote = myVotes.find((v) => v.proposalId === p.id);
        const amountStr = voteAmount[p.id] ?? "0.1";
        const amountPlanck = (() => { try { return parseDOT(amountStr); } catch { return 0n; } })();
        const txState = voteTxState[p.id] ?? "idle";
        const txMsg = voteTxMsg[p.id] ?? "";
        const isActive = p.state === 0;
        const canExecute = p.state === 1 && blockNumber && p.executeAfter > 0n ? BigInt(blockNumber) >= p.executeAfter : p.state === 1 && p.executeAfter === 0n;

        return (
          <div key={p.id} className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ color: "var(--text-strong)", fontWeight: 700, fontSize: 15 }}>Proposal #{p.id}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: STATE_COLORS[p.state] ?? "var(--text-muted)", background: "var(--bg-raised)", padding: "1px 6px", borderRadius: 4 }}>
                  {STATE_LABELS[p.state] ?? "Unknown"}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {isActive && signer && (
                  <>
                    <button onClick={() => handleResolve(p.id)} disabled={actionBusy === p.id} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12 }}>
                      {actionBusy === p.id ? "..." : "Resolve"}
                    </button>
                    <button onClick={() => handleCancel(p.id)} disabled={actionBusy === p.id} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12, color: "var(--error)" }}>
                      Cancel
                    </button>
                  </>
                )}
                {canExecute && signer && (
                  <button onClick={() => handleExecute(p.id)} disabled={actionBusy === p.id} className="nano-btn nano-btn-accent" style={{ padding: "4px 10px", fontSize: 12 }}>
                    {actionBusy === p.id ? "..." : "Execute"}
                  </button>
                )}
              </div>
            </div>

            {p.description && (
              <div style={{ color: "var(--text)", fontSize: 13, marginBottom: 10, fontStyle: "italic" }}>
                "{p.description}"
              </div>
            )}

            <div style={{ marginBottom: 10, display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12 }}>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Proposer</div>
                <AddressDisplay address={p.proposer} chars={6} style={{ color: "var(--text-strong)", fontFamily: "var(--font-mono)" }} />
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Target</div>
                <AddressDisplay address={p.target} chars={6} style={{ color: "var(--text-strong)", fontFamily: "var(--font-mono)" }} />
              </div>
              {p.bond > 0n && (
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Bond</div>
                  <div style={{ color: "var(--text)" }}><DOTAmount planck={p.bond} /></div>
                </div>
              )}
              {p.endBlock > 0n && blockNumber && (
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>
                    {BigInt(blockNumber) < p.endBlock ? "Voting ends" : "Ended"}
                  </div>
                  <div style={{ color: "var(--text)" }}>
                    {BigInt(blockNumber) < p.endBlock
                      ? `~${formatBlockDelta(Number(p.endBlock) - blockNumber)}`
                      : `Block #${p.endBlock.toString()}`}
                  </div>
                </div>
              )}
              {p.state === 1 && p.executeAfter > 0n && (
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>
                    {canExecute ? "Ready to execute" : "Timelock ends"}
                  </div>
                  <div style={{ color: canExecute ? "var(--ok)" : "var(--text)" }}>
                    {canExecute ? "Now" : blockNumber ? `~${formatBlockDelta(Number(p.executeAfter) - blockNumber)}` : `Block #${p.executeAfter}`}
                  </div>
                </div>
              )}
            </div>

            {total > 0n && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ position: "relative", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 3, height: 8, overflow: "hidden", display: "flex" }}>
                  <div style={{ width: `${ayePct}%`, height: "100%", background: "rgba(74,222,128,0.35)" }} />
                  <div style={{ width: `${100 - ayePct}%`, height: "100%", background: "rgba(248,113,113,0.35)" }} />
                  <div style={{ position: "absolute", left: "50%", top: 0, width: 1, height: "100%", background: "var(--text-muted)", opacity: 0.4 }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  <span style={{ color: "var(--ok)" }}>Aye {ayePct}% · <DOTAmount planck={p.ayeWeight} /></span>
                  <span style={{ color: "var(--error)" }}>Nay {100 - ayePct}% · <DOTAmount planck={p.nayWeight} /></span>
                </div>
              </div>
            )}

            {myVote && (
              <div className="nano-info nano-info--ok" style={{ marginBottom: 10, fontSize: 12 }}>
                You voted <strong>{myVote.aye ? "Aye" : "Nay"}</strong> ·{" "}
                <DOTAmount planck={myVote.lockAmount} /> · {CONVICTION_WEIGHTS[myVote.conviction]}x conviction
              </div>
            )}

            {isActive && !myVote && address && (
              <form onSubmit={(e) => handleVote(p.id, e)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setVoteIsAye((s) => ({ ...s, [p.id]: true }))}
                    className="nano-btn"
                    style={{ flex: 1, padding: "8px", fontSize: 13, color: (voteIsAye[p.id] ?? true) ? "var(--ok)" : undefined, border: (voteIsAye[p.id] ?? true) ? "1px solid rgba(74,222,128,0.3)" : undefined, background: (voteIsAye[p.id] ?? true) ? "rgba(74,222,128,0.08)" : undefined }}
                  >
                    Aye (Support)
                  </button>
                  <button
                    type="button"
                    onClick={() => setVoteIsAye((s) => ({ ...s, [p.id]: false }))}
                    className="nano-btn"
                    style={{ flex: 1, padding: "8px", fontSize: 13, color: !(voteIsAye[p.id] ?? true) ? "var(--error)" : undefined, border: !(voteIsAye[p.id] ?? true) ? "1px solid rgba(248,113,113,0.3)" : undefined, background: !(voteIsAye[p.id] ?? true) ? "rgba(248,113,113,0.08)" : undefined }}
                  >
                    Nay (Oppose)
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
                  {txState === "pending" ? "Voting..." : `Vote ${(voteIsAye[p.id] ?? true) ? "Aye" : "Nay"} with ${amountStr} ${sym}`}
                </button>
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
}
