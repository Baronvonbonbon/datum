import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";

export function RateLimiterAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [loading, setLoading] = useState(true);
  const [rateLimiterAddr, setRateLimiterAddr] = useState<string | null>(null);
  const [windowBlocks, setWindowBlocks] = useState<string | null>(null);
  const [maxPerWindow, setMaxPerWindow] = useState<string | null>(null);

  const [wireInput, setWireInput] = useState("");
  const [wireTxState, setWireTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [wireTxMsg, setWireTxMsg] = useState("");

  const [windowInput, setWindowInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [adjustTxState, setAdjustTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [adjustTxMsg, setAdjustTxMsg] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const addr = await contracts.settlement.rateLimiter().catch(() => null);
      setRateLimiterAddr(addr ?? null);

      const ZERO = "0x0000000000000000000000000000000000000000";
      if (addr && addr !== ZERO && contracts.rateLimiter) {
        const [wb, mp] = await Promise.all([
          contracts.rateLimiter.windowBlocks().catch(() => null),
          contracts.rateLimiter.maxPublisherImpressionsPerWindow().catch(() => null),
        ]);
        setWindowBlocks(wb !== null ? wb.toString() : null);
        setMaxPerWindow(mp !== null ? mp.toString() : null);
      } else {
        setWindowBlocks(null);
        setMaxPerWindow(null);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleWire() {
    if (!signer) return;
    setWireTxState("pending");
    setWireTxMsg("");
    try {
      const c = contracts.settlement.connect(signer);
      const tx = await c.setRateLimiter(wireInput.trim() || "0x0000000000000000000000000000000000000000");
      await confirmTx(tx);
      setWireTxState("success");
      setWireTxMsg("Rate limiter wired.");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setWireTxState("error");
    }
  }

  async function handleAdjust() {
    if (!signer || !contracts.rateLimiter) return;
    if (!windowInput || !maxInput) { setAdjustTxMsg("Enter both values."); setAdjustTxState("error"); return; }
    setAdjustTxState("pending");
    setAdjustTxMsg("");
    try {
      const c = contracts.rateLimiter.connect(signer);
      const tx = await c.setLimits(BigInt(windowInput), BigInt(maxInput));
      await confirmTx(tx);
      setAdjustTxState("success");
      setAdjustTxMsg("Limits updated.");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setAdjustTxState("error");
    }
  }

  const ZERO = "0x0000000000000000000000000000000000000000";
  const isEnabled = rateLimiterAddr && rateLimiterAddr !== ZERO;

  return (
    <div className="nano-fade" style={{ maxWidth: 560 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Rate Limiter (BM-5)</h1>

      <div className="nano-info nano-info--muted" style={{ marginBottom: 16, fontSize: 12 }}>
        Optional per-publisher impression cap. Settlement checks this contract before processing claims. Set to <code>address(0)</code> to disable.
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)" }}>Loading...</div>
      ) : (
        <>
          {/* Status */}
          <div className="nano-card" style={{ padding: 14, marginBottom: 16 }}>
            <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Status</div>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Wired Address</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: isEnabled ? "var(--ok)" : "var(--text-muted)" }}>
                  {isEnabled ? rateLimiterAddr : "Disabled (address(0))"}
                </div>
              </div>
              {isEnabled && (
                <>
                  <div>
                    <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Window (blocks)</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{windowBlocks ?? "—"}</div>
                  </div>
                  <div>
                    <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Max per Window</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{maxPerWindow ?? "—"}</div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Wire / Unwire */}
          {signer && (
            <div className="nano-card" style={{ padding: 14, marginBottom: 16 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
                {isEnabled ? "Unwire / Change" : "Wire Rate Limiter"}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  value={wireInput}
                  onChange={(e) => setWireInput(e.target.value)}
                  placeholder="0x... (blank = address(0) to disable)"
                  style={{ flex: 1, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 10px", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }}
                />
                <button
                  onClick={handleWire}
                  disabled={wireTxState === "pending"}
                  className="nano-btn"
                  style={{ padding: "6px 14px", fontSize: 12 }}
                >
                  {wireTxState === "pending" ? "..." : "Set"}
                </button>
              </div>
              <TransactionStatus state={wireTxState} message={wireTxMsg} />
            </div>
          )}

          {/* Adjust limits */}
          {signer && isEnabled && (
            <div className="nano-card" style={{ padding: 14 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Adjust Limits</div>
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
