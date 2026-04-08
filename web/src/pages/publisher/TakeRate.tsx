import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useBlock } from "../../hooks/useBlock";
import { TransactionStatus } from "../../components/TransactionStatus";
import { formatBlockDelta } from "@shared/conviction";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { RequirePublisher } from "../../components/RequirePublisher";
import { useToast } from "../../context/ToastContext";

export function TakeRate() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { blockNumber } = useBlock();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const [current, setCurrent] = useState<number | null>(null);
  const [pending, setPending] = useState<{ rate: number; effectiveBlock: number } | null>(null);
  const [newRate, setNewRate] = useState(50);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    try {
      const data = await contracts.publishers.getPublisher(address);
      setCurrent(Number(data.takeRateBps ?? data[1] ?? 0));
      const pendingRate = Number(data.pendingTakeRateBps ?? data[3] ?? 0);
      const effectiveBlock = Number(data.takeRateEffectiveBlock ?? data[4] ?? 0);
      if (pendingRate > 0 && effectiveBlock > 0) {
        setPending({ rate: pendingRate, effectiveBlock });
      } else {
        setPending(null);
      }
    } catch { /* not registered */ }
  }

  async function handleQueue(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;
    setTxState("pending");
    try {
      const bps = Math.round(newRate * 100);
      const c = contracts.publishers.connect(signer);
      const tx = await c.updateTakeRate(bps);
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Take rate update queued.");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function handleApply() {
    if (!signer) return;
    setTxState("pending");
    try {
      const c = contracts.publishers.connect(signer);
      const tx = await c.applyTakeRateUpdate();
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Take rate applied.");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  const canApply = pending && blockNumber && blockNumber >= pending.effectiveBlock;
  const blocksRemaining = pending && blockNumber ? Math.max(0, pending.effectiveBlock - blockNumber) : null;

  return (
    <RequirePublisher>
    <div className="nano-fade" style={{ maxWidth: 480 }}>
      <Link to="/publisher" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Take Rate</h1>

      {current !== null && (
        <div className="nano-card" style={{ padding: 12, marginBottom: 16 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Current Rate</div>
          <div style={{ color: "var(--accent)", fontSize: 24, fontWeight: 700 }}>{(current / 100).toFixed(0)}%</div>
        </div>
      )}

      {pending && (
        <div className="nano-info nano-info--warn" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Pending Update: {(pending.rate / 100).toFixed(0)}%</div>
          <div style={{ fontSize: 12 }}>
            Effective block: #{pending.effectiveBlock}
            {blocksRemaining !== null && blocksRemaining > 0 && (
              <span> · {formatBlockDelta(blocksRemaining)} remaining</span>
            )}
          </div>
          {canApply && (
            <button onClick={handleApply} disabled={txState === "pending"} className="nano-btn" style={{ marginTop: 10, padding: "6px 14px", fontSize: 13, color: "var(--ok)", border: "1px solid rgba(74,222,128,0.3)" }}>
              Apply Update Now
            </button>
          )}
        </div>
      )}

      {!pending && (
        <form onSubmit={handleQueue} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 6 }}>
              New Rate: <span style={{ color: "var(--accent)", fontWeight: 700 }}>{newRate}%</span>
            </label>
            <input type="range" min={30} max={80} value={newRate} onChange={(e) => setNewRate(Number(e.target.value))} style={{ width: "100%", accentColor: "var(--accent)" }} />
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Rate changes are delayed by the configured timelock period (~7 days).</div>
          <TransactionStatus state={txState} message={txMsg} />
          <button type="submit" disabled={txState === "pending" || !signer} className="nano-btn nano-btn-accent" style={{ padding: "8px 16px", fontSize: 13 }}>
            Queue Rate Change
          </button>
        </form>
      )}

      {(txState === "success" || txState === "error") && pending && (
        <TransactionStatus state={txState} message={txMsg} />
      )}
    </div>
    </RequirePublisher>
  );
}
