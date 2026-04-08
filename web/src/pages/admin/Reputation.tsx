import { useState } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";

function scoreBadge(score: number) {
  const pct = (score / 100).toFixed(1);
  const color = score >= 9000 ? "var(--ok)" : score >= 7000 ? "var(--warn)" : "var(--error)";
  return <span style={{ color, fontWeight: 700 }}>{pct}%</span>;
}

export function ReputationAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  // Lookup state
  const [lookupAddr, setLookupAddr] = useState("");
  const [lookupCampaign, setLookupCampaign] = useState("");
  const [lookupResult, setLookupResult] = useState<{
    settled: string; rejected: string; score: number;
    anomaly?: boolean; cs?: string; cr?: string;
  } | null>(null);
  const [lookupError, setLookupError] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);

  // Reporter management
  const [reporterInput, setReporterInput] = useState("");
  const [addTxState, setAddTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [addTxMsg, setAddTxMsg] = useState("");
  const [removeTxState, setRemoveTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [removeTxMsg, setRemoveTxMsg] = useState("");

  // Check reporter status
  const [checkReporter, setCheckReporter] = useState("");
  const [isReporter, setIsReporter] = useState<boolean | null>(null);

  async function handleLookup() {
    if (!contracts.reputation) { setLookupError("Reputation contract not configured."); return; }
    if (!lookupAddr) { setLookupError("Enter a publisher address."); return; }
    setLookupLoading(true);
    setLookupError("");
    setLookupResult(null);
    try {
      const [settled, rejected, score] = await contracts.reputation.getPublisherStats(lookupAddr);
      const result: typeof lookupResult = {
        settled: settled.toString(),
        rejected: rejected.toString(),
        score: Number(score),
      };
      if (lookupCampaign) {
        const [cs, cr] = await contracts.reputation.getCampaignStats(lookupAddr, BigInt(lookupCampaign));
        const anomaly = await contracts.reputation.isAnomaly(lookupAddr, BigInt(lookupCampaign));
        result.cs = cs.toString();
        result.cr = cr.toString();
        result.anomaly = anomaly;
      }
      setLookupResult(result);
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setLookupLoading(false);
    }
  }

  async function handleAddReporter() {
    if (!signer || !contracts.reputation) return;
    if (!reporterInput) { setAddTxMsg("Enter reporter address."); setAddTxState("error"); return; }
    setAddTxState("pending"); setAddTxMsg("");
    try {
      const c = contracts.reputation.connect(signer);
      const tx = await c.addReporter(reporterInput.trim());
      await confirmTx(tx);
      setAddTxState("success");
      setAddTxMsg("Reporter added.");
    } catch (err) {
      push(humanizeError(err), "error");
      setAddTxMsg(humanizeError(err));
      setAddTxState("error");
    }
  }

  async function handleRemoveReporter() {
    if (!signer || !contracts.reputation) return;
    if (!reporterInput) { setRemoveTxMsg("Enter reporter address."); setRemoveTxState("error"); return; }
    setRemoveTxState("pending"); setRemoveTxMsg("");
    try {
      const c = contracts.reputation.connect(signer);
      const tx = await c.removeReporter(reporterInput.trim());
      await confirmTx(tx);
      setRemoveTxState("success");
      setRemoveTxMsg("Reporter removed.");
    } catch (err) {
      push(humanizeError(err), "error");
      setRemoveTxMsg(humanizeError(err));
      setRemoveTxState("error");
    }
  }

  async function handleCheckReporter() {
    if (!contracts.reputation || !checkReporter) return;
    try {
      const result = await contracts.reputation.reporters(checkReporter.trim());
      setIsReporter(result);
    } catch {
      setIsReporter(null);
    }
  }

  const notDeployed = !contracts.reputation;

  return (
    <div className="nano-fade" style={{ maxWidth: 580 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 16 }}>
        Publisher Reputation (BM-8/BM-9)
      </h1>

      <div className="nano-info nano-info--muted" style={{ marginBottom: 16, fontSize: 12 }}>
        Tracks per-publisher settlement acceptance rates. Score = settled / (settled + rejected) × 10000 bps.
        Anomaly detection (BM-9) flags campaigns where a publisher's rejection rate exceeds 2× their global rate.
        Stats are recorded by approved reporter addresses (relay bot EOA).
      </div>

      {notDeployed && (
        <div className="nano-info nano-info--warn" style={{ marginBottom: 16 }}>
          Reputation contract address not configured — deploy DatumPublisherReputation and update networks.ts.
        </div>
      )}

      {/* Publisher Lookup */}
      <div className="nano-card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
          Publisher Lookup
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <input
            type="text"
            value={lookupAddr}
            onChange={(e) => setLookupAddr(e.target.value)}
            placeholder="Publisher address (0x...)"
            style={{ flex: 2, minWidth: 200, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 10px", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }}
          />
          <input
            type="text"
            value={lookupCampaign}
            onChange={(e) => setLookupCampaign(e.target.value)}
            placeholder="Campaign ID (optional)"
            style={{ flex: 1, minWidth: 100, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 10px", color: "var(--text)", fontSize: 12 }}
          />
          <button
            onClick={handleLookup}
            disabled={lookupLoading || notDeployed}
            className="nano-btn"
            style={{ padding: "6px 14px", fontSize: 12 }}
          >
            {lookupLoading ? "..." : "Lookup"}
          </button>
        </div>
        {lookupResult && (
          <div style={{ marginTop: 10, display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Settled (global)</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ok)" }}>{lookupResult.settled}</div>
            </div>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Rejected (global)</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--error)" }}>{lookupResult.rejected}</div>
            </div>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Score</div>
              <div style={{ fontSize: 14 }}>{scoreBadge(lookupResult.score)}</div>
            </div>
            {lookupResult.cs !== undefined && (
              <>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Settled (campaign)</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ok)" }}>{lookupResult.cs}</div>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Rejected (campaign)</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--error)" }}>{lookupResult.cr}</div>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Anomaly (BM-9)</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: lookupResult.anomaly ? "var(--error)" : "var(--ok)" }}>
                    {lookupResult.anomaly ? "YES" : "No"}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Reporter Management */}
      {signer && (
        <div className="nano-card" style={{ padding: 14, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
            Reporter Management
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
            Only approved reporters (relay bot EOA) can call <code>recordSettlement()</code>.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
            <input
              type="text"
              value={reporterInput}
              onChange={(e) => setReporterInput(e.target.value)}
              placeholder="Reporter address (0x...)"
              style={{ flex: 1, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 10px", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }}
            />
            <button
              onClick={handleAddReporter}
              disabled={addTxState === "pending" || notDeployed}
              className="nano-btn nano-btn--ok"
              style={{ padding: "6px 12px", fontSize: 12 }}
            >
              {addTxState === "pending" ? "..." : "Add"}
            </button>
            <button
              onClick={handleRemoveReporter}
              disabled={removeTxState === "pending" || notDeployed}
              className="nano-btn nano-btn--danger"
              style={{ padding: "6px 12px", fontSize: 12 }}
            >
              {removeTxState === "pending" ? "..." : "Remove"}
            </button>
          </div>
          <TransactionStatus state={addTxState} message={addTxMsg} />
          <TransactionStatus state={removeTxState} message={removeTxMsg} />
        </div>
      )}

      {/* Check Reporter */}
      <div className="nano-card" style={{ padding: 14 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
          Check Reporter Status
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            value={checkReporter}
            onChange={(e) => { setCheckReporter(e.target.value); setIsReporter(null); }}
            placeholder="Address (0x...)"
            style={{ flex: 1, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 10px", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }}
          />
          <button
            onClick={handleCheckReporter}
            disabled={notDeployed}
            className="nano-btn"
            style={{ padding: "6px 14px", fontSize: 12 }}
          >
            Check
          </button>
        </div>
        {isReporter !== null && (
          <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: isReporter ? "var(--ok)" : "var(--text-muted)" }}>
            {isReporter ? "Approved reporter" : "Not a reporter"}
          </div>
        )}
      </div>
    </div>
  );
}
