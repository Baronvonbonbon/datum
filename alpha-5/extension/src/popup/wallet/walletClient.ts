// Popup-side wallet client.
//
// Thin typed wrapper over chrome.runtime.sendMessage. React components
// call `walletClient.createWallet(...)` etc. and get back a Promise
// resolved with the per-op return shape. The wire format is a single
// WALLET_RPC_REQUEST envelope; we correlate by requestId.
//
// Per-op return shapes mirror the functions in
// background/wallet/{unlock,signing,rpcDispatcher}.ts. Keep this table
// in sync with that dispatcher.

import type {
  WalletRpcOp,
  WalletRpcResponse,
} from "@shared/messages";
import type { AccountMeta } from "../../background/wallet/accounts";
import type { WalletStatus } from "../../background/wallet/unlock";

/// Return shape for `sendNative` — used by SendTab to render the
/// "submitted, awaiting confirmation" state.
export type SendNativeResult = { txHash: string; nonce: number };

/// Build a typed call into the dispatcher. The result type is op-
/// dependent and provided by the caller via the generic.
async function call<T>(op: WalletRpcOp, args?: unknown): Promise<T> {
  const requestId = newRequestId();
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "WALLET_RPC_REQUEST", requestId, op, args },
      (reply: WalletRpcResponse | undefined) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          reject(new Error(lastErr.message));
          return;
        }
        if (!reply || reply.type !== "WALLET_RPC_RESPONSE") {
          reject(new Error(`walletClient(${op}): malformed reply`));
          return;
        }
        if (!reply.ok) {
          reject(new Error(reply.error ?? `walletClient(${op}): failed`));
          return;
        }
        resolve(reply.payload as T);
      }
    );
  });
}

let _reqCounter = 0;
function newRequestId(): string {
  _reqCounter = (_reqCounter + 1) | 0;
  return `popup-${Date.now()}-${_reqCounter}`;
}

// ─── Public API ────────────────────────────────────────────────────────

export const walletClient = {
  getStatus(): Promise<WalletStatus> {
    return call<WalletStatus>("getStatus");
  },

  createWallet(args: {
    password: string;
    strength?: 128 | 256;
    bip39Passphrase?: string;
  }): Promise<WalletStatus> {
    return call<WalletStatus>("createWallet", args);
  },

  importWallet(args: {
    password: string;
    phrase: string;
    bip39Passphrase?: string;
  }): Promise<WalletStatus> {
    return call<WalletStatus>("importWallet", args);
  },

  unlock(password: string): Promise<WalletStatus> {
    return call<WalletStatus>("unlock", { password });
  },

  lock(): Promise<WalletStatus> {
    return call<WalletStatus>("lock");
  },

  resetWallet(): Promise<WalletStatus> {
    return call<WalletStatus>("resetWallet");
  },

  addHdAccount(label?: string): Promise<WalletStatus> {
    return call<WalletStatus>("addHdAccount", { label });
  },

  addImportedAccount(args: {
    privateKey: string;
    password: string;
    label?: string;
  }): Promise<WalletStatus> {
    return call<WalletStatus>("addImportedAccount", args);
  },

  setActiveAccount(index: number): Promise<WalletStatus> {
    return call<WalletStatus>("setActiveAccount", { index });
  },

  setIdleTimeoutMinutes(minutes: number): Promise<void> {
    return call<void>("setIdleTimeoutMinutes", { minutes });
  },

  /// Hex-encoded balance (wei). Caller parses via BigInt(...).
  getNativeBalance(address: string): Promise<string> {
    return call<string>("getNativeBalance", { address });
  },

  /// High-level "send DOT" — background builds the EIP-1559 tx, signs
  /// it with the active account, broadcasts via pine.
  sendNative(args: {
    to: string;
    valueWei: string; // bigint as string
    chainId?: number;
    gasLimit?: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas?: string;
  }): Promise<SendNativeResult> {
    return call<SendNativeResult>("sendNative", args);
  },

  signTransaction(tx: unknown): Promise<string> {
    return call<string>("signTransaction", { tx });
  },

  signTypedData(args: {
    domain: unknown;
    types: unknown;
    value: unknown;
  }): Promise<string> {
    return call<string>("signTypedData", args);
  },

  personalSign(message: string): Promise<string> {
    return call<string>("personalSign", { message });
  },
};

// Re-export for downstream type consumers (the screens).
export type { AccountMeta, WalletStatus };
