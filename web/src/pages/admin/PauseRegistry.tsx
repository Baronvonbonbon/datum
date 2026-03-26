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
    <div style={{ maxWidth: 560 }}>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Pause Registry</h1>

      <div style={{ padding: "6px 10px", background: "#0a0a14", border: "1px solid #1a1a2e", borderRadius: 4, color: "#888", fontSize: 12, marginBottom: 16 }}>
        The pause registry provides a single on-chain flag checked by all protocol contracts. In an emergency, pausing here suspends all user-facing operations simultaneously.
      </div>

      {loading ? (
        <div style={{ color: "#555" }}>Loading...</div>
      ) : (
        <>
          <div style={{ padding: 16, background: "#0d0d18", border: `1px solid ${paused ? "#5a2a2a" : "#1a2e1a"}`, borderRadius: 8, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>Protocol Status</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: paused ? "#ff6060" : "#60c060" }}>
                  {paused === null ? "Unknown" : paused ? "PAUSED" : "ACTIVE"}
                </div>
              </div>
              {signer && paused !== null && (
                <button
                  onClick={paused ? handleUnpause : handlePause}
                  disabled={txState === "pending"}
                  style={{
                    padding: "8px 18px",
                    background: paused ? "#0a2a0a" : "#2a0a0a",
                    border: `1px solid ${paused ? "#2a5a2a" : "#5a2a2a"}`,
                    borderRadius: 4,
                    color: paused ? "#60c060" : "#ff8080",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {txState === "pending" ? "Processing..." : paused ? "Unpause Protocol" : "Pause Protocol"}
                </button>
              )}
            </div>
          </div>

          <TransactionStatus state={txState} message={txMsg} />

          <div style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, padding: 14 }}>
            <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Affected Contracts</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {PAUSED_CONTRACTS.map((name) => (
                <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid #0f0f1a" }}>
                  <span style={{ color: "#888", fontSize: 13 }}>{name}</span>
                  <span style={{ fontSize: 11, color: paused ? "#ff8080" : "#60c060" }}>
                    {paused ? "Paused" : "Active"}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ color: "#444", fontSize: 11, marginTop: 10 }}>
              BudgetLedger, PaymentVault, CampaignLifecycle, GovernanceSlash, and Timelock are not pause-gated (allow safe resolution of in-progress actions).
            </div>
          </div>
        </>
      )}
    </div>
  );
}
