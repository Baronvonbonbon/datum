// Wallet RPC dispatcher — popup-facing.
//
// `background/index.ts` routes WALLET_RPC_REQUEST messages here.
// We switch on `op` and call the matching function in unlock.ts /
// signing.ts. Replies follow the uniform { ok, payload?, error? }
// envelope; the popup-side walletClient correlates by requestId.
//
// Why a single envelope vs. one PopupToBackground variant per op:
//   - The wallet has ~15 ops. Inflating PopupToBackground with each
//     would balloon the union type and force every consumer (including
//     unrelated content-script handlers) to depend on wallet types.
//   - Versioning is easier — new ops add to WalletRpcOp without
//     touching the broader message contract.

import type { WalletRpcOp, WalletRpcResponse } from "@shared/messages";
import {
  getStatus,
  createWallet,
  importWallet,
  unlock,
  lock,
  resetWallet,
  addHdAccount,
  addImportedAccount,
  setActiveAccount,
  setIdleTimeoutMinutes,
  touchActivity,
} from "./unlock";
import {
  signTransaction,
  signTypedData,
  personalSign,
} from "./signing";
import { pineRpc } from "../pineBridge";

export async function dispatchWalletRpc(
  requestId: string,
  op: WalletRpcOp,
  args: any
): Promise<WalletRpcResponse> {
  try {
    const payload = await runOp(op, args ?? {});
    return { type: "WALLET_RPC_RESPONSE", requestId, ok: true, payload };
  } catch (err: any) {
    return {
      type: "WALLET_RPC_RESPONSE",
      requestId,
      ok: false,
      error: String(err?.message ?? err),
    };
  }
}

async function runOp(op: WalletRpcOp, args: any): Promise<unknown> {
  // Treat every wallet RPC as user activity so the auto-lock timer
  // doesn't fire mid-flow.
  touchActivity();

  switch (op) {
    case "getStatus":
      return getStatus();
    case "createWallet":
      return createWallet({
        password: args.password,
        strength: args.strength,
        bip39Passphrase: args.bip39Passphrase,
      });
    case "importWallet":
      return importWallet({
        password: args.password,
        phrase: args.phrase,
        bip39Passphrase: args.bip39Passphrase,
      });
    case "unlock":
      return unlock({ password: args.password });
    case "lock":
      return lock();
    case "resetWallet":
      return resetWallet();
    case "addHdAccount":
      return addHdAccount(args.label);
    case "addImportedAccount":
      return addImportedAccount({
        privateKey: args.privateKey,
        password: args.password,
        label: args.label,
      });
    case "setActiveAccount":
      return setActiveAccount(args.index);
    case "setIdleTimeoutMinutes":
      return setIdleTimeoutMinutes(args.minutes);
    case "getNativeBalance":
      return pineRpc<string>("eth_getBalance", [args.address, "latest"]);
    case "sendNative": {
      // High-level helper: build EIP-1559 tx, sign via the active
      // account, broadcast via pine. Returns the tx hash.
      const { to, valueWei, chainId, gasLimit, maxFeePerGas, maxPriorityFeePerGas } = args;
      const fromAddress = (await getStatus()).activeAddress;
      const nonceHex = await pineRpc<string>("eth_getTransactionCount", [
        fromAddress,
        "latest",
      ]);
      const nonce = Number(BigInt(nonceHex));
      const tx = {
        type: 2,
        chainId: chainId ?? 420420417,
        nonce,
        to,
        value: BigInt(valueWei),
        gasLimit: BigInt(gasLimit ?? 21000),
        maxFeePerGas: BigInt(maxFeePerGas),
        maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas ?? maxFeePerGas),
      };
      const rawSigned = await signTransaction(tx);
      const txHash = await pineRpc<string>("eth_sendRawTransaction", [rawSigned]);
      return { txHash, nonce };
    }
    case "signTransaction":
      return signTransaction(args.tx);
    case "signTypedData":
      return signTypedData(args.domain, args.types, args.value);
    case "personalSign":
      return personalSign(args.message);
    default: {
      const exhaustive: never = op;
      throw new Error(`unknown wallet op: ${exhaustive}`);
    }
  }
}
