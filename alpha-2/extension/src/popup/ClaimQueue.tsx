import { useState, useEffect, useCallback, useRef } from "react";
import { getSettlementContract, getAttestationVerifierContract, getProvider } from "@shared/contracts";
import { SerializedClaimBatch, SettlementResult, StoredSettings } from "@shared/types";
import { formatDOT } from "@shared/dot";
import { DEFAULT_SETTINGS, getCurrencySymbol } from "@shared/networks";
import { getSigner, getUnlockedWallet } from "@shared/walletManager";
import { exportClaims, importClaims, ImportResult } from "@shared/claimExport";
import { humanizeError } from "@shared/errorCodes";

interface QueueState {
  pendingCount: number;
  byUser: Record<string, Record<string, number>>;
  lastFlush: number | null;
}

// Minimal campaign info we need for earnings estimate
interface CampaignMeta {
  id: string;
  bidCpmPlanck: string;
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
  const [campaigns, setCampaigns] = useState<Record<string, CampaignMeta>>({});
  const [submitting, setSubmitting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [result, setResult] = useState<SettlementResult | null>(null);
  const [signedCount, setSignedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [sym, setSym] = useState("DOT");
  const [stalePruned, setStalePruned] = useState(0); // CL-2: stale claims notification
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadState = useCallback(async () => {
    const [queueResponse, stored] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_QUEUE_STATE" }),
      chrome.storage.local.get(["lastAutoFlushResult", "activeCampaigns", "settings"]),
    ]);
    setQueueState(queueResponse);
    if (stored.lastAutoFlushResult) {
      setAutoFlushResult(stored.lastAutoFlushResult as AutoFlushResult);
    }
    // Build a lookup map by campaign id string
    if (stored.activeCampaigns) {
      const map: Record<string, CampaignMeta> = {};
      for (const c of stored.activeCampaigns as CampaignMeta[]) {
        map[c.id] = c;
      }
      setCampaigns(map);
    }

    // Proactively prune claims already settled on-chain (e.g. publisher submitted via relay)
    if (address && queueResponse?.pendingCount > 0) {
      try {
        const settings = stored.settings ?? DEFAULT_SETTINGS;
        if (settings.contractAddresses?.settlement) {
          const userCampaigns = queueResponse.byUser?.[address];
          if (userCampaigns && Object.keys(userCampaigns).length > 0) {
            await pruneSettledClaims(address, settings, Object.keys(userCampaigns));
            // Reload queue state after pruning
            const refreshed = await chrome.runtime.sendMessage({ type: "GET_QUEUE_STATE" });
            const prunedCount = (queueResponse.pendingCount ?? 0) - (refreshed.pendingCount ?? 0);
            if (prunedCount > 0) setStalePruned(prunedCount); // CL-2
            setQueueState(refreshed);
          }
        }
      } catch (err) {
        console.warn("[DATUM] Failed to prune settled claims:", err);
      }
    }
  }, [address]);

