import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { StatusBadge } from "../../components/StatusBadge";
import { DOTAmount } from "../../components/DOTAmount";
import { IPFSPreview } from "../../components/IPFSPreview";
import { humanizeError } from "@shared/errorCodes";
import { ethers } from "ethers";

interface MyCampaign {
  id: number;
  status: number;
  publisher: string;
  bidCpmPlanck: bigint;
  snapshotTakeRateBps: number;
  remaining: bigint;
  metadataHash: string;
}

export function AdvertiserDashboard() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const [campaigns, setCampaigns] = useState<MyCampaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const nextId = Number(await contracts.campaigns.nextCampaignId());
      const mine: MyCampaign[] = [];

      await Promise.all(
        Array.from({ length: nextId }, (_, i) => i).map(async (id) => {
          try {
            const adv = await contracts.campaigns.getCampaignAdvertiser(BigInt(id));
            if ((adv as string).toLowerCase() !== address.toLowerCase()) return;
            const c = await contracts.campaigns.getCampaignForSettlement(BigInt(id));
            let remaining = 0n;
            try {
              remaining = BigInt(await contracts.budgetLedger.getRemainingBudget(BigInt(id)));
            } catch { /* no budgetLedger */ }
            let metadataHash = "0x" + "0".repeat(64);
            try {
              const filter = contracts.campaigns.filters.CampaignMetadataSet(BigInt(id));
              const logs = await contracts.campaigns.queryFilter(filter);
              if (logs.length > 0) {
                metadataHash = (logs[logs.length - 1] as any).args?.metadataHash ?? metadataHash;
              }
            } catch { /* no events */ }
            mine.push({
              id, status: Number(c[0]), publisher: c[1] as string,
              bidCpmPlanck: BigInt(c[2]), snapshotTakeRateBps: Number(c[3]),
              remaining, metadataHash,
            });
          } catch { /* skip */ }
        })
      );

      setCampaigns(mine.sort((a, b) => b.id - a.id));
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }, [address, contracts]);

  useEffect(() => { load(); }, [load]);

  async function doAction(id: number, action: "pause" | "resume" | "complete") {
    if (!signer) return;
    setActionBusy(id);
    setActionResult(null);
    try {
      const c = contracts.campaigns.connect(signer);
      let tx;
      if (action === "pause") tx = await c.togglePause(BigInt(id), true);
      else if (action === "resume") tx = await c.togglePause(BigInt(id), false);
      else {
        const lc = contracts.lifecycle.connect(signer);
        tx = await lc.completeCampaign(BigInt(id));
      }
      await tx.wait();
      setActionResult(`Campaign #${id} ${action}d`);
      load();
    } catch (err) {
      setActionResult(humanizeError(err));
    } finally {
      setActionBusy(null);
    }
  }

  if (!address) return (
    <div style={{ padding: 20, color: "#666" }}>
      Connect your wallet to manage campaigns.
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700 }}>My Campaigns</h1>
        <Link to="/advertiser/create" style={{ padding: "6px 14px", background: "#1a1a3a", color: "#a0a0ff", border: "1px solid #4a4a8a", borderRadius: 4, fontSize: 13, textDecoration: "none" }}>
          + New Campaign
        </Link>
      </div>

      {actionResult && (
        <div style={{ padding: "8px 12px", background: "#0a2a0a", border: "1px solid #2a4a2a", borderRadius: 4, color: "#80c080", fontSize: 13, marginBottom: 12 }}>
          {actionResult}
        </div>
      )}

      {loading && <div style={{ color: "#555" }}>Loading your campaigns...</div>}
      {error && <div style={errorBox}>{error}</div>}

      {!loading && campaigns.length === 0 && (
        <div style={{ padding: 20, color: "#555", textAlign: "center" }}>
          No campaigns yet. <Link to="/advertiser/create" style={{ color: "#a0a0ff" }}>Create your first campaign.</Link>
        </div>
      )}

      {campaigns.map((c) => (
        <div key={c.id} style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <span style={{ color: "#a0a0ff", fontWeight: 700, fontSize: 16 }}>Campaign #{c.id}</span>
              <StatusBadge status={c.status} style={{ marginLeft: 10 }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Link to={`/advertiser/campaign/${c.id}/metadata`} style={smallBtn}>Edit Metadata</Link>
              <Link to={`/advertiser/campaign/${c.id}`} style={smallBtn}>Detail</Link>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 12 }}>
            <div style={infoCell}><div style={infoLabel}>Remaining</div><DOTAmount planck={c.remaining} /></div>
            <div style={infoCell}><div style={infoLabel}>Bid CPM</div><DOTAmount planck={c.bidCpmPlanck} /></div>
            <div style={infoCell}><div style={infoLabel}>Take Rate</div><span style={{ color: "#e0e0e0" }}>{(c.snapshotTakeRateBps / 100).toFixed(0)}%</span></div>
          </div>

          <IPFSPreview metadataHash={c.metadataHash} compact />

          {signer && (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {c.status === 1 && (
                <button onClick={() => doAction(c.id, "pause")} disabled={actionBusy === c.id} style={actionBtn}>
                  Pause
                </button>
              )}
              {c.status === 2 && (
                <button onClick={() => doAction(c.id, "resume")} disabled={actionBusy === c.id} style={actionBtn}>
                  Resume
                </button>
              )}
              {(c.status === 1 || c.status === 2) && (
                <button onClick={() => doAction(c.id, "complete")} disabled={actionBusy === c.id} style={{ ...actionBtn, color: "#ff8080", border: "1px solid #4a1a1a" }}>
                  Complete Early
                </button>
              )}
              {actionBusy === c.id && <span style={{ color: "#555", fontSize: 12, alignSelf: "center" }}>Processing...</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const errorBox: React.CSSProperties = { padding: "10px 14px", background: "#1a0a0a", border: "1px solid #3a1a1a", borderRadius: 6, color: "#ff8080", fontSize: 13, marginBottom: 12 };
const smallBtn: React.CSSProperties = { padding: "4px 10px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#888", fontSize: 12, textDecoration: "none" };
const infoCell: React.CSSProperties = { background: "#111", border: "1px solid #1a1a2e", borderRadius: 4, padding: "8px 10px" };
const infoLabel: React.CSSProperties = { color: "#555", fontSize: 11, marginBottom: 2 };
const actionBtn: React.CSSProperties = { padding: "5px 12px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#888", fontSize: 12, cursor: "pointer" };
