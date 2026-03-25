import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useBlock } from "../../hooks/useBlock";
import { useSettings } from "../../context/SettingsContext";
import { StatusBadge } from "../../components/StatusBadge";
import { DOTAmount } from "../../components/DOTAmount";
import { AddressDisplay } from "../../components/AddressDisplay";
import { IPFSPreview } from "../../components/IPFSPreview";
import { humanizeError } from "@shared/errorCodes";
import { formatBlockDelta } from "@shared/conviction";

interface GovCampaign {
  id: number;
  status: number;
  advertiser: string;
  bidCpmPlanck: bigint;
  ayeWeighted: bigint;
  nayWeighted: bigint;
  resolved: boolean;
  myVoteDir: number;
  metadataHash: string;
  lastSettlementBlock: number;
}

export function GovernanceDashboard() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { blockNumber } = useBlock();
  const { settings } = useSettings();
  const [campaigns, setCampaigns] = useState<GovCampaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<"active" | "all">("active");

  const load = useCallback(async () => {
    if (!settings.contractAddresses.campaigns) return;
    setLoading(true);
    try {
      const nextId = Number(await contracts.campaigns.nextCampaignId());
      const results: GovCampaign[] = [];

      await Promise.all(
        Array.from({ length: Math.min(nextId, 100) }, (_, i) => nextId - 1 - i).map(async (id) => {
          if (id < 0) return;
          try {
            const [c, adv, aye, nay, resolved] = await Promise.all([
              contracts.campaigns.getCampaignForSettlement(BigInt(id)),
              contracts.campaigns.getCampaignAdvertiser(BigInt(id)),
              contracts.governanceV2.ayeWeighted(BigInt(id)).catch(() => 0n),
              contracts.governanceV2.nayWeighted(BigInt(id)).catch(() => 0n),
              contracts.governanceV2.resolved(BigInt(id)).catch(() => false),
            ]);

            let myVoteDir = 0;
            if (address) {
              try {
                const v = await contracts.governanceV2.getVote(BigInt(id), address);
                myVoteDir = Number(v.direction ?? v[0] ?? 0);
              } catch { /* no vote */ }
            }

            let metadataHash = "0x" + "0".repeat(64);
            try {
              const filter = contracts.campaigns.filters.CampaignMetadataSet(BigInt(id));
              const logs = await contracts.campaigns.queryFilter(filter);
              if (logs.length > 0) metadataHash = (logs[logs.length - 1] as any).args?.metadataHash ?? metadataHash;
            } catch { /* no events */ }

            let lastSettlementBlock = 0;
            try {
              lastSettlementBlock = Number(await contracts.budgetLedger.lastSettlementBlock(BigInt(id)));
            } catch { /* no budgetLedger */ }

            results.push({
              id, status: Number(c[0]),
              advertiser: adv as string,
              bidCpmPlanck: BigInt(c[2]),
              ayeWeighted: BigInt(aye),
              nayWeighted: BigInt(nay),
              resolved: Boolean(resolved),
              myVoteDir,
              metadataHash,
              lastSettlementBlock,
            });
          } catch { /* skip */ }
        })
      );

      setCampaigns(results.sort((a, b) => {
        const order = [0, 1, 2, 3, 4, 5];
        return order.indexOf(a.status) - order.indexOf(b.status) || b.id - a.id;
      }));
    } finally {
      setLoading(false);
    }
  }, [address, settings.contractAddresses.campaigns]);

  useEffect(() => { load(); }, [load]);

  async function evaluate(id: number) {
    if (!signer) return;
    setActionBusy(id);
    setActionMsg(null);
    try {
      const c = contracts.governanceV2.connect(signer);
      const tx = await c.evaluateCampaign(BigInt(id));
      await tx.wait();
      setActionMsg(`Campaign #${id} evaluated.`);
      load();
    } catch (err) {
      setActionMsg(humanizeError(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function expireInactive(id: number) {
    if (!signer) return;
    setActionBusy(id);
    try {
      const lc = contracts.lifecycle.connect(signer);
      const tx = await lc.expireInactiveCampaign(BigInt(id));
      await tx.wait();
      setActionMsg(`Campaign #${id} expired (inactivity).`);
      load();
    } catch (err) {
      setActionMsg(humanizeError(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function expirePending(id: number) {
    if (!signer) return;
    setActionBusy(id);
    try {
      const lc = contracts.lifecycle.connect(signer);
      const tx = await lc.expirePendingCampaign(BigInt(id));
      await tx.wait();
      setActionMsg(`Campaign #${id} expired (pending timeout).`);
      load();
    } catch (err) {
      setActionMsg(humanizeError(err));
    } finally {
      setActionBusy(null);
    }
  }

  const displayed = filter === "active"
    ? campaigns.filter((c) => c.status <= 2)
    : campaigns;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700 }}>Governance</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to="/governance/my-votes" style={navBtn}>My Votes</Link>
          <Link to="/governance/parameters" style={navBtn}>Parameters</Link>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button onClick={() => setFilter("active")} style={{ ...filterBtn, ...(filter === "active" ? filterBtnActive : {}) }}>Active / Pending</button>
        <button onClick={() => setFilter("all")} style={{ ...filterBtn, ...(filter === "all" ? filterBtnActive : {}) }}>All Campaigns</button>
        <button onClick={() => load()} style={{ ...filterBtn, marginLeft: "auto" }}>Refresh</button>
      </div>

      {actionMsg && (
        <div style={{ padding: "8px 12px", background: "#0d0d18", border: "1px solid #2a2a4a", borderRadius: 4, color: "#a0a0ff", fontSize: 13, marginBottom: 12 }}>
          {actionMsg}
        </div>
      )}

      {loading && <div style={{ color: "#555" }}>Loading campaigns...</div>}

      {displayed.map((c) => {
        const total = c.ayeWeighted + c.nayWeighted;
        const ayePct = total > 0n ? Number(c.ayeWeighted * 100n / total) : 0;
        const inactiveEligible = c.status === 1 && blockNumber && c.lastSettlementBlock > 0
          && blockNumber - c.lastSettlementBlock > 432_000;

        return (
          <div key={c.id} style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, padding: 14, marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ color: "#a0a0ff", fontWeight: 700 }}>#{c.id}</span>
                <StatusBadge status={c.status} />
                {c.myVoteDir === 1 && <span style={{ fontSize: 11, color: "#60c060", fontWeight: 600 }}>✓ Voted Aye</span>}
                {c.myVoteDir === 2 && <span style={{ fontSize: 11, color: "#ff8080", fontWeight: 600 }}>✗ Voted Nay</span>}
                {c.resolved && <span style={{ fontSize: 11, color: "#555" }}>Resolved</span>}
              </div>
              <Link to={`/governance/vote/${c.id}`} style={{ padding: "4px 10px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 4, color: "#a0a0ff", fontSize: 12, textDecoration: "none" }}>
                Vote
              </Link>
            </div>

            <div style={{ marginBottom: 8 }}>
              <IPFSPreview metadataHash={c.metadataHash} compact />
            </div>

            {total > 0n && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ background: "#1a1a1a", borderRadius: 3, height: 8, overflow: "hidden" }}>
                  <div style={{ width: `${ayePct}%`, height: "100%", background: "#406040" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#555", marginTop: 2 }}>
                  <span>Aye {ayePct}% · <DOTAmount planck={c.ayeWeighted} /></span>
                  <span>Nay {100 - ayePct}% · <DOTAmount planck={c.nayWeighted} /></span>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(c.status <= 2) && signer && (
                <button onClick={() => evaluate(c.id)} disabled={actionBusy === c.id} style={smallActionBtn}>
                  Evaluate
                </button>
              )}
              {inactiveEligible && signer && (
                <button onClick={() => expireInactive(c.id)} disabled={actionBusy === c.id} style={{ ...smallActionBtn, color: "#ff9040", border: "1px solid #4a3a0a" }}>
                  Expire (Inactive)
                </button>
              )}
              {c.status === 0 && signer && (
                <button onClick={() => expirePending(c.id)} disabled={actionBusy === c.id} style={{ ...smallActionBtn, color: "#888" }}>
                  Expire (Pending Timeout)
                </button>
              )}
              {actionBusy === c.id && <span style={{ color: "#555", fontSize: 11, alignSelf: "center" }}>Processing...</span>}
            </div>
          </div>
        );
      })}

      {!loading && displayed.length === 0 && (
        <div style={{ color: "#555", padding: 20, textAlign: "center" }}>
          {filter === "active" ? "No active or pending campaigns." : "No campaigns found."}
        </div>
      )}
    </div>
  );
}

const navBtn: React.CSSProperties = { padding: "5px 12px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#888", fontSize: 12, textDecoration: "none" };
const filterBtn: React.CSSProperties = { padding: "5px 12px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#666", fontSize: 12, cursor: "pointer" };
const filterBtnActive: React.CSSProperties = { background: "#1a1a3a", border: "1px solid #4a4a8a", color: "#a0a0ff" };
const smallActionBtn: React.CSSProperties = { padding: "4px 10px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 3, color: "#888", fontSize: 12, cursor: "pointer" };
