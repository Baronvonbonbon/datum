// Offscreen document for auto-submit signing.
// This page has DOM access so wallet extensions can inject window.ethereum.
// Background sends OFFSCREEN_SUBMIT → we sign + submit → reply OFFSCREEN_SUBMIT_RESULT.

import { BrowserProvider, Eip1193Provider } from "ethers";
import { getSettlementContract } from "@shared/contracts";
import { BackgroundToOffscreen, OffscreenToBackground } from "@shared/messages";

declare global {
  interface Window {
    ethereum?: unknown;
  }
}

chrome.runtime.onMessage.addListener(
  (msg: BackgroundToOffscreen, _sender, sendResponse) => {
    if (msg.type !== "OFFSCREEN_SUBMIT") return false;
    handleSubmit(msg).then(sendResponse).catch((err) => {
      sendResponse({ type: "OFFSCREEN_SUBMIT_RESULT", settledCount: 0, rejectedCount: 0, error: String(err) });
    });
    return true; // async
  }
);

async function handleSubmit(msg: BackgroundToOffscreen): Promise<OffscreenToBackground> {
  if (!window.ethereum) {
    return {
      type: "OFFSCREEN_SUBMIT_RESULT",
      settledCount: 0,
      rejectedCount: 0,
      error: "No EIP-1193 provider in offscreen context. Wallet extension may not inject here.",
    };
  }

  const provider = new BrowserProvider(window.ethereum as Eip1193Provider);

  // Check if provider has accounts available (wallet must already be connected)
  let accounts: string[];
  try {
    accounts = await provider.send("eth_accounts", []);
  } catch {
    accounts = [];
  }
  if (accounts.length === 0) {
    return {
      type: "OFFSCREEN_SUBMIT_RESULT",
      settledCount: 0,
      rejectedCount: 0,
      error: "No accounts available in offscreen context. User must connect wallet via popup first.",
    };
  }

  const signer = await provider.getSigner(msg.userAddress);
  const settlement = getSettlementContract(msg.contractAddresses, signer);

  // Deserialize batches (bigints arrive as strings)
  const contractBatches = msg.batches.map((b) => ({
    user: b.user,
    campaignId: BigInt(b.campaignId),
    claims: b.claims.map((c) => ({
      campaignId: BigInt(c.campaignId),
      publisher: c.publisher,
      eventCount: BigInt(c.eventCount),
      ratePlanck: BigInt(c.ratePlanck),
      actionType: Number(c.actionType ?? 0),
      clickSessionHash: c.clickSessionHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
      nonce: BigInt(c.nonce),
      previousClaimHash: c.previousClaimHash,
      claimHash: c.claimHash,
      zkProof: c.zkProof,
      nullifier: c.nullifier,
      actionSig: c.actionSig ?? "0x",
    })),
  }));

  let settledCount = 0;
  let rejectedCount = 0;
  const rejectedCampaignIds = new Set<string>();

  try {
    const signerAddress = await signer.getAddress();
    const nonceBeforeTx = await provider.getTransactionCount(signerAddress);
    console.log(`[DATUM offscreen] settleClaims: signer=${signerAddress.slice(0, 10)}… nonceBefore=${nonceBeforeTx} batches=${contractBatches.length}`);

    // Paseo pallet-revive: explicit gas opts required (eth_estimateGas returns null revert data)
    await settlement.settleClaims(contractBatches, {
      gasLimit: 500_000_000n,
      type: 0,
      gasPrice: 1_000_000_000_000n,
    });

    // Nonce poll — Paseo getTransactionReceipt returns null for confirmed txs
    for (let i = 0; i < 60; i++) {
      const current = await provider.getTransactionCount(signerAddress);
      if (current > nonceBeforeTx) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Verify on-chain lastNonce per (campaign, actionType) to determine what settled
    const settledNonces: Record<string, string[]> = {};
    for (const b of contractBatches) {
      const cid = b.campaignId.toString();
      settledNonces[cid] = settledNonces[cid] ?? [];

      // Group claims by actionType — each has its own nonce chain
      const byActionType = new Map<number, typeof b.claims>();
      for (const c of b.claims) {
        const arr = byActionType.get(c.actionType) ?? [];
        arr.push(c);
        byActionType.set(c.actionType, arr);
      }

      for (const [actionType, claims] of byActionType) {
        const sortedClaims = claims.sort((a, z) => (a.nonce < z.nonce ? -1 : 1));
        try {
          const onChainNonce: bigint = await settlement.lastNonce(b.user, b.campaignId, actionType);
          console.log(`[DATUM offscreen] campaign=${cid} actionType=${actionType} on-chain nonce=${onChainNonce}`);
          if (onChainNonce >= sortedClaims[0].nonce) {
            const count = Number(onChainNonce - sortedClaims[0].nonce + 1n);
            const settled = sortedClaims.slice(0, count);
            settledNonces[cid].push(...settled.map((c) => c.nonce.toString()));
            settledCount += settled.length;
            if (count < sortedClaims.length) {
              rejectedCampaignIds.add(cid);
              rejectedCount += sortedClaims.length - count;
            }
          } else {
            rejectedCampaignIds.add(cid);
            rejectedCount += sortedClaims.length;
          }
        } catch {
          // RPC error — optimistically treat as settled
          settledNonces[cid].push(...sortedClaims.map((c) => c.nonce.toString()));
          settledCount += sortedClaims.length;
        }
      }
    }

    if (settledCount > 0) {
      await chrome.runtime.sendMessage({
        type: "REMOVE_SETTLED_CLAIMS",
        userAddress: msg.userAddress,
        settledNonces,
      });
    }

    if (rejectedCampaignIds.size > 0) {
      await chrome.runtime.sendMessage({
        type: "DISCARD_REJECTED_CLAIMS",
        userAddress: msg.userAddress,
        campaignIds: Array.from(rejectedCampaignIds),
      });
    }

    return { type: "OFFSCREEN_SUBMIT_RESULT", settledCount, rejectedCount };
  } catch (err) {
    return {
      type: "OFFSCREEN_SUBMIT_RESULT",
      settledCount: 0,
      rejectedCount: 0,
      error: String(err),
    };
  }
}
