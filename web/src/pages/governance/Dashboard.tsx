import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
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
import { useTx } from "../../hooks/useTx";
import { queryFilterAll } from "@shared/eventQuery";

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
  pageReports: number;
  adReports: number;
  rewardToken?: string;
  rewardPerImpression?: bigint;
  rewardSymbol?: string;
  rewardDecimals?: number;
  rewardBudget?: bigint;
}

export function GovernanceDashboard() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { blockNumber } = useBlock();
  const { settings } = useSettings();
  const { confirmTx } = useTx();
  const [campaigns, setCampaigns] = useState<GovCampaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<"active" | "all" | "reported">("active");

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
              const logs = await queryFilterAll(contracts.campaigns, filter);
              if (logs.length > 0) metadataHash = (logs[logs.length - 1] as any).args?.metadataHash ?? metadataHash;
            } catch { /* no events */ }

            let lastSettlementBlock = 0;
            try {
              lastSettlementBlock = Number(await contracts.budgetLedger.lastSettlementBlock(BigInt(id)));
            } catch { /* no budgetLedger */ }

            let pageReports = 0, adReports = 0;
            try {
              if (contracts.reports) {
                [pageReports, adReports] = await Promise.all([
                  contracts.reports.pageReports(BigInt(id)).then(Number),
                  contracts.reports.adReports(BigInt(id)).then(Number),
                ]);
              }
            } catch { /* no reports contract */ }

            let rewardToken: string | undefined;
            let rewardPerImpression: bigint | undefined;
            let rewardSymbol: string | undefined;
            let rewardDecimals: number | undefined;
            let rewardBudget: bigint | undefined;
            try {
              const [tok, perImp] = await Promise.all([
                contracts.campaigns.getCampaignRewardToken(BigInt(id)).catch(() => ethers.ZeroAddress),
                contracts.campaigns.getCampaignRewardPerImpression(BigInt(id)).catch(() => 0n),
              ]);
              if (tok && tok !== ethers.ZeroAddress) {
                rewardToken = tok as string;
                rewardPerImpression = BigInt(perImp);
                const erc20 = new ethers.Contract(tok, ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], contracts.readProvider);
                const [sym2, dec] = await Promise.all([erc20.symbol().catch(() => "TOKEN"), erc20.decimals().catch(() => 18)]);
                rewardSymbol = sym2 as string;
                rewardDecimals = Number(dec);
                try { rewardBudget = BigInt(await contracts.tokenRewardVault.campaignTokenBudget(tok, BigInt(id))); } catch { /* ok */ }
              }
            } catch { /* no token reward */ }

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
              pageReports,
              adReports,
              rewardToken,
              rewardPerImpression,
              rewardSymbol,
              rewardDecimals,
              rewardBudget,
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
      await confirmTx(tx);
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
      await confirmTx(tx);
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
      await confirmTx(tx);
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
    : filter === "reported"
    ? campaigns.filter((c) => c.pageReports + c.adReports > 0)
    : campaigns;

  return (
    <div className="nano-fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Governance</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to="/governance/my-votes" className="nano-btn" style={{ padding: "5px 12px", fontSize: 12, textDecoration: "none" }}>My Votes</Link>
          <Link to="/governance/parameters" className="nano-btn" style={{ padding: "5px 12px", fontSize: 12, textDecoration: "none" }}>Parameters</Link>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button onClick={() => setFilter("active")} className={filter === "active" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12 }}>Active / Pending</button>
        <button onClick={() => setFilter("reported")} className={filter === "reported" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12, color: filter !== "reported" ? "var(--warn)" : undefined }}>Reported</button>
        <button onClick={() => setFilter("all")} className={filter === "all" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 12px", fontSize: 12 }}>All Campaigns</button>
        <button onClick={() => load()} className="nano-btn" style={{ padding: "5px 12px", fontSize: 12, marginLeft: "auto" }}>Refresh</button>
      </div>

      {actionMsg && (
        <div className="nano-info nano-info--muted" style={{ marginBottom: 12 }}>
          {actionMsg}
        </div>
      )}

      {loading && <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Loading campaigns</div>}

      {displayed.map((c) => {
        const total = c.ayeWeighted + c.nayWeighted;
        const ayePct = total > 0n ? Number(c.ayeWeighted * 100n / total) : 0;
        const inactiveEligible = c.status === 1 && blockNumber && c.lastSettlementBlock > 0
          && blockNumber - c.lastSettlementBlock > 432_000;

        return (
          <div key={c.id} className="nano-card" style={{ padding: 14, marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Link to={`/campaigns/${c.id}`} style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "none", fontSize: 15 }}>#{c.id}</Link>
                <StatusBadge status={c.status} />
                <AddressDisplay address={c.advertiser} chars={4} style={{ fontSize: 11, color: "var(--text-muted)" }} />
                {c.myVoteDir === 1 && <span style={{ fontSize: 11, color: "var(--ok)", fontWeight: 600 }}>✓ Aye</span>}
                {c.myVoteDir === 2 && <span style={{ fontSize: 11, color: "var(--error)", fontWeight: 600 }}>✗ Nay</span>}
                {c.resolved && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Resolved</span>}
                {c.rewardToken && c.rewardSymbol && (
                  <span title={`Token rewards: ${(Number(c.rewardPerImpression ?? 0) / Math.pow(10, c.rewardDecimals ?? 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${c.rewardSymbol} per impression`}
                    style={{ fontSize: 10, fontWeight: 600, color: "var(--role-advertiser)", background: "var(--role-advertiser-dim)", border: "1px solid var(--role-advertiser-border)", borderRadius: 4, padding: "1px 5px", letterSpacing: "0.04em", cursor: "default" }}>
                    {c.rewardSymbol}
                  </span>
                )}
                {c.adReports > 0 && (
                  <span title={`${c.adReports} ad report${c.adReports !== 1 ? "s" : ""}`} style={{ fontSize: 10, fontWeight: 700, color: "var(--warn)", background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.3)", borderRadius: 4, padding: "1px 5px", letterSpacing: "0.04em" }}>
                    ⚑ {c.adReports} AD
                  </span>
                )}
                {c.pageReports > 0 && (
                  <span title={`${c.pageReports} page report${c.pageReports !== 1 ? "s" : ""}`} style={{ fontSize: 10, fontWeight: 700, color: "var(--error)", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 4, padding: "1px 5px", letterSpacing: "0.04em" }}>
                    ⚑ {c.pageReports} PAGE
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <Link to={`/campaigns/${c.id}`} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none" }}>Detail</Link>
                <Link to={`/governance/vote/${c.id}`} className="nano-btn nano-btn-accent" style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none" }}>
                  Vote →
                </Link>
              </div>
            </div>

            <div style={{ marginBottom: 8 }}>
              <IPFSPreview metadataHash={c.metadataHash} compact />
            </div>

            {total > 0n && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ position: "relative", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 3, height: 8, overflow: "hidden", display: "flex" }}>
                  <div style={{ width: `${ayePct}%`, height: "100%", background: "rgba(74,222,128,0.35)" }} />
                  <div style={{ width: `${100 - ayePct}%`, height: "100%", background: "rgba(248,113,113,0.35)" }} />
                  <div style={{ position: "absolute", left: "50%", top: 0, width: 1, height: "100%", background: "var(--text-muted)", opacity: 0.4 }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  <span style={{ color: "var(--ok)" }}>Aye {ayePct}% · <DOTAmount planck={c.ayeWeighted} /></span>
                  <span style={{ color: "var(--error)" }}>Nay {100 - ayePct}% · <DOTAmount planck={c.nayWeighted} /></span>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(c.status <= 2) && signer && (
                <button onClick={() => evaluate(c.id)} disabled={actionBusy === c.id} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12 }}>
                  Evaluate
                </button>
              )}
              {inactiveEligible && signer && (
                <button onClick={() => expireInactive(c.id)} disabled={actionBusy === c.id} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12, color: "var(--warn)" }}>
                  Expire (Inactive)
                </button>
              )}
              {c.status === 0 && signer && (
                <button onClick={() => expirePending(c.id)} disabled={actionBusy === c.id} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12 }}>
                  Expire (Pending Timeout)
                </button>
              )}
              {actionBusy === c.id && <span style={{ color: "var(--text-muted)", fontSize: 11, alignSelf: "center" }}>Processing...</span>}
            </div>
          </div>
        );
      })}

      {!loading && displayed.length === 0 && (
        <div style={{ color: "var(--text-muted)", padding: 20, textAlign: "center" }}>
          {filter === "active" ? "No active or pending campaigns." : filter === "reported" ? "No reported campaigns." : "No campaigns found."}
        </div>
      )}
    </div>
  );
}
