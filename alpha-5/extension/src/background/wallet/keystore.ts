// Encrypted-vault persistence.
//
// The vault is the on-disk form of the user's wallet: a single
// JSON blob stored under `chrome.storage.local` at key `walletVault`.
// Persisted contents:
//
//   {
//     version: number;
//     kdf: { name: "argon2id"; m: number; t: number; p: number; salt: hex };
//     cipher: { name: "AES-GCM"; iv: hex; ciphertext: hex };
//     accounts: AccountMeta[];   // metadata only — no key material
//     activeIndex: number;       // index INTO accounts (not BIP-32 index)
//     createdAt: number;         // unix ms
//   }
//
// `ciphertext` decrypts to a `VaultPayload`:
//
//   {
//     mnemonic: string;          // BIP-39 phrase (HD root)
//     passphrase: string;        // BIP-39 optional 25th word (may be "")
//     importedKeys: Record<string, hex>;  // {address → 0x...64 hex}
//   }
//
// Important invariants:
// - Only the offscreen wallet host ever sees `mnemonic` / `passphrase` /
//   `importedKeys` in plaintext.
// - This module does **not** perform encryption or decryption itself —
//   that's offscreen's job. We just persist the encrypted envelope and
//   the public account metadata.
// - `accounts` and `activeIndex` are written by the background unlock
//   path after each mutation. They live outside the ciphertext so the
//   popup can render the account list without unlocking the vault.

import type { AccountMeta } from "./accounts";

const STORAGE_KEY = "walletVault";
export const VAULT_VERSION = 1;

/// The full envelope as it lives in chrome.storage.local.
export type Vault = {
  version: number;
  kdf: VaultKdfParams;
  cipher: VaultCipherParams;
  /// Public account metadata — labels, derivation paths, source flag.
  /// Safe to read without unlocking.
  accounts: AccountMeta[];
  /// Pointer into `accounts`. Always 0 ≤ activeIndex < accounts.length
  /// after a successful unlock.
  activeIndex: number;
  createdAt: number;
};

/// KDF parameters captured at vault-creation time so a future unlock
/// uses the same shape. We may bump defaults later; old vaults keep
/// using their original params until they're re-encrypted.
export type VaultKdfParams = {
  name: "argon2id";
  /// Memory cost in KB (Argon2 `m` parameter, in KiB).
  m: number;
  /// Iteration count.
  t: number;
  /// Parallelism (always 1 in browser; threads don't help here).
  p: number;
  /// Hex-encoded 16-byte salt.
  salt: string;
};

export type VaultCipherParams = {
  name: "AES-GCM";
  /// Hex-encoded 12-byte IV.
  iv: string;
  /// Hex-encoded ciphertext (includes the 16-byte AES-GCM tag at the end).
  ciphertext: string;
};

/// Cleartext payload — never persisted, never crosses into the service
/// worker. Decrypted only inside the offscreen wallet host.
export type VaultPayload = {
  mnemonic: string;
  passphrase: string;
  /// Raw secp256k1 private keys (0x-prefixed, 64 hex chars) keyed by the
  /// EOA address they correspond to. These bypass HD derivation entirely
  /// and are stored alongside HD accounts under `accounts` with
  /// `source: "imported"`.
  importedKeys: Record<string, string>;
};

/// Default KDF params for a freshly-created vault. Aligned with the
/// design doc §3.4.1 — "interactive params". Heavier than browser-
/// default PBKDF2 by orders of magnitude.
export const DEFAULT_KDF_PARAMS: Omit<VaultKdfParams, "salt"> = {
  name: "argon2id",
  m: 64 * 1024,  // 64 MiB
  t: 3,
  p: 1,
};

// ─── Storage I/O ────────────────────────────────────────────────────────

/// True iff a vault has been written.
export async function hasVault(): Promise<boolean> {
  const v = await readVault();
  return v !== null;
}

/// Read the current vault. Returns `null` if no vault is stored.
export async function readVault(): Promise<Vault | null> {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  const v = got[STORAGE_KEY];
  if (!v) return null;
  if (!isWellFormedVault(v)) {
    // Corrupt vault — the offscreen host will refuse to use it; surface
    // null so the popup can prompt the user to reset.
    return null;
  }
  return v as Vault;
}

/// Atomically write a new vault, replacing any prior contents.
/// Caller is responsible for having produced `cipher` via the
/// offscreen wallet host's `encryptVault` call.
export async function writeVault(vault: Vault): Promise<void> {
  if (!isWellFormedVault(vault)) {
    throw new Error("refusing to persist malformed vault");
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: vault });
}

/// Update only the public-metadata portion of the vault (account list +
/// active index). Keeps the same ciphertext + KDF params. Used after
/// addAccount / setLabel / setActive — none of which touch key material.
export async function updateVaultMetadata(
  patch: { accounts?: AccountMeta[]; activeIndex?: number }
): Promise<void> {
  const cur = await readVault();
  if (!cur) throw new Error("no vault to update");
  const next: Vault = { ...cur };
  if (patch.accounts !== undefined) next.accounts = patch.accounts;
  if (patch.activeIndex !== undefined) next.activeIndex = patch.activeIndex;
  await writeVault(next);
}

/// Erase the vault. The popup confirms a destructive prompt before
/// calling this. Recovery is only via re-import of the BIP-39 phrase.
export async function deleteVault(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

// ─── Validation ────────────────────────────────────────────────────────

/// Structural check on a candidate vault. Doesn't try to decrypt;
/// just confirms the shape is the one this version of the extension
/// can read.
function isWellFormedVault(v: unknown): v is Vault {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.version !== "number") return false;
  if (typeof o.createdAt !== "number") return false;
  if (typeof o.activeIndex !== "number") return false;
  if (!Array.isArray(o.accounts)) return false;
  const kdf = o.kdf as Record<string, unknown> | undefined;
  if (!kdf || kdf.name !== "argon2id") return false;
  if (typeof kdf.m !== "number" || typeof kdf.t !== "number" || typeof kdf.p !== "number") {
    return false;
  }
  if (typeof kdf.salt !== "string") return false;
  const cipher = o.cipher as Record<string, unknown> | undefined;
  if (!cipher || cipher.name !== "AES-GCM") return false;
  if (typeof cipher.iv !== "string" || typeof cipher.ciphertext !== "string") return false;
  return true;
}