  useEffect(() => {
    loadState();
    chrome.storage.local.get("settings").then((s) => {
      const network = (s.settings ?? DEFAULT_SETTINGS).network;
      setSym(getCurrencySymbol(network));
    });
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

      if (!settings.contractAddresses.attestationVerifier) {
        throw new Error("AttestationVerifier contract address not configured. Check Settings.");
      }

      const signer = getSigner(settings.rpcUrl);

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

      // Request publisher attestation for each batch (mandatory in alpha-2)
      const attestedBatches = await Promise.all(serializedBatches.map(async (b) => {
        const claimsLen = b.claims.length;
        let publisherSig = "0x";
        try {
          const attestResponse = await chrome.runtime.sendMessage({
            type: "REQUEST_PUBLISHER_ATTESTATION",
            publisherAddress: b.claims[0]?.publisher ?? "",
            campaignId: b.campaignId,
            userAddress: b.user,
            firstNonce: b.claims[0].nonce,
            lastNonce: b.claims[claimsLen - 1].nonce,
            claimCount: claimsLen,
          });
          if (attestResponse?.signature) publisherSig = attestResponse.signature;
        } catch {
          // Attestation unavailable — degraded trust mode (open campaigns)
        }
        return {
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
          publisherSig,
        };
      }));

      const attestationVerifier = getAttestationVerifierContract(settings.contractAddresses, signer);

      // Submit via AttestationVerifier (mandatory P1 path)
      const tx = await attestationVerifier.settleClaimsAttested(attestedBatches);
      const receipt = await tx.wait();

      // Parse SettlementResult from events — count ClaimSettled vs ClaimRejected
      let settledCount = 0n;
      let rejectedCount = 0n;
      let totalPaid = 0n;

      if (receipt?.logs) {
        const iface = attestationVerifier.interface;
        for (const log of receipt.logs) {
          try {
            const parsed = iface.parseLog(log);
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
      const msg = humanizeError(err);
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

      const signer = getSigner(settings.rpcUrl);
      const provider = signer.provider!;
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

        // Attempt publisher attestation (degraded trust if unavailable)
        let publisherSig = "0x";
        try {
          const attestResponse = await chrome.runtime.sendMessage({
            type: "REQUEST_PUBLISHER_ATTESTATION",
            publisherAddress: b.claims[0]?.publisher ?? "",
            campaignId: b.campaignId,
            userAddress: b.user,
            firstNonce: b.claims[0].nonce,
            lastNonce: b.claims[claimsLen - 1].nonce,
            claimCount: claimsLen,
          });
          if (attestResponse?.signature) {
            publisherSig = attestResponse.signature;
          }
        } catch {
          // Attestation unavailable — degraded trust mode
        }

        signedBatches.push({
          user: b.user,
          campaignId: b.campaignId,
          claims: b.claims,
          deadline,
          signature,
          publisherSig,
        });
      }

      // Store signed batches locally (for display + backup)
      await chrome.storage.local.set({
        signedBatches: {
          batches: signedBatches,
          signedAt: Date.now(),
          deadline,
        },
      });

      // POST batches to publisher relay endpoints
      const relaysByPublisher = new Map<string, typeof signedBatches>();
      for (const batch of signedBatches) {
        const publisher = batch.claims[0]?.publisher ?? "";
        if (!publisher) continue;
        const key = `publisherDomain:${publisher.toLowerCase()}`;
        const relayStorage = await chrome.storage.local.get(key);
        const domain: string | undefined = relayStorage[key];
        if (!domain) continue;
        const relayUrl = `https://${domain}`;
        const existing = relaysByPublisher.get(relayUrl) ?? [];
        existing.push(batch);
        relaysByPublisher.set(relayUrl, existing);
      }

      for (const [relayUrl, batches] of relaysByPublisher) {
        try {
          await fetch(`${relayUrl}/relay/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ batches }),
            signal: AbortSignal.timeout(8000),
          });
          console.log(`[DATUM] POSTed ${batches.length} batch(es) to ${relayUrl}`);
        } catch (err) {
          console.warn(`[DATUM] Relay POST failed for ${relayUrl}:`, err);
          // Non-fatal — batches are stored locally and can be retried
        }
      }

      setSignedCount(signedBatches.length);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setSigning(false);
    }
  }

  async function handleExport() {
    if (!address) return;
    setExporting(true);
    setError(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const blob = await exportClaims(signer);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `datum-claims-${address.slice(0, 8)}-${Date.now()}.dat`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setExporting(false);
    }
  }

  async function handleImport(file: File) {
    if (!address) return;
    setImporting(true);
    setError(null);
    setImportResult(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);

      // Build on-chain nonce check function
      const onChainNonceFn = async (userAddr: string, campaignId: string): Promise<number> => {
        if (!settings.contractAddresses.settlement) return 0;
        const provider = getProvider(settings.rpcUrl);
        const settlement = getSettlementContract(settings.contractAddresses, provider);
        return Number(await settlement.lastNonce(userAddr, BigInt(campaignId)));
      };

      const result = await importClaims(file, signer, onChainNonceFn);
      setImportResult(result);
      if (result.imported) {
        await loadState(); // refresh queue display
      }
      if (result.error) {
        setError(result.error);
      }
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setImporting(false);
    }
  }

  const pendingCount = queueState?.pendingCount ?? 0;
  const userClaims = address ? queueState?.byUser?.[address] : null;

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
          No pending claims. Browse pages to earn {sym}.
        </div>
      ) : (
        <>
          {userClaims && Object.entries(userClaims).map(([cid, count]) => {
            const meta = campaigns[cid];
            const estPlanck = meta
              ? (BigInt(meta.bidCpmPlanck) * BigInt(count) * 7500n) / (1000n * 10000n)
              : null;
            return (
              <div key={cid} style={claimRowStyle}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#a0a0ff" }}>Campaign #{cid}</span>
                  <span style={{ color: "#888", fontSize: 12 }}>
                    {count} impression{count !== 1 ? "s" : ""}
                  </span>
                </div>
                {estPlanck !== null && (
                  <div style={{ color: "#60c060", fontSize: 11, marginTop: 2 }}>
                    ~{formatDOT(estPlanck)} {sym} est. earnings
                  </div>
                )}
              </div>
            );
          })}

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
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <button
                  onClick={handleExport}
                  disabled={exporting || importing}
                  style={{ ...portabilityBtn, flex: 1 }}
                >
                  {exporting ? "Exporting…" : "Export Claims"}
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={exporting || importing}
                  style={{ ...portabilityBtn, flex: 1 }}
                >
                  {importing ? "Importing…" : "Import Claims"}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".dat"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImport(file);
                    e.target.value = ""; // reset for re-import
                  }}
                />
              </div>
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
              Total paid: {formatDOT(result.totalPaid)} {sym}
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
          <AttestationBadges />
        </div>
      )}

      {importResult && !importResult.error && (
        <div style={{ marginTop: 12, padding: 10, background: "#0a2a0a", borderRadius: 6, fontSize: 13, color: "#60c060" }}>
          Import complete: {importResult.chainsImported} chain{importResult.chainsImported !== 1 ? "s" : ""}, {importResult.claimsImported} claim{importResult.claimsImported !== 1 ? "s" : ""} imported
          {importResult.skippedStale > 0 && (
            <span style={{ color: "#888" }}> ({importResult.skippedStale} skipped — already settled)</span>
          )}
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

      {/* CL-2: Stale claims pruned notification */}
      {stalePruned > 0 && (
        <div style={{ marginTop: 8, padding: 8, background: "#1a1a0a", borderRadius: 4, fontSize: 11, color: "#c0c060" }}>
          {stalePruned} claim{stalePruned !== 1 ? "s" : ""} pruned — already settled on-chain (publisher relay or external submission).
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
// Attestation status badges
// -------------------------------------------------------------------------

function AttestationBadges() {
  const [batches, setBatches] = useState<Array<{ campaignId: string; publisherSig: string }>>([]);

  useEffect(() => {
    chrome.storage.local.get("signedBatches", (stored) => {
      if (stored.signedBatches?.batches) {
        setBatches(stored.signedBatches.batches.map((b: any) => ({
          campaignId: b.campaignId,
          publisherSig: b.publisherSig ?? "0x",
        })));
      }
    });
  }, []);

  if (batches.length === 0) return null;

  return (
    <div style={{ marginTop: 6 }}>
      {batches.map((b, i) => {
        const attested = b.publisherSig && b.publisherSig !== "0x" && b.publisherSig.length > 2;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, fontSize: 11 }}>
            <span style={{ color: "#888" }}>Campaign #{b.campaignId}</span>
            <span
              style={{
                padding: "1px 6px",
                borderRadius: 3,
                fontSize: 10,
                fontWeight: 600,
                background: attested ? "#0a2a0a" : "#2a1a0a",
                color: attested ? "#60c060" : "#c09060",
                border: `1px solid ${attested ? "#2a4a2a" : "#4a3a2a"}`,
              }}
              title={attested
                ? "Publisher co-signed this batch — stronger fraud protection"
                : "No publisher attestation — degraded trust mode"
              }
            >
              {attested ? "Attested" : "Unattested"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

// Prune claims that have already been settled on-chain (e.g. publisher submitted via relay).
// Compares on-chain nonce vs local chain state — only syncs when they differ, meaning
// something settled externally that the extension doesn't know about.
async function pruneSettledClaims(
  userAddress: string,
  settings: StoredSettings,
  campaignIds: string[]
) {
  const provider = getProvider(settings.rpcUrl);
  const settlement = getSettlementContract(settings.contractAddresses, provider);

  // Read local chain state for all queued campaigns
  const chainStateKeys = campaignIds.map((cid) => `chainState:${userAddress}:${cid}`);
  const localStates = await chrome.storage.local.get(chainStateKeys);

  for (const cid of campaignIds) {
    try {
      const localKey = `chainState:${userAddress}:${cid}`;
      const localNonce: number = localStates[localKey]?.lastNonce ?? 0;

      const onChainNonce = Number(await settlement.lastNonce(userAddress, BigInt(cid)));
      if (onChainNonce > localNonce) {
        // On-chain nonce advanced beyond local state — claims were settled externally
        const onChainHash = await settlement.lastClaimHash(userAddress, BigInt(cid));
        await chrome.runtime.sendMessage({
          type: "SYNC_CHAIN_STATE",
          userAddress,
          campaignId: cid,
          onChainNonce,
          onChainHash: String(onChainHash),
        });
      }
    } catch {
      // RPC failure — skip this campaign, leave claims as-is
    }
  }
}

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

const portabilityBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#1a1a1a",
  color: "#888",
  border: "1px solid #333",
  padding: "6px 10px",
  fontSize: 11,
};
