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
      impressionCount: BigInt(c.impressionCount),
      clearingCpmPlanck: BigInt(c.clearingCpmPlanck),
      nonce: BigInt(c.nonce),
      previousClaimHash: c.previousClaimHash,
      claimHash: c.claimHash,
      zkProof: c.zkProof,
      nullifier: c.nullifier,
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

    // Verify on-chain lastNonce per campaign to determine what settled
    const settledNonces: Record<string, string[]> = {};
    for (const b of contractBatches) {
      const cid = b.campaignId.toString();
      try {
        const onChainNonce: bigint = await settlement.lastNonce(b.user, b.campaignId);
        console.log(`[DATUM offscreen] campaign=${cid} on-chain nonce=${onChainNonce}, batch first=${b.claims[0].nonce} last=${b.claims[b.claims.length - 1].nonce}`);
        if (onChainNonce >= b.claims[0].nonce) {
          const count = Number(onChainNonce - b.claims[0].nonce + 1n);
          const settled = b.claims.slice(0, count);
          settledNonces[cid] = settled.map((c) => c.nonce.toString());
          settledCount += settled.length;
          if (count < b.claims.length) {
            // Partial — remaining claims rejected
            rejectedCampaignIds.add(cid);
            rejectedCount += b.claims.length - count;
          }
        } else {
          // Nothing settled
          rejectedCampaignIds.add(cid);
          rejectedCount += b.claims.length;
        }
      } catch {
        // RPC error — optimistically treat as settled
        settledNonces[cid] = b.claims.map((c) => c.nonce.toString());
        settledCount += b.claims.length;
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
