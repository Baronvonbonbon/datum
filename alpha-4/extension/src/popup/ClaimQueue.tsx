import { useState, useEffect, useCallback, useRef } from "react";
import { getSettlementContract, getAttestationVerifierContract, getBudgetLedgerContract, getProvider } from "@shared/contracts";
import { SerializedClaimBatch, SettlementResult, StoredSettings } from "@shared/types";
import { formatDOT } from "@shared/dot";
import { DEFAULT_SETTINGS, getCurrencySymbol } from "@shared/networks";
import { getSigner, getUnlockedWallet } from "@shared/walletManager";
import { exportClaims, importClaims, ImportResult } from "@shared/claimExport";
import { humanizeError } from "@shared/errorCodes";

/**
 * Paseo receipt workaround: getTransactionReceipt always returns null on Paseo.
 * Poll transaction count instead. Today's implementation always returns null
 * — callers treat null as "confirmed, no log data" and fall back to optimistic
 * accounting. The return type leaves room for a real receipt once Paseo's
 * eth-rpc bug is fixed; the receipt-decoding branches at the call sites
 * become live again at that point.
 */
async function waitForTxPaseo(
  provider: any,
  signerAddress: string,
  nonceBefore: number,
): Promise<{ logs: Array<{ topics: ReadonlyArray<string>; data: string }> } | null> {
  for (let i = 0; i < 60; i++) {
    const current = await provider.getTransactionCount(signerAddress);
    if (current > nonceBefore) return null;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null; // timed out — treat as confirmed
}

// BM-3: Fetch a PoW challenge from the relay and solve it (SHA-256, leading zero bytes).
async function solvePoWChallenge(relayUrl: string): Promise<{ powChallenge: string; powNonce: string }> {
  const resp = await fetch(`${relayUrl}/relay/challenge`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`Challenge fetch failed: ${resp.status}`);
  const { challenge, difficulty } = await resp.json() as { challenge: string; difficulty: number };

  // Solve: find a nonce where SHA-256(challenge + nonce) starts with `difficulty` zero bytes
  let nonce = 0;
  const enc = new TextEncoder();
  while (true) {
    const nonceStr = nonce.toString();
    const data = enc.encode(challenge + nonceStr);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    let ok = true;
    for (let i = 0; i < difficulty; i++) { if (hash[i] !== 0) { ok = false; break; } }
    if (ok) return { powChallenge: challenge, powNonce: nonceStr };
    nonce++;
  }
}

function BouncingText({ text }: { text: string }) {
  return (
    <span>
      {text.split("").map((ch, i) => (
        <span
          key={i}
          className={ch === " " ? undefined : "nano-bounce-char"}
          style={ch === " " ? { display: "inline-block", width: "0.3em" } : { animationDelay: `${i * 0.05}s` }}
        >
          {ch === " " ? "\u00a0" : ch}
        </span>
      ))}
    </span>
  );
}

interface QueueState {
  pendingCount: number;
  byUser: Record<string, Record<string, number>>;
  lastFlush: number | null;
  rawQueueDepth?: number;
}

// Minimal campaign info we need for earnings estimate
interface CampaignMeta {
  id: string;
  viewBid: string;
}

interface AutoFlushResult {
  settledCount: number;
  rejectedCount: number;
  error?: string;
  timestamp: number;
}

interface Props {
  address: string | null;
  onSettled?: () => void;
}

export function ClaimQueue({ address, onSettled }: Props) {
  const [queueState, setQueueState] = useState<QueueState | null>(null);
  const [autoFlushResult, setAutoFlushResult] = useState<AutoFlushResult | null>(null);
  const [campaigns, setCampaigns] = useState<Record<string, CampaignMeta>>({});
  const [submitting, setSubmitting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [result, setResult] = useState<SettlementResult | null>(null);
  const [signedCount, setSignedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submittingCampaign, setSubmittingCampaign] = useState<string | null>(null);
  const [discardingCampaign, setDiscardingCampaign] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [attestationWarnings, setAttestationWarnings] = useState<Record<string, string>>({});
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
    // Poll every 3s so newly recorded impressions appear without manual refresh.
    const id = setInterval(loadState, 3000);
    return () => clearInterval(id);
  }, [loadState]);

  async function getSettings() {
    const stored = await chrome.storage.local.get("settings");
    return stored.settings ?? DEFAULT_SETTINGS;
  }

  /** Fetch actual on-chain remaining budgets for a set of campaign IDs.
   *  Returns { budgetMap, failedIds } where failedIds contains campaigns whose
   *  RPC call failed (budget is 0n in map but NOT confirmed exhausted on-chain).
   *  Total network failure → throws so the caller can surface an error to the user. */
  async function fetchOnChainBudgets(
    campaignIds: string[],
    settings: StoredSettings,
  ): Promise<{ budgetMap: Record<string, bigint>; failedIds: Set<string> }> {
    const budgetMap: Record<string, bigint> = {};
    const failedIds = new Set<string>();
    if (!settings.contractAddresses.budgetLedger || campaignIds.length === 0) {
      return { budgetMap, failedIds };
    }
    // Throws on total network failure — caller must handle
    const provider = getProvider(settings.rpcUrl);
    const ledger = getBudgetLedgerContract(settings.contractAddresses, provider);
    await Promise.all(campaignIds.map(async (id) => {
      try {
        budgetMap[id] = BigInt(await ledger.getRemainingBudget(BigInt(id)));
      } catch {
        // Single campaign lookup failed — treat as 0 but mark as failed
        // so we don't auto-discard claims when the RPC was just flaky.
        budgetMap[id] = 0n;
        failedIds.add(id);
      }
    }));
    return { budgetMap, failedIds };
  }

  /** Auto-discard claims for campaigns with confirmed 0 budget (not RPC failures). */
  async function discardExhaustedCampaigns(
    originalBatches: SerializedClaimBatch[],
    filteredBatches: SerializedClaimBatch[],
    failedIds: Set<string>,
    userAddress: string,
  ): Promise<string[]> {
    const filteredIds = new Set(filteredBatches.map((b) => b.campaignId));
    const discarded: string[] = [];
    for (const b of originalBatches) {
      if (!filteredIds.has(b.campaignId) && !failedIds.has(b.campaignId)) {
        // Confirmed exhausted on-chain — safe to discard
        try {
          await chrome.runtime.sendMessage({
            type: "DISCARD_CAMPAIGN_CLAIMS",
            userAddress,
            campaignId: b.campaignId,
          });
          discarded.push(`#${b.campaignId}`);
        } catch { /* best-effort */ }
      }
    }
    return discarded;
  }

  /** Truncate claims in each batch so total payment ≤ on-chain remaining budget.
   *  Drops batches that have zero affordable claims.
   *  Payment per claim:
   *    - actionType 0 (view/CPM): eventCount * ratePlanck / 1000
   *    - actionType 1/2 (click/action): eventCount * ratePlanck */
  function applyBudgetFilter(
    batches: SerializedClaimBatch[],
    budgetMap: Record<string, bigint>,
  ): SerializedClaimBatch[] {
    const result: SerializedClaimBatch[] = [];
    for (const b of batches) {
      // Unknown budget (budgetLedger not configured) → 0 to be safe
      const budget0 = budgetMap[b.campaignId] ?? 0n;
      let budget = budget0;
      const affordable: typeof b.claims = [];
      for (const c of b.claims) {
        const events = BigInt(c.eventCount);
        const rate = BigInt(c.ratePlanck);
        const payment = Number(c.actionType) === 0 ? (events * rate) / 1000n : events * rate;
        if (payment > budget) break; // chain must stay sequential — stop here
        affordable.push(c);
        budget -= payment;
      }
      if (affordable.length > 0) result.push({ ...b, claims: affordable });
    }
    return result;
  }

  async function submitAll() {
    if (!address) return;
    setError(null);
    setResult(null);
    setAttestationWarnings({});

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

      // Demo fast path: daemon uses pre-funded relay wallet (no user gas required).
      // Try this before touching the user's wallet.
      const daemonResp = await chrome.runtime.sendMessage({
        type: "DAEMON_SUBMIT_CLAIMS",
        userAddress: address,
      }).catch(() => null);
      if (daemonResp?.ok) {
        const settled = BigInt(daemonResp.settledCount ?? 0);
        setResult({ settledCount: settled, rejectedCount: 0n, totalPaid: 0n });
        if (settled > 0) { await loadState(); onSettled?.(); }
        return;
      }
      if (daemonResp?.error) {
        // Daemon available but reported an error (e.g. stale nonces, empty queue).
        // Fall through to user wallet — the daemon couldn't handle it.
        console.warn("[datum] daemon error, falling through to user wallet:", daemonResp.error);
        await loadState();
      }

      const signer = getSigner(settings.rpcUrl);
      const signerAddr: string = signer.address;

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

      // Budget check: fetch CURRENT on-chain remaining budgets so stale poller
      // cache doesn't let us submit claims that exceed the actual balance.
      // E16 hard-reverts the entire tx — one exhausted campaign kills all others.
      const campaignIds = [...new Set(serializedBatches.map((b) => b.campaignId))];
      let budgetMap: Record<string, bigint>;
      let budgetFailedIds: Set<string>;
      try {
        ({ budgetMap, failedIds: budgetFailedIds } = await fetchOnChainBudgets(campaignIds, settings));
      } catch (budgetErr) {
        throw new Error(`Could not verify campaign budgets on-chain: ${String(budgetErr)}`);
      }
      const budgetCheckedBatches = applyBudgetFilter(serializedBatches, budgetMap);
      // Auto-discard claims for campaigns confirmed exhausted on-chain.
      const autoDiscarded = await discardExhaustedCampaigns(
        serializedBatches, budgetCheckedBatches, budgetFailedIds, address,
      );

      // Split any campaign batch with >50 claims into ≤50-claim sub-batches
      // BEFORE attestation so each sub-batch gets its own correctly-scoped signature.
      // (Contract: require(claims.length <= 50, "E28"))
      const MAX_CLAIMS_PER_BATCH = 50;
      const flatBatches: SerializedClaimBatch[] = [];
      for (const b of budgetCheckedBatches) {
        if (b.claims.length <= MAX_CLAIMS_PER_BATCH) {
          flatBatches.push(b);
        } else {
          for (let j = 0; j < b.claims.length; j += MAX_CLAIMS_PER_BATCH) {
            flatBatches.push({ ...b, claims: b.claims.slice(j, j + MAX_CLAIMS_PER_BATCH) });
          }
        }
      }

      if (flatBatches.length === 0) {
        const discardNote = autoDiscarded.length > 0
          ? ` Dead claims for campaign${autoDiscarded.length > 1 ? "s" : ""} ${autoDiscarded.join(", ")} have been discarded.`
          : " Use Discard to remove these claims.";
        setError(`All campaigns have insufficient remaining budget.${discardNote}`);
        if (autoDiscarded.length > 0) await loadState();
        return;
      }

      // Request publisher attestation for each (sub-)batch.
      // Each sub-batch gets its own EIP-712 sig covering its firstNonce/lastNonce/claimCount.
      const warnings: Record<string, string> = {};
      const attestedBatches = await Promise.all(flatBatches.map(async (b) => {
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
          if (attestResponse?.error) warnings[b.campaignId] = attestResponse.error;
        } catch {
          // Attestation unavailable — degraded trust mode (open campaigns)
        }
        return {
          user: b.user,
          campaignId: BigInt(b.campaignId),
          claims: b.claims.map((c) => ({
            campaignId: BigInt(c.campaignId),
            publisher: c.publisher,
            eventCount: BigInt(c.eventCount),
            ratePlanck: BigInt(c.ratePlanck),
            actionType: Number(c.actionType),
            clickSessionHash: c.clickSessionHash,
            nonce: BigInt(c.nonce),
            previousClaimHash: c.previousClaimHash,
            claimHash: c.claimHash,
            zkProof: c.zkProof,
            nullifier: c.nullifier,
            actionSig: c.actionSig,
          })),
          publisherSig,
        };
      }));
      if (Object.keys(warnings).length > 0) setAttestationWarnings(warnings);

      const attestationVerifier = getAttestationVerifierContract(settings.contractAddresses, signer);

      // Build tx chunks: ≤10 campaign batches per tx, no duplicate campaignId in one tx
      // (split sub-batches for the same campaign must go into separate sequential txs).
      const BATCH_CHUNK = 10;
      const txChunks: (typeof attestedBatches)[] = [];
      let curChunk: typeof attestedBatches = [];
      const curCampaigns = new Set<string>();
      for (const b of attestedBatches) {
        const cid = b.campaignId.toString();
        if (curChunk.length >= BATCH_CHUNK || curCampaigns.has(cid)) {
          txChunks.push(curChunk);
          curChunk = [];
          curCampaigns.clear();
        }
        curChunk.push(b);
        curCampaigns.add(cid);
      }
      if (curChunk.length > 0) txChunks.push(curChunk);

      let settledCount = 0n;
      let rejectedCount = 0n;
      let totalPaid = 0n;
      const allSettledBatches: typeof attestedBatches = [];

      const provider = signer.provider!;
      for (const chunk of txChunks) {
        const nonceBefore = await provider.getTransactionCount(signerAddr);
        const tx = await attestationVerifier.settleClaimsAttested(chunk, { gasLimit: 500_000_000n, type: 0, gasPrice: 1_000_000_000_000n });
        // Paseo: tx.wait() polls getTransactionReceipt which always returns null.
        // Use nonce polling instead; treat null receipt as optimistic confirmation.
        const receipt = await waitForTxPaseo(provider, signerAddr, nonceBefore);

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
        } else {
          // Paseo: no receipt — optimistically count all submitted claims as settled
          settledCount += BigInt(chunk.reduce((n, b) => n + b.claims.length, 0));
        }
        allSettledBatches.push(...chunk);
      }

      const settlementResult: SettlementResult = { settledCount, rejectedCount, totalPaid };
      setResult(settlementResult);

      // Remove settled claims from queue
      if (settledCount > 0) {
        // Build map of campaignId → settled nonces from the attested batches
        const settledNonces: Record<string, string[]> = {};
        for (const b of allSettledBatches) {
          const cid = b.campaignId.toString();
          settledNonces[cid] = b.claims.map((c) => c.nonce.toString());
        }
        await chrome.runtime.sendMessage({
          type: "REMOVE_SETTLED_CLAIMS",
          userAddress: address,
          settledNonces,
        });
        await loadState();
        onSettled?.();
      }

      // Handle nonce mismatch: if all claims were rejected, try to re-sync from chain
      if (settledCount === 0n && rejectedCount > 0n) {
        await resyncFromChain(address, settings, allSettledBatches);
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
              eventCount: BigInt(c.eventCount),
              ratePlanck: BigInt(c.ratePlanck),
              actionType: Number(c.actionType),
              clickSessionHash: c.clickSessionHash,
              nonce: BigInt(c.nonce),
              previousClaimHash: c.previousClaimHash,
              claimHash: c.claimHash,
              zkProof: c.zkProof,
              nullifier: c.nullifier,
              actionSig: c.actionSig,
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

  async function submitCampaign(campaignId: string) {
    if (!address) return;
    setError(null);
    setResult(null);
    setAttestationWarnings({});

    const mutexResponse = await chrome.runtime.sendMessage({ type: "ACQUIRE_MUTEX" });
    if (!mutexResponse?.acquired) {
      setError("A submission is already in progress. Please wait.");
      return;
    }

    setSubmittingCampaign(campaignId);
    try {
      const settings = await getSettings();
      if (!settings.contractAddresses.attestationVerifier) {
        throw new Error("AttestationVerifier contract address not configured. Check Settings.");
      }

      // Demo fast path: daemon uses pre-funded relay wallet.
      try {
        const daemonResp = await chrome.runtime.sendMessage({
          type: "DAEMON_SUBMIT_CLAIMS",
          userAddress: address,
        });
        if (daemonResp?.ok) {
          const settled = BigInt(daemonResp.settledCount ?? 0);
          setResult({ settledCount: settled, rejectedCount: 0n, totalPaid: 0n });
          if (settled > 0) { await loadState(); onSettled?.(); }
          return;
        }
      } catch { /* fall through to user wallet */ }

      const signer = getSigner(settings.rpcUrl);
      const signerAddr: string = signer.address;

      const batchResponse = await chrome.runtime.sendMessage({
        type: "SUBMIT_CAMPAIGN_CLAIMS",
        userAddress: address,
        campaignId,
      });

      const serializedBatch: SerializedClaimBatch | null = batchResponse?.batch ?? null;
      if (!serializedBatch) {
        setError("No pending claims for this campaign.");
        return;
      }

      // Budget check: fetch on-chain remaining budget and truncate claims.
      let budgetMap: Record<string, bigint>;
      let budgetFailedIds: Set<string>;
      try {
        ({ budgetMap, failedIds: budgetFailedIds } = await fetchOnChainBudgets(
          [serializedBatch.campaignId], settings,
        ));
      } catch (budgetErr) {
        throw new Error(`Could not verify campaign budget on-chain: ${String(budgetErr)}`);
      }
      const [trimmed] = applyBudgetFilter([serializedBatch], budgetMap);
      if (!trimmed) {
        // Auto-discard if budget is confirmed 0 on-chain (not just RPC flakiness)
        if (!budgetFailedIds.has(serializedBatch.campaignId)) {
          try {
            await chrome.runtime.sendMessage({
              type: "DISCARD_CAMPAIGN_CLAIMS",
              userAddress: address,
              campaignId: serializedBatch.campaignId,
            });
            await loadState();
            setError(`Campaign #${serializedBatch.campaignId} budget exhausted — claims discarded.`);
          } catch {
            setError("Campaign has insufficient remaining budget. Use Discard to remove these claims.");
          }
        } else {
          setError("Campaign has insufficient remaining budget (could not reach chain to confirm).");
        }
        return;
      }
      const trimmedBatch: SerializedClaimBatch = trimmed;

      // Request publisher attestation (use trimmedBatch — may have fewer claims than original)
      const claimsLen = trimmedBatch.claims.length;
      let publisherSig = "0x";
      try {
        const attestResponse = await chrome.runtime.sendMessage({
          type: "REQUEST_PUBLISHER_ATTESTATION",
          publisherAddress: trimmedBatch.claims[0]?.publisher ?? "",
          campaignId: trimmedBatch.campaignId,
          userAddress: trimmedBatch.user,
          firstNonce: trimmedBatch.claims[0].nonce,
          lastNonce: trimmedBatch.claims[claimsLen - 1].nonce,
          claimCount: claimsLen,
        });
        if (attestResponse?.signature) publisherSig = attestResponse.signature;
        if (attestResponse?.error) setAttestationWarnings({ [campaignId]: attestResponse.error });
      } catch {
        // Attestation unavailable — degraded trust mode
      }

      const attestedBatch = {
        user: trimmedBatch.user,
        campaignId: BigInt(trimmedBatch.campaignId),
        claims: trimmedBatch.claims.map((c) => ({
          campaignId: BigInt(c.campaignId),
          publisher: c.publisher,
          eventCount: BigInt(c.eventCount),
          ratePlanck: BigInt(c.ratePlanck),
          actionType: Number(c.actionType),
          clickSessionHash: c.clickSessionHash,
          nonce: BigInt(c.nonce),
          previousClaimHash: c.previousClaimHash,
          claimHash: c.claimHash,
          zkProof: c.zkProof,
          nullifier: c.nullifier,
          actionSig: c.actionSig,
        })),
        publisherSig,
      };

      const attestationVerifier = getAttestationVerifierContract(settings.contractAddresses, signer);
      const provider = signer.provider!;
      const nonceBefore = await provider.getTransactionCount(signerAddr);
      await attestationVerifier.settleClaimsAttested([attestedBatch], { gasLimit: 500_000_000n, type: 0, gasPrice: 1_000_000_000_000n });
      // Paseo: tx.wait() polls getTransactionReceipt which always returns null — use nonce polling.
      const receipt = await waitForTxPaseo(provider, signerAddr, nonceBefore);

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
            // log from a different contract
          }
        }
      } else {
        // Paseo: no receipt — optimistically count all submitted claims as settled
        settledCount = BigInt(attestedBatch.claims.length);
      }

      setResult({ settledCount, rejectedCount, totalPaid });

      if (settledCount > 0) {
        const settledNonces: Record<string, string[]> = {
          [attestedBatch.campaignId.toString()]: attestedBatch.claims.map((c) => c.nonce.toString()),
        };
        await chrome.runtime.sendMessage({
          type: "REMOVE_SETTLED_CLAIMS",
          userAddress: address,
          settledNonces,
        });
        await loadState();
        onSettled?.();
      }

      if (settledCount === 0n && rejectedCount > 0n) {
        await resyncFromChain(address, settings, [attestedBatch]);
        setError("Claims rejected — chain state resynced. Try submitting again.");
      }
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setSubmittingCampaign(null);
      await chrome.runtime.sendMessage({ type: "RELEASE_MUTEX" });
    }
  }

  async function discardCampaign(campaignId: string) {
    if (!address) return;
    setError(null);
    setDiscardingCampaign(campaignId);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "DISCARD_CAMPAIGN_CLAIMS",
        userAddress: address,
        campaignId,
      });
      if (response?.removed > 0) {
        await loadState();
      }
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setDiscardingCampaign(null);
    }
  }

  async function signForRelay() {
    if (!address) return;
    setSigning(true);
    setError(null);
    setSignedCount(null);
    setAttestationWarnings({});

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

      // In aggregated/demo mode, raw impressions need to be built into hashed claims first.
      await chrome.runtime.sendMessage({ type: "DRAIN_CLAIMS_ONLY" }).catch(() => null);

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
      const warnings: Record<string, string> = {};
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
          if (attestResponse?.error) warnings[b.campaignId] = attestResponse.error;
        } catch {
          // Attestation unavailable — degraded trust mode
        }

        signedBatches.push({
          user: b.user,
          campaignId: b.campaignId,
          claims: b.claims,
          deadline,
          userSig: signature,
          publisherSig,
          advertiserSig: "0x",
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
          // BM-3: Solve PoW challenge before submission
          const pow = await solvePoWChallenge(relayUrl);
          await fetch(`${relayUrl}/relay/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ batches, ...pow }),
            signal: AbortSignal.timeout(15000),
          });
          console.log(`[DATUM] POSTed ${batches.length} batch(es) to ${relayUrl}`);
        } catch (err) {
          console.warn(`[DATUM] Relay POST failed for ${relayUrl}:`, err);
          // Non-fatal — batches are stored locally and can be retried
        }
      }

      if (Object.keys(warnings).length > 0) setAttestationWarnings(warnings);
      setSignedCount(signedBatches.length);

      // Remove signed claims from local queue — relay holds them now
      if (signedBatches.length > 0) {
        const settledNonces: Record<string, string[]> = {};
        for (const b of signedBatches) {
          const cid = String(b.campaignId);
          settledNonces[cid] = b.claims.map((c: any) => String(c.nonce));
        }
        await chrome.runtime.sendMessage({
          type: "REMOVE_SETTLED_CLAIMS",
          userAddress: address,
          settledNonces,
        });
        await loadState();
        onSettled?.();
      }
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
  const rawQueueDepth = queueState?.rawQueueDepth ?? 0;
  const userClaims = address ? queueState?.byUser?.[address] : null;
  // Total impression count across all campaigns for this user
  const totalImpressions = userClaims ? Object.values(userClaims).reduce((a, b) => a + b, 0) : 0;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: "var(--accent)", fontWeight: 600 }}>Pending Claims</span>
        {totalImpressions > 0 && (
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {totalImpressions} impression{totalImpressions !== 1 ? "s" : ""}
            {rawQueueDepth > 0 && <span style={{ color: "var(--text-muted)", opacity: 0.7 }}> (buffered)</span>}
          </span>
        )}
      </div>

      {pendingCount === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
          No pending claims. Browse pages to earn {sym}.
        </div>
      ) : (
        <>
          {userClaims && Object.entries(userClaims).map(([cid, count]) => {
            const meta = campaigns[cid];
            const estPlanck = meta
              ? (BigInt(meta.viewBid) * BigInt(count) * 7500n) / (1000n * 10000n)
              : null;
            const anyBusy = submitting || signing || submittingCampaign !== null || discardingCampaign !== null;
            return (
              <div key={cid} style={claimRowStyle}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--accent)" }}>Campaign #{cid}</span>
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {count} impression{count !== 1 ? "s" : ""}
                  </span>
                </div>
                {estPlanck !== null && (
                  <div style={{ color: "var(--ok)", fontSize: 11, marginTop: 2 }}>
                    ~{formatDOT(estPlanck)} {sym} est. earnings
                  </div>
                )}
                {address && (
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <button
                      onClick={() => submitCampaign(cid)}
                      disabled={anyBusy}
                      style={campaignBtn}
                    >
                      {submittingCampaign === cid ? <BouncingText text="Submitting claims..." /> : "Submit"}
                    </button>
                    <button
                      onClick={() => discardCampaign(cid)}
                      disabled={anyBusy}
                      style={campaignDiscardBtn}
                    >
                      {discardingCampaign === cid ? "Discarding…" : "Discard"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {address ? (
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexDirection: "column" }}>
              <button
                onClick={submitAll}
                disabled={submitting || signing || submittingCampaign !== null || discardingCampaign !== null}
                style={primaryBtn}
              >
                {submitting ? <BouncingText text="Submitting claims..." /> : "Submit All (you pay gas)"}
              </button>
              <button
                onClick={signForRelay}
                disabled={submitting || signing || submittingCampaign !== null || discardingCampaign !== null}
                style={secondaryBtn}
              >
                {signing ? <BouncingText text="Signing claims..." /> : "Sign for Publisher (zero gas)"}
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
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>
              Connect wallet to submit claims.
            </div>
          )}
        </>
      )}

      {result && (
        <div style={{ marginTop: 12, padding: 10, background: "rgba(110,231,183,0.08)", border: "1px solid rgba(110,231,183,0.2)", borderRadius: "var(--radius-sm)", fontSize: 13 }}>
          <div style={{ color: "var(--ok)" }}>
            ✓ Settled: {result.settledCount.toString()} · Rejected: {result.rejectedCount.toString()}
          </div>
          {result.totalPaid > 0n && (
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>
              Total paid: {formatDOT(result.totalPaid)} {sym}
            </div>
          )}
        </div>
      )}

      {signedCount !== null && (
        <div style={{ marginTop: 12, padding: 10, background: "rgba(160,160,255,0.08)", border: "1px solid rgba(160,160,255,0.2)", borderRadius: "var(--radius-sm)", fontSize: 13, color: "var(--accent)" }}>
          ✓ Signed {signedCount} batch{signedCount !== 1 ? "es" : ""} for publisher relay.
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
            The publisher will submit these on your behalf.
          </div>
          <AttestationBadges />
        </div>
      )}

      {importResult && !importResult.error && (
        <div style={{ marginTop: 12, padding: 10, background: "rgba(110,231,183,0.08)", border: "1px solid rgba(110,231,183,0.2)", borderRadius: "var(--radius-sm)", fontSize: 13, color: "var(--ok)" }}>
          Import complete: {importResult.chainsImported} chain{importResult.chainsImported !== 1 ? "s" : ""}, {importResult.claimsImported} claim{importResult.claimsImported !== 1 ? "s" : ""} imported
          {importResult.skippedStale > 0 && (
            <span style={{ color: "var(--text-muted)" }}> ({importResult.skippedStale} skipped — already settled)</span>
          )}
        </div>
      )}

      {/* PU-3: Attestation warnings */}
      {Object.keys(attestationWarnings).length > 0 && (
        <div style={{ marginTop: 12, padding: 10, background: "rgba(252,211,77,0.07)", borderRadius: "var(--radius-sm)", border: "1px solid rgba(252,211,77,0.2)", fontSize: 12 }}>
          <div style={{ color: "var(--warn)", fontWeight: 600, marginBottom: 4 }}>Attestation warnings:</div>
          {Object.entries(attestationWarnings).map(([cid, reason]) => (
            <div key={cid} style={{ color: "var(--warn)", marginTop: 2 }}>
              Campaign #{cid}: {reason}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 8, padding: 8, background: "rgba(252,165,165,0.08)", border: "1px solid rgba(252,165,165,0.2)", borderRadius: "var(--radius-sm)", color: "var(--error)", fontSize: 12 }}>
          {error}
        </div>
      )}

      {autoFlushResult && (
        <div style={{ marginTop: 12, padding: 8, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: 11 }}>
          <span style={{ color: "var(--text-muted)" }}>Auto-submit </span>
          {autoFlushResult.error ? (
            <span style={{ color: "var(--error)" }}>failed: {autoFlushResult.error.slice(0, 80)}</span>
          ) : (
            <span style={{ color: "var(--ok)" }}>
              ✓ {autoFlushResult.settledCount} settled · {autoFlushResult.rejectedCount} rejected
            </span>
          )}
          <span style={{ color: "rgba(255,255,255,0.2)", marginLeft: 6 }}>
            {new Date(autoFlushResult.timestamp).toLocaleTimeString()}
          </span>
        </div>
      )}

      {/* CL-2: Stale claims pruned notification */}
      {stalePruned > 0 && (
        <div style={{ marginTop: 8, padding: 8, background: "rgba(252,211,77,0.07)", border: "1px solid rgba(252,211,77,0.2)", borderRadius: "var(--radius-sm)", fontSize: 11, color: "var(--warn)" }}>
          {stalePruned} claim{stalePruned !== 1 ? "s" : ""} pruned — already settled on-chain (publisher relay or external submission).
        </div>
      )}

      {queueState?.lastFlush && (
        <div style={{ marginTop: 4, color: "rgba(255,255,255,0.2)", fontSize: 11 }}>
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
            <span style={{ color: "var(--text-muted)" }}>Campaign #{b.campaignId}</span>
            <span
              style={{
                padding: "1px 6px",
                borderRadius: 3,
                fontSize: 10,
                fontWeight: 600,
                background: attested ? "rgba(110,231,183,0.08)" : "rgba(252,211,77,0.07)",
                color: attested ? "var(--ok)" : "var(--warn)",
                border: `1px solid ${attested ? "rgba(110,231,183,0.2)" : "rgba(252,211,77,0.2)"}`,
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
// Syncs when on-chain nonce > local nonce (external settlement), OR when nonces match but
// hashes differ (local chain state was built from a wrong base after a reset).
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
      const localHash: string = localStates[localKey]?.lastClaimHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000";

      const onChainNonce = Number(await settlement.lastNonce(userAddress, BigInt(cid)));
      if (onChainNonce > localNonce) {
        // On-chain nonce advanced beyond local state — claims settled externally or daemon stale
        const onChainHash = await settlement.lastClaimHash(userAddress, BigInt(cid));
        await chrome.runtime.sendMessage({
          type: "SYNC_CHAIN_STATE",
          userAddress,
          campaignId: cid,
          onChainNonce,
          onChainHash: String(onChainHash),
        });
        // Remove any queued claims with nonce ≤ on-chain nonce (they are already settled)
        await chrome.runtime.sendMessage({
          type: "PRUNE_SETTLED_UP_TO_NONCE",
          userAddress,
          campaignId: cid,
          upToNonce: onChainNonce,
        });
      } else if (onChainNonce === localNonce && onChainNonce > 0) {
        // Nonces match — also verify hashes. If they differ, local claims were built from
        // a wrong base (e.g. after a chain-state reset) and will revert on submission.
        const onChainHash = await settlement.lastClaimHash(userAddress, BigInt(cid));
        if (String(onChainHash).toLowerCase() !== localHash.toLowerCase()) {
          await chrome.runtime.sendMessage({
            type: "SYNC_CHAIN_STATE",
            userAddress,
            campaignId: cid,
            onChainNonce,
            onChainHash: String(onChainHash),
          });
        }
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
  background: "var(--bg-raised)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  marginBottom: 6,
  fontSize: 13,
};

const primaryBtn: React.CSSProperties = {
  background: "rgba(160,160,255,0.1)",
  color: "var(--accent)",
  border: "1px solid rgba(160,160,255,0.3)",
  borderRadius: "var(--radius-sm)",
  padding: "8px 14px",
  fontSize: 13,
  cursor: "pointer",
  width: "100%",
  fontFamily: "inherit",
  fontWeight: 500,
};

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "var(--bg-raised)",
  color: "var(--ok)",
  border: "1px solid rgba(110,231,183,0.2)",
};

const portabilityBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "var(--bg-raised)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  padding: "6px 10px",
  fontSize: 11,
};

const campaignBtn: React.CSSProperties = {
  background: "rgba(160,160,255,0.08)",
  color: "var(--accent)",
  border: "1px solid rgba(160,160,255,0.2)",
  borderRadius: "var(--radius-sm)",
  padding: "3px 10px",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "inherit",
};

const campaignDiscardBtn: React.CSSProperties = {
  background: "var(--bg-raised)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  padding: "3px 10px",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "inherit",
};
