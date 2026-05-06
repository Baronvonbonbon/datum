import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { AdminNav } from "../../components/AdminNav";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";

export function RateLimiterAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [loading, setLoading] = useState(true);
  const [windowBlocks, setWindowBlocks] = useState<string | null>(null);
  const [maxPerWindow, setMaxPerWindow] = useState<string | null>(null);

  const [windowInput, setWindowInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [adjustTxState, setAdjustTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [adjustTxMsg, setAdjustTxMsg] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [wb, mp] = await Promise.all([
        contracts.settlement.rlWindowBlocks().catch(() => null),
        contracts.settlement.rlMaxEventsPerWindow().catch(() => null),
      ]);
      setWindowBlocks(wb !== null ? wb.toString() : null);
      setMaxPerWindow(mp !== null ? mp.toString() : null);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdjust() {
    if (!signer) return;
    if (!windowInput || !maxInput) { setAdjustTxMsg("Enter both values."); setAdjustTxState("error"); return; }
    setAdjustTxState("pending");
    setAdjustTxMsg("");
    try {
      const c = contracts.settlement.connect(signer);
      const tx = await c.setRateLimits(BigInt(windowInput), BigInt(maxInput));
      await confirmTx(tx);
      setAdjustTxState("success");
      setAdjustTxMsg("Limits updated.");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setAdjustTxState("error");
    }
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 560 }}>
      <AdminNav />
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Rate Limiter (BM-5)</h1>

      <div className="nano-info nano-info--muted" style={{ marginBottom: 16, fontSize: 12 }}>
        Per-publisher impression cap built into Settlement. Limits are checked before processing claims.
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)" }}>Loading...</div>
      ) : (
        <>
          {/* Status */}
          <div className="nano-card" style={{ padding: 14, marginBottom: 16 }}>
            <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Current Limits</div>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Window (blocks)</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{windowBlocks ?? "—"}</div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Max per Window</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{maxPerWindow ?? "—"}</div>
              </div>
            </div>
          </div>

          {/* Adjust limits */}
          {signer && (
            <div className="nano-card" style={{ padding: 14 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Adjust Limits (owner only)</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Window Size (blocks)</div>
                  <input
                    type="number"
                    value={windowInput}
                    onChange={(e) => setWindowInput(e.target.value)}
                    placeholder={windowBlocks ?? "e.g. 600"}
                    style={{ width: "100%", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 10px", color: "var(--text)", fontSize: 12 }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Max Impressions / Window</div>
                  <input
                    type="number"
                    value={maxInput}
                    onChange={(e) => setMaxInput(e.target.value)}
                    placeholder={maxPerWindow ?? "e.g. 100"}
                    style={{ width: "100%", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 10px", color: "var(--text)", fontSize: 12 }}
                  />
                </div>
              </div>
              <button
                onClick={handleAdjust}
                disabled={adjustTxState === "pending"}
                className="nano-btn"
                style={{ padding: "6px 14px", fontSize: 12 }}
              >
                {adjustTxState === "pending" ? "Updating..." : "Update Limits"}
              </button>
              <TransactionStatus state={adjustTxState} message={adjustTxMsg} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
