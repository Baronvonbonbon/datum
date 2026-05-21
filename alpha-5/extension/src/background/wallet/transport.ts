// Background-side transport for wallet ops.
//
// Sends WALLET_* messages to the offscreen document and resolves the
// matching WALLET_RESULT envelope into a typed Promise. All other
// wallet modules (unlock.ts, signing.ts, accounts UI handlers) go
// through this single function so the offscreen IPC shape is in one
// place.
//
// Reuses the same offscreen-document lifecycle as pineBridge — calling
// `ensurePineReady` ensures the doc exists. We don't need pine to be
// connected for wallet ops, but the offscreen doc has to be alive.

import type { BackgroundToOffscreen, OffscreenToBackground } from "@shared/messages";
import { ensurePineReady } from "../pineBridge";

/// Distributive Omit so Omit<Union, K> preserves the per-branch
/// property sets. Without this, TS collapses to the intersection of
/// branches' keys and rejects every non-shared field.
type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

type WalletMsg = Extract<BackgroundToOffscreen, { type: `WALLET_${string}` }>;

/// Send a WALLET_* op to the offscreen wallet and resolve the
/// `payload` field of the reply. Rejects when `ok` is false.
export async function walletRpc<TPayload>(
  msg: DistributiveOmit<WalletMsg, "requestId">
): Promise<TPayload> {
  await ensureOffscreenAlive();
  const requestId = newRequestId();
  const fullMsg = { ...msg, requestId } as BackgroundToOffscreen;
  const reply = await sendToOffscreen(fullMsg);
  if (!reply || reply.type !== "WALLET_RESULT") {
    throw new Error(`walletRpc(${msg.type}): missing or malformed reply`);
  }
  if (!reply.ok) {
    const err = new Error(reply.error ?? "wallet op failed") as Error & {
      walletErrorCode?: string;
    };
    err.walletErrorCode = reply.error;
    throw err;
  }
  return reply.payload as TPayload;
}

// ─── Internals ────────────────────────────────────────────────────────

/// Reuses pineBridge's offscreen-document-creation path. The offscreen
/// doc is shared across pine + wallet + the existing OFFSCREEN_SUBMIT
/// flow; one document instance handles all three.
async function ensureOffscreenAlive(): Promise<void> {
  // We don't need pine to be _connected_ before we can sign — wallet
  // ops are entirely local. But the offscreen document must exist.
  // ensurePineReady triggers offscreen creation; if pine later fails
  // to connect it doesn't break wallet ops.
  await ensurePineReady().catch(() => {
    // Swallow pine connection errors here — wallet doesn't need pine.
    // pineBridge surfaces the connection error via PINE_STATUS for
    // any UI that cares.
  });
}

function sendToOffscreen(
  msg: BackgroundToOffscreen
): Promise<OffscreenToBackground | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(reply);
    });
  });
}

let _reqCounter = 0;
function newRequestId(): string {
  _reqCounter = (_reqCounter + 1) | 0;
  return `wallet-${Date.now()}-${_reqCounter}`;
}

export const __test = {
  reset(): void {
    _reqCounter = 0;
  },
};
