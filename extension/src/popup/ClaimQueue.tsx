import { useState, useEffect, useCallback } from "react";
import { BrowserProvider, Eip1193Provider } from "ethers";
import { getSettlementContract, getProvider } from "@shared/contracts";
import { SerializedClaimBatch, SettlementResult, StoredSettings } from "@shared/types";
import { formatDOT } from "@shared/dot";
import { DEFAULT_SETTINGS } from "@shared/networks";

interface QueueState {
  pendingCount: number;
  byUser: Record<string, Record<string, number>>;
  lastFlush: number | null;
}

interface AutoFlushResult {
  settledCount: number;
  rejectedCount: number;
  error?: string;
  timestamp: number;
}

interface Props {
  address: string | null;
}

export function ClaimQueue({ address }: Props) {
  const [queueState, setQueueState] = useState<QueueState | null>(null);
  const [autoFlushResult, setAutoFlushResult] = useState<AutoFlushResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [result, setResult] = useState<SettlementResult | null>(null);
  const [signedCount, setSignedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    const [queueResponse, stored] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_QUEUE_STATE" }),
      chrome.storage.local.get("lastAutoFlushResult"),
    ]);
    setQueueState(queueResponse);
    if (stored.lastAutoFlushResult) {
      setAutoFlushResult(stored.lastAutoFlushResult as AutoFlushResult);
    }
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
    setError(null);
    setResult(null);

    // Acquire submission mutex — prevents race with auto-submit
    const mutexResponse = await chrome.runtime.sendMessage({ type: "ACQUIRE_MUTEX" });
    if (!mutexResponse?.acquired) {
      setError("A submission is already in progress. Please wait.");
      return;
    }

    setSubmitting(true);
    try {
      const settings = await getSettings();
      if (!settings.contractAddresses.settlement) {
        throw new Error("Settlement contract address not configured. Check Settings.");
      }

      if (!window.ethereum) throw new Error("No EIP-1193 provider found. Install SubWallet.");
      const provider = new BrowserProvider(window.ethereum as Eip1193Provider);
      const signer = await provider.getSigner();

      // Get batches from background (serialized — bigints as strings)
      const batchesResponse = await chrome.runtime.sendMessage({
        type: "SUBMIT_CLAIMS",
        userAddress: address,
      });

      const serializedBatches: SerializedClaimBatch[] = batchesResponse?.batches ?? [];
      if (serializedBatches.length === 0) {
        setError("No pending claims for your address.");
        return;
      }

      // Deserialize bigints for contract call
      const contractBatches = serializedBatches.map((b) => ({
        user: b.user,
        campaignId: BigInt(b.campaignId),
        claims: b.claims.map((c) => ({
          campaignId: BigInt(c.campaignId),
          publisher: c.publisher,
          impressionCount: BigInt(c.impressionCount),
          clearingCpmPlanck: BigInt(c.clearingCpmPlanck),
          nonce: BigInt(c.nonce),
          previousClaimHash: c.previousClaimHash,
          claimHash: c.claimHash,
          zkProof: c.zkProof,
        })),
      }));

      const settlement = getSettlementContract(settings.contractAddresses, signer);

      // Submit transaction
      const tx = await settlement.settleClaims(contractBatches);
      const receipt = await tx.wait();

      // Parse SettlementResult from events — count ClaimSettled vs ClaimRejected
      let settledCount = 0n;
      let rejectedCount = 0n;
      let totalPaid = 0n;

      if (receipt?.logs) {
        // Try to decode events from receipt
        const settlementInterface = settlement.interface;
        for (const log of receipt.logs) {
          try {
            const parsed = settlementInterface.parseLog(log);
            if (parsed?.name === "ClaimSettled") {
              settledCount++;
              totalPaid += BigInt(parsed.args.totalPayment ?? 0);
            } else if (parsed?.name === "ClaimRejected") {
              rejectedCount++;
            }
          } catch {
            // log from a different contract, skip
          }
        }
      }

      const settlementResult: SettlementResult = { settledCount, rejectedCount, totalPaid };
      setResult(settlementResult);

      // Remove settled claims from queue
      if (settledCount > 0) {
        // Build map of campaignId → settled nonces from contract batches
        const settledNonces: Record<string, string[]> = {};
        for (const b of contractBatches) {
          const cid = b.campaignId.toString();
          settledNonces[cid] = b.claims.map((c) => c.nonce.toString());
        }
        await chrome.runtime.sendMessage({
          type: "REMOVE_SETTLED_CLAIMS",
          userAddress: address,
          settledNonces,
        });
        await loadState();
      }

      // Handle nonce mismatch: if all claims were rejected, try to re-sync from chain
      if (settledCount === 0n && rejectedCount > 0n) {
        await resyncFromChain(address, settings, contractBatches);
        setError("Claims rejected — chain state resynced. Try submitting again.");
      }
    } catch (err) {
      const msg = String(err);
      // Detect nonce-related revert and trigger resync
      if (msg.includes("E04") || msg.includes("E05") || msg.includes("nonce")) {
        try {
          const settings = await getSettings();
          const batchesResponse = await chrome.runtime.sendMessage({
            type: "SUBMIT_CLAIMS",
            userAddress: address,
          });
          const batches: SerializedClaimBatch[] = batchesResponse?.batches ?? [];
          const contractBatches = batches.map((b) => ({
            user: b.user,
            campaignId: BigInt(b.campaignId),
            claims: b.claims.map((c) => ({
              campaignId: BigInt(c.campaignId),
              publisher: c.publisher,
              impressionCount: BigInt(c.impressionCount),
              clearingCpmPlanck: BigInt(c.clearingCpmPlanck),
              nonce: BigInt(c.nonce),
              previousClaimHash: c.previousClaimHash,
              claimHash: c.claimHash,
              zkProof: c.zkProof,
            })),
          }));
          await resyncFromChain(address, settings, contractBatches);
          setError("Nonce mismatch — chain state resynced. Try submitting again.");
        } catch {
          setError(msg);
        }
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
      await chrome.runtime.sendMessage({ type: "RELEASE_MUTEX" });
    }
  }

  async function signForRelay() {
    if (!address) return;
    setSigning(true);
    setError(null);
    setSignedCount(null);

    try {
      const settings = await getSettings();
      if (!settings.contractAddresses.relay) {
        throw new Error("Relay contract address not configured. Check Settings.");
      }

      if (!window.ethereum) throw new Error("No EIP-1193 provider found.");
      const provider = new BrowserProvider(window.ethereum as Eip1193Provider);
      const signer = await provider.getSigner();
      const network = await provider.getNetwork();
      const currentBlock = await provider.getBlockNumber();
      // Signature valid for ~10 minutes (100 blocks at 6s each)
      const deadline = currentBlock + 100;

      // Get all batches for this user
      const batchesResponse = await chrome.runtime.sendMessage({
        type: "SUBMIT_CLAIMS",
        userAddress: address,
      });
      const serializedBatches: SerializedClaimBatch[] = batchesResponse?.batches ?? [];
      if (serializedBatches.length === 0) {
        setError("No pending claims for your address.");
        return;
      }

      const domain = {
        name: "DatumRelay",
        version: "1",
        chainId: network.chainId,
        verifyingContract: settings.contractAddresses.relay,
      };

      const types = {
        ClaimBatch: [
          { name: "user", type: "address" },
          { name: "campaignId", type: "uint256" },
          { name: "firstNonce", type: "uint256" },
          { name: "lastNonce", type: "uint256" },
          { name: "claimCount", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      // Sign each batch and store as SignedClaimBatch in storage
      const signedBatches = [];
      for (const b of serializedBatches) {
        const claimsLen = b.claims.length;
        if (claimsLen === 0) continue;

        const value = {
          user: b.user,
          campaignId: BigInt(b.campaignId),
          firstNonce: BigInt(b.claims[0].nonce),
          lastNonce: BigInt(b.claims[claimsLen - 1].nonce),
          claimCount: BigInt(claimsLen),
          deadline: BigInt(deadline),
        };

        const signature = await signer.signTypedData(domain, types, value);

        signedBatches.push({
          user: b.user,
          campaignId: b.campaignId,
          claims: b.claims,
          deadline,
          signature,
        });
      }

      // Store signed batches for publisher relay pickup
      await chrome.storage.local.set({
        signedBatches: {
          batches: signedBatches,
          signedAt: Date.now(),
          deadline,
        },
      });

      setSignedCount(signedBatches.length);
    } catch (err) {
      setError(String(err));
    } finally {
      setSigning(false);
    }
  }

  const pendingCount = queueState?.pendingCount ?? 0;
  const userClaims = address ? queueState?.byUser?.[address] : null;

  // Estimate earnings for queued claims
  const estimatedEarnings = estimateEarnings(userClaims ?? {});

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>Pending Claims</span>
        {pendingCount > 0 && (
          <span style={{ color: "#888", fontSize: 12 }}>
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
            <div key={cid} style={claimRowStyle}>
              <span style={{ color: "#a0a0ff" }}>Campaign #{cid}</span>
              <span style={{ color: "#888", marginLeft: 8 }}>
                {count} impression{count !== 1 ? "s" : ""}
              </span>
            </div>
          ))}

          {estimatedEarnings > 0n && (
            <div style={{ color: "#60c060", fontSize: 12, marginTop: 4, marginBottom: 8 }}>
              Est. earnings: {formatDOT(estimatedEarnings)} DOT
            </div>
          )}

          {address ? (
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexDirection: "column" }}>
              <button
                onClick={submitAll}
                disabled={submitting || signing}
                style={primaryBtn}
              >
                {submitting ? "Submitting…" : "Submit All (you pay gas)"}
              </button>
              <button
                onClick={signForRelay}
                disabled={submitting || signing}
                style={secondaryBtn}
              >
                {signing ? "Signing…" : "Sign for Publisher (zero gas)"}
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
          <div style={{ color: "#60c060" }}>
            ✓ Settled: {result.settledCount.toString()} · Rejected: {result.rejectedCount.toString()}
          </div>
          {result.totalPaid > 0n && (
            <div style={{ color: "#888", fontSize: 12, marginTop: 2 }}>
              Total paid: {formatDOT(result.totalPaid)} DOT
            </div>
          )}
        </div>
      )}

      {signedCount !== null && (
        <div style={{ marginTop: 12, padding: 10, background: "#0a1a2a", borderRadius: 6, fontSize: 13, color: "#60a0ff" }}>
          ✓ Signed {signedCount} batch{signedCount !== 1 ? "es" : ""} for publisher relay.
          <div style={{ color: "#888", fontSize: 11, marginTop: 2 }}>
            The publisher will submit these on your behalf.
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 8, color: "#ff8080", fontSize: 12 }}>
          {error}
        </div>
      )}

      {autoFlushResult && (
        <div style={{ marginTop: 12, padding: 8, background: "#111", borderRadius: 4, fontSize: 11 }}>
          <span style={{ color: "#555" }}>Auto-submit </span>
          {autoFlushResult.error ? (
            <span style={{ color: "#ff6060" }}>failed: {autoFlushResult.error.slice(0, 80)}</span>
          ) : (
            <span style={{ color: "#508050" }}>
              ✓ {autoFlushResult.settledCount} settled · {autoFlushResult.rejectedCount} rejected
            </span>
          )}
          <span style={{ color: "#444", marginLeft: 6 }}>
            {new Date(autoFlushResult.timestamp).toLocaleTimeString()}
          </span>
        </div>
      )}

      {queueState?.lastFlush && (
        <div style={{ marginTop: 4, color: "#444", fontSize: 11 }}>
          Last auto-flush attempt: {new Date(queueState.lastFlush).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

// Re-sync chain state from on-chain after nonce mismatch
async function resyncFromChain(
  userAddress: string,
  settings: StoredSettings,
  batches: Array<{ campaignId: bigint }>
) {
  const provider = getProvider(settings.rpcUrl);
  const settlement = getSettlementContract(settings.contractAddresses, provider);

  for (const b of batches) {
    try {
      const onChainNonce = await settlement.lastNonce(userAddress, b.campaignId);
      const onChainHash = await settlement.lastClaimHash(userAddress, b.campaignId);
      await chrome.runtime.sendMessage({
        type: "SYNC_CHAIN_STATE",
        userAddress,
        campaignId: b.campaignId.toString(),
        onChainNonce: Number(onChainNonce),
        onChainHash: String(onChainHash),
      });
    } catch {
      // If we can't read on-chain state, leave local state as-is
    }
  }
}

// Rough earnings estimate from queue state (no campaign CPM available in popup)
// Returns 0n unless we can compute — used only for display
function estimateEarnings(userClaims: Record<string, number>): bigint {
  // Without per-campaign CPM data in the popup, we can't compute exact earnings.
  // Return 0n — the actual value will be shown post-settlement.
  void userClaims;
  return 0n;
}

// Extend Window to include ethereum
declare global {
  interface Window {
    ethereum?: unknown;
  }
}

const claimRowStyle: React.CSSProperties = {
  padding: "8px 12px",
  background: "#1a1a2e",
  borderRadius: 6,
  marginBottom: 6,
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
  background: "#1a2a1a",
  color: "#60c060",
  border: "1px solid #2a4a2a",
};
