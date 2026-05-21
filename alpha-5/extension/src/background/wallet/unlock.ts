// Background-side unlock state machine + auto-lock timer.
//
// Public surface:
//   createWallet({ password, ... }): persists a fresh vault and leaves
//   the wallet unlocked.
//
//   importWallet({ password, phrase, ... }): persists a vault from a
//   user-supplied mnemonic; unlocked on success.
//
//   unlock({ password }): decrypts the persisted vault into offscreen
//   memory.
//
//   lock(): explicit lock (popup button or auto-lock timer).
//
//   resetWallet(): deletes the vault entirely. Used by the destructive
//   "Reset wallet" path in SettingsTab.
//
//   isUnlocked(): cheap check — asks offscreen.
//
//   getActiveAccount(): returns the cached active account meta or
//   throws if the wallet is locked.
//
//   getStatus(): full snapshot for the popup UI.
//
// The cache here mirrors the offscreen state for cheap reads from
// background hooks (campaignPoller deciding whether to attempt
// signing, etc.). Mutations on offscreen always re-sync the cache.

import {
  hasVault,
  readVault,
  writeVault,
  deleteVault,
  updateVaultMetadata,
  type Vault,
  type VaultCipherParams,
  type VaultKdfParams,
} from "./keystore";
import type { AccountMeta } from "./accounts";
import type { MnemonicStrength } from "./mnemonic";
import { walletRpc } from "./transport";
import { clearAllPermissions } from "./permissions";
import { denyAll as denyAllPending } from "./permissionQueue";

// ─── Cached state (background process) ─────────────────────────────────

/// Cached offscreen state. Updated on every successful op; the popup
/// reads this synchronously via getStatus().
let _cache: {
  unlocked: boolean;
  accounts: AccountMeta[];
  activeIndex: number;
  activeAddress: string;
} = {
  unlocked: false,
  accounts: [],
  activeIndex: 0,
  activeAddress: "",
};

/// Auto-lock timer. Renewed on every wallet activity; on idle expiry we
/// call lock().
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _idleTimeoutMs = 30 * 60 * 1000; // 30 min default per design

// ─── Public API ────────────────────────────────────────────────────────

export type WalletStatus = {
  /// "no-vault": no wallet created yet — popup shows onboarding.
  /// "locked":   vault exists but no in-memory key material — popup
  ///             shows the unlock screen.
  /// "unlocked": vault exists and key material is in offscreen memory —
  ///             popup renders the dashboard.
  state: "no-vault" | "locked" | "unlocked";
  accounts: AccountMeta[];
  activeIndex: number;
  activeAddress: string;
  /// Milliseconds until auto-lock fires; null when locked.
  msUntilAutoLock: number | null;
};

export async function getStatus(): Promise<WalletStatus> {
  if (_cache.unlocked) {
    return {
      state: "unlocked",
      accounts: _cache.accounts,
      activeIndex: _cache.activeIndex,
      activeAddress: _cache.activeAddress,
      msUntilAutoLock: msUntilAutoLock(),
    };
  }
  return {
    state: (await hasVault()) ? "locked" : "no-vault",
    accounts: [],
    activeIndex: 0,
    activeAddress: "",
    msUntilAutoLock: null,
  };
}

export async function isUnlocked(): Promise<boolean> {
  if (_cache.unlocked) return true;
  // Reconcile with offscreen — service worker may have woken with stale
  // cache after a restart where offscreen kept the keys.
  const r = await walletRpc<{ unlocked: boolean }>({
    type: "WALLET_IS_UNLOCKED",
  });
  if (r.unlocked) {
    // Cache will be repopulated lazily on next op needing accounts;
    // for now mark unlocked so callers don't spin.
    _cache.unlocked = true;
  }
  return r.unlocked;
}

export async function createWallet(args: {
  password: string;
  strength?: MnemonicStrength;
  bip39Passphrase?: string;
}): Promise<WalletStatus> {
  const result = await walletRpc<{
    vault: Vault;
    accounts: AccountMeta[];
    activeIndex: number;
  }>({
    type: "WALLET_CREATE",
    password: args.password,
    strength: args.strength,
    bip39Passphrase: args.bip39Passphrase,
  });
  await writeVault(result.vault);
  syncCache({
    unlocked: true,
    accounts: result.accounts,
    activeIndex: result.activeIndex,
    activeAddress: result.accounts[result.activeIndex]?.address ?? "",
  });
  renewIdleTimer();
  return getStatus();
}

export async function importWallet(args: {
  password: string;
  phrase: string;
  bip39Passphrase?: string;
}): Promise<WalletStatus> {
  const result = await walletRpc<
    | { vault: Vault; accounts: AccountMeta[]; activeIndex: number }
    | { error: "invalid-mnemonic" }
  >({
    type: "WALLET_IMPORT",
    password: args.password,
    phrase: args.phrase,
    bip39Passphrase: args.bip39Passphrase,
  });
  if ("error" in result) {
    throw new Error(result.error);
  }
  await writeVault(result.vault);
  syncCache({
    unlocked: true,
    accounts: result.accounts,
    activeIndex: result.activeIndex,
    activeAddress: result.accounts[result.activeIndex]?.address ?? "",
  });
  renewIdleTimer();
  return getStatus();
}

export async function unlock(args: { password: string }): Promise<WalletStatus> {
  const vault = await readVault();
  if (!vault) throw new Error("no-vault");
  const result = await walletRpc<{
    accounts: AccountMeta[];
    activeIndex: number;
    activeAddress: string;
  }>({
    type: "WALLET_UNLOCK",
    vault,
    password: args.password,
  });
  syncCache({
    unlocked: true,
    accounts: result.accounts,
    activeIndex: result.activeIndex,
    activeAddress: result.activeAddress,
  });
  renewIdleTimer();
  return getStatus();
}

