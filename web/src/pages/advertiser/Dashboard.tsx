import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { StatusBadge } from "../../components/StatusBadge";
import { DOTAmount } from "../../components/DOTAmount";
import { IPFSPreview } from "../../components/IPFSPreview";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { tagLabel } from "@shared/tagDictionary";
import { queryFilterAll } from "@shared/eventQuery";
import { toCSV, downloadCSV } from "@shared/csvExport";
import { formatDOT } from "@shared/dot";
import { ConfirmModal } from "../../components/ConfirmModal";

interface MyCampaign {
  id: number;
  status: number;
  publisher: string;
  bidCpmPlanck: bigint;
  snapshotTakeRateBps: number;
  remaining: bigint;
  originalBudget: bigint;
  metadataHash: string;
  tags: string[];
}

export function AdvertiserDashboard() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { confirmTx } = useTx();
  const [campaigns, setCampaigns] = useState<MyCampaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ id: number; action: "pause" | "resume" | "complete" } | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      // Scan all campaigns by ID and filter by advertiser (Paseo indexed event filters are unreliable)
      const nextId = Number(await contracts.campaigns.nextCampaignId());
      const allIds = Array.from({ length: Math.min(nextId, 200) }, (_, i) => nextId - 1 - i).filter(i => i >= 0);

      const mine: MyCampaign[] = [];
      await Promise.all(
        allIds.map(async (id) => {
          try {
            const c = await contracts.campaigns.getCampaignForSettlement(BigInt(id));
            // Check if this campaign belongs to the connected wallet
            const adv = await contracts.campaigns.getCampaignAdvertiser(BigInt(id));
            if ((adv as string).toLowerCase() !== address.toLowerCase()) return;
            let remaining = 0n;
            let originalBudget = 0n;
            try {
              remaining = BigInt(await contracts.budgetLedger.getRemainingBudget(BigInt(id)));
              // Try to get original budget from BudgetInitialized event
              const bFilter = contracts.budgetLedger.filters.BudgetInitialized(BigInt(id));
              const bLogs = await queryFilterAll(contracts.budgetLedger, bFilter);
              if (bLogs.length > 0) {
                originalBudget = BigInt((bLogs[0] as any).args?.budget ?? 0);
              }
            } catch { /* no budgetLedger */ }
            let metadataHash = "0x" + "0".repeat(64);
            try {
              const mFilter = contracts.campaigns.filters.CampaignMetadataSet(BigInt(id));
              const mLogs = await queryFilterAll(contracts.campaigns, mFilter);
              if (mLogs.length > 0) {
                metadataHash = (mLogs[mLogs.length - 1] as any).args?.metadataHash ?? metadataHash;
              }
            } catch { /* no events */ }
            let tags: string[] = [];
            try {
              const rawTags: string[] = await contracts.campaigns.getCampaignTags(BigInt(id));
              tags = rawTags.map((h) => tagLabel(h) ?? h.slice(0, 10) + "...");
            } catch { /* getCampaignTags may not exist */ }
            mine.push({
              id, status: Number(c[0]), publisher: c[1] as string,
              bidCpmPlanck: BigInt(c[2]), snapshotTakeRateBps: Number(c[3]),
              remaining, originalBudget, metadataHash, tags,
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
      await confirmTx(tx);
      setActionResult(`Campaign #${id} ${action}d`);
      load();
    } catch (err) {
      setActionResult(humanizeError(err));
    } finally {
      setActionBusy(null);
    }
  }

  if (!address) return (
    <div style={{ padding: 20, color: "var(--text-muted)" }}>
      Connect your wallet to manage campaigns.
    </div>
  );

  return (
    <div className="nano-fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>My Campaigns</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {campaigns.length > 0 && (
            <button
              onClick={() => {
                const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];
                const rows = campaigns.map((c) => ({
                  ID: c.id,
                  Status: STATUS[c.status] ?? String(c.status),
                  Publisher: c.publisher,
                  "Bid CPM": formatDOT(c.bidCpmPlanck),
                  "Take Rate": `${(c.snapshotTakeRateBps / 100).toFixed(0)}%`,
                  Remaining: formatDOT(c.remaining),
                  "Original Budget": c.originalBudget > 0n ? formatDOT(c.originalBudget) : "",
                  Tags: c.tags.join("; "),
                }));
                downloadCSV("my-campaigns.csv", toCSV(["ID", "Status", "Publisher", "Bid CPM", "Take Rate", "Remaining", "Original Budget", "Tags"], rows));
              }}
              className="nano-btn"
              style={{ fontSize: 12 }}
            >
              Export CSV
            </button>
          )}
          <Link to="/advertiser/analytics" className="nano-btn" style={{ fontSize: 12, textDecoration: "none" }}>Analytics</Link>
          <button onClick={() => load()} className="nano-btn" style={{ fontSize: 12 }}>Refresh</button>
          <Link to="/advertiser/create" className="nano-btn nano-btn-accent" style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}>
            + New Campaign
          </Link>
        </div>
      </div>

      {actionResult && (
        <div className="nano-info nano-info--ok" style={{ marginBottom: 12 }}>
          {actionResult}
        </div>
      )}

      {loading && <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Loading your campaigns</div>}
      {error && <div className="nano-info nano-info--error" style={{ marginBottom: 12 }}>{error}</div>}

      {!loading && campaigns.length === 0 && (
        <div style={{ padding: 20, color: "var(--text-muted)", textAlign: "center" }}>
          No campaigns yet. <Link to="/advertiser/create" style={{ color: "var(--accent)" }}>Create your first campaign.</Link>
        </div>
      )}

      {campaigns.map((c) => (
        <div key={c.id} className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: 16 }}>Campaign #{c.id}</span>
              <StatusBadge status={c.status} style={{ marginLeft: 10 }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {c.status === 0 && (
                <Link to={`/governance/vote/${c.id}`} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none", color: "var(--warn)" }}>Needs Votes</Link>
              )}
              <Link to={`/advertiser/campaign/${c.id}/metadata`} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none" }}>Edit Metadata</Link>
              <Link to={`/advertiser/campaign/${c.id}`} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none" }}>Detail</Link>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 12 }}>
            <div className="nano-card" style={{ padding: "8px 10px" }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Remaining</div>
              <DOTAmount planck={c.remaining} />
              {c.originalBudget > 0n && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>
                    {Number(c.remaining * 100n / c.originalBudget)}% of <DOTAmount planck={c.originalBudget} />
                  </div>
                  <div style={{ height: 3, borderRadius: 2, background: "var(--bg-raised)", overflow: "hidden" }}>
                    <div style={{
                      width: `${Number(c.remaining * 100n / c.originalBudget)}%`,
                      height: "100%",
                      background: Number(c.remaining * 100n / c.originalBudget) > 20 ? "var(--ok)" : "var(--warn)",
                      borderRadius: 2,
                      transition: "width 300ms ease-out",
                    }} />
                  </div>
                </div>
              )}
            </div>
            <div className="nano-card" style={{ padding: "8px 10px" }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Bid CPM</div>
              <DOTAmount planck={c.bidCpmPlanck} />
            </div>
            <div className="nano-card" style={{ padding: "8px 10px" }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Take Rate</div>
              <span style={{ color: "var(--text-strong)" }}>{(c.snapshotTakeRateBps / 100).toFixed(0)}%</span>
            </div>
          </div>

          {c.tags.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
              {c.tags.map((t, i) => (
                <span key={i} className="nano-badge" style={{ fontSize: 11 }}>{t}</span>
              ))}
            </div>
          )}

          <IPFSPreview metadataHash={c.metadataHash} compact />

          {signer && (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {c.status === 1 && (
                <button onClick={() => doAction(c.id, "pause")} disabled={actionBusy === c.id} className="nano-btn" style={{ fontSize: 12 }}>
                  Pause
                </button>
              )}
              {c.status === 2 && (
                <button onClick={() => doAction(c.id, "resume")} disabled={actionBusy === c.id} className="nano-btn" style={{ fontSize: 12 }}>
                  Resume
                </button>
              )}
              {(c.status === 1 || c.status === 2) && (
                <button onClick={() => setConfirmAction({ id: c.id, action: "complete" })} disabled={actionBusy === c.id} className="nano-btn" style={{ fontSize: 12, color: "var(--error)", border: "1px solid rgba(248,113,113,0.3)" }}>
                  Complete Early
                </button>
              )}
              {actionBusy === c.id && <span style={{ color: "var(--text-muted)", fontSize: 12, alignSelf: "center" }}>Processing...</span>}
            </div>
          )}
        </div>
      ))}

      {confirmAction && (
        <ConfirmModal
          title={`Complete Campaign #${confirmAction.id}?`}
          message="This will end the campaign early and refund unspent budget to your wallet. This cannot be undone."
          confirmLabel="Complete Campaign"
          danger
          onConfirm={() => { doAction(confirmAction.id, confirmAction.action); setConfirmAction(null); }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
