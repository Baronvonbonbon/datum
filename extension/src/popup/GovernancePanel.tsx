import { useState, useEffect, useCallback } from "react";
import { parseUnits } from "ethers";
import { getGovernanceVotingContract, getGovernanceRewardsContract, getCampaignsContract, getProvider } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { CATEGORY_NAMES } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { getSigner } from "@shared/walletManager";

interface Props {
  address: string | null;
}

interface CampaignVote {
  ayeTotal: bigint;
  nayTotal: bigint;
  uniqueReviewers: bigint;
  terminationBlock: bigint;
  activated: boolean;
  terminated: boolean;
}

interface VoteRecord {
  voter: string;
  direction: number; // 0=None, 1=Aye, 2=Nay
  lockAmount: bigint;
  conviction: number;
  lockedUntilBlock: bigint;
  castAtBlock: bigint;
}

interface GovernableCampaign {
  id: string;
  status: number; // 0=Pending, 1=Active, 2=Paused
  advertiser: string;
  publisher: string;
  budget: bigint;
  bidCpmPlanck: bigint;
  categoryId: number;
  ayeTotal: bigint;
  nayTotal: bigint;
  reviewers: bigint;
}

const CONVICTION_LABELS: Record<number, string> = {
  1: "1x (base lockup)",
  2: "2x (2x lockup)",
  3: "4x (4x lockup)",
  4: "8x (8x lockup)",
  5: "16x (16x lockup)",
  6: "32x (32x lockup)",
};

