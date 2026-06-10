// Offscreen-side dispatcher for wallet ops.
//
// `offscreen.ts` routes WALLET_* messages here. We narrow on `type`,
// call the matching public function in `wallet.ts`, and wrap the
// result in the uniform `WALLET_RESULT` envelope. Errors thrown by
// wallet.ts surface as `{ ok: false, error: <message> }` — the
// orchestrator on the background side turns these into rejected
// promises with a properly-typed error code.

import type { BackgroundToOffscreen, OffscreenToBackground } from "@shared/messages";
import {
  createWallet,
  importWallet,
  unlockWallet,
  lockWallet,
  isUnlocked,
  addHdAccount,
  addImportedAccount,
  setActiveAccount,
  reencryptCurrent,
  signTransaction,
  signTypedData,
  personalSign,
} from "./wallet";

type WalletMsg = Extract<BackgroundToOffscreen, { type: `WALLET_${string}` }>;

export async function handleWalletMessage(
  msg: BackgroundToOffscreen
): Promise<OffscreenToBackground> {
  // Narrow to the wallet subset — caller (offscreen.ts) already checks
  // the type tag, this branch keeps the switch exhaustive for TS.
  if (!msg.type.startsWith("WALLET_")) {
    return walletErr("not-a-wallet-message", "unknown");
  }
  const w = msg as WalletMsg;
  try {
    switch (w.type) {
      case "WALLET_CREATE":
        return ok(w.requestId, await createWallet({
          password: w.password,
          strength: w.strength,
          bip39Passphrase: w.bip39Passphrase,
        }));
      case "WALLET_IMPORT":
        return ok(w.requestId, await importWallet({
          password: w.password,
          phrase: w.phrase,
          bip39Passphrase: w.bip39Passphrase,
        }));
      case "WALLET_UNLOCK":
        return ok(w.requestId, await unlockWallet({
          vault: w.vault,
          password: w.password,
        }));
      case "WALLET_LOCK":
        lockWallet();
        return ok(w.requestId, { locked: true });
      case "WALLET_IS_UNLOCKED":
        return ok(w.requestId, { unlocked: isUnlocked() });
      case "WALLET_ADD_HD_ACCOUNT":
        return ok(w.requestId, addHdAccount({ label: w.label }));
      case "WALLET_ADD_IMPORTED":
        return ok(w.requestId, addImportedAccount({
          privateKey: w.privateKey,
          label: w.label,
        }));
      case "WALLET_SET_ACTIVE":
        return ok(w.requestId, setActiveAccount(w.index));
      case "WALLET_REENCRYPT":
        return ok(w.requestId, await reencryptCurrent({ password: w.password }));
      case "WALLET_SIGN_TRANSACTION":
        return ok(w.requestId, await signTransaction({ tx: w.tx as any }));
      case "WALLET_SIGN_TYPED_DATA":
        return ok(w.requestId, await signTypedData({
          domain: w.domain as any,
          types: w.types as any,
          value: w.value,
        }));
      case "WALLET_PERSONAL_SIGN":
        return ok(w.requestId, await personalSign({ message: w.message }));
    }
  } catch (err: any) {
    return walletErr(String(err?.message ?? err), w.requestId);
  }
}

function ok(requestId: string, payload: unknown): OffscreenToBackground {
  return { type: "WALLET_RESULT", requestId, ok: true, payload };
}

function walletErr(message: string, requestId: string): OffscreenToBackground {
  return { type: "WALLET_RESULT", requestId, ok: false, error: message };
}
