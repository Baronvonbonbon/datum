// DatumCouncil — N-of-M governance member page.
//
// Lists pending council proposals with state (Active/Passed/Executed/Vetoed/
// Expired/Cancelled). Members can vote, the guardian can veto, the proposer
// can cancel, and anyone can execute a passed proposal once the cooldown has
// elapsed and the execution window is still open.

import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { ethers, Interface } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useBlock } from "../../hooks/useBlock";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { useSettings } from "../../context/SettingsContext";
import { AddressDisplay } from "../../components/AddressDisplay";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { formatBlockDelta } from "@shared/conviction";

const STATE_LABELS = ["Active", "Passed", "Executed", "Vetoed", "Expired", "Cancelled"];
const STATE_COLORS = ["var(--accent)", "var(--ok)", "var(--ok)", "var(--error)", "var(--text-muted)", "var(--text-muted)"];

interface CouncilProposal {
  id: number;
  proposer: string;
  description: string;
  proposedBlock: number;
  votingEndsBlock: number;
  executableAfterBlock: number;
  executionExpiresBlock: number;
  voteCount: number;
  executed: boolean;
  vetoed: boolean;
  cancelled: boolean;
  state: number;
  hasVoted: boolean;
  targets: string[];
  callDataLengths: number[];
}

