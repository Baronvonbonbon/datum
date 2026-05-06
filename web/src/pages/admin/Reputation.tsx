import { useState } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { AdminNav } from "../../components/AdminNav";
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
  const [lookupLoading, setLookupLoading] = useState(false);

  async function handleLookup() {
    if (!contracts.settlement) return;
    if (!lookupAddr) return;
    setLookupLoading(true);
    setLookupResult(null);
    try {
      const [settled, rejected, score] = await contracts.settlement.getPublisherStats(lookupAddr);
      const result: typeof lookupResult = {
        settled: settled.toString(),
        rejected: rejected.toString(),
        score: Number(score),
      };
      if (lookupCampaign) {
        const [cs, cr] = await contracts.settlement.getCampaignRepStats(lookupAddr, BigInt(lookupCampaign));
        const anomaly = await contracts.settlement.isAnomaly(lookupAddr, BigInt(lookupCampaign));
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

  const notDeployed = !contracts.settlement;

  return (
    <div className="nano-fade" style={{ maxWidth: 580 }}>
      <AdminNav />
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 16 }}>
        Publisher Reputation (BM-8/BM-9)
      </h1>

      <div className="nano-info nano-info--muted" style={{ marginBottom: 16, fontSize: 12 }}>
        Tracks per-publisher settlement acceptance rates. Score = settled / (settled + rejected) × 10000 bps.
        Anomaly detection (BM-9) flags campaigns where a publisher's rejection rate exceeds 2× their global rate.
        Stats are recorded by Settlement directly (FP-16) — no relay-bot reporter needed.
      </div>

      {notDeployed && (
        <div className="nano-info nano-info--warn" style={{ marginBottom: 16 }}>
          Settlement contract address not configured — check networks.ts.
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

    </div>
  );
}