const STATUS_NAMES: Record<number, string> = {
  0: "Pending",
  1: "Active",
  2: "Paused",
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
  const [campaignVote, setCampaignVote] = useState<CampaignVote | null>(null);
  const [myVote, setMyVote] = useState<VoteRecord | null>(null);
  const [minStake, setMinStake] = useState<bigint | null>(null);
  const [currentBlock, setCurrentBlock] = useState<number | null>(null);
  const [querying, setQuerying] = useState(false);

  // Campaign lists
  const [campaigns, setCampaigns] = useState<GovernableCampaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [activationThreshold, setActivationThreshold] = useState<bigint | null>(null);
  const [terminationThreshold, setTerminationThreshold] = useState<bigint | null>(null);

  // Withdraw
  const [withdrawing, setWithdrawing] = useState(false);

  // Derived: selected campaign status (from campaigns list)
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
      const votingContract = getGovernanceVotingContract(settings.contractAddresses, provider);

      const [nextId, actThresh, termThresh, minStakeVal] = await Promise.all([
        campaignsContract.nextCampaignId(),
        votingContract.activationThreshold(),
        votingContract.terminationThreshold(),
        votingContract.minReviewerStake(),
      ]);

      setActivationThreshold(BigInt(actThresh));
      setTerminationThreshold(BigInt(termThresh));
      setMinStake(BigInt(minStakeVal));

      const count = Number(nextId);
      const governable: GovernableCampaign[] = [];

      // Fetch in parallel batches of up to 10
      for (let i = 0; i < count; i += 10) {
        const batch = Array.from({ length: Math.min(10, count - i) }, (_, j) => i + j);
        const results = await Promise.all(
          batch.map(async (id) => {
            try {
              const c = await campaignsContract.getCampaign(BigInt(id));
              const status = Number(c.status);
              // 0=Pending (can aye), 1=Active (can nay), 2=Paused (can nay)
              if (status !== 0 && status !== 1 && status !== 2) return null;
              const vote = await votingContract.getCampaignVote(BigInt(id));
              // Skip already-terminated via governance
              if (vote.terminated) return null;
              return {
                id: id.toString(),
                status,
                advertiser: c.advertiser,
                publisher: c.publisher,
                budget: BigInt(c.budgetPlanck ?? c.remainingBudget),
                bidCpmPlanck: BigInt(c.bidCpmPlanck),
                categoryId: Number(c.categoryId),
                ayeTotal: BigInt(vote.ayeTotal),
                nayTotal: BigInt(vote.nayTotal),
                reviewers: BigInt(vote.uniqueReviewers),
              } as GovernableCampaign;
            } catch {
              return null;
            }
          })
        );
        for (const r of results) if (r) governable.push(r);
      }

      setCampaigns(governable);
    } catch {
      // Silent — non-critical
    } finally {
      setLoadingCampaigns(false);
    }
  }, []);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  async function castVote(direction: "aye" | "nay") {
    if (!address || !campaignId) return;
    setVoting(true);
    setTxResult(null);
    setError(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const votingContract = getGovernanceVotingContract(settings.contractAddresses, signer);

      const valuePlanck = parseUnits(dotAmount, 10);
      const cid = BigInt(campaignId);

      const tx = direction === "aye"
        ? await votingContract.voteAye(cid, conviction, { value: valuePlanck })
        : await votingContract.voteNay(cid, conviction, { value: valuePlanck });
      await tx.wait();

      setTxResult(`Vote ${direction.toUpperCase()} cast on campaign #${campaignId} with conviction ${conviction}.`);
      // Auto-refresh vote status and campaign list
      if (queryCampaignId === campaignId) {
        queryVoteStatus();
      }
      loadCampaigns();
    } catch (err) {
      setError(String(err));
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
      const votingContract = getGovernanceVotingContract(settings.contractAddresses, provider);

      const [voteData, blockNum] = await Promise.all([
        votingContract.getCampaignVote(BigInt(cid)),
        provider.getBlockNumber(),
      ]);

      setCampaignVote({
        ayeTotal: BigInt(voteData.ayeTotal),
        nayTotal: BigInt(voteData.nayTotal),
        uniqueReviewers: BigInt(voteData.uniqueReviewers),
        terminationBlock: BigInt(voteData.terminationBlock),
        activated: voteData.activated,
        terminated: voteData.terminated,
      });
      setCurrentBlock(blockNum);

      // Query user's own vote record
      if (address) {
        const record = await votingContract.getVoteRecord(BigInt(cid), address);
        setMyVote({
          voter: record.voter,
          direction: Number(record.direction),
          lockAmount: BigInt(record.lockAmount),
          conviction: Number(record.conviction),
          lockedUntilBlock: BigInt(record.lockedUntilBlock),
          castAtBlock: BigInt(record.castAtBlock),
        });
      }

      setQueryCampaignId(cid);
    } catch (err) {
      setError(String(err));
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
      const rewards = getGovernanceRewardsContract(settings.contractAddresses, signer);

      const tx = await rewards.withdrawStake(BigInt(queryCampaignId));
      await tx.wait();
      setTxResult("Stake withdrawn successfully.");
      queryVoteStatus();
    } catch (err) {
      setError(String(err));
    } finally {
      setWithdrawing(false);
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

  // Can only aye on Pending, nay on Active/Paused
  const canAye = selectedStatus === 0 || selectedStatus === null;
  const canNay = selectedStatus === 1 || selectedStatus === 2 || selectedStatus === null;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>Governance Voting</span>
      </div>

      {/* Thresholds info */}
      {activationThreshold !== null && (
        <div style={{ marginBottom: 10, padding: "6px 10px", background: "#111", borderRadius: 4, fontSize: 11, color: "#666" }}>
          Activation: {formatDOT(activationThreshold)} DOT weighted aye
          {terminationThreshold !== null && (
            <span> &middot; Termination: {formatDOT(terminationThreshold)} DOT weighted nay</span>
          )}
          {minStake !== null && (
            <span> &middot; Min stake: {formatDOT(minStake)} DOT</span>
          )}
        </div>
      )}

      {/* Pending Campaigns — need Aye votes to activate */}
      <CampaignSection
        title="Pending Activation"
        subtitle="Vote Aye to activate"
        campaigns={pendingCampaigns}
        loading={loadingCampaigns}
        threshold={activationThreshold}
        thresholdField="ayeTotal"
        selectedId={campaignId}
        onSelect={setCampaignId}
        onRefresh={loadCampaigns}
        emptyText="No campaigns pending activation."
      />

      {/* Active Campaigns — can receive Nay votes to terminate */}
      <CampaignSection
        title="Active Campaigns"
        subtitle="Vote Nay to terminate"
        campaigns={activeCampaigns}
        loading={loadingCampaigns}
        threshold={terminationThreshold}
        thresholdField="nayTotal"
        selectedId={campaignId}
        onSelect={setCampaignId}
        onRefresh={loadCampaigns}
        emptyText="No active campaigns."
      />

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
                background: selectedStatus === 0 ? "#1a1a0a" : "#0a2a0a",
                color: selectedStatus === 0 ? "#c0c060" : "#60c060",
                border: `1px solid ${selectedStatus === 0 ? "#3a3a2a" : "#2a4a2a"}`,
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
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => castVote("aye")}
            disabled={voting || !campaignId || !canAye}
            style={{ ...ayeBtn, flex: 1, opacity: canAye ? 1 : 0.4 }}
            title={!canAye ? "Aye only for Pending campaigns" : ""}
          >
            {voting ? "Voting..." : "Vote Aye"}
          </button>
          <button
            onClick={() => castVote("nay")}
            disabled={voting || !campaignId || !canNay}
            style={{ ...nayBtn, flex: 1, opacity: canNay ? 1 : 0.4 }}
            title={!canNay ? "Nay only for Active/Paused campaigns" : ""}
          >
            {voting ? "Voting..." : "Vote Nay"}
          </button>
        </div>
        {selectedStatus !== null && (
          <div style={{ color: "#555", fontSize: 10, marginTop: 4, textAlign: "center" }}>
            {selectedStatus === 0
              ? "Pending campaign — only Aye votes accepted"
              : "Active campaign — only Nay votes accepted"}
          </div>
        )}
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

      {/* Campaign Vote Display */}
      {campaignVote && (
        <div style={{ ...cardStyle, marginTop: 10 }}>
          <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            Campaign #{queryCampaignId}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ color: "#60c060", fontSize: 12 }}>
              Aye: {formatDOT(campaignVote.ayeTotal)} DOT
            </span>
            <span style={{ color: "#ff8080", fontSize: 12 }}>
              Nay: {formatDOT(campaignVote.nayTotal)} DOT
            </span>
          </div>
          <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>
            Reviewers: {campaignVote.uniqueReviewers.toString()}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {campaignVote.activated && (
              <span style={statusBadge("#0a2a0a", "#60c060", "#2a4a2a")}>Activated</span>
            )}
            {campaignVote.terminated && (
              <span style={statusBadge("#2a0a0a", "#ff8080", "#4a1a1a")}>Terminated</span>
            )}
            {!campaignVote.activated && !campaignVote.terminated && (
              <span style={statusBadge("#1a1a0a", "#c0c060", "#3a3a2a")}>Pending</span>
            )}
          </div>
        </div>
      )}

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

          {/* Withdraw stake button — show when lockup expired */}
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
// Campaign list section (reused for Pending and Active)
// ---------------------------------------------------------------------------

function CampaignSection({
  title, subtitle, campaigns, loading, threshold, thresholdField,
  selectedId, onSelect, onRefresh, emptyText,
}: {
  title: string;
  subtitle: string;
  campaigns: GovernableCampaign[];
  loading: boolean;
  threshold: bigint | null;
  thresholdField: "ayeTotal" | "nayTotal";
  selectedId: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
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
        <div style={{ color: "#555", fontSize: 12, padding: "4px 8px" }}>{emptyText}</div>
      ) : (
        <div style={{ maxHeight: 140, overflowY: "auto" }}>
          {campaigns.map((c) => {
            const progress = threshold && threshold > 0n ? c[thresholdField] : 0n;
            const pct = threshold && threshold > 0n
              ? Math.min(100, Number((progress * 100n) / threshold))
              : 0;
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
                  <span style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 12 }}>#{c.id}</span>
                  <span style={{ color: "#666", fontSize: 10 }}>
                    {CATEGORY_NAMES[c.categoryId] ?? "Unknown"}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color: "#888" }}>
                    {formatDOT(c.budget)} DOT &middot; {formatDOT(c.bidCpmPlanck)} CPM
                  </span>
                  <span style={{ color: "#888" }}>
                    {c.reviewers.toString()} voter{c.reviewers !== 1n ? "s" : ""}
                  </span>
                </div>
                {/* Progress bar toward threshold */}
                {threshold && threshold > 0n && (
                  <div style={{ position: "relative", height: 4, background: "#1a1a2e", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      position: "absolute", top: 0, left: 0, height: "100%",
                      width: `${pct}%`,
                      background: thresholdField === "ayeTotal" ? "#2a6a2a" : "#6a2a2a",
                      borderRadius: 2,
                      transition: "width 0.3s",
                    }} />
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 2 }}>
                  <span style={{ color: thresholdField === "ayeTotal" ? "#60c060" : "#ff8080" }}>
                    {formatDOT(progress)} / {threshold ? formatDOT(threshold) : "?"} DOT
                  </span>
                  <span style={{ color: "#555" }}>{pct}%</span>
                </div>
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
