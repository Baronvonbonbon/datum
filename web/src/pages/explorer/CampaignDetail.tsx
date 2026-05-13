import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useBlock } from "../../hooks/useBlock";
import { useSettings } from "../../context/SettingsContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { StatusBadge } from "../../components/StatusBadge";
import { AddressDisplay } from "../../components/AddressDisplay";
import { DOTAmount } from "../../components/DOTAmount";
import { IPFSPreview } from "../../components/IPFSPreview";
import { TransactionStatus } from "../../components/TransactionStatus";
import { CampaignStatus } from "@shared/types";
import { formatBlockDelta } from "@shared/conviction";
import { getExplorerUrl } from "@shared/networks";
import { tagLabel } from "@shared/tagDictionary";
import { ethers, Contract } from "ethers";
import { queryFilterAll } from "@shared/eventQuery";
import { humanizeError } from "@shared/errorCodes";
import { toCSV, downloadCSV } from "@shared/csvExport";
import { formatDOT } from "@shared/dot";
import { getAssetMetadata } from "@shared/assetRegistry";

const ACTION_LABELS: Record<number, string> = { 0: "View", 1: "Click", 2: "Action" };

interface SettlementEvent {
  txHash: string;
  blockNumber: number;
  user: string;
  publisher: string;
  impressionCount: bigint;
  ratePlanck: bigint;
  userPayment: bigint;
  publisherPayment: bigint;
  actionType: number;
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
  const { push } = useToast();
  const EXPLORER = getExplorerUrl(settings.network);
  const [campaign, setCampaign] = useState<any>(null);
  const [budget, setBudget] = useState<any>(null);
  const [governance, setGovernance] = useState<any>(null);
  const [metadataHash, setMetadataHash] = useState<string>("0x" + "0".repeat(64));
  const [bulletinDigest, setBulletinDigest] = useState<string>("0x" + "0".repeat(64));
  const [bulletinCodec, setBulletinCodec] = useState<number>(0);
  const [snapshotRelaySigner, setSnapshotRelaySigner] = useState<string | null>(null);
  const [snapshotTags, setSnapshotTags] = useState<string[]>([]);
  const [requiredTags, setRequiredTags] = useState<string[]>([]);
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

  // Governance action state
  const [evaluateBusy, setEvaluateBusy] = useState(false);
  const [evaluateMsg, setEvaluateMsg] = useState<string | null>(null);

  // Token reward sidecar state (visible to all)
  const [tokenReward, setTokenReward] = useState<{
    token: string;
    rewardPerImpression: bigint;
    remainingBudget: bigint;
    meta: { symbol: string; decimals: number; name: string } | null;
  } | null>(null);
  const [reclaimingBudget, setReclaimingBudget] = useState(false);
  const [tokenBudgetMsg, setTokenBudgetMsg] = useState<string | null>(null);
  const [bondAmount, setBondAmount] = useState<bigint | null>(null);

  // Advertiser pull-payment state — pendingAdvertiserRefund (DOT) + bondOwner (challenge bond)
  const [pendingDotRefund, setPendingDotRefund] = useState<bigint>(0n);
  const [bondOwnerAddr, setBondOwnerAddr] = useState<string | null>(null);
  const [claimingDotRefund, setClaimingDotRefund] = useState(false);
  const [claimingBond, setClaimingBond] = useState(false);
  const [refundMsg, setRefundMsg] = useState<string | null>(null);

  // Dual-sig flag (set per-campaign by the advertiser, pre-activation only)
  const [requiresDualSig, setRequiresDualSig] = useState(false);
  const [dualSigBusy, setDualSigBusy] = useState(false);

  // Per-pot configuration (CPM/CPC/CPA) — drives the Bid Configuration section
  interface PotInfo { actionType: number; budgetPlanck: bigint; dailyCapPlanck: bigint; ratePlanck: bigint; actionVerifier: string; remaining: bigint; }
  const [pots, setPots] = useState<PotInfo[]>([]);

  // Token-reward deposit (top-up) state — for wizard-recovery and ongoing top-ups
  const [depositAmount, setDepositAmount] = useState("");
  const [depositing, setDepositing] = useState(false);
  const [depositMsg, setDepositMsg] = useState<string | null>(null);

  useEffect(() => {
    if (id !== undefined) load(Number(id));
  }, [id]);

