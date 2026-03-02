import { useState, useEffect, useCallback } from "react";
import { BrowserProvider, Eip1193Provider, parseUnits } from "ethers";
import { getSettlementContract, getPublishersContract, getCampaignsContract, getProvider } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { CATEGORY_NAMES } from "@shared/types";

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

      const [bal, pubData] = await Promise.all([
        settlement.publisherBalance(address).catch(() => 0n),
        publishers.getPublisher(address).catch(() => null),
      ]);

      setBalance(bal as bigint);

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
      if (!window.ethereum) throw new Error("No EIP-1193 provider found.");
      const settings = await getSettings();
      const provider = new BrowserProvider(window.ethereum as Eip1193Provider);
      const signer = await provider.getSigner();
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
  const [metadataUri, setMetadataUri] = useState("");
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    setResult(null);
    setFormError(null);
    try {
      if (!window.ethereum) throw new Error("No EIP-1193 provider found.");
      const stored = await chrome.storage.local.get("settings");
      const settings = stored.settings ?? DEFAULT_SETTINGS;

      const provider = new BrowserProvider(window.ethereum as Eip1193Provider);
      const signer = await provider.getSigner();
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

      // If metadata URI is provided, set it on the campaign
      if (metadataUri.trim()) {
        // Parse campaign ID from receipt events or use nextCampaignId - 1
        const cid = await campaigns.nextCampaignId() - 1n;
        const metaTx = await campaigns.setMetadata(cid, metadataUri.trim());
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
        <label style={formLabel}>Metadata URI (IPFS CID or URL, optional)</label>
        <input type="text" value={metadataUri} onChange={(e) => setMetadataUri(e.target.value)}
          style={{ ...formInput, fontFamily: "monospace", fontSize: 11 }}
          placeholder="ipfs://Qm... or https://..." />
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

declare global {
  interface Window {
    ethereum?: unknown;
  }
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

const emptyStyle: React.CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "#666",
  fontSize: 13,
};
