import { useState, useEffect, useCallback } from "react";
import { getSettlementContract, getPublishersContract, getRelayContract, getProvider } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { getSigner } from "@shared/walletManager";
import { CATEGORY_NAMES } from "@shared/types";

interface Props {
  address: string | null;
}

interface PublisherInfo {
  isRegistered: boolean;
  takeRateBps: number;
  pendingTakeRateBps: number | null;
  pendingEffectiveBlock: number | null;
  categoryBitmask: bigint;
}

export function PublisherPanel({ address }: Props) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [publisherInfo, setPublisherInfo] = useState<PublisherInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [savingCategories, setSavingCategories] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<Set<number>>(new Set());
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
        const bitmask = BigInt(pubData.categoryBitmask ?? 0);
        setPublisherInfo({
          isRegistered: pubData.isActive ?? false,
          takeRateBps: Number(pubData.takeRateBps ?? 0),
          pendingTakeRateBps: pubData.pendingTakeRateBps != null ? Number(pubData.pendingTakeRateBps) : null,
          pendingEffectiveBlock: pubData.pendingEffectiveBlock != null ? Number(pubData.pendingEffectiveBlock) : null,
          categoryBitmask: bitmask,
        });
        // Populate selected categories from bitmask
        const cats = new Set<number>();
        for (let i = 1; i <= 26; i++) {
          if (bitmask & (1n << BigInt(i))) cats.add(i);
        }
        setSelectedCategories(cats);
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

  async function saveCategories() {
    if (!address) return;
    setSavingCategories(true);
    setTxResult(null);
    setError(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const pubContract = getPublishersContract(settings.contractAddresses, signer);

      let bitmask = 0n;
      for (const cat of selectedCategories) {
        bitmask |= 1n << BigInt(cat);
      }

      const tx = await pubContract.setCategories(bitmask);
      await tx.wait();
      setTxResult(`Categories updated (${selectedCategories.size} selected).`);
      loadData();
    } catch (err) {
      setError(String(err));
    } finally {
      setSavingCategories(false);
    }
  }

  function toggleCategory(catId: number) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
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

          {/* Category Bitmask Management */}
          {publisherInfo?.isRegistered && (
            <div style={{ ...cardStyle, marginTop: 8 }}>
              <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
                Ad Categories
              </div>
              <div style={{ maxHeight: 120, overflowY: "auto", marginBottom: 6 }}>
                {Array.from({ length: 26 }, (_, i) => i + 1).map((catId) => (
                  <label key={catId} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#bbb", cursor: "pointer", marginBottom: 2 }}>
                    <input
                      type="checkbox"
                      checked={selectedCategories.has(catId)}
                      onChange={() => toggleCategory(catId)}
                      style={{ accentColor: "#a0a0ff" }}
                    />
                    {CATEGORY_NAMES[catId] ?? `Category ${catId}`}
                  </label>
                ))}
              </div>
              <button onClick={saveCategories} disabled={savingCategories}
                style={{ ...secondaryBtn, padding: "6px 12px", fontSize: 11, width: "auto" }}>
                {savingCategories ? "Saving..." : `Save Categories (${selectedCategories.size})`}
              </button>
            </div>
          )}

          {/* SDK Embed Snippet */}
          {publisherInfo?.isRegistered && address && (
            <div style={{ ...cardStyle, marginTop: 8 }}>
              <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
                SDK Embed Snippet
              </div>
              <div style={{ background: "#111122", padding: 8, borderRadius: 4, fontFamily: "monospace", fontSize: 10, color: "#aaa", wordBreak: "break-all", lineHeight: 1.5 }}>
                {`<script src="datum-sdk.js" data-categories="${Array.from(selectedCategories).sort((a, b) => a - b).join(",")}" data-publisher="${address}"></script>\n<div id="datum-ad-slot"></div>`}
              </div>
              <button
                onClick={() => {
                  const snippet = `<script src="datum-sdk.js" data-categories="${Array.from(selectedCategories).sort((a, b) => a - b).join(",")}" data-publisher="${address}"></script>\n<div id="datum-ad-slot"></div>`;
                  navigator.clipboard.writeText(snippet).then(() => setTxResult("Snippet copied!"));
                }}
                style={{ ...secondaryBtn, padding: "4px 10px", fontSize: 10, width: "auto", marginTop: 4 }}
              >
                Copy to Clipboard
              </button>
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
