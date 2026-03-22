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
    })),
  }));

  let settledCount = 0;
  let rejectedCount = 0;

  try {
    const tx = await settlement.settleClaims(contractBatches);
    const receipt = await tx.wait();

    if (receipt?.logs) {
      const iface = settlement.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === "ClaimSettled") settledCount++;
          else if (parsed?.name === "ClaimRejected") rejectedCount++;
        } catch {
          // log from different contract
        }
      }
    }

    // Ask background to remove settled claims
    if (settledCount > 0) {
      const settledNonces: Record<string, string[]> = {};
      for (const b of contractBatches) {
        const cid = b.campaignId.toString();
        settledNonces[cid] = b.claims.map((c) => c.nonce.toString());
      }
      await chrome.runtime.sendMessage({
        type: "REMOVE_SETTLED_CLAIMS",
        userAddress: msg.userAddress,
        settledNonces,
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
