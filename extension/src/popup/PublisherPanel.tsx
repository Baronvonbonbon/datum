import { useState, useEffect, useCallback } from "react";
import { parseUnits } from "ethers";
import { getSettlementContract, getPublishersContract, getCampaignsContract, getRelayContract, getProvider } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { cidToBytes32 } from "@shared/ipfs";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { CATEGORY_NAMES } from "@shared/types";
import { getSigner } from "@shared/walletManager";

interface Props {
  address: string | null;
}

interface PublisherInfo {
  isRegistered: boolean;
  takeRateBps: number;
  pendingTakeRateBps: number | null;
  pendingEffectiveBlock: number | null;
}

export function PublisherPanel({ address }: Props) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [publisherInfo, setPublisherInfo] = useState<PublisherInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [relaySubmitting, setRelaySubmitting] = useState(false);
  const [signedBatchData, setSignedBatchData] = useState<{
    batches: any[];
    signedAt: number;
    deadline: number;
  } | null>(null);
  const [currentBlock, setCurrentBlock] = useState<number | null>(null);
  const [txResult, setTxResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function getSettings() {
    const stored = await chrome.storage.local.get("settings");
    return stored.settings ?? DEFAULT_SETTINGS;
  }

  const loadData = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const settings = await getSettings();
      const provider = getProvider(settings.rpcUrl);
      const settlement = getSettlementContract(settings.contractAddresses, provider);
      const publishers = getPublishersContract(settings.contractAddresses, provider);

      const [bal, pubData, blockNum, stored] = await Promise.all([
        settlement.publisherBalance(address).catch(() => 0n),
        publishers.getPublisher(address).catch(() => null),
        provider.getBlockNumber().catch(() => null),
        chrome.storage.local.get("signedBatches"),
      ]);

      setBalance(bal as bigint);
      if (blockNum !== null) setCurrentBlock(blockNum);
      setSignedBatchData(stored.signedBatches ?? null);

      if (pubData) {
        setPublisherInfo({
          isRegistered: pubData.isActive ?? false,
          takeRateBps: Number(pubData.takeRateBps ?? 0),
          pendingTakeRateBps: pubData.pendingTakeRateBps != null ? Number(pubData.pendingTakeRateBps) : null,
          pendingEffectiveBlock: pubData.pendingEffectiveBlock != null ? Number(pubData.pendingEffectiveBlock) : null,
        });
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function withdraw() {
    if (!address) return;
    setWithdrawing(true);
    setTxResult(null);
    setError(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const settlement = getSettlementContract(settings.contractAddresses, signer);

      const tx = await settlement.withdrawPublisher();
      await tx.wait();
      setTxResult("Withdrawal successful.");
      loadData();
    } catch (err) {
      setError(String(err));
    } finally {
      setWithdrawing(false);
    }
  }

  async function relaySubmit() {
    if (!signedBatchData?.batches?.length) return;
    setRelaySubmitting(true);
    setTxResult(null);
    setError(null);
    try {
      const settings = await getSettings();
      if (!settings.contractAddresses.relay) {
        throw new Error("Relay contract address not configured. Check Settings.");
      }
      const signer = getSigner(settings.rpcUrl);
      const relay = getRelayContract(settings.contractAddresses, signer);
      const settlement = getSettlementContract(settings.contractAddresses, signer);

      // Deserialize signed batches (bigints stored as strings/numbers)
      const contractBatches = signedBatchData.batches.map((b: any) => ({
        user: b.user,
        campaignId: BigInt(b.campaignId),
        claims: b.claims.map((c: any) => ({
          campaignId: BigInt(c.campaignId),
          publisher: c.publisher,
          impressionCount: BigInt(c.impressionCount),
          clearingCpmPlanck: BigInt(c.clearingCpmPlanck),
          nonce: BigInt(c.nonce),
          previousClaimHash: c.previousClaimHash,
          claimHash: c.claimHash,
          zkProof: c.zkProof,
        })),
        deadline: BigInt(b.deadline),
        signature: b.signature,
        publisherSig: b.publisherSig ?? "0x",
      }));

      const tx = await relay.settleClaimsFor(contractBatches);
      const receipt = await tx.wait();

      // Parse ClaimSettled/ClaimRejected events from settlement interface
      let settledCount = 0;
      let rejectedCount = 0;
      let totalPaid = 0n;
      if (receipt?.logs) {
        const iface = settlement.interface;
        for (const log of receipt.logs) {
          try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === "ClaimSettled") {
              settledCount++;
              totalPaid += BigInt(parsed.args.totalPayment ?? parsed.args.userPayment ?? 0);
            } else if (parsed?.name === "ClaimRejected") {
              rejectedCount++;
            }
          } catch { /* log from different contract */ }
        }
      }

      // Clear signed batches from storage
      await chrome.storage.local.remove("signedBatches");
      setSignedBatchData(null);
      setTxResult(`Relay submitted: ${settledCount} settled, ${rejectedCount} rejected. Total paid: ${formatDOT(totalPaid)} DOT`);
      loadData();
    } catch (err) {
      setError(String(err));
    } finally {
      setRelaySubmitting(false);
    }
  }

  if (!address) {
    return (
      <div style={emptyStyle}>
        Connect wallet to view publisher balance.
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>Publisher Balance</span>
      </div>

      {loading ? (
        <div style={{ color: "#555", fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <div style={cardStyle}>
            <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>Withdrawable balance</div>
            <div style={{ color: "#e0e0e0", fontSize: 18, fontWeight: 600 }}>
              {balance !== null ? formatDOT(balance) : "—"} DOT
            </div>
          </div>

          {publisherInfo && (
            <div style={{ ...cardStyle, marginTop: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#888", fontSize: 12 }}>Registration</span>
                <span style={{
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: 3,
                  background: publisherInfo.isRegistered ? "#0a2a0a" : "#2a0a0a",
                  color: publisherInfo.isRegistered ? "#60c060" : "#ff8080",
                }}>
                  {publisherInfo.isRegistered ? "Active" : "Inactive"}
                </span>
              </div>
              <div style={{ color: "#888", fontSize: 12 }}>
                Take rate: {(publisherInfo.takeRateBps / 100).toFixed(2)}%
              </div>
              {publisherInfo.pendingTakeRateBps !== null && (
                <div style={{ color: "#666", fontSize: 11, marginTop: 2 }}>
                  Pending: {(publisherInfo.pendingTakeRateBps / 100).toFixed(2)}% (block {publisherInfo.pendingEffectiveBlock})
                </div>
              )}
            </div>
          )}

          {balance !== null && balance > 0n && (
            <button
              onClick={withdraw}
              disabled={withdrawing}
              style={{ ...primaryBtn, marginTop: 12 }}
            >
              {withdrawing ? "Withdrawing…" : `Withdraw ${formatDOT(balance)} DOT`}
            </button>
          )}

          <button onClick={loadData} style={{ ...secondaryBtn, marginTop: 8 }}>
            Refresh
          </button>

          {/* Relay Submit Section */}
          {signedBatchData && signedBatchData.batches.length > 0 && (
            <div style={{ marginTop: 12, padding: 10, background: "#0a1a2a", borderRadius: 6, border: "1px solid #1a2a4a" }}>
              <div style={{ color: "#60a0ff", fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                Signed Batches for Relay
              </div>
              <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>
                {signedBatchData.batches.length} batch{signedBatchData.batches.length !== 1 ? "es" : ""} pending
                {" · "}Deadline block: {signedBatchData.deadline}
              </div>
              {currentBlock !== null && signedBatchData.deadline <= currentBlock ? (
                <div style={{ color: "#ff8080", fontSize: 12, marginBottom: 6 }}>
                  Expired (current block: {currentBlock}). User must re-sign.
                </div>
              ) : currentBlock !== null ? (
                <div style={{ color: "#508050", fontSize: 11, marginBottom: 6 }}>
                  ~{Math.max(0, (signedBatchData.deadline - currentBlock) * 6)} seconds remaining
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={relaySubmit}
                  disabled={relaySubmitting || (currentBlock !== null && signedBatchData.deadline <= currentBlock)}
                  style={{ ...relayBtn, flex: 1 }}
                >
                  {relaySubmitting ? "Submitting..." : "Submit Signed Claims"}
                </button>
                <button
                  onClick={async () => {
                    await chrome.storage.local.remove("signedBatches");
                    setSignedBatchData(null);
                  }}
                  style={{ ...secondaryBtn, flex: 0, padding: "8px 12px", width: "auto" }}
                >
                  Clear
                </button>
              </div>
            </div>
          )}
        </>
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

      {/* Campaign creation form */}
      <div style={{ marginTop: 16, borderTop: "1px solid #2a2a2a", paddingTop: 12 }}>
        <div style={{ color: "#a0a0ff", fontWeight: 600, marginBottom: 8 }}>Create Campaign</div>
        <CreateCampaignForm address={address} onCreated={loadData} />
      </div>
    </div>
  );
}

function CreateCampaignForm({ address, onCreated }: { address: string; onCreated: () => void }) {
  const [budget, setBudget] = useState("1");
  const [dailyCap, setDailyCap] = useState("0.1");
  const [bidCpm, setBidCpm] = useState("0.01");
  const [categoryId, setCategoryId] = useState(0);
  const [metadataCid, setMetadataCid] = useState("");
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    setResult(null);
    setFormError(null);
    try {
      const stored = await chrome.storage.local.get("settings");
      const settings = stored.settings ?? DEFAULT_SETTINGS;

      const signer = getSigner(settings.rpcUrl);
      const campaigns = getCampaignsContract(settings.contractAddresses, signer);

      // Convert DOT strings to planck (1 DOT = 10^10 planck)
      const budgetPlanck = parseUnits(budget, 10);
      const dailyCapPlanck = parseUnits(dailyCap, 10);
      const bidCpmPlanck = parseUnits(bidCpm, 10);

      const tx = await campaigns.createCampaign(
        address, // publisher = self
        dailyCapPlanck,
        bidCpmPlanck,
        categoryId,
        { value: budgetPlanck }
      );
      const receipt = await tx.wait();

      // If metadata CID is provided, encode to bytes32 and set on-chain
      if (metadataCid.trim()) {
        // Parse campaign ID from CampaignCreated event in receipt
        let campaignId: bigint | undefined;
        for (const log of receipt.logs) {
          try {
            const parsed = campaigns.interface.parseLog({ topics: log.topics as string[], data: log.data });
            if (parsed?.name === "CampaignCreated") campaignId = parsed.args.campaignId;
          } catch { /* log from different contract */ }
        }
        if (campaignId === undefined) throw new Error("Could not parse campaign ID from receipt");

        const metadataHash = cidToBytes32(metadataCid.trim());
        const metaTx = await campaigns.setMetadata(campaignId, metadataHash);
        await metaTx.wait();
      }

      setResult("Campaign created! It will appear after governance activation.");
      onCreated();
    } catch (err) {
      setFormError(String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <label style={formLabel}>Budget (DOT)</label>
        <input type="text" value={budget} onChange={(e) => setBudget(e.target.value)}
          style={formInput} placeholder="1.0" />
      </div>
      <div style={{ marginBottom: 6 }}>
        <label style={formLabel}>Daily Cap (DOT)</label>
        <input type="text" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)}
          style={formInput} placeholder="0.1" />
      </div>
      <div style={{ marginBottom: 6 }}>
        <label style={formLabel}>Bid CPM (DOT per 1000 impressions)</label>
        <input type="text" value={bidCpm} onChange={(e) => setBidCpm(e.target.value)}
          style={formInput} placeholder="0.01" />
      </div>
      <div style={{ marginBottom: 6 }}>
        <label style={formLabel}>Category</label>
        <select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}
          style={{ ...formInput, cursor: "pointer" }}>
          {Object.entries(CATEGORY_NAMES).map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label style={formLabel}>Metadata CID (IPFS CIDv0, optional)</label>
        <input type="text" value={metadataCid} onChange={(e) => setMetadataCid(e.target.value)}
          style={{ ...formInput, fontFamily: "monospace", fontSize: 11 }}
          placeholder="QmXyz..." />
        <div style={{ color: "#555", fontSize: 10, marginTop: 2 }}>
          Pin JSON with title, description, category, creative fields to IPFS
        </div>
      </div>
      <button onClick={create} disabled={creating} style={primaryBtn}>
        {creating ? "Creating..." : "Create Campaign"}
      </button>
      {result && (
        <div style={{ marginTop: 6, color: "#60c060", fontSize: 12 }}>{result}</div>
      )}
      {formError && (
        <div style={{ marginTop: 6, color: "#ff8080", fontSize: 12 }}>{formError}</div>
      )}
    </div>
  );
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

const relayBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#0a2a3a",
  color: "#60a0ff",
  border: "1px solid #1a3a5a",
};

const emptyStyle: React.CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "#666",
  fontSize: 13,
};
