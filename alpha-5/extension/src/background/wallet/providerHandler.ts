// EIP-1193 provider handler — the new `window.datum` surface.
//
// Content scripts forward provider requests via PROVIDER_RPC_REQUEST
// (one envelope, op-and-params inside). This module routes by EIP-1193
// method name, applies the per-origin permission gate, and forwards to
// pine (reads) or the offscreen-hosted wallet (signing).
//
// Permission model (default-deny):
//   - eth_chainId is free — no permission needed, no key material
//     exposure. Lets dApps detect the chain before requesting access.
//   - eth_requestAccounts triggers the approval flow if the origin
//     isn't already granted; once granted, the active address is
//     returned. Future calls from the same origin skip the prompt.
//   - eth_accounts returns the active address only when the origin is
//     granted; otherwise `[]`.
//   - Read RPCs (eth_call, eth_getBalance, eth_getLogs, etc.) require
//     a granted origin — they don't sign, but they reveal what the user
//     might be reading. Pass through to pine when granted.
//   - Signing methods (personal_sign, eth_signTypedData_v4,
//     eth_sendTransaction) require both a granted origin AND an
//     unlocked wallet. If the wallet is locked, return an EIP-1193
//     `4100 unauthorized` error; the dApp prompts the user to open
//     the popup and unlock.
//
// `wallet_switchEthereumChain` / `wallet_addEthereumChain` return a
// non-error "unsupported" today — we're Paseo-only on testnet and
// emit no chain switch.

import { isPermitted, grantPermission } from "./permissions";
import { enqueue as queueApproval } from "./permissionQueue";
import { getStatus } from "./unlock";
import {
  signTransaction,
  signTypedData,
  personalSign,
} from "./signing";
import { pineRpc } from "../pineBridge";

/// EIP-1193 ProviderRpcError code values. Subset we use:
///   4001 = User Rejected Request
///   4100 = Unauthorized (origin not permitted, or wallet locked)
///   4200 = Unsupported Method
///   4900 = Disconnected (wallet not initialized)
///   -32601 = Method not found (JSON-RPC standard)
export type ProviderRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type ProviderRpcResult =
  | { ok: true; result: unknown }
  | { ok: false; error: ProviderRpcError };

/// Read-RPC allowlist. Forwarded verbatim to pine via pineRpc when the
/// origin is permitted. Anything not in this list returns 4200
/// Unsupported. Kept narrow to avoid leaking chain-state queries the
/// user didn't mean to consent to.
const READ_RPC_ALLOWLIST = new Set([
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getLogs",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "net_version",
  "web3_clientVersion",
]);

const PASEO_CHAIN_ID_HEX = "0x190f1b41"; // 420420417

/// Entry point — content script ↔ background message routes here via
/// the PROVIDER_RPC_REQUEST envelope.
export async function handleProviderRequest(args: {
  origin: string;
  method: string;
  params: unknown[];
}): Promise<ProviderRpcResult> {
  const { origin, method, params } = args;

  // chainId is a free read — needed before the dApp even tries
  // to connect.
  if (method === "eth_chainId" || method === "net_version") {
    return { ok: true, result: method === "net_version" ? "420420417" : PASEO_CHAIN_ID_HEX };
  }

  if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
    // Testnet posture: Paseo-only. We deliberately return an
    // EIP-1193-style "chain not supported" code so wallets that
    // implement the spec (4902 = unrecognized chain) can decide
    // gracefully.
    return {
      ok: false,
      error: { code: 4902, message: "DATUM is Paseo-only on testnet" },
    };
  }

  if (method === "eth_requestAccounts") {
    return handleRequestAccounts(origin);
  }

  // Everything beyond this point requires a granted permission.
  const permitted = await isPermitted(origin);
  if (!permitted) {
    if (method === "eth_accounts") {
      // Unauthenticated read of accounts → empty array. Avoids the
      // user-rejected error overhead for dApps that just probe whether
      // we have a wallet.
      return { ok: true, result: [] };
    }
    return {
      ok: false,
      error: { code: 4100, message: "Origin not permitted to call DATUM provider" },
    };
  }

  if (method === "eth_accounts") {
    const status = await getStatus();
    if (status.state !== "unlocked" || !status.activeAddress) return { ok: true, result: [] };
    return { ok: true, result: [status.activeAddress] };
  }

  // Signing methods require an unlocked wallet.
  if (
    method === "personal_sign" ||
    method === "eth_sign" ||
    method === "eth_signTypedData_v4" ||
    method === "eth_signTypedData" ||
    method === "eth_sendTransaction"
  ) {
    const status = await getStatus();
    if (status.state !== "unlocked") {
      return {
        ok: false,
        error: { code: 4100, message: "DATUM wallet is locked" },
      };
    }
    return handleSigningMethod(method, params, status.activeAddress);
  }

  // Read RPC pass-through.
  if (READ_RPC_ALLOWLIST.has(method)) {
    try {
      const result = await pineRpc(method, params);
      return { ok: true, result };
    } catch (err: any) {
      const code = typeof err?.code === "number" ? err.code : -32603;
      return {
        ok: false,
        error: { code, message: String(err?.message ?? err), data: err?.data },
      };
    }
  }

  return {
    ok: false,
    error: { code: 4200, message: `Unsupported method: ${method}` },
  };
}

