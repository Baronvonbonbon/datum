import { useState, useEffect, useCallback } from "react";
import { parseUnits } from "ethers";
import { getGovernanceV2Contract, getGovernanceSlashContract, getCampaignsContract, getProvider } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { CampaignMetadata, CATEGORY_NAMES } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { getSigner } from "@shared/walletManager";
import { humanizeError } from "@shared/errorCodes";

interface Props {
  address: string | null;
}

interface GovernableCampaign {
  id: string;
  status: number;
  advertiser: string;
  bidCpmPlanck: bigint;
  categoryId: number;
  ayeWeighted: bigint;
  nayWeighted: bigint;
  resolved: boolean;
  remainingBudget: bigint;
}

interface VoteRecord {
  direction: number; // 0=None, 1=Aye, 2=Nay
  lockAmount: bigint;
  conviction: number;
  lockedUntilBlock: bigint;
}

// GV-1: Conviction labels with human-readable lockup durations
// Base lockup = 14,400 blocks (~24h at 6s blocks)
const CONVICTION_LABELS: Record<number, string> = {
  0: "0x — no lockup",
  1: "1x — ~24h lockup",
  2: "2x — ~48h lockup",
  3: "4x — ~4 day lockup",
  4: "8x — ~8 day lockup",
  5: "16x — ~16 day lockup",
  6: "32x — ~32 day lockup (max ~365d cap)",
};

const STATUS_NAMES: Record<number, string> = {
  0: "Pending",
  1: "Active",
  2: "Paused",
  3: "Completed",
  4: "Terminated",
  5: "Expired",
};

