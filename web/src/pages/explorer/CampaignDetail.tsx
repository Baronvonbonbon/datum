import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useBlock } from "../../hooks/useBlock";
import { useSettings } from "../../context/SettingsContext";
import { StatusBadge } from "../../components/StatusBadge";
import { AddressDisplay } from "../../components/AddressDisplay";
import { DOTAmount } from "../../components/DOTAmount";
import { IPFSPreview } from "../../components/IPFSPreview";
import { CampaignStatus } from "@shared/types";
import { formatBlockDelta } from "@shared/conviction";
import { ethers } from "ethers";

const EXPLORER = "https://blockscout-testnet.polkadot.io";

interface SettlementEvent {
  txHash: string;
  blockNumber: number;
  user: string;
  publisher: string;
  impressionCount: bigint;
  clearingCpmPlanck: bigint;
  userPayment: bigint;
  publisherPayment: bigint;
}

export function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const contracts = useContracts();
  const { blockNumber } = useBlock();
  const { settings } = useSettings();
  const [campaign, setCampaign] = useState<any>(null);
  const [budget, setBudget] = useState<any>(null);
  const [governance, setGovernance] = useState<any>(null);
  const [metadataHash, setMetadataHash] = useState<string>("0x" + "0".repeat(64));
  const [settlements, setSettlements] = useState<SettlementEvent[]>([]);
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

      // Settlement history from ClaimSettled events
      try {
        const filter = contracts.settlement.filters.ClaimSettled(BigInt(campaignId));
        const logs = await contracts.settlement.queryFilter(filter);
        const evts: SettlementEvent[] = logs.map((log: any) => ({
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          user: log.args?.user ?? "",
          publisher: log.args?.publisher ?? "",
          impressionCount: BigInt(log.args?.impressionCount ?? 0),
          clearingCpmPlanck: BigInt(log.args?.clearingCpmPlanck ?? 0),
          userPayment: BigInt(log.args?.userPayment ?? 0),
          publisherPayment: BigInt(log.args?.publisherPayment ?? 0),
        }));
        setSettlements(evts.reverse()); // newest first
      } catch { /* no settlement contract */ }

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

  const totalImpressions = settlements.reduce((s, e) => s + e.impressionCount, 0n);
  const totalUserPayments = settlements.reduce((s, e) => s + e.userPayment, 0n);
  const totalPublisherPayments = settlements.reduce((s, e) => s + e.publisherPayment, 0n);
  const uniqueUsers = new Set(settlements.map((e) => e.user)).size;

  return (
    <div className="nano-fade" style={{ maxWidth: 860 }}>
      <div style={{ marginBottom: 20 }}>
        <Link to="/campaigns" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Campaigns</Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
          <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Campaign #{campaign.id}</h1>
          <StatusBadge status={campaign.status} />
          {campaign.status <= 1 && (
            <Link to={`/governance/vote/${campaign.id}`} className="nano-btn nano-btn-accent" style={{ marginLeft: "auto", padding: "5px 14px", fontSize: 12, textDecoration: "none" }}>
              Vote →
            </Link>
          )}
        </div>
      </div>

      {/* Core info grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
        <InfoCard label="Advertiser">
          <AddressDisplay address={campaign.advertiser} explorerBase={EXPLORER} />
        </InfoCard>
        <InfoCard label="Publisher">
          {isOpen
            ? <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Open (any publisher)</span>
            : <AddressDisplay address={campaign.publisher} explorerBase={EXPLORER} />}
        </InfoCard>
        <InfoCard label="Bid CPM">
          <DOTAmount planck={campaign.bidCpmPlanck} />
        </InfoCard>
        <InfoCard label="Take Rate">
          <span style={{ color: "var(--text-strong)" }}>{(campaign.snapshotTakeRateBps / 100).toFixed(0)}%</span>
        </InfoCard>
      </div>

      {/* Settlement totals — always shown once loaded */}
      {settlements.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
          <InfoCard label="Total Impressions">
            <span style={{ color: "var(--ok)" }}>{totalImpressions.toLocaleString()}</span>
          </InfoCard>
          <InfoCard label="Unique Users">
            <span style={{ color: "var(--text-strong)" }}>{uniqueUsers}</span>
          </InfoCard>
          <InfoCard label="Paid to Users">
            <DOTAmount planck={totalUserPayments} />
          </InfoCard>
          <InfoCard label="Paid to Publishers">
            <DOTAmount planck={totalPublisherPayments} />
          </InfoCard>
        </div>
      )}

      {budget && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Budget</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            <InfoCard label="Remaining"><DOTAmount planck={budget.remaining} /></InfoCard>
            <InfoCard label="Daily Cap"><DOTAmount planck={budget.dailyCap} /></InfoCard>
          </div>
          {budget.lastSettlementBlock > 0 && blockNumber && (
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 10 }}>
              Last settlement: block #{budget.lastSettlementBlock} · {formatBlockDelta(blockNumber - budget.lastSettlementBlock)} ago
              {campaign.status === CampaignStatus.Active && blockNumber - budget.lastSettlementBlock > 432_000 && (
                <span style={{ color: "var(--warn)", marginLeft: 8 }}>⚠ Inactivity timeout eligible</span>
              )}
            </div>
          )}
        </section>
      )}

      {governance && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Governance</h2>
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text)", marginBottom: 4 }}>
              <span>Aye {ayePct}%</span>
              <span>Nay {100 - ayePct}%</span>
            </div>
            <div style={{ background: "var(--bg-raised)", borderRadius: 4, height: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
              <div style={{ width: `${ayePct}%`, height: "100%", background: "var(--ok)", opacity: 0.5 }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              <span><DOTAmount planck={governance.ayeWeighted} /> aye</span>
              <span><DOTAmount planck={governance.nayWeighted} /> nay</span>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Quorum: {quorumPct}% of <DOTAmount planck={governance.quorum} /> threshold
            {governance.resolved && <span style={{ color: "var(--ok)", marginLeft: 8 }}>✓ Resolved</span>}
          </div>
        </section>
      )}

      <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Creative</h2>
        <IPFSPreview metadataHash={metadataHash} />
      </section>

      {/* Settlement history */}
      <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>
          Settlement History
          {settlements.length > 0 && <span style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 8, textTransform: "none", fontSize: 12 }}>{settlements.length} event{settlements.length !== 1 ? "s" : ""}</span>}
        </h2>
        {settlements.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No settlements yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="nano-table">
              <thead>
                <tr>
                  <th>Block</th>
                  <th>User</th>
                  <th>Publisher</th>
                  <th>Impressions</th>
                  <th>CPM</th>
                  <th>User Earned</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {settlements.map((s, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>#{s.blockNumber}</td>
                    <td><AddressDisplay address={s.user} chars={4} explorerBase={EXPLORER} style={{ fontSize: 12 }} /></td>
                    <td><AddressDisplay address={s.publisher} chars={4} explorerBase={EXPLORER} style={{ fontSize: 12 }} /></td>
                    <td style={{ color: "var(--ok)", fontSize: 12 }}>{s.impressionCount.toString()}</td>
                    <td style={{ fontSize: 12 }}><DOTAmount planck={s.clearingCpmPlanck} /></td>
                    <td style={{ fontSize: 12 }}><DOTAmount planck={s.userPayment} /></td>
                    <td>
                      <a href={`${EXPLORER}/tx/${s.txHash}`} target="_blank" rel="noreferrer"
                        style={{ color: "var(--accent-dim)", fontSize: 11, fontFamily: "monospace" }}>
                        {s.txHash.slice(0, 8)}…
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
