// Offscreen document for auto-submit signing.
// This page has DOM access so wallet extensions can inject window.ethereum.
// Background sends OFFSCREEN_SUBMIT → we sign + submit → reply OFFSCREEN_SUBMIT_RESULT.

import { BrowserProvider, Eip1193Provider } from "ethers";
import { getSettlementContract } from "@shared/contracts";
import { BackgroundToOffscreen, OffscreenToBackground } from "@shared/messages";
import { handlePineMessage } from "./smoldot";
import { handleWalletMessage } from "./wallet-dispatch";

declare global {
  interface Window {
    ethereum?: unknown;
  }
}

// Single multiplexer for every message the background sends to this
// offscreen doc. New message families dispatch from here.
//
// Convention: each handler returns the full OffscreenToBackground reply.
// Synchronous returns are wrapped in Promise.resolve so the listener
// branch is uniform.
chrome.runtime.onMessage.addListener(
  (msg: BackgroundToOffscreen, _sender, sendResponse) => {
    switch (msg.type) {
      case "OFFSCREEN_SUBMIT": {
        const submitMsg = msg; // narrowed by the case guard
        handleSubmit(submitMsg).then(sendResponse).catch((err) => {
          sendResponse({ type: "OFFSCREEN_SUBMIT_RESULT", settledCount: 0, rejectedCount: 0, error: String(err) });
        });
        return true; // async
      }
      case "WALLET_CREATE":
      case "WALLET_IMPORT":
      case "WALLET_UNLOCK":
      case "WALLET_LOCK":
      case "WALLET_IS_UNLOCKED":
      case "WALLET_ADD_HD_ACCOUNT":
      case "WALLET_ADD_IMPORTED":
      case "WALLET_SET_ACTIVE":
      case "WALLET_REENCRYPT":
      case "WALLET_SIGN_TRANSACTION":
      case "WALLET_SIGN_TYPED_DATA":
      case "WALLET_PERSONAL_SIGN": {
        // Wallet ops follow a uniform { ok, payload?, error? } envelope so
        // background's orchestrator can correlate by requestId and either
        // resolve or reject the corresponding Promise cleanly.
        handleWalletMessage(msg).then(sendResponse).catch((err) => {
          sendResponse({
            type: "WALLET_RESULT",
            requestId: msg.requestId,
            ok: false,
            error: String(err?.message ?? err),
          });
        });
        return true; // async
      }
      case "PINE_INIT":
      case "PINE_RPC_REQUEST":
      case "PINE_STATUS_SUBSCRIBE": {
        handlePineMessage(msg).then(sendResponse).catch((err) => {
          // Pine errors return as PINE_RPC_RESULT with an error payload so
          // the background bridge can route them back to the original caller.
          if (msg.type === "PINE_RPC_REQUEST") {
            sendResponse({
              type: "PINE_RPC_RESULT",
              requestId: msg.requestId,
              error: { code: -32603, message: String(err) },
            });
          } else {
            // PINE_INIT / PINE_STATUS_SUBSCRIBE don't have a requestId; just
            // log. Status broadcasts continue independently.
            console.error("[offscreen] pine handler error", err);
            sendResponse(undefined);
          }
        });
        return true; // async
      }
      default:
        return false;
    }
  }
);

// Narrow BackgroundToOffscreen down to the OFFSCREEN_SUBMIT variant.
type OffscreenSubmitMsg = Extract<BackgroundToOffscreen, { type: "OFFSCREEN_SUBMIT" }>;

async function handleSubmit(msg: OffscreenSubmitMsg): Promise<OffscreenToBackground> {
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
      zkProof: Array.isArray(c.zkProof) ? c.zkProof : new Array(8).fill("0x" + "00".repeat(32)),
      nullifier: c.nullifier,
      actionSig: Array.isArray(c.actionSig) ? c.actionSig : ["0x" + "00".repeat(32), "0x" + "00".repeat(32), "0x" + "00".repeat(32)],
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
