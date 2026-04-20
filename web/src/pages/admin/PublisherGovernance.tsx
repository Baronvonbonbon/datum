import { useState } from "react";
import { formatEther, parseEther } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { AdminNav } from "../../components/AdminNav";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";

const STATE_LABELS = ["Active", "Upheld", "Dismissed", "Cancelled"] as const;
function stateColor(s: number) {
  return s === 0 ? "var(--warn)" : s === 1 ? "var(--error)" : s === 2 ? "var(--ok)" : "#888";
}

export function PublisherGovernanceAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  // Proposal lookup
  const [lookupId, setLookupId] = useState("");
  const [proposal, setProposal] = useState<{
    publisher: string; proposer: string; evidenceHash: string;
    startBlock: bigint; graceUntil: bigint;
    ayeWeight: bigint; nayWeight: bigint; state: number;
  } | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  // Propose (fraud accusation)
  const [propPublisher, setPropPublisher] = useState("");
  const [propEvidence, setPropEvidence] = useState("");
  const [proposeTxState, setProposeTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [proposeTxMsg, setProposeTxMsg] = useState("");

  // Vote
  const [voteId, setVoteId] = useState("");
  const [voteAye, setVoteAye] = useState(true);
  const [voteConviction, setVoteConviction] = useState(0);
  const [voteAmount, setVoteAmount] = useState("1");
  const [voteTxState, setVoteTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [voteTxMsg, setVoteTxMsg] = useState("");

  // Resolve / Cancel
  const [actionId, setActionId] = useState("");
  const [actionTxState, setActionTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [actionTxMsg, setActionTxMsg] = useState("");

  // Params
  const [params, setParams] = useState({ quorum: "", slashBps: "", bonusBps: "", grace: "" });
  const [paramsTxState, setParamsTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [paramsTxMsg, setParamsTxMsg] = useState("");

  async function handleLookup() {
    if (!contracts.publisherGovernance) return;
    setLookupLoading(true);
    setProposal(null);
    try {
      const p = await contracts.publisherGovernance.proposals(BigInt(lookupId));
      setProposal({
        publisher: p.publisher, proposer: p.proposer, evidenceHash: p.evidenceHash,
        startBlock: p.startBlock, graceUntil: p.graceUntil,
        ayeWeight: p.ayeWeight, nayWeight: p.nayWeight, state: Number(p.state),
      });
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    } finally {
      setLookupLoading(false);
    }
  }

  async function handlePropose() {
    if (!contracts.publisherGovernance || !signer) return;
    setProposeTxState("pending");
    setProposeTxMsg("Submitting accusation…");
    try {
      const gov = contracts.publisherGovernance.connect(signer);
      const tx = await confirmTx(() => gov.propose(propPublisher, propEvidence || "0x" + "0".repeat(64)));
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
    if (!contracts.publisherGovernance || !signer) return;
    setVoteTxState("pending");
    setVoteTxMsg("Casting vote…");
    try {
      const gov = contracts.publisherGovernance.connect(signer);
      const tx = await confirmTx(() =>
        gov.vote(BigInt(voteId), voteAye, voteConviction, { value: parseEther(voteAmount) })
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

  async function handleAction(action: "resolve" | "cancel") {
    if (!contracts.publisherGovernance || !signer) return;
    setActionTxState("pending");
    setActionTxMsg(`${action}…`);
    try {
      const gov = contracts.publisherGovernance.connect(signer);
      const id = BigInt(actionId);
      const tx = await confirmTx(() => action === "resolve" ? gov.resolve(id) : gov.cancel(id));
      if (!tx) { setActionTxState("idle"); return; }
      await tx.wait();
      setActionTxState("success");
      setActionTxMsg(`${action} done.`);
    } catch (err) {
      setActionTxState("error");
      setActionTxMsg(humanizeError(err));
    }
  }

  async function loadParams() {
    if (!contracts.publisherGovernance) return;
    try {
      const [q, slash, bonus, grace] = await Promise.all([
        contracts.publisherGovernance.quorum(),
        contracts.publisherGovernance.slashBps(),
        contracts.publisherGovernance.bondBonusBps(),
        contracts.publisherGovernance.minGraceBlocks(),
      ]);
      setParams({ quorum: formatEther(q), slashBps: slash.toString(), bonusBps: bonus.toString(), grace: grace.toString() });
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    }
  }

  async function handleSetParams() {
    if (!contracts.publisherGovernance || !signer) return;
    setParamsTxState("pending");
    setParamsTxMsg("Updating…");
    try {
      const gov = contracts.publisherGovernance.connect(signer);
      const tx = await confirmTx(() =>
        gov.setParams(parseEther(params.quorum), BigInt(params.slashBps), BigInt(params.bonusBps), BigInt(params.grace))
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

  return (
    <div style={{ padding: "2rem", maxWidth: 720 }}>
      <AdminNav />
      <h1 style={{ marginBottom: "0.25rem" }}>Publisher Governance</h1>
      <p style={{ color: "#888", marginBottom: "2rem", fontSize: "0.85rem" }}>
        FP-3 — Conviction-weighted fraud governance. Fraud upheld → slash publisher stake → bonus pool to challengers.
      </p>

      {/* Proposal lookup */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Proposal Lookup</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input placeholder="Proposal ID" value={lookupId} onChange={e => setLookupId(e.target.value)} style={{ width: 120 }} />
          <button onClick={handleLookup} disabled={lookupLoading || !lookupId}>{lookupLoading ? "Loading…" : "Fetch"}</button>
        </div>
        {proposal && (
          <div style={{ marginTop: "0.75rem", background: "var(--surface)", padding: "1rem", borderRadius: 8, fontSize: "0.85rem" }}>
            <div><b>State:</b> <span style={{ color: stateColor(proposal.state), fontWeight: 700 }}>{STATE_LABELS[proposal.state]}</span></div>
            <div><b>Publisher:</b> {proposal.publisher}</div>
            <div><b>Proposer:</b> {proposal.proposer}</div>
            <div><b>Evidence:</b> <code style={{ fontSize: 11 }}>{proposal.evidenceHash}</code></div>
            <div><b>Blocks:</b> start {proposal.startBlock.toString()} · grace until {proposal.graceUntil.toString()}</div>
            <div><b>Aye:</b> {formatEther(proposal.ayeWeight)} DOT-equiv &nbsp; <b>Nay:</b> {formatEther(proposal.nayWeight)} DOT-equiv</div>
          </div>
        )}
      </section>

      {/* Propose */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Accuse Publisher</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <input placeholder="Publisher address" value={propPublisher} onChange={e => setPropPublisher(e.target.value)} />
          <input placeholder="Evidence hash (bytes32, 0x…)" value={propEvidence} onChange={e => setPropEvidence(e.target.value)} />
          <button onClick={handlePropose} disabled={proposeTxState === "pending" || !propPublisher}>
            {proposeTxState === "pending" ? "Submitting…" : "Propose (accuse)"}
          </button>
        </div>
        <TransactionStatus state={proposeTxState} message={proposeTxMsg} />
      </section>

      {/* Vote */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Cast Vote</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <input placeholder="Proposal ID" value={voteId} onChange={e => setVoteId(e.target.value)} style={{ width: 120 }} />
          <div style={{ display: "flex", gap: "1rem" }}>
            <label><input type="radio" checked={voteAye} onChange={() => setVoteAye(true)} /> Aye (fraud)</label>
            <label><input type="radio" checked={!voteAye} onChange={() => setVoteAye(false)} /> Nay (legitimate)</label>
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

      {/* Resolve / Cancel */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Resolve / Cancel</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input placeholder="Proposal ID" value={actionId} onChange={e => setActionId(e.target.value)} style={{ width: 120 }} />
          <button onClick={() => handleAction("resolve")} disabled={actionTxState === "pending" || !actionId}>Resolve</button>
          <button onClick={() => handleAction("cancel")} disabled={actionTxState === "pending" || !actionId}
            style={{ background: "var(--error)" }}>Cancel</button>
        </div>
        <TransactionStatus state={actionTxState} message={actionTxMsg} />
      </section>

      {/* Params */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Governance Parameters (owner only)</h2>
        <button onClick={loadParams} style={{ marginBottom: "0.5rem", fontSize: "0.8rem" }}>Load current values</button>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "0.4rem" }}>
          <input placeholder="Quorum (DOT)" value={params.quorum} onChange={e => setParams(p => ({ ...p, quorum: e.target.value }))} />
          <input placeholder="Slash bps" value={params.slashBps} onChange={e => setParams(p => ({ ...p, slashBps: e.target.value }))} />
          <input placeholder="Bonus bps" value={params.bonusBps} onChange={e => setParams(p => ({ ...p, bonusBps: e.target.value }))} />
          <input placeholder="Grace blocks" value={params.grace} onChange={e => setParams(p => ({ ...p, grace: e.target.value }))} />
        </div>
        <button onClick={handleSetParams} disabled={paramsTxState === "pending"} style={{ marginTop: "0.5rem" }}>
          {paramsTxState === "pending" ? "Updating…" : "setParams"}
        </button>
        <TransactionStatus state={paramsTxState} message={paramsTxMsg} />
      </section>
    </div>
  );
}
