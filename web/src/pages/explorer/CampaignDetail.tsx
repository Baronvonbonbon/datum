import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useBlock } from "../../hooks/useBlock";
import { useSettings } from "../../context/SettingsContext";
import { useTx } from "../../hooks/useTx";
import { StatusBadge } from "../../components/StatusBadge";
import { AddressDisplay } from "../../components/AddressDisplay";
import { DOTAmount } from "../../components/DOTAmount";
import { IPFSPreview } from "../../components/IPFSPreview";
import { TransactionStatus } from "../../components/TransactionStatus";
import { CampaignStatus } from "@shared/types";
import { formatBlockDelta } from "@shared/conviction";
import { getExplorerUrl } from "@shared/networks";
import { tagLabel } from "@shared/tagDictionary";
import { ethers } from "ethers";
import { queryFilterAll } from "@shared/eventQuery";
import { humanizeError } from "@shared/errorCodes";
import { toCSV, downloadCSV } from "@shared/csvExport";
import { formatDOT } from "@shared/dot";

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

const REPORT_REASONS: Record<number, string> = {
  1: "Spam",
  2: "Misleading",
  3: "Inappropriate",
  4: "Broken",
  5: "Other",
};

export function CampaignDetail({ backLink, backLabel }: { backLink?: string; backLabel?: string } = {}) {
  const { id } = useParams<{ id: string }>();
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { blockNumber } = useBlock();
  const { settings } = useSettings();
  const { confirmTx } = useTx();
  const EXPLORER = getExplorerUrl(settings.network);
  const [campaign, setCampaign] = useState<any>(null);
  const [budget, setBudget] = useState<any>(null);
  const [governance, setGovernance] = useState<any>(null);
  const [metadataHash, setMetadataHash] = useState<string>("0x" + "0".repeat(64));
  const [snapshotRelaySigner, setSnapshotRelaySigner] = useState<string | null>(null);
  const [snapshotTags, setSnapshotTags] = useState<string[]>([]);
  const [requiresZkProof, setRequiresZkProof] = useState(false);
  const [pageReportCount, setPageReportCount] = useState<bigint>(0n);
  const [adReportCount, setAdReportCount] = useState<bigint>(0n);
  const [reportReason, setReportReason] = useState(1);
  const [reportingPage, setReportingPage] = useState(false);
  const [reportingAd, setReportingAd] = useState(false);
  const [reportMsg, setReportMsg] = useState<string | null>(null);
  const [reportState, setReportState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [settlements, setSettlements] = useState<SettlementEvent[]>([]);
  const [settlementPage, setSettlementPage] = useState(0);
  const SETTLEMENTS_PER_PAGE = 15;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Token reward budget state (advertiser view)
  const [tokenAddress, setTokenAddress] = useState("");
  const [tokenBudget, setTokenBudget] = useState<bigint | null>(null);
  const [tokenMeta, setTokenMeta] = useState<{ symbol: string; decimals: number } | null>(null);
  const [checkingTokenBudget, setCheckingTokenBudget] = useState(false);
  const [reclaimingBudget, setReclaimingBudget] = useState(false);
  const [tokenBudgetMsg, setTokenBudgetMsg] = useState<string | null>(null);

  useEffect(() => {
    if (id !== undefined) load(Number(id));
  }, [id]);

  // Refresh settlement list whenever a new block arrives (after initial load)
  useEffect(() => {
    if (id !== undefined && campaign !== null && blockNumber !== null) {
      loadSettlements(Number(id));
    }
  }, [blockNumber]);

  async function loadSettlements(campaignId: number) {
    try {
      const filter = contracts.settlement.filters.ClaimSettled(BigInt(campaignId));
      const logs = await queryFilterAll(contracts.settlement, filter);
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
  }

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
        let originalBudget = 0n;
        try {
          const bFilter = contracts.budgetLedger.filters.BudgetInitialized(BigInt(campaignId));
          const bLogs = await queryFilterAll(contracts.budgetLedger, bFilter);
          if (bLogs.length > 0) originalBudget = BigInt((bLogs[0] as any).args?.budget ?? 0);
        } catch { /* no event */ }
        setBudget({
          remaining: BigInt(remaining),
          dailyCap: BigInt(dailyCap),
          lastSettlementBlock: Number(lastBlock),
          originalBudget,
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

      // Snapshot relay signer + publisher tags + ZK requirement
      try {
        const [relayAddr, pubTags, zkReq] = await Promise.all([
          contracts.campaigns.getCampaignRelaySigner(BigInt(campaignId)).catch(() => ethers.ZeroAddress),
          contracts.campaigns.getCampaignPublisherTags(BigInt(campaignId)).catch(() => []),
          contracts.campaigns.getCampaignRequiresZkProof(BigInt(campaignId)).catch(() => false),
        ]);
        setSnapshotRelaySigner(relayAddr !== ethers.ZeroAddress ? relayAddr as string : null);
        setSnapshotTags((pubTags as string[]).map((h: string) => tagLabel(h) ?? h.slice(0, 10) + "..."));
        setRequiresZkProof(Boolean(zkReq));
      } catch { /* not deployed */ }

      // Report counts
      try {
        const [pr, ar] = await Promise.all([
          contracts.reports.pageReports(BigInt(campaignId)).catch(() => 0n),
          contracts.reports.adReports(BigInt(campaignId)).catch(() => 0n),
        ]);
        setPageReportCount(BigInt(pr));
        setAdReportCount(BigInt(ar));
      } catch { /* no reports contract */ }

      // Metadata hash from events
      try {
        const filter = contracts.campaigns.filters.CampaignMetadataSet(BigInt(campaignId));
        const logs = await queryFilterAll(contracts.campaigns, filter);
        if (logs.length > 0) {
          const last = logs[logs.length - 1] as any;
          setMetadataHash(last.args?.metadataHash ?? "0x" + "0".repeat(64));
        }
      } catch { /* no events */ }

      // Initial settlement load
      await loadSettlements(campaignId);

    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckTokenBudget() {
    if (!campaign || !ethers.isAddress(tokenAddress.trim())) {
      setTokenBudgetMsg("Enter a valid ERC-20 token address.");
      return;
    }
    setCheckingTokenBudget(true);
    setTokenBudgetMsg(null);
    setTokenBudget(null);
    setTokenMeta(null);
    try {
      const budget = await contracts.tokenRewardVault.campaignTokenBudget(tokenAddress.trim(), BigInt(campaign.id));
      setTokenBudget(BigInt(budget));
      const erc20 = new ethers.Contract(tokenAddress.trim(), ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], contracts.readProvider);
      const [sym, dec] = await Promise.all([erc20.symbol().catch(() => "TOKEN"), erc20.decimals().catch(() => 18)]);
      setTokenMeta({ symbol: sym as string, decimals: Number(dec) });
    } catch (err) {
      setTokenBudgetMsg(humanizeError(err));
    } finally {
      setCheckingTokenBudget(false);
    }
  }

  async function handleReclaimBudget() {
    if (!signer || !campaign || !tokenAddress.trim()) return;
    setReclaimingBudget(true);
    setTokenBudgetMsg(null);
    try {
      const vault = contracts.tokenRewardVault.connect(signer) as typeof contracts.tokenRewardVault;
      const tx = await vault.reclaimExpiredBudget(BigInt(campaign.id), tokenAddress.trim());
      await tx.wait();
      setTokenBudgetMsg("Budget reclaimed successfully.");
      setTokenBudget(0n);
    } catch (err) {
      setTokenBudgetMsg(humanizeError(err));
    } finally {
      setReclaimingBudget(false);
    }
  }

  async function handleReportPage() {
    if (!signer || !campaign) return;
    setReportingPage(true);
    setReportState("pending");
    setReportMsg(null);
    try {
      const rep = contracts.reports.connect(signer);
      const tx = await rep.reportPage(BigInt(campaign.id), reportReason);
      await confirmTx(tx);
      setPageReportCount((c) => c + 1n);
      setReportState("success");
      setReportMsg("Page reported.");
    } catch (err) {
      setReportState("error");
      setReportMsg(humanizeError(err));
    } finally {
      setReportingPage(false);
    }
  }

  async function handleReportAd() {
    if (!signer || !campaign) return;
    setReportingAd(true);
    setReportState("pending");
    setReportMsg(null);
    try {
      const rep = contracts.reports.connect(signer);
      const tx = await rep.reportAd(BigInt(campaign.id), reportReason);
      await confirmTx(tx);
      setAdReportCount((c) => c + 1n);
      setReportState("success");
      setReportMsg("Ad reported.");
    } catch (err) {
      setReportState("error");
      setReportMsg(humanizeError(err));
    } finally {
      setReportingAd(false);
    }
  }

  if (loading) return <div className="nano-pending-text" style={{ color: "var(--text-muted)", padding: 20 }}>Loading campaign #{id}</div>;
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
        <Link to={backLink ?? "/campaigns"} style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>{backLabel ?? "← Campaigns"}</Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
          <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Campaign #{campaign.id}</h1>
          <StatusBadge status={campaign.status} />
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {address && campaign.advertiser.toLowerCase() === address.toLowerCase() && (
              <>
                <Link to={`/advertiser/campaign/${campaign.id}/metadata`} className="nano-btn" style={{ padding: "5px 12px", fontSize: 12, textDecoration: "none" }}>Edit Metadata</Link>
                <Link to="/advertiser" className="nano-btn" style={{ padding: "5px 12px", fontSize: 12, textDecoration: "none" }}>My Campaigns</Link>
              </>
            )}
            {campaign.status <= 1 && (
              <Link to={`/governance/vote/${campaign.id}`} className="nano-btn nano-btn-accent" style={{ padding: "5px 14px", fontSize: 12, textDecoration: "none" }}>
                Vote →
              </Link>
            )}
          </div>
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
        {requiresZkProof && (
          <InfoCard label="ZK Proof">
            <span className="nano-badge" style={{ color: "var(--accent)", fontSize: 12 }}>Required</span>
          </InfoCard>
        )}
      </div>

      {/* Publisher Snapshot */}
      {!isOpen && (snapshotRelaySigner || snapshotTags.length > 0) && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Publisher Snapshot</h2>
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 10 }}>Values snapshotted at campaign creation.</div>
          {snapshotRelaySigner && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Relay Signer</div>
              <AddressDisplay address={snapshotRelaySigner} explorerBase={EXPLORER} />
            </div>
          )}
          {snapshotTags.length > 0 && (
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Tags at Creation</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {snapshotTags.map((tag, i) => (
                  <span key={i} className="nano-badge" style={{ color: "var(--accent)" }}>{tag}</span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

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
          {budget.originalBudget > 0n && (() => {
            const pct = Number(budget.remaining * 100n / budget.originalBudget);
            return (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
                  <span><DOTAmount planck={budget.remaining} /> remaining</span>
                  <span>{pct}% of <DOTAmount planck={budget.originalBudget} /></span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: "var(--bg-raised)", overflow: "hidden", border: "1px solid var(--border)" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: pct > 20 ? "var(--ok)" : "var(--warn)", borderRadius: 3, transition: "width 300ms ease-out" }} />
                </div>
              </div>
            );
          })()}
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
              <span style={{ color: "var(--ok)" }}>Aye {ayePct}%</span>
              <span style={{ color: "var(--error)" }}>Nay {100 - ayePct}%</span>
            </div>
            <div style={{ position: "relative", background: "var(--bg-raised)", borderRadius: 4, height: 10, overflow: "hidden", border: "1px solid var(--border)", display: "flex" }}>
              <div style={{ width: `${ayePct}%`, height: "100%", background: "rgba(74,222,128,0.35)" }} />
              <div style={{ width: `${100 - ayePct}%`, height: "100%", background: "rgba(248,113,113,0.35)" }} />
              <div style={{ position: "absolute", left: "50%", top: 0, width: 1, height: "100%", background: "var(--text-muted)", opacity: 0.4 }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              <span><DOTAmount planck={governance.ayeWeighted} /> aye</span>
              <span><DOTAmount planck={governance.nayWeighted} /> nay</span>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Quorum: {quorumPct}% of <DOTAmount planck={governance.quorum} /> threshold
              {governance.resolved && <span style={{ color: "var(--ok)", marginLeft: 8 }}>✓ Resolved</span>}
            </div>
            {campaign.status <= 2 && (
              <Link to={`/governance/vote/${campaign.id}`} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none" }}>
                Cast Vote →
              </Link>
            )}
          </div>
        </section>
      )}

      <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Creative</h2>
        <IPFSPreview metadataHash={metadataHash} />
      </section>

      {/* Token Budget (advertiser only) */}
      {address && campaign.advertiser.toLowerCase() === address.toLowerCase() && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Token Reward Budget</h2>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
            Check remaining ERC-20 token budget for this campaign. Ended campaigns (Completed / Terminated / Expired) can reclaim unspent tokens.
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              type="text"
              value={tokenAddress}
              onChange={(e) => { setTokenAddress(e.target.value.trim()); setTokenBudget(null); setTokenMeta(null); setTokenBudgetMsg(null); }}
              placeholder="Token contract address (0x...)"
              className="nano-input"
              style={{ flex: 1, fontSize: 12 }}
            />
            <button className="nano-btn" onClick={handleCheckTokenBudget} disabled={checkingTokenBudget} style={{ fontSize: 12, padding: "5px 12px", whiteSpace: "nowrap" }}>
              {checkingTokenBudget ? "Checking..." : "Check Balance"}
            </button>
          </div>
          {tokenBudget !== null && tokenMeta && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ color: "var(--text-strong)", fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                Remaining: {tokenBudget === 0n ? "0" : (Number(tokenBudget) / Math.pow(10, tokenMeta.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })}{" "}
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{tokenMeta.symbol}</span>
              </div>
              {tokenBudget > 0n && campaign.status >= 3 && (
                <button className="nano-btn" onClick={handleReclaimBudget} disabled={reclaimingBudget} style={{ fontSize: 12, padding: "5px 12px" }}>
                  {reclaimingBudget ? "Reclaiming..." : `Reclaim ${tokenMeta.symbol} Budget`}
                </button>
              )}
              {tokenBudget > 0n && campaign.status < 3 && (
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 4 }}>Budget reclaim available when campaign ends (Completed / Terminated / Expired).</div>
              )}
            </div>
          )}
          {tokenBudgetMsg && (
            <div style={{ fontSize: 12, color: tokenBudgetMsg.includes("successfully") ? "var(--ok)" : "var(--error)", marginTop: 4 }}>
              {tokenBudgetMsg}
            </div>
          )}
        </section>
      )}

      {/* Community Feedback */}
      <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Community Feedback</h2>
        <div style={{ display: "flex", gap: 20, marginBottom: 14 }}>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Page Reports</div>
            <div style={{ color: "var(--text-strong)", fontSize: 18, fontWeight: 700 }}>{pageReportCount.toString()}</div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Ad Reports</div>
            <div style={{ color: "var(--text-strong)", fontSize: 18, fontWeight: 700 }}>{adReportCount.toString()}</div>
          </div>
        </div>
        {signer ? (
          <div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ color: "var(--text)", fontSize: 12, marginRight: 8 }}>Reason:</label>
              <select
                className="nano-select"
                value={reportReason}
                onChange={(e) => setReportReason(Number(e.target.value))}
                style={{ fontSize: 12, padding: "3px 8px" }}
              >
                {Object.entries(REPORT_REASONS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="nano-btn"
                onClick={handleReportPage}
                disabled={reportingPage || reportingAd}
                style={{ fontSize: 12, padding: "5px 12px" }}
              >
                {reportingPage ? "Reporting..." : "Report Page"}
              </button>
              <button
                className="nano-btn"
                onClick={handleReportAd}
                disabled={reportingPage || reportingAd}
                style={{ fontSize: 12, padding: "5px 12px" }}
              >
                {reportingAd ? "Reporting..." : "Report Ad"}
              </button>
            </div>
            {(reportMsg || reportState !== "idle") && (
              <div style={{ marginTop: 8 }}>
                <TransactionStatus state={reportState} message={reportMsg ?? undefined} />
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Connect wallet to report.</div>
        )}
      </section>

      {/* Settlement history */}
      <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>
          Settlement History
          {settlements.length > 0 && <span style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 8, textTransform: "none", fontSize: 12 }}>{settlements.length} event{settlements.length !== 1 ? "s" : ""}</span>}
          {settlements.length > 0 && (
            <button
              onClick={() => {
                const rows = settlements.map((s) => ({
                  Block: s.blockNumber,
                  User: s.user,
                  Publisher: s.publisher,
                  Impressions: s.impressionCount.toString(),
                  CPM: formatDOT(s.clearingCpmPlanck),
                  "User Earned": formatDOT(s.userPayment),
                  "Publisher Earned": formatDOT(s.publisherPayment),
                  Tx: s.txHash,
                }));
                downloadCSV(`campaign-${id}-settlements.csv`, toCSV(["Block", "User", "Publisher", "Impressions", "CPM", "User Earned", "Publisher Earned", "Tx"], rows));
              }}
              className="nano-btn"
              style={{ fontSize: 10, padding: "2px 8px", marginLeft: 8, textTransform: "none", fontWeight: 400, float: "right" }}
            >
              Export CSV
            </button>
          )}
        </h2>
        {settlements.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No settlements yet.</div>
        ) : (
          <>
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
                  {settlements
                    .slice(settlementPage * SETTLEMENTS_PER_PAGE, (settlementPage + 1) * SETTLEMENTS_PER_PAGE)
                    .map((s, i) => (
                    <tr key={i}>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>#{s.blockNumber}</td>
                      <td><AddressDisplay address={s.user} chars={4} explorerBase={EXPLORER} style={{ fontSize: 12 }} /></td>
                      <td><AddressDisplay address={s.publisher} chars={4} explorerBase={EXPLORER} style={{ fontSize: 12 }} /></td>
                      <td style={{ color: "var(--ok)", fontSize: 12 }}>{s.impressionCount.toString()}</td>
                      <td style={{ fontSize: 12 }}><DOTAmount planck={s.clearingCpmPlanck} /></td>
                      <td style={{ fontSize: 12 }}><DOTAmount planck={s.userPayment} /></td>
                      <td>
                        {EXPLORER && /^0x[0-9a-fA-F]{64}$/.test(s.txHash) ? (
                          <a href={`${EXPLORER}/tx/${s.txHash}`} target="_blank" rel="noopener noreferrer"
                            style={{ color: "var(--accent-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                            {s.txHash.slice(0, 8)}…
                          </a>
                        ) : (
                          <span style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                            {s.txHash.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {settlements.length > SETTLEMENTS_PER_PAGE && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  Showing {settlementPage * SETTLEMENTS_PER_PAGE + 1}–{Math.min((settlementPage + 1) * SETTLEMENTS_PER_PAGE, settlements.length)} of {settlements.length}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => setSettlementPage((p) => Math.max(0, p - 1))}
                    disabled={settlementPage === 0}
                    className="nano-btn"
                    style={{ fontSize: 11, padding: "3px 10px" }}
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setSettlementPage((p) => p + 1)}
                    disabled={(settlementPage + 1) * SETTLEMENTS_PER_PAGE >= settlements.length}
                    className="nano-btn"
                    style={{ fontSize: 11, padding: "3px 10px" }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
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
