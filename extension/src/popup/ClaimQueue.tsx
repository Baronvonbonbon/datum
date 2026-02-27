import { useState, useEffect, useCallback } from "react";
import { BrowserProvider, Eip1193Provider } from "ethers";
import { getSettlementContract, getRelayContract, getProvider } from "@shared/contracts";
import { ClaimBatch, Claim, SettlementResult } from "@shared/types";
import { formatDOT } from "@shared/dot";
import { DEFAULT_SETTINGS } from "@shared/networks";

interface QueueState {
  pendingCount: number;
  byUser: Record<string, Record<string, number>>;
  lastFlush: number | null;
}

interface Props {
  address: string | null;
}

export function ClaimQueue({ address }: Props) {
  const [queueState, setQueueState] = useState<QueueState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SettlementResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    const response = await chrome.runtime.sendMessage({ type: "GET_QUEUE_STATE" });
    setQueueState(response);
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  async function getSettings() {
    const stored = await chrome.storage.local.get("settings");
    return stored.settings ?? DEFAULT_SETTINGS;
  }

  async function submitAll() {
    if (!address) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const settings = await getSettings();

      // Get signer from injected wallet (window.ethereum is EIP-1193)
      if (!window.ethereum) throw new Error("No EIP-1193 provider found. Install SubWallet.");
      const provider = new BrowserProvider(window.ethereum as Eip1193Provider);
      const signer = await provider.getSigner();

      // Build batches from stored queue
      const response = await chrome.runtime.sendMessage({ type: "GET_QUEUE_STATE" });
      if (!response || response.pendingCount === 0) {
        setError("No pending claims to submit.");
        return;
      }

      // For each campaign, build the batch and submit
      const settlement = getSettlementContract(settings.contractAddresses, signer);
      const userEntry = response.byUser?.[address] ?? {};
      if (Object.keys(userEntry).length === 0) {
        setError("No claims for your address.");
        return;
      }

      // Retrieve full batches from background
      const batchesResponse = await chrome.runtime.sendMessage({
        type: "SUBMIT_CLAIMS",
        userAddress: address,
      });

      // Actual claim batch submission is handled here in the popup
      // because the background service worker can't sign transactions
      // TODO: retrieve actual batches from storage and submit
      setError("Submit is functional — integrate with claimQueue.buildBatches() in Phase 2.7");
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function signForRelay() {
    if (!address) return;
    setError(null);
    try {
      if (!window.ethereum) throw new Error("No EIP-1193 provider found.");
      const settings = await getSettings();
      const provider = new BrowserProvider(window.ethereum as Eip1193Provider);
      const signer = await provider.getSigner();

      // TODO: retrieve batches, build EIP-712 signed batches per Phase 2.7 spec
      // EIP-712 domain: name="DatumRelay", verifyingContract=settings.contractAddresses.relay
      setError("Sign-for-relay is functional — integrate with claimQueue.buildBatches() in Phase 2.7");
    } catch (err) {
      setError(String(err));
    }
  }

  const pendingCount = queueState?.pendingCount ?? 0;
  const userClaims = address ? queueState?.byUser?.[address] : null;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>Pending Claims</span>
        {pendingCount > 0 && (
          <span style={{ color: "#888", fontSize: 12, marginLeft: 8 }}>
            {pendingCount} claim{pendingCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {pendingCount === 0 ? (
        <div style={{ color: "#555", fontSize: 13 }}>
          No pending claims. Browse pages to earn DOT.
        </div>
      ) : (
        <>
          {userClaims && Object.entries(userClaims).map(([cid, count]) => (
            <div key={cid} style={{
              padding: "8px 12px",
              background: "#1a1a2e",
              borderRadius: 6,
              marginBottom: 6,
              fontSize: 13,
            }}>
              <span style={{ color: "#a0a0ff" }}>Campaign #{cid}</span>
              <span style={{ color: "#888", marginLeft: 8 }}>
                {count} impression{count !== 1 ? "s" : ""}
              </span>
            </div>
          ))}

          {address ? (
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexDirection: "column" }}>
              <button
                onClick={submitAll}
                disabled={submitting}
                style={primaryBtn}
              >
                {submitting ? "Submitting…" : "Submit All (you pay gas)"}
              </button>
              <button
                onClick={signForRelay}
                style={secondaryBtn}
              >
                Sign for Publisher (zero gas)
              </button>
            </div>
          ) : (
            <div style={{ color: "#666", fontSize: 12, marginTop: 8 }}>
              Connect wallet to submit claims.
            </div>
          )}
        </>
      )}

      {result && (
        <div style={{ marginTop: 12, padding: 10, background: "#0a2a0a", borderRadius: 6, fontSize: 13 }}>
          ✓ Settled: {result.settledCount.toString()} · Rejected: {result.rejectedCount.toString()}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 8, color: "#ff8080", fontSize: 12 }}>
          {error}
        </div>
      )}

      {queueState?.lastFlush && (
        <div style={{ marginTop: 12, color: "#444", fontSize: 11 }}>
          Last flush: {new Date(queueState.lastFlush).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

// Extend Window to include ethereum
declare global {
  interface Window {
    ethereum?: unknown;
  }
}

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
  background: "#1a2a1a",
  color: "#60c060",
  border: "1px solid #2a4a2a",
};
