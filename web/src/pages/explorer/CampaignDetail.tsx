import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useBlock } from "../../hooks/useBlock";
import { StatusBadge } from "../../components/StatusBadge";
import { AddressDisplay } from "../../components/AddressDisplay";
import { DOTAmount } from "../../components/DOTAmount";
import { IPFSPreview } from "../../components/IPFSPreview";
import { CATEGORY_NAMES, CampaignStatus } from "@shared/types";
import { formatBlockDelta } from "@shared/conviction";
import { ethers } from "ethers";

export function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const contracts = useContracts();
  const { blockNumber } = useBlock();
  const [campaign, setCampaign] = useState<any>(null);
  const [budget, setBudget] = useState<any>(null);
  const [governance, setGovernance] = useState<any>(null);
  const [metadataHash, setMetadataHash] = useState<string>("0x" + "0".repeat(64));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id !== undefined) load(Number(id));
  }, [id]);

  async function load(campaignId: number) {
    setLoading(true);
    setError(null);
    try {
      const [c, adv] = await Promise.all([
        contracts.campaigns.getCampaignForSettlement(BigInt(campaignId)),
        contracts.campaigns.getCampaignAdvertiser(BigInt(campaignId)),
      ]);

      setCampaign({
        id: campaignId,
        status: Number(c[0]),
        publisher: c[1] as string,
        bidCpmPlanck: BigInt(c[2]),
        snapshotTakeRateBps: Number(c[3]),
        advertiser: adv as string,
      });

      // Budget info (individual view functions, no aggregate getter)
      try {
        const [remaining, dailyCap, lastBlock] = await Promise.all([
          contracts.budgetLedger.getRemainingBudget(BigInt(campaignId)).catch(() => 0n),
          contracts.budgetLedger.getDailyCap(BigInt(campaignId)).catch(() => 0n),
          contracts.budgetLedger.lastSettlementBlock(BigInt(campaignId)).catch(() => 0),
        ]);
        setBudget({
          remaining: BigInt(remaining),
          dailyCap: BigInt(dailyCap),
          lastSettlementBlock: Number(lastBlock),
        });
      } catch { /* BudgetLedger not configured */ }

      // Governance info
      try {
        const [aye, nay, resolved, quorum] = await Promise.all([
          contracts.governanceV2.ayeWeighted(BigInt(campaignId)),
          contracts.governanceV2.nayWeighted(BigInt(campaignId)),
          contracts.governanceV2.resolved(BigInt(campaignId)),
          contracts.governanceV2.quorumWeighted(),
        ]);
        setGovernance({
          ayeWeighted: BigInt(aye),
          nayWeighted: BigInt(nay),
          resolved: Boolean(resolved),
          quorum: BigInt(quorum),
        });
      } catch { /* GovernanceV2 not configured */ }

      // Metadata hash from events
      try {
        const filter = contracts.campaigns.filters.CampaignMetadataSet(BigInt(campaignId));
        const logs = await contracts.campaigns.queryFilter(filter);
        if (logs.length > 0) {
          const last = logs[logs.length - 1] as any;
          setMetadataHash(last.args?.metadataHash ?? "0x" + "0".repeat(64));
        }
      } catch { /* no events */ }

    } catch (err) {
      setError(String(err).slice(0, 300));
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={{ color: "var(--text-muted)", padding: 20 }}>Loading campaign #{id}...</div>;
  if (error) return <div className="nano-info nano-info--error">Error: {error}</div>;
  if (!campaign) return <div style={{ color: "var(--text-muted)" }}>Campaign not found.</div>;

  const totalVotes = governance ? governance.ayeWeighted + governance.nayWeighted : 0n;
  const ayePct = totalVotes > 0n ? Number(governance!.ayeWeighted * 100n / totalVotes) : 0;
  const quorumPct = governance ? (totalVotes > 0n ? Number(totalVotes * 100n / governance.quorum) : 0) : 0;
  const isOpen = campaign.publisher === ethers.ZeroAddress;

  return (
    <div className="nano-fade" style={{ maxWidth: 800 }}>
      <div style={{ marginBottom: 20 }}>
        <Link to="/campaigns" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Campaigns</Link>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginTop: 8 }}>
          Campaign #{campaign.id}
          <StatusBadge status={campaign.status} style={{ marginLeft: 12, verticalAlign: "middle" }} />
        </h1>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <InfoCard label="Advertiser">
          <AddressDisplay address={campaign.advertiser} />
        </InfoCard>
        <InfoCard label="Publisher">
          {isOpen
            ? <span style={{ color: "var(--text)" }}>Open (any publisher)</span>
            : <AddressDisplay address={campaign.publisher} />}
        </InfoCard>
        <InfoCard label="Bid CPM">
          <DOTAmount planck={campaign.bidCpmPlanck} />
        </InfoCard>
        <InfoCard label="Take Rate">
          <span style={{ color: "var(--text-strong)" }}>{(campaign.snapshotTakeRateBps / 100).toFixed(0)}%</span>
        </InfoCard>
      </div>

      {budget && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ color: "var(--accent)", fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Budget</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            <InfoCard label="Remaining"><DOTAmount planck={budget.remaining} /></InfoCard>
            <InfoCard label="Daily Cap"><DOTAmount planck={budget.dailyCap} /></InfoCard>
          </div>
          {budget.lastSettlementBlock > 0 && blockNumber && (
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>
              Last settlement: block #{budget.lastSettlementBlock}
              {" · "}
              {formatBlockDelta(blockNumber - budget.lastSettlementBlock)} ago
              {campaign.status === CampaignStatus.Active && blockNumber - budget.lastSettlementBlock > 432_000 && (
                <span style={{ color: "var(--warn)", marginLeft: 8 }}>⚠ Inactivity timeout eligible</span>
              )}
            </div>
          )}
        </section>
      )}

      {governance && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ color: "var(--accent)", fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Governance</h2>
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text)", marginBottom: 4 }}>
              <span>Aye {ayePct}%</span>
              <span>Nay {100 - ayePct}%</span>
            </div>
            <div style={{ background: "var(--bg-raised)", borderRadius: 4, height: 12, overflow: "hidden", border: "1px solid var(--border)" }}>
              <div style={{ width: `${ayePct}%`, height: "100%", background: "var(--ok)", opacity: 0.6 }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              <span><DOTAmount planck={governance.ayeWeighted} /> aye</span>
              <span><DOTAmount planck={governance.nayWeighted} /> nay</span>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--text)" }}>
            Quorum: {quorumPct}% of {<DOTAmount planck={governance.quorum} />} threshold
            {governance.resolved && <span style={{ color: "var(--ok)", marginLeft: 8 }}>✓ Resolved</span>}
          </div>
          {campaign.status <= 1 && (
            <Link to={`/governance/vote/${campaign.id}`} className="nano-btn nano-btn-accent" style={{
              display: "inline-block", marginTop: 10,
              padding: "6px 14px", fontSize: 12, textDecoration: "none",
            }}>
              Vote on this campaign
            </Link>
          )}
        </section>
      )}

      <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ color: "var(--accent)", fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Creative</h2>
        <IPFSPreview metadataHash={metadataHash} />
      </section>
    </div>
  );
}

function InfoCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="nano-card" style={{ padding: "10px 14px" }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ color: "var(--text-strong)", fontSize: 14 }}>{children}</div>
    </div>
  );
}
