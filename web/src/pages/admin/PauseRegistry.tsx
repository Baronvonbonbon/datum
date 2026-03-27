import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";

const PAUSED_CONTRACTS = [
  "Campaigns",
  "Publishers",
  "Settlement",
  "GovernanceV2",
  "Relay",
];

export function PauseRegistryAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const [paused, setPaused] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const p = await contracts.pauseRegistry.paused().catch(() => null);
      setPaused(p === null ? null : Boolean(p));
    } finally {
      setLoading(false);
    }
  }

  async function handlePause() {
    if (!signer) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.pauseRegistry.connect(signer);
      const tx = await c.pause();
      await tx.wait();
      setTxState("success");
      setTxMsg("Protocol paused. All contract operations are suspended.");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function handleUnpause() {
    if (!signer) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.pauseRegistry.connect(signer);
      const tx = await c.unpause();
      await tx.wait();
      setTxState("success");
      setTxMsg("Protocol unpaused. Operations resumed.");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 560 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Pause Registry</h1>

      <div className="nano-info nano-info--muted" style={{ marginBottom: 16, fontSize: 12 }}>
        The pause registry provides a single on-chain flag checked by all protocol contracts. In an emergency, pausing here suspends all user-facing operations simultaneously.
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)" }}>Loading...</div>
      ) : (
        <>
          <div className="nano-card" style={{
            border: `1px solid ${paused ? "rgba(252,165,165,0.3)" : "rgba(110,231,183,0.2)"}`,
            padding: 16, marginBottom: 16,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 4 }}>Protocol Status</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: paused ? "var(--error)" : "var(--ok)" }}>
                  {paused === null ? "Unknown" : paused ? "PAUSED" : "ACTIVE"}
                </div>
              </div>
              {signer && paused !== null && (
                <button
                  onClick={paused ? handleUnpause : handlePause}
                  disabled={txState === "pending"}
                  className="nano-btn"
                  style={{
                    padding: "8px 18px",
                    fontSize: 13,
                    fontWeight: 600,
                    color: paused ? "var(--ok)" : "var(--error)",
                    border: paused ? "1px solid rgba(110,231,183,0.3)" : "1px solid rgba(252,165,165,0.3)",
                  }}
                >
                  {txState === "pending" ? "Processing..." : paused ? "Unpause Protocol" : "Pause Protocol"}
                </button>
              )}
            </div>
          </div>

          <TransactionStatus state={txState} message={txMsg} />

          <div className="nano-card" style={{ padding: 14 }}>
            <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Affected Contracts</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {PAUSED_CONTRACTS.map((name) => (
                <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ color: "var(--text)", fontSize: 13 }}>{name}</span>
                  <span style={{ fontSize: 11, color: paused ? "var(--error)" : "var(--ok)" }}>
                    {paused ? "Paused" : "Active"}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 10 }}>
              BudgetLedger, PaymentVault, CampaignLifecycle, GovernanceSlash, and Timelock are not pause-gated (allow safe resolution of in-progress actions).
            </div>
          </div>
        </>
      )}
    </div>
  );
}