export async function lock(): Promise<WalletStatus> {
  if (_cache.unlocked) {
    await walletRpc<{ locked: true }>({ type: "WALLET_LOCK" });
  }
  clearIdleTimer();
  // Any dApp waiting on a permission prompt now sees a denied result
  // so its Promise doesn't outlive the unlocked session that birthed it.
  denyAllPending();
  syncCache({
    unlocked: false,
    accounts: [],
    activeIndex: 0,
    activeAddress: "",
  });
  return getStatus();
}

/// Destructive — erases the persisted vault AND every per-origin
/// permission grant. After this the popup routes back to onboarding;
/// dApps that had previously connected must re-request.
export async function resetWallet(): Promise<WalletStatus> {
  await lock().catch(() => undefined);
  await deleteVault();
  await clearAllPermissions();
  return getStatus();
}

/// Configure the auto-lock idle timeout (in minutes). Persisted under
/// `walletIdleTimeoutMin` so it survives restarts. SettingsTab calls
/// this; default is 30 min.
export async function setIdleTimeoutMinutes(min: number): Promise<void> {
  if (min < 1 || min > 24 * 60) {
    throw new Error("idle timeout must be between 1 minute and 24 hours");
  }
  _idleTimeoutMs = min * 60 * 1000;
  await chrome.storage.local.set({ walletIdleTimeoutMin: min });
  if (_cache.unlocked) renewIdleTimer();
}

/// Read the persisted idle-timeout setting at startup.
export async function loadIdleTimeoutSetting(): Promise<void> {
  const got = await chrome.storage.local.get("walletIdleTimeoutMin");
  const v = got.walletIdleTimeoutMin;
  if (typeof v === "number" && v >= 1 && v <= 24 * 60) {
    _idleTimeoutMs = v * 60 * 1000;
  }
}

/// Reset the idle timer. Called by any code path that constitutes
/// "user activity" — popup opening, sign requests, dApp provider calls.
export function touchActivity(): void {
  if (_cache.unlocked) renewIdleTimer();
}

// ─── Account mutations ────────────────────────────────────────────────

export async function addHdAccount(label?: string): Promise<WalletStatus> {
  const r = await walletRpc<{ accounts: AccountMeta[]; added: AccountMeta }>({
    type: "WALLET_ADD_HD_ACCOUNT",
    label,
  });
  await updateVaultMetadata({ accounts: r.accounts });
  syncCache({ accounts: r.accounts });
  touchActivity();
  return getStatus();
}

/// Import a raw 0x-private-key as a new account.
///
/// The caller must re-supply the wallet password because adding an
/// imported key mutates the encrypted payload (importedKeys map) and
/// we need to re-encrypt. We deliberately never cache the password
/// in background memory; the popup keeps it for the lifetime of the
/// import modal and discards on submit.
export async function addImportedAccount(args: {
  privateKey: string;
  password: string;
  label?: string;
}): Promise<WalletStatus> {
  const r = await walletRpc<{ accounts: AccountMeta[]; added: AccountMeta }>({
    type: "WALLET_ADD_IMPORTED",
    privateKey: args.privateKey,
    label: args.label,
  });
  // Re-encrypt with the supplied password so the new imported key is
  // captured in the persisted ciphertext.
  const newCipher = await walletRpc<{
    cipher: VaultCipherParams;
    kdf: VaultKdfParams;
  }>({
    type: "WALLET_REENCRYPT",
    password: args.password,
  });
  const cur = await readVault();
  if (!cur) throw new Error("vault disappeared mid-op");
  await writeVault({
    ...cur,
    cipher: newCipher.cipher,
    kdf: newCipher.kdf,
    accounts: r.accounts,
  });
  syncCache({ accounts: r.accounts });
  touchActivity();
  return getStatus();
}

export async function setActiveAccount(index: number): Promise<WalletStatus> {
  const r = await walletRpc<{ activeAddress: string }>({
    type: "WALLET_SET_ACTIVE",
    index,
  });
  await updateVaultMetadata({ activeIndex: index });
  syncCache({ activeIndex: index, activeAddress: r.activeAddress });
  touchActivity();
  return getStatus();
}

// ─── Internals ────────────────────────────────────────────────────────

function syncCache(patch: Partial<typeof _cache>): void {
  _cache = { ..._cache, ...patch };
}

function renewIdleTimer(): void {
  clearIdleTimer();
  _idleTimer = setTimeout(() => {
    lock().catch((err) => {
      console.error("[wallet] auto-lock failed", err);
    });
  }, _idleTimeoutMs);
  _idleExpiresAt = Date.now() + _idleTimeoutMs;
}

function clearIdleTimer(): void {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  _idleExpiresAt = null;
}

let _idleExpiresAt: number | null = null;
function msUntilAutoLock(): number | null {
  if (!_idleExpiresAt) return null;
  return Math.max(0, _idleExpiresAt - Date.now());
}

// ─── Test surface ─────────────────────────────────────────────────────

export const __test = {
  reset(): void {
    _cache = {
      unlocked: false,
      accounts: [],
      activeIndex: 0,
      activeAddress: "",
    };
    clearIdleTimer();
    _idleTimeoutMs = 30 * 60 * 1000;
  },
  setCache(patch: Partial<typeof _cache>): void {
    syncCache(patch);
  },
  getIdleTimeoutMs(): number {
    return _idleTimeoutMs;
  },
};