export function Council() {
  const contracts = useContracts();
  const { settings } = useSettings();
  const { address, signer } = useWallet();
  const { blockNumber } = useBlock();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [proposals, setProposals] = useState<CouncilProposal[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [guardian, setGuardian] = useState<string>("");
  const [threshold, setThreshold] = useState<number>(0);
  const [config, setConfig] = useState<{ votingPeriod: number; execDelay: number; vetoWindow: number; maxExec: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  // Propose form
  const [showPropose, setShowPropose] = useState(false);
  const [propTarget, setPropTarget] = useState("");
  const [propValue, setPropValue] = useState("0");
  const [propCalldata, setPropCalldata] = useState("");
  const [propDescription, setPropDescription] = useState("");

  // Grant treasury state
  const [grantToken, setGrantToken] = useState<string>("");
  const [grantPerProposalMax, setGrantPerProposalMax] = useState<bigint>(0n);
  const [grantMonthlyMax, setGrantMonthlyMax] = useState<bigint>(0n);
  const [grantMonthlyUsed, setGrantMonthlyUsed] = useState<bigint>(0n);

  // Grant proposal form
  const [showGrant, setShowGrant] = useState(false);
  const [grantRecipient, setGrantRecipient] = useState("");
  const [grantAmount, setGrantAmount] = useState("");
  const [grantDescription, setGrantDescription] = useState("");

  const isMember = address ? members.some((m) => m.toLowerCase() === address.toLowerCase()) : false;
  const isGuardian = address ? guardian.toLowerCase() === address.toLowerCase() : false;

  const load = useCallback(async () => {
    if (!contracts.council) return;
    setLoading(true);
    try {
      const [memberList, g, th, vp, ed, vw, me] = await Promise.all([
        contracts.council.getMemberList().catch(() => []),
        contracts.council.guardian().catch(() => ""),
        contracts.council.threshold().catch(() => 0n),
        contracts.council.votingPeriodBlocks().catch(() => 0n),
        contracts.council.executionDelayBlocks().catch(() => 0n),
        contracts.council.vetoWindowBlocks().catch(() => 0n),
        contracts.council.maxExecutionWindowBlocks().catch(() => 0n),
      ]);
      setMembers((memberList as string[]) ?? []);
      setGuardian(String(g));
      setThreshold(Number(th));
      setConfig({
        votingPeriod: Number(vp),
        execDelay: Number(ed),
        vetoWindow: Number(vw),
        maxExec: Number(me),
      });

      // Grant treasury state
      try {
        const [gt, perMax, monthMax, monthUsed] = await Promise.all([
          contracts.council.grantToken().catch(() => ethers.ZeroAddress),
          contracts.council.grantPerProposalMax().catch(() => 0n),
          contracts.council.grantMonthlyMax().catch(() => 0n),
          contracts.council.grantMonthlyUsed().catch(() => 0n),
        ]);
        setGrantToken(String(gt));
        setGrantPerProposalMax(BigInt(perMax));
        setGrantMonthlyMax(BigInt(monthMax));
        setGrantMonthlyUsed(BigInt(monthUsed));
      } catch { /* legacy deployment */ }

      const nextId = Number(await contracts.council.nextProposalId().catch(() => 0n));
      const loaded: CouncilProposal[] = [];
      for (let i = nextId - 1; i >= 0; i--) {
        try {
          const [p, st, actions] = await Promise.all([
            contracts.council.proposals(BigInt(i)),
            contracts.council.proposalState(BigInt(i)),
            contracts.council.getProposalActions(BigInt(i)).catch(() => [[], [], [], ""]),
          ]);
          let voted = false;
          if (address) {
            try { voted = Boolean(await contracts.council.hasVoted(BigInt(i), address)); } catch { /* */ }
          }
          loaded.push({
            id: i,
            proposer: String(p.proposer ?? p[0] ?? ""),
            description: String((actions as any)[3] ?? ""),
            proposedBlock: Number(p.proposedBlock ?? p[1] ?? 0),
            votingEndsBlock: Number(p.votingEndsBlock ?? p[2] ?? 0),
            executableAfterBlock: Number(p.executableAfterBlock ?? p[3] ?? 0),
            executionExpiresBlock: Number(p.executionExpiresBlock ?? p[4] ?? 0),
            voteCount: Number(p.voteCount ?? p[5] ?? 0),
            executed: Boolean(p.executed ?? p[6] ?? false),
            vetoed: Boolean(p.vetoed ?? p[7] ?? false),
            cancelled: Boolean(p.cancelled ?? p[8] ?? false),
            state: Number(st),
            hasVoted: voted,
            targets: ((actions as any)[0] ?? []) as string[],
            callDataLengths: (((actions as any)[2] ?? []) as string[]).map((d) => (d.length - 2) / 2),
          });
        } catch { /* skip malformed */ }
      }
      setProposals(loaded);
    } finally {
      setLoading(false);
    }
  }, [address, contracts.council]);

  useEffect(() => { load(); }, [load]);

  async function handleVote(id: number) {
    if (!signer) return;
    setBusyId(id);
    setTxState("pending"); setTxMsg("");
    try {
      const c = contracts.council.connect(signer);
      const tx = await c.vote(BigInt(id));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Voted on proposal #${id}.`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleExecute(id: number) {
    if (!signer) return;
    setBusyId(id);
    setTxState("pending"); setTxMsg("");
    try {
      const c = contracts.council.connect(signer);
      const tx = await c.execute(BigInt(id));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Executed proposal #${id}.`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleVeto(id: number) {
    if (!signer) return;
    setBusyId(id);
    setTxState("pending"); setTxMsg("");
    try {
      const c = contracts.council.connect(signer);
      const tx = await c.veto(BigInt(id));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Vetoed proposal #${id}.`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(id: number) {
    if (!signer) return;
    setBusyId(id);
    setTxState("pending"); setTxMsg("");
    try {
      const c = contracts.council.connect(signer);
      const tx = await c.cancel(BigInt(id));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Cancelled proposal #${id}.`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleProposeGrant(e: React.FormEvent) {
    e.preventDefault();
    if (!signer || !isMember) return;
    setTxState("pending"); setTxMsg("");
    try {
      const recipient = grantRecipient.trim();
      if (!ethers.isAddress(recipient)) throw new Error("Invalid recipient address");
      // Grant token uses 10 decimals (WDATUM); accept human-readable input.
      const amount = ethers.parseUnits(grantAmount.trim(), 10);
      if (amount <= 0n) throw new Error("Amount must be positive");
      if (amount > grantPerProposalMax) {
        throw new Error(`Above per-proposal cap (${ethers.formatUnits(grantPerProposalMax, 10)} DATUM)`);
      }
      const iface = new Interface(["function executeGrant(address recipient, uint256 amount)"]);
      const calldata = iface.encodeFunctionData("executeGrant", [recipient, amount]);
      const councilAddr = settings.contractAddresses.council;
      const c = contracts.council.connect(signer);
      const tx = await c.propose([councilAddr], [0n], [calldata], grantDescription.trim() || `Grant ${grantAmount} DATUM to ${recipient}`);
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Grant proposal submitted.");
      setGrantRecipient(""); setGrantAmount(""); setGrantDescription("");
      setShowGrant(false);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function handlePropose(e: React.FormEvent) {
    e.preventDefault();
    if (!signer || !isMember) return;
    setTxState("pending"); setTxMsg("");
    try {
      const target = propTarget.trim();
      const calldata = propCalldata.trim().startsWith("0x") ? propCalldata.trim() : "0x";
      const value = BigInt(propValue.trim() || "0");
      const c = contracts.council.connect(signer);
      const tx = await c.propose([target], [value], [calldata], propDescription.trim());
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Proposal submitted.");
      setPropTarget(""); setPropValue("0"); setPropCalldata(""); setPropDescription("");
      setShowPropose(false);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  if (!contracts.council) {
    return (
      <div className="nano-fade" style={{ maxWidth: 760 }}>
        <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Council</h1>
        <div className="nano-info nano-info--warn" style={{ marginTop: 12 }}>
          DatumCouncil contract not configured for this network.
        </div>
      </div>
    );
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 820 }}>
      <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0" }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Council</h1>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => load()} className="nano-btn" style={{ fontSize: 12 }}>Refresh</button>
          {isMember && (
            <>
              <button
                onClick={() => { setShowPropose((s) => !s); setShowGrant(false); }}
                className="nano-btn nano-btn-accent"
                style={{ padding: "6px 14px", fontSize: 13 }}
              >
                {showPropose ? "Close" : "+ New Proposal"}
              </button>
              <button
                onClick={() => { setShowGrant((s) => !s); setShowPropose(false); }}
                className="nano-btn"
                style={{ padding: "6px 14px", fontSize: 13 }}
                disabled={!grantToken || grantToken === ethers.ZeroAddress}
                title={!grantToken || grantToken === ethers.ZeroAddress ? "Grant token not configured" : ""}
              >
                {showGrant ? "Close" : "+ Grant"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Grant treasury */}
      {grantToken && grantToken !== ethers.ZeroAddress && (
        <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Grant treasury</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12 }}>
            <span style={{ color: "var(--text-muted)" }}>Grant token</span>
            <AddressDisplay address={grantToken} chars={8} style={{ fontSize: 11 }} />
            <span style={{ color: "var(--text-muted)" }}>Per-proposal cap</span>
            <span style={{ color: "var(--text)" }}>{ethers.formatUnits(grantPerProposalMax, 10)} DATUM</span>
            <span style={{ color: "var(--text-muted)" }}>Monthly cap</span>
            <span style={{ color: "var(--text)" }}>{ethers.formatUnits(grantMonthlyMax, 10)} DATUM</span>
            <span style={{ color: "var(--text-muted)" }}>Used this month</span>
            <span style={{ color: "var(--text)" }}>
              {ethers.formatUnits(grantMonthlyUsed, 10)} DATUM
              {grantMonthlyMax > 0n && ` (${Number(grantMonthlyUsed * 10000n / grantMonthlyMax) / 100}%)`}
            </span>
          </div>
        </div>
      )}

      {/* Grant proposal form */}
      {showGrant && isMember && (
        <form onSubmit={handleProposeGrant} className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Propose grant</div>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 12 }}>
            Builds a council proposal that, once passed + executed, calls{" "}
            <code>executeGrant(recipient, amount)</code> on the council contract itself.
            Standard threshold + execution delay + veto window apply.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Recipient address
              <input className="nano-input" value={grantRecipient} onChange={(e) => setGrantRecipient(e.target.value)} placeholder="0x..." style={{ marginTop: 4 }} required />
            </label>
            <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Amount (DATUM, 10 decimals)
              <input className="nano-input" value={grantAmount} onChange={(e) => setGrantAmount(e.target.value)} placeholder="100" style={{ marginTop: 4 }} required />
            </label>
            <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Description
              <textarea className="nano-input" value={grantDescription} onChange={(e) => setGrantDescription(e.target.value)} rows={2} style={{ marginTop: 4 }} placeholder="Why this grant?" />
            </label>
            <button type="submit" className="nano-btn nano-btn-accent" style={{ alignSelf: "flex-start", padding: "6px 16px", fontSize: 12 }}>
              Submit grant proposal
            </button>
          </div>
        </form>
      )}

      {/* Membership + config */}
      <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Members ({members.length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {members.map((m) => (
                <div key={m} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <AddressDisplay address={m} chars={8} style={{ fontSize: 12 }} />
                  {address && m.toLowerCase() === address.toLowerCase() && (
                    <span className="nano-badge" style={{ color: "var(--ok)", fontSize: 10 }}>you</span>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Guardian</div>
            {guardian && guardian !== "0x0000000000000000000000000000000000000000" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AddressDisplay address={guardian} chars={8} style={{ fontSize: 12 }} />
                {isGuardian && <span className="nano-badge" style={{ color: "var(--warn)", fontSize: 10 }}>you</span>}
              </div>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic" }}>no veto power</div>
            )}
          </div>
        </div>
        {config && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
            <div>Threshold: <strong style={{ color: "var(--text)" }}>{threshold} of {members.length}</strong></div>
            <div>Voting: <strong style={{ color: "var(--text)" }}>{formatBlockDelta(config.votingPeriod)}</strong></div>
            <div>Exec delay: <strong style={{ color: "var(--text)" }}>{formatBlockDelta(config.execDelay)}</strong></div>
            <div>Veto window: <strong style={{ color: "var(--text)" }}>{formatBlockDelta(config.vetoWindow)}</strong></div>
            <div>Exec window: <strong style={{ color: "var(--text)" }}>{formatBlockDelta(config.maxExec)}</strong></div>
          </div>
        )}
      </div>

      {/* Propose form */}
      {showPropose && isMember && (
        <form onSubmit={handlePropose} className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>New Proposal</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>Description</label>
              <input
                value={propDescription}
                onChange={(e) => setPropDescription(e.target.value)}
                className="nano-input"
                placeholder="What does this proposal do?"
                required
                style={{ fontSize: 12 }}
              />
            </div>
            <div>
              <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>Target contract</label>
              <input
                value={propTarget}
                onChange={(e) => setPropTarget(e.target.value)}
                className="nano-input"
                placeholder="0x... (e.g. governance router)"
                required
                style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
              <div>
                <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>Value (planck)</label>
                <input
                  value={propValue}
                  onChange={(e) => setPropValue(e.target.value)}
                  className="nano-input"
                  type="number"
                  min="0"
                  style={{ fontSize: 12 }}
                />
              </div>
              <div>
                <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>Calldata</label>
                <input
                  value={propCalldata}
                  onChange={(e) => setPropCalldata(e.target.value)}
                  className="nano-input"
                  placeholder="0x..."
                  required
                  style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}
                />
              </div>
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
              Single-call proposals only (multi-call composition not exposed in this UI).
              Encode calldata via <code style={{ color: "var(--accent)" }}>iface.encodeFunctionData(name, args)</code>.
            </div>
            <button type="submit" disabled={txState === "pending"} className="nano-btn nano-btn-accent" style={{ padding: "8px 16px", fontSize: 13 }}>
              {txState === "pending" ? "Submitting…" : "Submit Proposal"}
            </button>
          </div>
        </form>
      )}

      <TransactionStatus state={txState} message={txMsg} />

      {loading ? (
        <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Loading proposals</div>
      ) : proposals.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: 20, textAlign: "center" }}>
          No council proposals yet.
        </div>
      ) : (
        <div>
          {proposals.map((p) => {
            const stateLabel = STATE_LABELS[p.state] ?? "?";
            const stateColor = STATE_COLORS[p.state] ?? "var(--text)";
            const isProposer = address && p.proposer.toLowerCase() === address.toLowerCase();
            const canVote = isMember && p.state === 0 && !p.hasVoted;
            const canExecute = p.state === 1 && blockNumber !== null && blockNumber >= p.executableAfterBlock;
            const inVetoWindow = config && blockNumber !== null && blockNumber <= p.proposedBlock + config.vetoWindow;
            const canVeto = isGuardian && !p.executed && !p.vetoed && inVetoWindow;
            const canCancel = isProposer && !p.executed && !p.vetoed && !p.cancelled;
            const blocksToVoteEnd = blockNumber !== null ? Math.max(0, p.votingEndsBlock - blockNumber) : 0;
            const blocksToExecutable = blockNumber !== null && p.executableAfterBlock > 0
              ? Math.max(0, p.executableAfterBlock - blockNumber) : 0;
            const blocksToExpiry = blockNumber !== null && p.executionExpiresBlock > 0
              ? Math.max(0, p.executionExpiresBlock - blockNumber) : 0;

            return (
              <div key={p.id} className="nano-card" style={{ padding: 14, marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                  <div>
                    <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: 14 }}>Proposal #{p.id}</span>
                    <span style={{ marginLeft: 8, color: stateColor, fontSize: 11, fontWeight: 600 }}>{stateLabel}</span>
                  </div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                    Votes: <strong style={{ color: p.voteCount >= threshold ? "var(--ok)" : "var(--text)" }}>{p.voteCount} / {threshold}</strong>
                  </div>
                </div>

                {p.description && (
                  <div style={{ color: "var(--text)", fontSize: 13, marginBottom: 8 }}>{p.description}</div>
                )}

                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                  <div>Proposer: <AddressDisplay address={p.proposer} chars={6} style={{ fontSize: 11 }} /></div>
                  {p.targets[0] && (
                    <div>Target: <code style={{ color: "var(--text)" }}>{p.targets[0].slice(0, 10)}…{p.targets[0].slice(-4)}</code> ({p.callDataLengths[0]}B calldata)</div>
                  )}
                  {p.state === 0 && blocksToVoteEnd > 0 && (
                    <div>Voting ends: <strong style={{ color: "var(--text)" }}>{formatBlockDelta(blocksToVoteEnd)}</strong></div>
                  )}
                  {p.state === 1 && blocksToExecutable > 0 && (
                    <div>Executable in: <strong style={{ color: "var(--text)" }}>{formatBlockDelta(blocksToExecutable)}</strong></div>
                  )}
                  {p.state === 1 && blocksToExecutable === 0 && blocksToExpiry > 0 && (
                    <div>Window expires: <strong style={{ color: "var(--warn)" }}>{formatBlockDelta(blocksToExpiry)}</strong></div>
                  )}
                </div>

                {p.hasVoted && (
                  <div style={{ fontSize: 11, color: "var(--ok)", marginBottom: 6 }}>You voted on this proposal.</div>
                )}

                {signer && (canVote || canExecute || canVeto || canCancel) && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {canVote && (
                      <button onClick={() => handleVote(p.id)} disabled={busyId === p.id} className="nano-btn nano-btn-accent" style={{ padding: "5px 12px", fontSize: 12 }}>
                        {busyId === p.id ? "Voting…" : "Vote Yes"}
                      </button>
                    )}
                    {canExecute && (
                      <button onClick={() => handleExecute(p.id)} disabled={busyId === p.id} className="nano-btn" style={{ padding: "5px 12px", fontSize: 12, color: "var(--ok)", border: "1px solid rgba(74,222,128,0.3)" }}>
                        {busyId === p.id ? "Executing…" : "Execute"}
                      </button>
                    )}
                    {canVeto && (
                      <button onClick={() => handleVeto(p.id)} disabled={busyId === p.id} className="nano-btn" style={{ padding: "5px 12px", fontSize: 12, color: "var(--error)", border: "1px solid rgba(248,113,113,0.3)" }}>
                        {busyId === p.id ? "Vetoing…" : "Veto"}
                      </button>
                    )}
                    {canCancel && (
                      <button onClick={() => handleCancel(p.id)} disabled={busyId === p.id} className="nano-btn" style={{ padding: "5px 12px", fontSize: 12 }}>
                        {busyId === p.id ? "Cancelling…" : "Cancel"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