  // Refresh settlement list whenever a new block arrives (after initial load)
  useEffect(() => {
    if (id !== undefined && campaign !== null && blockNumber !== null) {
      loadSettlements(Number(id));
    }
  }, [blockNumber]);

  // Refresh the connected wallet's pending DOT refund (BudgetLedger pull-payment).
  // Reads on initial mount, on connect/disconnect, and after each new block.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!address) { if (!cancelled) setPendingDotRefund(0n); return; }
      try {
        const v = await contracts.budgetLedger.pendingAdvertiserRefund(address);
        if (!cancelled) setPendingDotRefund(BigInt(v));
      } catch { if (!cancelled) setPendingDotRefund(0n); }
    })();
    return () => { cancelled = true; };
  }, [address, blockNumber, contracts]);

  async function loadSettlements(campaignId: number) {
    try {
      const filter = contracts.settlement.filters.ClaimSettled(BigInt(campaignId));
      const logs = await queryFilterAll(contracts.settlement, filter);
      const evts: SettlementEvent[] = logs.map((log: any) => ({
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        user: log.args?.user ?? "",
        publisher: log.args?.publisher ?? "",
        impressionCount: BigInt(log.args?.eventCount ?? 0),
        ratePlanck: BigInt(log.args?.ratePlanck ?? 0),
        userPayment: BigInt(log.args?.userPayment ?? 0),
        publisherPayment: BigInt(log.args?.publisherPayment ?? 0),
        actionType: Number(log.args?.actionType ?? 0),
      }));
      setSettlements(evts.reverse()); // newest first
    } catch { /* no settlement contract */ }
  }

  async function load(campaignId: number) {
    setLoading(true);
    setError(null);
    try {
      const [c, adv, viewBid] = await Promise.all([
        contracts.campaigns.getCampaignForSettlement(BigInt(campaignId)),
        contracts.campaigns.getCampaignAdvertiser(BigInt(campaignId)),
        contracts.campaigns.getCampaignViewBid(BigInt(campaignId)).catch(() => 0n),
      ]);

      setCampaign({
        id: campaignId,
        status: Number(c[0]),
        publisher: c[1] as string,
        bidCpmPlanck: BigInt(viewBid),
        snapshotTakeRateBps: Number(c[2]),
        advertiser: adv as string,
      });

      // Budget info — sum across pots; per-pot dailyCap is shown in the
      // Bid Configuration section, this aggregate is just for the headline.
      try {
        const [remaining, viewDailyCap, lastBlock] = await Promise.all([
          contracts.budgetLedger.getTotalRemainingBudget(BigInt(campaignId)).catch(() => 0n),
          contracts.budgetLedger.getDailyCap(BigInt(campaignId), 0).catch(() => 0n),
          contracts.budgetLedger.lastSettlementBlock(BigInt(campaignId)).catch(() => 0),
        ]);
        const dailyCap = viewDailyCap;
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
        const [aye, nay, resolved, quorum, firstNayBlk, baseGrace] = await Promise.all([
          contracts.governanceV2.ayeWeighted(BigInt(campaignId)),
          contracts.governanceV2.nayWeighted(BigInt(campaignId)),
          contracts.governanceV2.resolved(BigInt(campaignId)),
          contracts.governanceV2.quorumWeighted(),
          contracts.governanceV2.firstNayBlock(BigInt(campaignId)).catch(() => 0),
          contracts.governanceV2.baseGraceBlocks().catch(() => 0),
        ]);
        setGovernance({
          ayeWeighted: BigInt(aye),
          nayWeighted: BigInt(nay),
          resolved: Boolean(resolved),
          quorum: BigInt(quorum),
          firstNayBlock: Number(firstNayBlk),
          baseGraceBlocks: Number(baseGrace),
        });
      } catch { /* GovernanceV2 not configured */ }

      // Snapshot relay signer + publisher tags + required tags + ZK requirement
      try {
        const [relayAddr, pubTags, reqTags, zkReq] = await Promise.all([
          contracts.campaigns.getCampaignRelaySigner(BigInt(campaignId)).catch(() => ethers.ZeroAddress),
          contracts.campaigns.getCampaignPublisherTags(BigInt(campaignId)).catch(() => []),
          contracts.campaigns.getCampaignTags(BigInt(campaignId)).catch(() => []),
          contracts.campaigns.getCampaignRequiresZkProof(BigInt(campaignId)).catch(() => false),
        ]);
        setSnapshotRelaySigner(relayAddr !== ethers.ZeroAddress ? relayAddr as string : null);
        setSnapshotTags((pubTags as string[]).map((h: string) => tagLabel(h) ?? h.slice(0, 10) + "..."));
        setRequiredTags((reqTags as string[]).map((h: string) => tagLabel(h) ?? h.slice(0, 10) + "..."));
        setRequiresZkProof(Boolean(zkReq));
      } catch { /* not deployed */ }

      // Report counts (merged into Campaigns in alpha-4)
      try {
        const [pr, ar] = await Promise.all([
          contracts.campaigns.pageReports(BigInt(campaignId)).catch(() => 0n),
          contracts.campaigns.adReports(BigInt(campaignId)).catch(() => 0n),
        ]);
        setPageReportCount(BigInt(pr));
        setAdReportCount(BigInt(ar));
      } catch { /* no campaigns contract */ }

      // Metadata hash from events
      try {
        const filter = contracts.campaigns.filters.CampaignMetadataSet(BigInt(campaignId));
        const logs = await queryFilterAll(contracts.campaigns, filter);
        if (logs.length > 0) {
          const last = logs[logs.length - 1] as any;
          setMetadataHash(last.args?.metadataHash ?? "0x" + "0".repeat(64));
        }
      } catch { /* no events */ }

      // Bulletin Chain creative ref (Phase A): prefer when set.
      try {
        const ref = await contracts.campaigns.getBulletinCreative(BigInt(campaignId));
        // ethers v6 returns Result tuple; tolerate either struct-style or array-style.
        const digest = (ref as any).cidDigest ?? (ref as any)[0];
        const codec = Number((ref as any).cidCodec ?? (ref as any)[1] ?? 0);
        if (digest && typeof digest === "string") setBulletinDigest(digest);
        setBulletinCodec(codec);
      } catch { /* legacy deployment without Bulletin support */ }

      // Token reward sidecar
      try {
        const [rewardTok, rewardPerImp] = await Promise.all([
          contracts.campaigns.getCampaignRewardToken(BigInt(campaignId)).catch(() => ethers.ZeroAddress),
          contracts.campaigns.getCampaignRewardPerImpression(BigInt(campaignId)).catch(() => 0n),
        ]);
        if (rewardTok && rewardTok !== ethers.ZeroAddress) {
          const knownAsset = getAssetMetadata(rewardTok as string);
          let sym: string, dec: number, nm: string;
          if (knownAsset) {
            sym = knownAsset.symbol; dec = knownAsset.decimals; nm = knownAsset.name;
          } else {
            const erc20 = new ethers.Contract(rewardTok, [
              "function symbol() view returns (string)",
              "function decimals() view returns (uint8)",
              "function name() view returns (string)",
            ], contracts.readProvider);
            [sym, dec, nm] = await Promise.all([
              erc20.symbol().catch(() => "TOKEN"),
              erc20.decimals().catch(() => 18),
              erc20.name().catch(() => "Unknown Token"),
            ]);
          }
          let remainingBudget = 0n;
          try {
            remainingBudget = BigInt(await contracts.tokenRewardVault.campaignTokenBudget(rewardTok, BigInt(campaignId)));
          } catch { /* vault not available */ }
          setTokenReward({
            token: rewardTok as string,
            rewardPerImpression: BigInt(rewardPerImp),
            remainingBudget,
            meta: { symbol: sym as string, decimals: Number(dec), name: nm as string },
          });
        } else {
          setTokenReward(null);
        }
      } catch { /* no token reward */ }

      // Challenge bond — amount + bondOwner (pull-claim recipient)
      try {
        const [b, owner] = await Promise.all([
          contracts.challengeBonds.bond(BigInt(campaignId)).catch(() => null),
          contracts.challengeBonds.bondOwner(BigInt(campaignId)).catch(() => null),
        ]);
        setBondAmount(b !== null ? BigInt(b) : null);
        setBondOwnerAddr(owner !== null ? (owner as string) : null);
      } catch { setBondAmount(null); setBondOwnerAddr(null); }

      // Per-campaign dual-sig flag (post-b85fcf7 settlement opt-in)
      try {
        const ds = await contracts.campaigns.getCampaignRequiresDualSig(BigInt(campaignId));
        setRequiresDualSig(Boolean(ds));
      } catch { setRequiresDualSig(false); }

      // Per-pot configuration — fetch all pots + remaining per pot
      try {
        const rawPots: any[] = await contracts.campaigns.getCampaignPots(BigInt(campaignId));
        const enriched: PotInfo[] = await Promise.all(rawPots.map(async (p: any) => {
          const at = Number(p.actionType ?? p[0] ?? 0);
          let rem = 0n;
          try {
            rem = BigInt(await contracts.budgetLedger.getRemainingBudget(BigInt(campaignId), at));
          } catch { /* missing pot */ }
          return {
            actionType: at,
            budgetPlanck: BigInt(p.budgetPlanck ?? p[1] ?? 0),
            dailyCapPlanck: BigInt(p.dailyCapPlanck ?? p[2] ?? 0),
            ratePlanck: BigInt(p.ratePlanck ?? p[3] ?? 0),
            actionVerifier: (p.actionVerifier ?? p[4] ?? ethers.ZeroAddress) as string,
            remaining: rem,
          };
        }));
        setPots(enriched);
      } catch { setPots([]); }

      // Initial settlement load
      await loadSettlements(campaignId);

    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setLoading(false);
    }
  }


  async function handleDepositTokenBudget() {
    if (!signer || !campaign || !tokenReward) return;
    const raw = depositAmount.trim();
    if (!raw) return;
    let amt: bigint;
    try {
      // Accept human decimal input — scale by token decimals
      const parts = raw.split(".");
      const whole = BigInt(parts[0] || "0");
      const fracRaw = (parts[1] ?? "").slice(0, tokenReward.meta?.decimals ?? 18);
      const fracPad = (fracRaw + "0".repeat((tokenReward.meta?.decimals ?? 18) - fracRaw.length)) || "0";
      amt = whole * (10n ** BigInt(tokenReward.meta?.decimals ?? 18)) + BigInt(fracPad || "0");
    } catch {
      setDepositMsg("Invalid amount.");
      return;
    }
    if (amt === 0n) { setDepositMsg("Enter a non-zero amount."); return; }
    setDepositing(true);
    setDepositMsg(null);
    try {
      const erc20 = new Contract(tokenReward.token, [
        "function approve(address,uint256) returns (bool)",
      ], signer);
      const vaultAddr = settings.contractAddresses.tokenRewardVault;
      const approveTx = await erc20.approve(vaultAddr, amt);
      await confirmTx(approveTx);
      const vault = contracts.tokenRewardVault.connect(signer) as typeof contracts.tokenRewardVault;
      const depositTx = await vault.depositCampaignBudget(BigInt(campaign.id), tokenReward.token, amt);
      await confirmTx(depositTx);
      setDepositMsg(`Deposited ${raw} ${tokenReward.meta?.symbol ?? ""}.`);
      setTokenReward((prev) => prev ? { ...prev, remainingBudget: prev.remainingBudget + amt } : prev);
      setDepositAmount("");
    } catch (err) {
      push(humanizeError(err), "error");
      setDepositMsg(humanizeError(err));
    } finally {
      setDepositing(false);
    }
  }

  async function handleClaimDotRefund() {
    if (!signer || pendingDotRefund === 0n) return;
    setClaimingDotRefund(true);
    setRefundMsg(null);
    try {
      const bl = contracts.budgetLedger.connect(signer) as typeof contracts.budgetLedger;
      const tx = await bl.claimAdvertiserRefund();
      await confirmTx(tx);
      setRefundMsg("DOT refund claimed.");
      setPendingDotRefund(0n);
    } catch (err) {
      push(humanizeError(err), "error");
      setRefundMsg(humanizeError(err));
    } finally {
      setClaimingDotRefund(false);
    }
  }

  async function handleClaimBond() {
    if (!signer || !campaign) return;
    setClaimingBond(true);
    setRefundMsg(null);
    try {
      const cb = contracts.challengeBonds.connect(signer) as typeof contracts.challengeBonds;
      const tx = await cb.claimBondReturn();
      await confirmTx(tx);
      setRefundMsg("Bond return claimed.");
    } catch (err) {
      push(humanizeError(err), "error");
      setRefundMsg(humanizeError(err));
    } finally {
      setClaimingBond(false);
    }
  }

  async function handleToggleDualSig() {
    if (!signer || !campaign) return;
    if (campaign.status !== 0) return; // contract requires Pending
    setDualSigBusy(true);
    try {
      const c = contracts.campaigns.connect(signer) as typeof contracts.campaigns;
      const tx = await c.setCampaignRequiresDualSig(BigInt(campaign.id), !requiresDualSig);
      await confirmTx(tx);
      setRequiresDualSig(!requiresDualSig);
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setDualSigBusy(false);
    }
  }

  async function handleReclaimBudget() {
    if (!signer || !campaign || !tokenReward) return;
    setReclaimingBudget(true);
    setTokenBudgetMsg(null);
    try {
      const vault = contracts.tokenRewardVault.connect(signer) as typeof contracts.tokenRewardVault;
      const tx = await vault.reclaimExpiredBudget(BigInt(campaign.id), tokenReward.token);
      await confirmTx(tx);
      setTokenBudgetMsg("Budget reclaimed successfully.");
      setTokenReward(prev => prev ? { ...prev, remainingBudget: 0n } : null);
    } catch (err) {
      push(humanizeError(err), "error");
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
      const c = contracts.campaigns.connect(signer);
      const tx = await c.reportPage(BigInt(campaign.id), reportReason);
      await confirmTx(tx);
      setPageReportCount((c) => c + 1n);
      setReportState("success");
      setReportMsg("Page reported.");
    } catch (err) {
      setReportState("error");
      push(humanizeError(err), "error");
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
      const c = contracts.campaigns.connect(signer);
      const tx = await c.reportAd(BigInt(campaign.id), reportReason);
      await confirmTx(tx);
      setAdReportCount((c) => c + 1n);
      setReportState("success");
      setReportMsg("Ad reported.");
    } catch (err) {
      setReportState("error");
      push(humanizeError(err), "error");
      setReportMsg(humanizeError(err));
    } finally {
      setReportingAd(false);
    }
  }

  async function handleEvaluate() {
    if (!signer || !campaign) return;
    setEvaluateBusy(true);
    setEvaluateMsg(null);
    try {
      const g = contracts.governanceV2.connect(signer);
      const tx = await g.evaluateCampaign(BigInt(campaign.id));
      await confirmTx(tx);
      setEvaluateMsg("Campaign evaluated successfully.");
      load(campaign.id);
    } catch (err) {
      push(humanizeError(err), "error");
      setEvaluateMsg(humanizeError(err));
    } finally {
      setEvaluateBusy(false);
    }
  }

  if (loading) return <div className="nano-pending-text" style={{ color: "var(--text-muted)", padding: 20 }}>Loading campaign #{id}</div>;
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
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <AddressDisplay address={campaign.advertiser} explorerBase={EXPLORER} />
            <Link to={`/advertisers/${campaign.advertiser}`} style={{ fontSize: 11, color: "var(--text-muted)" }}>View profile →</Link>
          </div>
        </InfoCard>
        <InfoCard label="Publisher">
          {isOpen
            ? <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Open (any publisher)</span>
            : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <AddressDisplay address={campaign.publisher} explorerBase={EXPLORER} />
                <Link to={`/publishers/${campaign.publisher}`} style={{ fontSize: 11, color: "var(--text-muted)" }}>View profile →</Link>
              </div>
            )}
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

      {/* Required Tags */}
      {requiredTags.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0 }}>Required publisher tags:</span>
          {requiredTags.map((tag, i) => (
            <span key={i} className="nano-badge" style={{ color: "var(--accent)" }}>{tag}</span>
          ))}
        </div>
      )}

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

      {governance && (() => {
        const graceReadyBlock = governance.firstNayBlock > 0
          ? governance.firstNayBlock + governance.baseGraceBlocks
          : null;
        const graceElapsed = graceReadyBlock !== null && blockNumber !== null
          ? blockNumber >= graceReadyBlock
          : null;
        const graceBlocksLeft = graceReadyBlock !== null && blockNumber !== null && !graceElapsed
          ? graceReadyBlock - blockNumber
          : 0;
        const nayMajority = totalVotes > 0n && governance.nayWeighted * 100n / totalVotes >= 50n;
        const canEvaluate = campaign.status <= 2;

        return (
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

            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
              Quorum: {quorumPct}% of <DOTAmount planck={governance.quorum} /> threshold
              {governance.resolved && <span style={{ color: "var(--ok)", marginLeft: 8 }}>✓ Resolved</span>}
            </div>

            {/* Grace period info — shown when nay majority and termination pending */}
            {nayMajority && governance.firstNayBlock > 0 && (
              <div style={{
                fontSize: 12,
                padding: "8px 10px",
                marginBottom: 10,
                borderRadius: "var(--radius-sm)",
                background: graceElapsed ? "rgba(74,222,128,0.08)" : "rgba(251,191,36,0.08)",
                border: `1px solid ${graceElapsed ? "rgba(74,222,128,0.2)" : "rgba(251,191,36,0.2)"}`,
                color: "var(--text)",
              }}>
                {graceElapsed ? (
                  <span style={{ color: "var(--ok)" }}>Grace period elapsed — termination can be evaluated.</span>
                ) : (
                  <span>
                    <span style={{ color: "var(--warn)" }}>Grace period:</span>{" "}
                    {graceBlocksLeft > 0 ? (
                      <>{formatBlockDelta(graceBlocksLeft)} remaining before termination can be evaluated</>
                    ) : (
                      <>calculating...</>
                    )}
                    <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                      (safety cooldown from first nay vote, block #{governance.firstNayBlock})
                    </span>
                  </span>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {campaign.status <= 1 && (
                <Link to={`/governance/vote/${campaign.id}`} className="nano-btn nano-btn-accent" style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none" }}>
                  Cast Vote →
                </Link>
              )}
              {canEvaluate && signer && (
                <button
                  onClick={handleEvaluate}
                  disabled={evaluateBusy}
                  className="nano-btn"
                  style={{ padding: "4px 10px", fontSize: 12 }}
                  title={nayMajority && graceElapsed === false ? "Grace period not yet elapsed — termination requires ~24h after first nay vote" : ""}
                >
                  {evaluateBusy ? "Evaluating..." : "Evaluate"}
                </button>
              )}
            </div>
            {evaluateMsg && (
              <div style={{ fontSize: 12, marginTop: 8, color: evaluateMsg.includes("successfully") ? "var(--ok)" : "var(--error)" }}>
                {evaluateMsg}
              </div>
            )}
          </section>
        );
      })()}

      <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Creative</h2>
        <IPFSPreview metadataHash={metadataHash} bulletinDigest={bulletinDigest} bulletinCodec={bulletinCodec} />
      </section>

      {/* Token Reward Sidecar — shown to all if campaign has one */}
      {tokenReward && tokenReward.meta && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Token Rewards</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10, marginBottom: 12 }}>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Token</div>
              <div style={{ color: "var(--text-strong)", fontWeight: 600, fontSize: 14 }}>
                {tokenReward.meta.symbol}
                {tokenReward.meta.name !== tokenReward.meta.symbol && (
                  <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: 11, marginLeft: 6 }}>{tokenReward.meta.name}</span>
                )}
              </div>
            </div>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Per Impression</div>
              <div style={{ color: "var(--text-strong)", fontWeight: 600, fontSize: 14, fontFamily: "var(--font-mono)" }}>
                {(Number(tokenReward.rewardPerImpression) / Math.pow(10, tokenReward.meta.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })} {tokenReward.meta.symbol}
              </div>
            </div>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Vault Budget Remaining</div>
              <div style={{ color: tokenReward.remainingBudget > 0n ? "var(--ok)" : "var(--text-muted)", fontWeight: 600, fontSize: 14, fontFamily: "var(--font-mono)" }}>
                {(Number(tokenReward.remainingBudget) / Math.pow(10, tokenReward.meta.decimals)).toLocaleString(undefined, { maximumFractionDigits: 3 })} {tokenReward.meta.symbol}
              </div>
            </div>
          </div>
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Token Contract</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <code style={{ fontSize: 11, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{tokenReward.token}</code>
              {EXPLORER && (
                <a
                  href={`${EXPLORER}/address/${tokenReward.token}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11, color: "var(--accent-dim)", textDecoration: "none" }}
                >
                  View on Explorer ↗
                </a>
              )}
            </div>
          </div>
          {/* Advertiser top-up — pre/active campaigns; supports wizard recovery */}
          {address && campaign.advertiser.toLowerCase() === address.toLowerCase() && campaign.status < 3 && (
            <div id="token-deposit" style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 10 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 6 }}>
                {tokenReward.remainingBudget === 0n ? "Vault is empty — deposit budget so users can earn token rewards." : "Top up the vault budget."}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="text"
                  inputMode="decimal"
                  className="nano-input"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder={`Amount in ${tokenReward.meta?.symbol ?? "tokens"}`}
                  style={{ fontSize: 12, width: 220 }}
                  disabled={depositing || !signer}
                />
                <button
                  className="nano-btn nano-btn-accent"
                  onClick={handleDepositTokenBudget}
                  disabled={depositing || !signer || !depositAmount.trim()}
                  style={{ fontSize: 12, padding: "5px 12px" }}
                >
                  {depositing ? "Depositing..." : "Approve & Deposit"}
                </button>
              </div>
              {depositMsg && (
                <div style={{ fontSize: 12, color: depositMsg.startsWith("Deposited") ? "var(--ok)" : "var(--error)", marginTop: 6 }}>
                  {depositMsg}
                </div>
              )}
            </div>
          )}

          {/* Advertiser reclaim (only when campaign ended) */}
          {address && campaign.advertiser.toLowerCase() === address.toLowerCase() && tokenReward.remainingBudget > 0n && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 10 }}>
              {campaign.status >= 3 ? (
                <button
                  className="nano-btn nano-btn-ok"
                  onClick={handleReclaimBudget}
                  disabled={reclaimingBudget}
                  style={{ fontSize: 12, padding: "5px 12px" }}
                >
                  {reclaimingBudget ? "Reclaiming..." : `Reclaim ${(Number(tokenReward.remainingBudget) / Math.pow(10, tokenReward.meta.decimals)).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${tokenReward.meta.symbol}`}
                </button>
              ) : (
                <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  Reclaim available when campaign ends (Completed / Terminated / Expired).
                </div>
              )}
              {tokenBudgetMsg && (
                <div style={{ fontSize: 12, color: tokenBudgetMsg.includes("successfully") ? "var(--ok)" : "var(--error)", marginTop: 6 }}>
                  {tokenBudgetMsg}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Challenge Bond */}
      {bondAmount !== null && bondAmount > 0n && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Challenge Bond</h2>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Locked Bond</div>
            <div style={{ color: "var(--ok)", fontWeight: 700, fontSize: 18, fontFamily: "var(--font-mono)" }}>
              <DOTAmount planck={bondAmount} />
            </div>
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 8 }}>
            Returned to advertiser on clean campaign end; distributed to challengers if fraud is upheld by governance.
          </div>
          {/* Pull-claim: only the bondOwner can claim the queued bond return after campaign end */}
          {signer && address && bondOwnerAddr && bondOwnerAddr.toLowerCase() === address.toLowerCase() && campaign.status >= 3 && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 12 }}>
              <button
                className="nano-btn nano-btn-ok"
                onClick={handleClaimBond}
                disabled={claimingBond}
                style={{ fontSize: 12, padding: "5px 12px" }}
              >
                {claimingBond ? "Claiming..." : "Claim Bond Return"}
              </button>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 6 }}>
                Bond return is pull-payment — claim transfers the queued amount to your wallet. Resolves to zero if already claimed or if a fraud verdict redirected it to the bonus pool.
              </div>
            </div>
          )}
        </section>
      )}

      {/* Pending DOT Refund — pull-payment from BudgetLedger after complete/terminate/expire */}
      {address && pendingDotRefund > 0n && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16, borderColor: "var(--ok)" }}>
          <h2 style={{ color: "var(--ok)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Pending Refund</h2>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Available to Claim</div>
              <div style={{ color: "var(--ok)", fontWeight: 700, fontSize: 18, fontFamily: "var(--font-mono)" }}>
                <DOTAmount planck={pendingDotRefund} />
              </div>
            </div>
            {signer && (
              <button
                className="nano-btn nano-btn-ok"
                onClick={handleClaimDotRefund}
                disabled={claimingDotRefund}
                style={{ fontSize: 13, padding: "8px 16px" }}
              >
                {claimingDotRefund ? "Claiming..." : "Claim Refund"}
              </button>
            )}
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 8 }}>
            Unspent budget from completed, terminated, or expired campaigns is queued in the ledger. Claim transfers it to your wallet.
          </div>
          {refundMsg && (
            <div style={{ fontSize: 12, color: refundMsg.toLowerCase().includes("claim") && !refundMsg.toLowerCase().includes("fail") ? "var(--ok)" : "var(--error)", marginTop: 6 }}>
              {refundMsg}
            </div>
          )}
        </section>
      )}

      {/* Bid Configuration — per-pot CPM/CPC/CPA breakdown */}
      {pots.length > 0 && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Bid Configuration</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            {pots.map((p) => {
              const label = p.actionType === 0 ? "CPM (View)" : p.actionType === 1 ? "CPC (Click)" : "CPA (Action)";
              const rateLabel = p.actionType === 0 ? "Rate per 1k views" : p.actionType === 1 ? "Per click" : "Per action";
              const remainingPct = p.budgetPlanck > 0n ? Number((p.remaining * 100n) / p.budgetPlanck) : 0;
              return (
                <div key={p.actionType} className="nano-card" style={{ padding: 12 }}>
                  <div style={{ color: "var(--accent)", fontSize: 12, fontWeight: 600, marginBottom: 8, letterSpacing: "0.04em" }}>{label}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11 }}>
                    <div>
                      <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>{rateLabel}</div>
                      <div style={{ color: "var(--text-strong)", fontFamily: "var(--font-mono)" }}><DOTAmount planck={p.ratePlanck} /></div>
                    </div>
                    <div>
                      <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>Daily Cap</div>
                      <div style={{ color: "var(--text-strong)", fontFamily: "var(--font-mono)" }}><DOTAmount planck={p.dailyCapPlanck} /></div>
                    </div>
                    <div>
                      <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>Budget</div>
                      <div style={{ color: "var(--text-strong)", fontFamily: "var(--font-mono)" }}><DOTAmount planck={p.budgetPlanck} /></div>
                    </div>
                    <div>
                      <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>Remaining</div>
                      <div style={{ color: remainingPct > 20 ? "var(--ok)" : "var(--warn)", fontFamily: "var(--font-mono)" }}><DOTAmount planck={p.remaining} /></div>
                    </div>
                  </div>
                  {p.budgetPlanck > 0n && (
                    <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: "var(--bg-raised)", overflow: "hidden" }}>
                      <div style={{ width: `${remainingPct}%`, height: "100%", background: remainingPct > 20 ? "var(--ok)" : "var(--warn)" }} />
                    </div>
                  )}
                  {p.actionType === 2 && p.actionVerifier !== ethers.ZeroAddress && (
                    <div style={{ marginTop: 8, fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                      Verifier: {p.actionVerifier}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Settlement Path (dual-sig flag) */}
      {address && campaign.advertiser.toLowerCase() === address.toLowerCase() && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Settlement Path</h2>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>
                {requiresDualSig ? "Dual-sig (publisher + advertiser cosign)" : "Single-sig (relay only)"}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 4, maxWidth: 520 }}>
                {requiresDualSig
                  ? "Each settlement batch requires the publisher's and your own EIP-712 cosignature. Either party can refuse to sign suspicious batches. Fraud-resistant but adds a coordination step."
                  : "Relay submits batches signed by user + publisher. Faster path; relies on the publisher's relay being honest."}
              </div>
            </div>
            {signer && campaign.status === 0 && (
              <button
                className="nano-btn"
                onClick={handleToggleDualSig}
                disabled={dualSigBusy}
                style={{ fontSize: 12, padding: "6px 14px" }}
              >
                {dualSigBusy ? "Saving..." : requiresDualSig ? "Switch to Single-Sig" : "Switch to Dual-Sig"}
              </button>
            )}
          </div>
          {campaign.status !== 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 8, fontStyle: "italic" }}>
              Settlement path is locked once the campaign activates.
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
                  Type: ACTION_LABELS[s.actionType] ?? String(s.actionType),
                  User: s.user,
                  Publisher: s.publisher,
                  Events: s.impressionCount.toString(),
                  Rate: formatDOT(s.ratePlanck),
                  "User Earned": formatDOT(s.userPayment),
                  "Publisher Earned": formatDOT(s.publisherPayment),
                  Tx: s.txHash,
                }));
                downloadCSV(`campaign-${id}-settlements.csv`, toCSV(["Block", "Type", "User", "Publisher", "Events", "Rate", "User Earned", "Publisher Earned", "Tx"], rows));
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
                    <th>Type</th>
                    <th>User</th>
                    <th>Publisher</th>
                    <th>Events</th>
                    <th>Rate</th>
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
                      <td><span className="nano-badge" style={{ fontSize: 10 }}>{ACTION_LABELS[s.actionType] ?? String(s.actionType)}</span></td>
                      <td><AddressDisplay address={s.user} chars={4} explorerBase={EXPLORER} style={{ fontSize: 12 }} /></td>
                      <td><AddressDisplay address={s.publisher} chars={4} explorerBase={EXPLORER} style={{ fontSize: 12 }} /></td>
                      <td style={{ color: "var(--ok)", fontSize: 12 }}>{s.impressionCount.toString()}</td>
                      <td style={{ fontSize: 12 }}><DOTAmount planck={s.ratePlanck} /></td>
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