export function GovernancePanel({ address }: Props) {
  // Vote form
  const [campaignId, setCampaignId] = useState("");
  const [dotAmount, setDotAmount] = useState("0.01");
  const [conviction, setConviction] = useState(1);
  const [voting, setVoting] = useState(false);
  const [txResult, setTxResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Query state
  const [queryCampaignId, setQueryCampaignId] = useState("");
  const [myVote, setMyVote] = useState<VoteRecord | null>(null);
  const [currentBlock, setCurrentBlock] = useState<number | null>(null);
  const [querying, setQuerying] = useState(false);

  // Campaign lists
  const [campaigns, setCampaigns] = useState<GovernableCampaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [metadata, setMetadata] = useState<Record<string, CampaignMetadata>>({});
  const [metadataUrls, setMetadataUrls] = useState<Record<string, string>>({});

  // V2 params
  const [quorumWeighted, setQuorumWeighted] = useState<bigint | null>(null);
  const [slashBps, setSlashBps] = useState<number | null>(null);
  const [pendingTimeout, setPendingTimeout] = useState<number | null>(null); // blocks

  // Actions
  const [withdrawing, setWithdrawing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [showResolved, setShowResolved] = useState(true);

  // Slash info per queried campaign
  const [slashFinalized, setSlashFinalized] = useState(false);
  const [claimableAmount, setClaimableAmount] = useState<bigint | null>(null);

  const selectedCampaign = campaigns.find((c) => c.id === campaignId);
  const selectedStatus = selectedCampaign?.status ?? null;

  async function getSettings() {
    const stored = await chrome.storage.local.get("settings");
    return stored.settings ?? DEFAULT_SETTINGS;
  }

  const loadCampaigns = useCallback(async () => {
    setLoadingCampaigns(true);
    try {
      const settings = await getSettings();
      const provider = getProvider(settings.rpcUrl);
      const campaignsContract = getCampaignsContract(settings.contractAddresses, provider);
      const v2 = getGovernanceV2Contract(settings.contractAddresses, provider);

      const [nextId, quorum, slash, timeout, blockNum] = await Promise.all([
        campaignsContract.nextCampaignId(),
        v2.quorumWeighted(),
        v2.slashBps(),
        campaignsContract.pendingTimeoutBlocks(),
        provider.getBlockNumber(),
      ]);

      setQuorumWeighted(BigInt(quorum));
      setSlashBps(Number(slash));
      setPendingTimeout(Number(timeout));
      setCurrentBlock(blockNum);

      const count = Number(nextId);
      const governable: GovernableCampaign[] = [];

      for (let i = 0; i < count; i += 10) {
        const batch = Array.from({ length: Math.min(10, count - i) }, (_, j) => i + j);
        const results = await Promise.all(
          batch.map(async (id) => {
            try {
              const [status, advertiser, remaining, ayeW, nayW, resolved] = await Promise.all([
                campaignsContract.getCampaignStatus(BigInt(id)),
                campaignsContract.getCampaignAdvertiser(BigInt(id)),
                campaignsContract.getCampaignRemainingBudget(BigInt(id)),
                v2.ayeWeighted(BigInt(id)),
                v2.nayWeighted(BigInt(id)),
                v2.resolved(BigInt(id)),
              ]);
              const s = Number(status);
              // Show Pending, Active, Paused, Completed, Terminated for governance
              if (s > 4) return null;
              return {
                id: id.toString(),
                status: s,
                advertiser,
                bidCpmPlanck: 0n, // not needed for governance display
                categoryId: 0,
                ayeWeighted: BigInt(ayeW),
                nayWeighted: BigInt(nayW),
                resolved: resolved as boolean,
                remainingBudget: BigInt(remaining),
              } as GovernableCampaign;
            } catch {
              return null;
            }
          })
        );
        for (const r of results) if (r) governable.push(r);
      }

      setCampaigns(governable);

      // Load cached IPFS metadata for campaign titles/links
      if (governable.length > 0) {
        const metaKeys = governable.flatMap((c) => [`metadata:${c.id}`, `metadata_url:${c.id}`]);
        const stored = await chrome.storage.local.get(metaKeys);
        const meta: Record<string, CampaignMetadata> = {};
        const urls: Record<string, string> = {};
        for (const c of governable) {
          if (stored[`metadata:${c.id}`]) meta[c.id] = stored[`metadata:${c.id}`];
          if (stored[`metadata_url:${c.id}`]) urls[c.id] = stored[`metadata_url:${c.id}`];
        }
        setMetadata(meta);
        setMetadataUrls(urls);
      }
    } catch {
      // Silent — non-critical
    } finally {
      setLoadingCampaigns(false);
    }
  }, []);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  async function castVote(aye: boolean) {
    if (!address || !campaignId) return;
    // GV-2: Vote permanence warning — contract prevents re-voting (E42)
    const lockDuration = CONVICTION_LABELS[conviction] ?? "unknown duration";
    const confirmed = confirm(
      `Voting is permanent — you cannot change your vote on campaign #${campaignId}.\n\n` +
      `You are voting ${aye ? "AYE" : "NAY"} with ${dotAmount} DOT at conviction ${conviction} (${lockDuration}).\n\n` +
      `Your stake will be locked and the losing side pays ${slashBps !== null ? (slashBps / 100).toFixed(1) : "?"}% slash on withdrawal.\n\n` +
      `Continue?`
    );
    if (!confirmed) return;
    setVoting(true);
    setTxResult(null);
    setError(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const v2 = getGovernanceV2Contract(settings.contractAddresses, signer);

      const valuePlanck = parseUnits(dotAmount, 10);
      const cid = BigInt(campaignId);

      const tx = await v2.vote(cid, aye, conviction, { value: valuePlanck });
      await tx.wait();

      setTxResult(`Vote ${aye ? "AYE" : "NAY"} cast on campaign #${campaignId} with conviction ${conviction}.`);
      if (queryCampaignId === campaignId) {
        queryVoteStatus();
      }
      loadCampaigns();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setVoting(false);
    }
  }

  const queryVoteStatus = useCallback(async () => {
    const cid = queryCampaignId || campaignId;
    if (!cid) return;
    setQuerying(true);
    setError(null);
    try {
      const settings = await getSettings();
      const provider = getProvider(settings.rpcUrl);
      const v2 = getGovernanceV2Contract(settings.contractAddresses, provider);
      const slash = getGovernanceSlashContract(settings.contractAddresses, provider);

      const [blockNum] = await Promise.all([
        provider.getBlockNumber(),
      ]);
      setCurrentBlock(blockNum);

      // Query user's own vote record
      if (address) {
        const record = await v2.getVote(BigInt(cid), address);
        setMyVote({
          direction: Number(record.direction ?? record[0]),
          lockAmount: BigInt(record.lockAmount ?? record[1]),
          conviction: Number(record.conviction ?? record[2]),
          lockedUntilBlock: BigInt(record.lockedUntilBlock ?? record[3]),
        });
      }

      // Slash status
      try {
        const finalized = await slash.finalized(BigInt(cid));
        setSlashFinalized(finalized as boolean);
        if (finalized && address) {
          const claimable = await slash.getClaimable(BigInt(cid), address);
          setClaimableAmount(BigInt(claimable));
        } else {
          setClaimableAmount(null);
        }
      } catch {
        setSlashFinalized(false);
        setClaimableAmount(null);
      }

      setQueryCampaignId(cid);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setQuerying(false);
    }
  }, [queryCampaignId, campaignId, address]);

  async function withdrawStake() {
    if (!address || !queryCampaignId) return;
    setWithdrawing(true);
    setError(null);
    setTxResult(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const v2 = getGovernanceV2Contract(settings.contractAddresses, signer);

      const tx = await v2.withdraw(BigInt(queryCampaignId));
      const receipt = await tx.wait();

      // Parse VoteWithdrawn event for returned/slashed amounts
      let returned = 0n;
      let slashed = 0n;
      if (receipt?.logs) {
        for (const log of receipt.logs) {
          try {
            const parsed = v2.interface.parseLog(log);
            if (parsed?.name === "VoteWithdrawn") {
              returned = BigInt(parsed.args.returned ?? parsed.args[3] ?? 0);
              slashed = BigInt(parsed.args.slashed ?? parsed.args[4] ?? 0);
            }
          } catch { /* log from different contract */ }
        }
      }

      const msg = slashed > 0n
        ? `Stake withdrawn: ${formatDOT(returned)} DOT returned, ${formatDOT(slashed)} DOT slashed.`
        : `Stake withdrawn: ${formatDOT(returned)} DOT returned.`;
      setTxResult(msg);
      queryVoteStatus();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setWithdrawing(false);
    }
  }

  async function evaluateCampaign(cid: string) {
    setEvaluating(true);
    setError(null);
    setTxResult(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const v2 = getGovernanceV2Contract(settings.contractAddresses, signer);

      const tx = await v2.evaluateCampaign(BigInt(cid));
      await tx.wait();
      setTxResult(`Campaign #${cid} evaluated successfully.`);
      loadCampaigns();
    } catch (err) {
      const msg = humanizeError(err);
      if (msg.includes("E47")) {
        // Pending campaign with nay majority — explain expiration alternative
        const timeoutNote = pendingTimeout
          ? ` Use "Expire" once the pending timeout (~${Math.round((pendingTimeout * 6) / 3600)}h from creation) has passed.`
          : " Use Expire once the pending timeout has passed.";
        setError(msg + timeoutNote);
      } else if (msg.includes("E53") && pendingTimeout) {
        setError(msg + ` Termination grace period: ~${Math.round((14400 * 6) / 3600)}h.`);
      } else {
        setError(msg);
      }
    } finally {
      setEvaluating(false);
    }
  }

  async function expirePending(cid: string) {
    setEvaluating(true);
    setError(null);
    setTxResult(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const campaignsContract = getCampaignsContract(settings.contractAddresses, signer);

      const tx = await campaignsContract.expirePendingCampaign(BigInt(cid));
      await tx.wait();
      setTxResult(`Campaign #${cid} expired — budget refunded to advertiser.`);
      loadCampaigns();
    } catch (err) {
      const msg = humanizeError(err);
      if (msg.includes("E24") && pendingTimeout) {
        const timeoutHours = Math.round((pendingTimeout * 6) / 3600);
        setError(`${msg} (~${timeoutHours}h from campaign creation)`);
      } else {
        setError(msg);
      }
    } finally {
      setEvaluating(false);
    }
  }

  async function finalizeSlash() {
    if (!queryCampaignId) return;
    setFinalizing(true);
    setError(null);
    setTxResult(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const slash = getGovernanceSlashContract(settings.contractAddresses, signer);

      const tx = await slash.finalizeSlash(BigInt(queryCampaignId));
      await tx.wait();
      setTxResult(`Slash finalized for campaign #${queryCampaignId}.`);
      queryVoteStatus();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setFinalizing(false);
    }
  }

  async function claimSlashReward() {
    if (!queryCampaignId) return;
    setClaiming(true);
    setError(null);
    setTxResult(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const slash = getGovernanceSlashContract(settings.contractAddresses, signer);

      const tx = await slash.claimSlashReward(BigInt(queryCampaignId));
      await tx.wait();
      setTxResult(`Slash reward claimed for campaign #${queryCampaignId}.`);
      queryVoteStatus();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setClaiming(false);
    }
  }

  if (!address) {
    return (
      <div style={emptyStyle}>
        Connect wallet to participate in governance.
      </div>
    );
  }

  const pendingCampaigns = campaigns.filter((c) => c.status === 0);
  const activeCampaigns = campaigns.filter((c) => c.status === 1 || c.status === 2);
  const resolvedCampaigns = campaigns.filter((c) => c.status === 3 || c.status === 4);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>Governance V2</span>
      </div>

      {/* V2 params info */}
      {quorumWeighted !== null && (
        <div style={{ marginBottom: 10, padding: "6px 10px", background: "#111", borderRadius: 4, fontSize: 11, color: "#666" }}>
          Quorum: {formatDOT(quorumWeighted)} DOT weighted
          {slashBps !== null && (
            <span> &middot; Slash: {(slashBps / 100).toFixed(1)}%</span>
          )}
          <div style={{ color: "#555", fontSize: 10, marginTop: 2 }}>
            V2: majority model (aye &gt; 50% + quorum to activate, nay &ge; 50% to terminate)
          </div>
        </div>
      )}

      {/* Pending Campaigns */}
      <CampaignSection
        title="Pending Campaigns"
        subtitle="Vote to activate or block"
        campaigns={pendingCampaigns}
        loading={loadingCampaigns}
        quorum={quorumWeighted}
        metadata={metadata}
        metadataUrls={metadataUrls}
        selectedId={campaignId}
        onSelect={setCampaignId}
        onRefresh={loadCampaigns}
        onEvaluate={evaluateCampaign}
        onExpire={expirePending}
        evaluating={evaluating}
        emptyText="No campaigns pending activation."
      />

      {/* Active Campaigns */}
      <CampaignSection
        title="Active Campaigns"
        subtitle="Vote to keep or terminate"
        campaigns={activeCampaigns}
        loading={loadingCampaigns}
        quorum={quorumWeighted}
        metadata={metadata}
        metadataUrls={metadataUrls}
        selectedId={campaignId}
        onSelect={setCampaignId}
        onRefresh={loadCampaigns}
        onEvaluate={evaluateCampaign}
        evaluating={evaluating}
        emptyText="No active campaigns."
      />

      {/* Resolved Campaigns */}
      {resolvedCampaigns.length > 0 && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2, padding: "0 2px" }}>
            <span />
            <button
              onClick={() => setShowResolved(!showResolved)}
              style={{ ...refreshBtn, fontSize: 9 }}
            >
              {showResolved ? "Hide" : "Show"} {resolvedCampaigns.length} resolved
            </button>
          </div>
          {showResolved && (
            <CampaignSection
              title="Resolved / Completed"
              subtitle="Evaluate, finalize slash, claim rewards"
              campaigns={resolvedCampaigns}
              loading={loadingCampaigns}
              quorum={quorumWeighted}
              metadata={metadata}
              metadataUrls={metadataUrls}
              selectedId={campaignId}
              onSelect={(id) => { setCampaignId(id); setQueryCampaignId(id); }}
              onRefresh={loadCampaigns}
              onEvaluate={evaluateCampaign}
              evaluating={evaluating}
              emptyText=""
            />
          )}
        </div>
      )}

      {/* Vote Form */}
      <div style={cardStyle}>
        <div style={{ marginBottom: 6 }}>
          <label style={formLabel}>Campaign ID</label>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="text"
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              style={{ ...formInput, flex: 1 }}
              placeholder="0"
            />
            {selectedStatus !== null && (
              <span style={{
                fontSize: 10, padding: "2px 6px", borderRadius: 3, whiteSpace: "nowrap",
                background: selectedStatus === 0 ? "#1a1a0a" : selectedStatus === 1 ? "#0a2a0a" : "#1a1a2e",
                color: selectedStatus === 0 ? "#c0c060" : selectedStatus === 1 ? "#60c060" : "#888",
                border: `1px solid ${selectedStatus === 0 ? "#3a3a2a" : selectedStatus === 1 ? "#2a4a2a" : "#2a2a4a"}`,
              }}>
                {STATUS_NAMES[selectedStatus]}
              </span>
            )}
          </div>
        </div>
        <div style={{ marginBottom: 6 }}>
          <label style={formLabel}>Stake (DOT)</label>
          <input
            type="text"
            value={dotAmount}
            onChange={(e) => setDotAmount(e.target.value)}
            style={formInput}
            placeholder="0.01"
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label style={formLabel}>Conviction (vote multiplier / lock duration)</label>
          <select
            value={conviction}
            onChange={(e) => setConviction(Number(e.target.value))}
            style={{ ...formInput, cursor: "pointer" }}
          >
            {Object.entries(CONVICTION_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
        {slashBps !== null && slashBps > 0 && (
          <div style={{ color: "#c09060", fontSize: 10, marginBottom: 6, padding: "4px 8px", background: "#1a1a0a", borderRadius: 3 }}>
            Losing side pays {(slashBps / 100).toFixed(1)}% of stake on withdrawal
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => castVote(true)}
            disabled={voting || !campaignId}
            style={{ ...ayeBtn, flex: 1 }}
          >
            {voting ? "Voting..." : "Vote Aye"}
          </button>
          <button
            onClick={() => castVote(false)}
            disabled={voting || !campaignId}
            style={{ ...nayBtn, flex: 1 }}
          >
            {voting ? "Voting..." : "Vote Nay"}
          </button>
        </div>
        <div style={{ color: "#555", fontSize: 10, marginTop: 4, textAlign: "center" }}>
          V2: Aye and Nay allowed on both Pending and Active campaigns
        </div>
      </div>

      {/* Query Vote Status */}
      <div style={{ marginTop: 12 }}>
        <button
          onClick={queryVoteStatus}
          disabled={querying || (!campaignId && !queryCampaignId)}
          style={secondaryBtn}
        >
          {querying ? "Loading..." : "Query Vote Status"}
        </button>
      </div>

      {/* Campaign vote totals for queried campaign */}
      {queryCampaignId && (() => {
        const qc = campaigns.find((c) => c.id === queryCampaignId);
        if (!qc) return null;
        const total = qc.ayeWeighted + qc.nayWeighted;
        const ayePct = total > 0n ? Number((qc.ayeWeighted * 100n) / total) : 0;
        const nayPct = total > 0n ? 100 - ayePct : 0;
        return (
          <div style={{ ...cardStyle, marginTop: 10 }}>
            <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
              Campaign #{queryCampaignId}{metadata[queryCampaignId]?.title ? ` — ${metadata[queryCampaignId].title}` : ""}
            </div>
            {metadata[queryCampaignId]?.description && (
              <div style={{ color: "#888", fontSize: 11, marginBottom: 4 }}>{metadata[queryCampaignId].description}</div>
            )}
            {metadataUrls[queryCampaignId] && (
              <div style={{ marginBottom: 4 }}>
                <a href={metadataUrls[queryCampaignId]} target="_blank" rel="noopener"
                  style={{ color: "#60a0ff", fontSize: 10, textDecoration: "underline" }}
                >View IPFS Metadata</a>
              </div>
            )}
            {/* Majority bar */}
            <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
              <div style={{ width: `${ayePct}%`, background: "#2a6a2a", transition: "width 0.3s" }} />
              <div style={{ width: `${nayPct}%`, background: "#6a2a2a", transition: "width 0.3s" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: "#60c060", fontSize: 12 }}>
                Aye: {formatDOT(qc.ayeWeighted)} DOT ({ayePct}%)
              </span>
              <span style={{ color: "#ff8080", fontSize: 12 }}>
                Nay: {formatDOT(qc.nayWeighted)} DOT ({nayPct}%)
              </span>
            </div>
            {quorumWeighted !== null && (
              <div style={{ color: "#888", fontSize: 11, marginBottom: 4 }}>
                Total: {formatDOT(total)} / {formatDOT(quorumWeighted)} DOT quorum
                {total >= quorumWeighted
                  ? <span style={{ color: "#60c060", marginLeft: 6 }}>Met</span>
                  : <span style={{ color: "#c09060", marginLeft: 6 }}>Not met</span>
                }
              </div>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <span style={statusBadge(
                qc.resolved ? "#0a2a0a" : "#1a1a0a",
                qc.resolved ? "#60c060" : "#c0c060",
                qc.resolved ? "#2a4a2a" : "#3a3a2a",
              )}>
                {qc.resolved ? "Resolved" : STATUS_NAMES[qc.status] ?? "Unknown"}
              </span>
            </div>

            {/* Evaluate button */}
            {!qc.resolved && (
              <button
                onClick={() => evaluateCampaign(queryCampaignId)}
                disabled={evaluating}
                style={{ ...primaryBtn, marginTop: 8, fontSize: 12, padding: "6px 12px" }}
              >
                {evaluating ? "Evaluating..." : "Evaluate Campaign"}
              </button>
            )}
          </div>
        );
      })()}

      {/* User's Vote Record */}
      {myVote && myVote.direction > 0 && (
        <div style={{ ...cardStyle, marginTop: 8 }}>
          <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>Your vote</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{
              color: myVote.direction === 1 ? "#60c060" : "#ff8080",
              fontWeight: 600,
              fontSize: 13,
            }}>
              {myVote.direction === 1 ? "AYE" : "NAY"}
            </span>
            <span style={{ color: "#888", fontSize: 12 }}>
              {formatDOT(myVote.lockAmount)} DOT (conv. {myVote.conviction})
            </span>
          </div>
          <div style={{ color: "#666", fontSize: 11 }}>
            Locked until block {myVote.lockedUntilBlock.toString()}
            {currentBlock !== null && (
              myVote.lockedUntilBlock <= BigInt(currentBlock)
                ? <span style={{ color: "#60c060", marginLeft: 6 }}>Unlocked</span>
                : <span style={{ color: "#c09060", marginLeft: 6 }}>
                    ~{Number(myVote.lockedUntilBlock - BigInt(currentBlock)) * 6}s remaining
                  </span>
            )}
          </div>

          {/* Withdraw stake button */}
          {currentBlock !== null && myVote.lockedUntilBlock <= BigInt(currentBlock) && (
            <button
              onClick={withdrawStake}
              disabled={withdrawing}
              style={{ ...primaryBtn, marginTop: 8 }}
            >
              {withdrawing ? "Withdrawing..." : `Withdraw ${formatDOT(myVote.lockAmount)} DOT Stake`}
            </button>
          )}
        </div>
      )}

      {/* Slash Section */}
      {queryCampaignId && (() => {
        const qc = campaigns.find((c) => c.id === queryCampaignId);
        if (!qc?.resolved) return null;
        return (
          <div style={{ ...cardStyle, marginTop: 8, background: "#1a0a1a", border: "1px solid #3a1a3a" }}>
            <div style={{ color: "#c080c0", fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
              Slash Pool
            </div>
            {!slashFinalized ? (
              <div>
                <div style={{ color: "#888", fontSize: 12, marginBottom: 6 }}>
                  Campaign resolved. Finalize to snapshot winning side weights.
                </div>
                <button
                  onClick={finalizeSlash}
                  disabled={finalizing}
                  style={{ ...primaryBtn, background: "#2a1a2a", color: "#c080c0", border: "1px solid #4a2a4a" }}
                >
                  {finalizing ? "Finalizing..." : "Finalize Slash"}
                </button>
              </div>
            ) : (
              <div>
                <div style={{ color: "#60c060", fontSize: 12, marginBottom: 4 }}>
                  Slash finalized.
                </div>
                {claimableAmount !== null && claimableAmount > 0n ? (
                  <div>
                    <div style={{ color: "#e0e0e0", fontSize: 13, marginBottom: 6 }}>
                      Claimable: {formatDOT(claimableAmount)} DOT
                    </div>
                    <button
                      onClick={claimSlashReward}
                      disabled={claiming}
                      style={{ ...primaryBtn, background: "#0a2a0a", color: "#60c060", border: "1px solid #2a4a2a" }}
                    >
                      {claiming ? "Claiming..." : "Claim Slash Reward"}
                    </button>
                  </div>
                ) : (
                  <div style={{ color: "#888", fontSize: 12 }}>
                    {claimableAmount === 0n ? "No claimable reward (losing side or already claimed)." : "Loading..."}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {txResult && (
        <div style={{ marginTop: 8, padding: 10, background: "#0a2a0a", borderRadius: 6, fontSize: 13, color: "#60c060" }}>
          {txResult}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 8, color: "#ff8080", fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campaign list section (reused for Pending, Active, Resolved)
// ---------------------------------------------------------------------------

function CampaignSection({
  title, subtitle, campaigns, loading, quorum, metadata, metadataUrls,
  selectedId, onSelect, onRefresh, onEvaluate, onExpire, evaluating, emptyText,
}: {
  title: string;
  subtitle: string;
  campaigns: GovernableCampaign[];
  loading: boolean;
  quorum: bigint | null;
  metadata?: Record<string, CampaignMetadata>;
  metadataUrls?: Record<string, string>;
  selectedId: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onEvaluate: (id: string) => void;
  onExpire?: (id: string) => void;
  evaluating: boolean;
  emptyText: string;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div>
          <span style={{ color: "#888", fontSize: 12 }}>{title}</span>
          <span style={{ color: "#555", fontSize: 10, marginLeft: 6 }}>{subtitle}</span>
        </div>
        <button onClick={onRefresh} disabled={loading} style={refreshBtn}>
          {loading ? "..." : "Refresh"}
        </button>
      </div>
      {loading && campaigns.length === 0 ? (
        <div style={{ color: "#555", fontSize: 12, padding: 8 }}>Loading...</div>
      ) : campaigns.length === 0 ? (
        emptyText ? <div style={{ color: "#555", fontSize: 12, padding: "4px 8px" }}>{emptyText}</div> : null
      ) : (
        <div style={{ maxHeight: 140, overflowY: "auto" }}>
          {campaigns.map((c) => {
            const total = c.ayeWeighted + c.nayWeighted;
            const ayePct = total > 0n ? Number((c.ayeWeighted * 100n) / total) : 0;
            // Can evaluate?
            const canEvaluate = !c.resolved && (
              (c.status === 0 && ayePct > 50 && quorum !== null && total >= quorum) ||
              (c.status === 1 && ayePct <= 50) ||
              ((c.status === 3 || c.status === 4) && !c.resolved)
            );
            // Pending campaign with nay majority — show Expire button instead
            const canExpire = !c.resolved && c.status === 0 && ayePct <= 50 && total > 0n && onExpire;
            return (
              <div
                key={c.id}
                onClick={() => onSelect(c.id)}
                style={{
                  ...rowStyle,
                  border: selectedId === c.id ? "1px solid #4a4a8a" : "1px solid #1a1a2e",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 12 }}>
                    #{c.id}{metadata?.[c.id]?.title ? ` — ${metadata[c.id].title}` : ""}
                  </span>
                  <span style={{ fontSize: 10, color: c.resolved ? "#60c060" : "#c0c060" }}>
                    {c.resolved ? "Resolved" : STATUS_NAMES[c.status]}
                  </span>
                </div>
                {metadataUrls?.[c.id] && (
                  <div style={{ marginBottom: 2 }}>
                    <a href={metadataUrls[c.id]} target="_blank" rel="noopener"
                      style={{ color: "#60a0ff", fontSize: 9, textDecoration: "underline" }}
                      onClick={(e) => e.stopPropagation()}
                    >View IPFS Metadata</a>
                  </div>
                )}
                {/* Majority bar */}
                <div style={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden", marginBottom: 2 }}>
                  <div style={{ width: `${ayePct}%`, background: "#2a6a2a", transition: "width 0.3s" }} />
                  <div style={{ width: `${100 - ayePct}%`, background: "#6a2a2a", transition: "width 0.3s" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
                  <span style={{ color: "#60c060" }}>Aye {ayePct}%</span>
                  <span style={{ color: "#ff8080" }}>Nay {100 - ayePct}%</span>
                </div>
                {/* GV-3: Quorum progress on campaign cards */}
                {quorum !== null && (
                  <div style={{ color: "#666", fontSize: 9, marginTop: 2 }}>
                    {formatDOT(total)} / {formatDOT(quorum)} quorum
                    {total >= quorum
                      ? <span style={{ color: "#60c060", marginLeft: 4 }}>met</span>
                      : <span style={{ color: "#c09060", marginLeft: 4 }}>
                          ({total > 0n ? Math.round(Number((total * 100n) / quorum)) : 0}%)
                        </span>
                    }
                  </div>
                )}
                {canEvaluate && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onEvaluate(c.id); }}
                    disabled={evaluating}
                    style={{ ...evalBtn, marginTop: 4 }}
                  >
                    {evaluating ? "..." : c.status === 0 ? "Activate" : c.status === 1 ? "Terminate" : "Resolve"}
                  </button>
                )}
                {canExpire && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onExpire(c.id); }}
                    disabled={evaluating}
                    style={{ ...evalBtn, marginTop: 4, background: "#2a1a0a", color: "#c09060", border: "1px solid #4a3a2a" }}
                  >
                    {evaluating ? "..." : "Expire (nay majority)"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function statusBadge(bg: string, color: string, border: string): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "2px 6px",
    borderRadius: 3,
    background: bg,
    color,
    border: `1px solid ${border}`,
  };
}

const cardStyle: React.CSSProperties = {
  padding: "10px 12px",
  background: "#1a1a2e",
  borderRadius: 6,
  fontSize: 13,
};

const primaryBtn: React.CSSProperties = {
  background: "#2a2a5a",
  color: "#a0a0ff",
  border: "1px solid #4a4a8a",
  borderRadius: 6,
  padding: "10px 16px",
  fontSize: 13,
  cursor: "pointer",
  width: "100%",
};

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#1a1a1a",
  color: "#666",
  border: "1px solid #333",
};

const ayeBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#0a2a0a",
  color: "#60c060",
  border: "1px solid #2a4a2a",
  width: "auto",
};

const nayBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#2a0a0a",
  color: "#ff8080",
  border: "1px solid #4a1a1a",
  width: "auto",
};

const evalBtn: React.CSSProperties = {
  background: "#1a1a3a",
  color: "#a0a0ff",
  border: "1px solid #3a3a6a",
  borderRadius: 3,
  padding: "2px 8px",
  fontSize: 10,
  cursor: "pointer",
  width: "100%",
};

const formLabel: React.CSSProperties = {
  display: "block",
  color: "#888",
  fontSize: 11,
  marginBottom: 2,
};

const formInput: React.CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  background: "#1a1a2e",
  border: "1px solid #2a2a4a",
  borderRadius: 4,
  color: "#e0e0e0",
  fontSize: 12,
  outline: "none",
};

const rowStyle: React.CSSProperties = {
  padding: "6px 10px",
  background: "#111122",
  borderRadius: 4,
  marginBottom: 4,
};

const refreshBtn: React.CSSProperties = {
  background: "#1a1a2e",
  color: "#a0a0ff",
  border: "1px solid #2a2a4a",
  borderRadius: 4,
  padding: "2px 8px",
  fontSize: 10,
  cursor: "pointer",
};

const emptyStyle: React.CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "#666",
  fontSize: 13,
};