async function handleRequestAccounts(origin: string): Promise<ProviderRpcResult> {
  const status = await getStatus();
  if (status.state === "no-vault") {
    return {
      ok: false,
      error: { code: 4900, message: "No DATUM wallet — install or onboard first" },
    };
  }

  // Already granted? Return the active address immediately, even when
  // the wallet is locked — the dApp may simply want to know the
  // canonical address; signing will fail-closed later.
  if (await isPermitted(origin)) {
    return {
      ok: true,
      result: status.activeAddress ? [status.activeAddress] : [],
    };
  }

  // Not yet granted → queue approval and wait for the popup.
  const outcome = await queueApproval(origin);
  if (outcome === "denied") {
    return {
      ok: false,
      error: { code: 4001, message: "User rejected the request" },
    };
  }
  if (outcome === "timed-out") {
    return {
      ok: false,
      error: { code: 4001, message: "Approval timed out" },
    };
  }

  // outcome === "approved" — persist the grant + return the address.
  // Re-read getStatus so the address reflects any switch the user made
  // mid-approval.
  const after = await getStatus();
  await grantPermission(origin, after.activeAddress);
  return {
    ok: true,
    result: after.activeAddress ? [after.activeAddress] : [],
  };
}

async function handleSigningMethod(
  method: string,
  params: unknown[],
  activeAddress: string
): Promise<ProviderRpcResult> {
  try {
    if (method === "personal_sign") {
      // EIP-1193 spec is [message, address]. We bind to the active
      // account regardless of the `address` param — caller-supplied
      // addresses outside the active set are rejected to avoid signer
      // confusion across accounts.
      const [rawMessage, requestedAddr] = params as [string, string];
      if (
        requestedAddr &&
        requestedAddr.toLowerCase() !== activeAddress.toLowerCase()
      ) {
        return {
          ok: false,
          error: { code: 4100, message: "Requested address is not active" },
        };
      }
      // Spec allows either utf8 or hex message. Hex is conventional
      // for MetaMask compat — decode if so, else pass through.
      const message =
        typeof rawMessage === "string" && /^0x[0-9a-fA-F]*$/.test(rawMessage)
          ? hexToUtf8(rawMessage)
          : String(rawMessage);
      const sig = await personalSign(message);
      return { ok: true, result: sig };
    }

    if (method === "eth_signTypedData_v4" || method === "eth_signTypedData") {
      // params = [address, typedData] where typedData is JSON string or object
      const [requestedAddr, typedData] = params as [string, string | Record<string, unknown>];
      if (
        requestedAddr &&
        requestedAddr.toLowerCase() !== activeAddress.toLowerCase()
      ) {
        return {
          ok: false,
          error: { code: 4100, message: "Requested address is not active" },
        };
      }
      const parsed =
        typeof typedData === "string" ? JSON.parse(typedData) : typedData;
      const { domain, types, message, primaryType } = parsed as any;
      // EIP-712 includes an `EIP712Domain` type entry; ethers infers
      // the domain types, so strip it before passing.
      const cleanTypes: Record<string, any> = { ...types };
      delete cleanTypes.EIP712Domain;
      // Reduce types to just the primary type chain — ethers picks
      // the entry that matches the value; including all is safe.
      const sig = await signTypedData(domain, cleanTypes, message);
      return { ok: true, result: sig };
    }

    if (method === "eth_sendTransaction") {
      // params = [{ to, value, data, gas, ... }]
      const [tx] = params as [Record<string, any>];
      if (tx.from && tx.from.toLowerCase() !== activeAddress.toLowerCase()) {
        return {
          ok: false,
          error: { code: 4100, message: "Tx `from` is not active address" },
        };
      }
      // We don't auto-fill gas/nonce/chainId here yet — the dApp must
      // supply them. The high-level `sendNative` op in rpcDispatcher
      // does the filling for the popup's own SendTab. dApp-driven
      // sends can be enriched in a follow-up.
      const raw = await signTransaction(tx);
      const txHash = await pineRpc<string>("eth_sendRawTransaction", [raw]);
      return { ok: true, result: txHash };
    }

    if (method === "eth_sign") {
      return {
        ok: false,
        error: { code: 4200, message: "eth_sign is deprecated; use personal_sign" },
      };
    }

    return {
      ok: false,
      error: { code: -32601, message: `Method not handled: ${method}` },
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: typeof err?.code === "number" ? err.code : -32603,
        message: String(err?.message ?? err),
      },
    };
  }
}

function hexToUtf8(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length === 0) return "";
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}
