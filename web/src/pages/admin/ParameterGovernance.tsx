import { useState } from "react";
import { parseEther, formatEther, ZeroAddress } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { AdminNav } from "../../components/AdminNav";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";

// State enum matching DatumParameterGovernance
const STATE_LABELS = ["Active", "Passed", "Executed", "Rejected", "Cancelled"] as const;

function stateColor(s: number) {
  return s === 0 ? "var(--warn)" : s === 1 ? "var(--ok)" : s === 2 ? "#888" : "var(--error)";
}

export function ParameterGovernanceAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  // ── Proposal lookup ──
  const [lookupId, setLookupId] = useState("");
  const [proposal, setProposal] = useState<{
    proposer: string; target: string; description: string;
    startBlock: bigint; endBlock: bigint; executeAfter: bigint;
    ayeWeight: bigint; nayWeight: bigint; bond: bigint; state: number;
  } | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  // ── Propose ──
  const [propTarget, setPropTarget] = useState("");
  const [propPayload, setPropPayload] = useState("");
  const [propDesc, setPropDesc] = useState("");
  const [propBond, setPropBond] = useState("2");
  const [proposeTxState, setProposeTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [proposeTxMsg, setProposeTxMsg] = useState("");

  // ── Vote ──
  const [voteId, setVoteId] = useState("");
  const [voteAye, setVoteAye] = useState(true);
  const [voteConviction, setVoteConviction] = useState(0);
  const [voteAmount, setVoteAmount] = useState("1");
  const [voteTxState, setVoteTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [voteTxMsg, setVoteTxMsg] = useState("");

  // ── Resolve / Execute / Cancel ──
  const [actionId, setActionId] = useState("");
  const [actionTxState, setActionTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [actionTxMsg, setActionTxMsg] = useState("");

  // ── Params ──
  const [params, setParams] = useState({ votingPeriod: "", timelock: "", quorum: "", bond: "" });
  const [paramsTxState, setParamsTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [paramsTxMsg, setParamsTxMsg] = useState("");

  async function handleLookup() {
    if (!contracts.parameterGovernance) return;
    setLookupLoading(true);
    setProposal(null);
    try {
      const id = BigInt(lookupId);
      const p = await contracts.parameterGovernance.proposals(id);
      setProposal({
        proposer: p.proposer, target: p.target, description: p.description,
        startBlock: p.startBlock, endBlock: p.endBlock, executeAfter: p.executeAfter,
        ayeWeight: p.ayeWeight, nayWeight: p.nayWeight, bond: p.bond, state: Number(p.state),
      });
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    } finally {
      setLookupLoading(false);
    }
  }

  async function handlePropose() {
    if (!contracts.parameterGovernance || !signer) return;
    setProposeTxState("pending");
    setProposeTxMsg("Submitting proposal…");
    try {
      const gov = contracts.parameterGovernance.connect(signer);
      const bondValue = parseEther(propBond);
      const tx = await confirmTx(() =>
        gov.propose(propTarget, propPayload || "0x", propDesc, { value: bondValue })
      );
      if (!tx) { setProposeTxState("idle"); return; }
      await tx.wait();
      setProposeTxState("success");
      setProposeTxMsg("Proposal submitted.");
    } catch (err) {
      setProposeTxState("error");
      setProposeTxMsg(humanizeError(err));
    }
  }

  async function handleVote() {
    if (!contracts.parameterGovernance || !signer) return;
    setVoteTxState("pending");
    setVoteTxMsg("Casting vote…");
    try {
      const gov = contracts.parameterGovernance.connect(signer);
      const amount = parseEther(voteAmount);
      const tx = await confirmTx(() =>
        gov.vote(BigInt(voteId), voteAye, voteConviction, { value: amount })
      );
      if (!tx) { setVoteTxState("idle"); return; }
      await tx.wait();
      setVoteTxState("success");
      setVoteTxMsg("Vote cast.");
    } catch (err) {
      setVoteTxState("error");
      setVoteTxMsg(humanizeError(err));
    }
  }

  async function handleAction(action: "resolve" | "execute" | "cancel") {
    if (!contracts.parameterGovernance || !signer) return;
    setActionTxState("pending");
    setActionTxMsg(`${action}…`);
    try {
      const gov = contracts.parameterGovernance.connect(signer);
      const id = BigInt(actionId);
      const tx = await confirmTx(() =>
        action === "resolve" ? gov.resolve(id) :
        action === "execute" ? gov.execute(id) :
        gov.cancel(id)
      );
      if (!tx) { setActionTxState("idle"); return; }
      await tx.wait();
      setActionTxState("success");
      setActionTxMsg(`${action} succeeded.`);
    } catch (err) {
      setActionTxState("error");
      setActionTxMsg(humanizeError(err));
    }
  }

  async function handleSetParams() {
    if (!contracts.parameterGovernance || !signer) return;
    setParamsTxState("pending");
    setParamsTxMsg("Updating params…");
    try {
      const gov = contracts.parameterGovernance.connect(signer);
      const tx = await confirmTx(() =>
        gov.setParams(
          BigInt(params.votingPeriod),
          BigInt(params.timelock),
          parseEther(params.quorum),
          parseEther(params.bond),
        )
      );
      if (!tx) { setParamsTxState("idle"); return; }
      await tx.wait();
      setParamsTxState("success");
      setParamsTxMsg("Params updated.");
    } catch (err) {
      setParamsTxState("error");
      setParamsTxMsg(humanizeError(err));
    }
  }

  async function loadCurrentParams() {
    if (!contracts.parameterGovernance) return;
    try {
      const [vp, tl, q, b] = await Promise.all([
        contracts.parameterGovernance.votingPeriodBlocks(),
        contracts.parameterGovernance.timelockBlocks(),
        contracts.parameterGovernance.quorum(),
        contracts.parameterGovernance.proposeBond(),
      ]);
      setParams({
        votingPeriod: vp.toString(),
        timelock: tl.toString(),
        quorum: formatEther(q),
        bond: formatEther(b),
      });
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    }
  }

  return (
    <div style={{ padding: "2rem", maxWidth: 720 }}>
      <AdminNav />
      <h1 style={{ marginBottom: "0.25rem" }}>Parameter Governance</h1>
      <p style={{ color: "#888", marginBottom: "2rem", fontSize: "0.85rem" }}>
        T1-B — Conviction-vote governance for FP system parameter changes.
        Proposals execute arbitrary <code>target.call(payload)</code> after passing.
      </p>

      {/* ── Proposal Lookup ── */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Proposal Lookup</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
          <input
            placeholder="Proposal ID"
            value={lookupId}
            onChange={e => setLookupId(e.target.value)}
            style={{ width: 120 }}
          />
          <button onClick={handleLookup} disabled={lookupLoading || !lookupId}>
            {lookupLoading ? "Loading…" : "Fetch"}
          </button>
        </div>
        {proposal && (
          <div style={{ marginTop: "0.75rem", background: "var(--surface)", padding: "1rem", borderRadius: 8, fontSize: "0.85rem" }}>
            <div><b>State:</b> <span style={{ color: stateColor(proposal.state) }}>{STATE_LABELS[proposal.state]}</span></div>
            <div><b>Proposer:</b> {proposal.proposer}</div>
            <div><b>Target:</b> {proposal.target}</div>
            <div><b>Description:</b> {proposal.description}</div>
            <div><b>Blocks:</b> {proposal.startBlock.toString()} → {proposal.endBlock.toString()}
              {proposal.executeAfter > 0n && <> (exec after {proposal.executeAfter.toString()})</>}
            </div>
            <div><b>Aye weight:</b> {formatEther(proposal.ayeWeight)} DOT-equiv &nbsp;
                 <b>Nay weight:</b> {formatEther(proposal.nayWeight)} DOT-equiv</div>
            <div><b>Bond:</b> {formatEther(proposal.bond)} DOT</div>
          </div>
        )}
      </section>

      {/* ── Propose ── */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Submit Proposal</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <input placeholder="Target contract address" value={propTarget} onChange={e => setPropTarget(e.target.value)} />
          <input placeholder="Encoded calldata (0x…)" value={propPayload} onChange={e => setPropPayload(e.target.value)} />
          <input placeholder="Description" value={propDesc} onChange={e => setPropDesc(e.target.value)} />
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input placeholder="Bond (DOT)" value={propBond} onChange={e => setPropBond(e.target.value)} style={{ width: 120 }} />
            <button onClick={handlePropose} disabled={proposeTxState === "pending" || !propTarget || !propDesc}>
              {proposeTxState === "pending" ? "Submitting…" : "Propose"}
            </button>
          </div>
        </div>
        <TransactionStatus state={proposeTxState} message={proposeTxMsg} />
      </section>

      {/* ── Vote ── */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Cast Vote</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <input placeholder="Proposal ID" value={voteId} onChange={e => setVoteId(e.target.value)} style={{ width: 120 }} />
          <div style={{ display: "flex", gap: "1rem" }}>
            <label><input type="radio" checked={voteAye} onChange={() => setVoteAye(true)} /> Aye</label>
            <label><input type="radio" checked={!voteAye} onChange={() => setVoteAye(false)} /> Nay</label>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <label>Conviction:
              <select value={voteConviction} onChange={e => setVoteConviction(Number(e.target.value))} style={{ marginLeft: "0.5rem" }}>
                {[0,1,2,3,4,5,6,7,8].map(c => (
                  <option key={c} value={c}>{c} (×{[1,2,3,4,6,9,14,18,21][c]})</option>
                ))}
              </select>
            </label>
            <input placeholder="Amount (DOT)" value={voteAmount} onChange={e => setVoteAmount(e.target.value)} style={{ width: 120 }} />
            <button onClick={handleVote} disabled={voteTxState === "pending" || !voteId}>
              {voteTxState === "pending" ? "Voting…" : "Vote"}
            </button>
          </div>
        </div>
        <TransactionStatus state={voteTxState} message={voteTxMsg} />
      </section>

      {/* ── Resolve / Execute / Cancel ── */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Resolve / Execute / Cancel</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <input placeholder="Proposal ID" value={actionId} onChange={e => setActionId(e.target.value)} style={{ width: 120 }} />
          <button onClick={() => handleAction("resolve")} disabled={actionTxState === "pending" || !actionId}>Resolve</button>
          <button onClick={() => handleAction("execute")} disabled={actionTxState === "pending" || !actionId}>Execute</button>
          <button onClick={() => handleAction("cancel")} disabled={actionTxState === "pending" || !actionId}
            style={{ background: "var(--error)" }}>Cancel</button>
        </div>
        <TransactionStatus state={actionTxState} message={actionTxMsg} />
      </section>

      {/* ── setParams ── */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Governance Parameters (owner only)</h2>
        <button onClick={loadCurrentParams} style={{ marginBottom: "0.5rem", fontSize: "0.8rem" }}>Load current values</button>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem" }}>
          <input placeholder="Voting period (blocks)" value={params.votingPeriod} onChange={e => setParams(p => ({ ...p, votingPeriod: e.target.value }))} />
          <input placeholder="Timelock (blocks)" value={params.timelock} onChange={e => setParams(p => ({ ...p, timelock: e.target.value }))} />
          <input placeholder="Quorum (DOT)" value={params.quorum} onChange={e => setParams(p => ({ ...p, quorum: e.target.value }))} />
          <input placeholder="Propose bond (DOT)" value={params.bond} onChange={e => setParams(p => ({ ...p, bond: e.target.value }))} />
        </div>
        <button onClick={handleSetParams} disabled={paramsTxState === "pending"} style={{ marginTop: "0.5rem" }}>
          {paramsTxState === "pending" ? "Updating…" : "setParams"}
        </button>
        <TransactionStatus state={paramsTxState} message={paramsTxMsg} />
      </section>
    </div>
  );
}
