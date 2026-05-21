// Offscreen-hosted wallet — handles vault encryption/decryption and
// signing. The unlocked seed (and any imported private keys) live in
// memory inside this module while the wallet is unlocked. Nothing
// downstream of the offscreen process ever sees raw key material.
//
// Why offscreen vs background:
// - MV3 service workers can be killed at any time (idle, version
//   change, browser memory pressure). Holding the seed there would
//   force re-unlock on every wake.
// - The offscreen document is kept alive for the extension's lifetime
//   (Chrome's offscreen API keeps a single doc resident as long as the
//   extension is loaded). It's the right place for state that should
//   survive service-worker restarts but die on browser close.
//
// Cryptographic posture:
// - Vault payload (mnemonic, passphrase, imported keys) encrypted with
//   AES-GCM. Key derived from the user password via Argon2id with the
//   parameters captured in `vault.kdf` (default 64 MiB / 3 iters / 1
//   thread, see keystore.DEFAULT_KDF_PARAMS).
// - 16-byte salt per vault; 12-byte IV per encryption. Both generated
//   via Web Crypto's getRandomValues, persisted in the envelope.
// - Argon2id derives a 32-byte key; we feed it straight to AES-GCM as
//   a 256-bit key.
//
// State machine:
//   idle      → no in-memory key material. unlock() can be called.
//   unlocked  → seed + imported keys in memory. sign*() works.
//   (transitions on lock() or on explicit reset.)

import { argon2idAsync } from "@noble/hashes/argon2.js";
import { Wallet, Transaction } from "ethers";
import type {
  Vault,
  VaultCipherParams,
  VaultKdfParams,
  VaultPayload,
} from "../background/wallet/keystore";
import { DEFAULT_KDF_PARAMS } from "../background/wallet/keystore";
import { deriveAccount } from "../background/wallet/derivation";
import {
  type AccountMeta,
  appendHdAccount,
  appendImportedAccount,
  defaultFirstAccount,
  nextHdIndex,
} from "../background/wallet/accounts";
import {
  generateMnemonic,
  validateMnemonic,
  type MnemonicStrength,
} from "../background/wallet/mnemonic";

// ─── In-memory state (offscreen process only) ──────────────────────────

let _payload: VaultPayload | null = null;
/// Cached account list mirroring the persisted vault metadata. Kept in
/// sync by every mutation path; sign requests read from here.
let _accounts: AccountMeta[] = [];
let _activeIndex = 0;

// ─── Public entry points (called by offscreen.ts dispatch) ──────────────

/// Generate a fresh wallet. Returns the new vault envelope (caller
/// persists it via background's keystore.writeVault) plus the account
/// list. Leaves the wallet UNLOCKED so the popup can navigate straight
/// into the dashboard without prompting for password again.
export async function createWallet(args: {
  password: string;
  strength?: MnemonicStrength;
  bip39Passphrase?: string;
}): Promise<{ vault: Vault; accounts: AccountMeta[]; activeIndex: number }> {
  if (!args.password) throw new Error("password required");
  const phrase = generateMnemonic(args.strength ?? 128);
  return finishCreate(phrase, args.password, args.bip39Passphrase ?? "");
}

/// Restore from a user-supplied mnemonic. Validates first; returns
/// `{ error: "invalid-mnemonic" }` if validation fails so the popup can
/// show a clean message instead of throwing.
export async function importWallet(args: {
  password: string;
  phrase: string;
  bip39Passphrase?: string;
}): Promise<
  | { vault: Vault; accounts: AccountMeta[]; activeIndex: number }
  | { error: "invalid-mnemonic" }
> {
  if (!args.password) throw new Error("password required");
  const normalized = validateMnemonic(args.phrase);
  if (!normalized) return { error: "invalid-mnemonic" };
  return finishCreate(normalized, args.password, args.bip39Passphrase ?? "");
}

/// Decrypt an existing vault into memory. Throws on wrong password
/// (AES-GCM tag mismatch surfaces as a generic decryption error).
export async function unlockWallet(args: {
  vault: Vault;
  password: string;
}): Promise<{ accounts: AccountMeta[]; activeIndex: number; activeAddress: string }> {
  const payload = await decryptVault(args.vault, args.password);
  _payload = payload;
  _accounts = args.vault.accounts;
  _activeIndex = args.vault.activeIndex;
  const active = _accounts[_activeIndex];
  return {
    accounts: _accounts,
    activeIndex: _activeIndex,
    activeAddress: active?.address ?? "",
  };
}

/// Drop in-memory key material. The vault stays persisted; next unlock
/// requires the password again.
export function lockWallet(): void {
  _payload = null;
  _accounts = [];
  _activeIndex = 0;
}

export function isUnlocked(): boolean {
  return _payload !== null;
}

/// Add a new HD-derived account. Vault payload (seed) is unchanged; we
/// only extend `accounts` metadata. Caller persists the new metadata
/// via keystore.updateVaultMetadata.
export function addHdAccount(args: { label?: string }): {
  accounts: AccountMeta[];
  added: AccountMeta;
} {
  requireUnlocked();
  const index = nextHdIndex(_accounts);
  const wallet = deriveAccount(_payload!.mnemonic, _payload!.passphrase, index);
  _accounts = appendHdAccount(_accounts, wallet.address, index, args.label);
  return { accounts: _accounts, added: _accounts[_accounts.length - 1] };
}

/// Import a raw 0x-private-key. Stores the key in the in-memory
/// payload's `importedKeys` map; the caller must re-encrypt the vault
/// afterwards (call `reencryptCurrent` with the same password).
export function addImportedAccount(args: {
  privateKey: string;
  label?: string;
}): { accounts: AccountMeta[]; added: AccountMeta } {
  requireUnlocked();
  const w = new Wallet(args.privateKey);
  const addr = w.address.toLowerCase();
  const next = appendImportedAccount(_accounts, addr, args.label);
  _payload!.importedKeys[addr] = w.privateKey;
  _accounts = next;
  return { accounts: _accounts, added: _accounts[_accounts.length - 1] };
}

/// Switch the active account. Returns the new active address so the
/// popup can emit `accountsChanged` for any connected dApp.
export function setActiveAccount(index: number): { activeAddress: string } {
  requireUnlocked();
  if (index < 0 || index >= _accounts.length) {
    throw new Error(`activeIndex ${index} out of range`);
  }
  _activeIndex = index;
  return { activeAddress: _accounts[_activeIndex].address };
}

/// Re-encrypt the current in-memory payload with the same password.
/// Used after addImportedAccount mutates `importedKeys`. Returns the
/// new ciphertext envelope; caller writes it back via keystore.
export async function reencryptCurrent(args: {
  password: string;
  kdf?: Omit<VaultKdfParams, "salt">;
}): Promise<{ cipher: VaultCipherParams; kdf: VaultKdfParams }> {
  requireUnlocked();
  return encryptPayload(_payload!, args.password, args.kdf ?? DEFAULT_KDF_PARAMS);
}

/// Sign an EIP-1559 transaction with the active account's private key.
/// Returns the raw signed transaction hex; caller broadcasts via pine's
/// eth_sendRawTransaction.
export async function signTransaction(args: {
  /// Ethers-compatible transaction-request shape. `from` must match
  /// the active account address (we don't auto-switch).
  tx: import("ethers").TransactionRequest;
}): Promise<string> {
  const wallet = signerForActive();
  const tx = Transaction.from(args.tx as any);
  const sig = await wallet.signTransaction(tx as any);
  return sig;
}

/// Sign EIP-712 typed data. `domain`, `types`, and `value` are passed
/// straight through to ethers v6 `signTypedData`.
export async function signTypedData(args: {
  domain: import("ethers").TypedDataDomain;
  types: Record<string, Array<import("ethers").TypedDataField>>;
  value: Record<string, unknown>;
}): Promise<string> {
  const wallet = signerForActive();
  return wallet.signTypedData(args.domain, args.types, args.value);
}

/// personal_sign — wrap `message` per EIP-191 and sign with the active
/// key. ethers v6 `signMessage` already prepends the prefix.
export async function personalSign(args: { message: string }): Promise<string> {
  const wallet = signerForActive();
  return wallet.signMessage(args.message);
}

// ─── Helpers ────────────────────────────────────────────────────────────

/// Common path for createWallet + importWallet. Encrypts the new
/// payload, builds the vault envelope, derives the first HD account,
/// and leaves the wallet unlocked in memory.
async function finishCreate(
  phrase: string,
  password: string,
  bip39Passphrase: string
): Promise<{ vault: Vault; accounts: AccountMeta[]; activeIndex: number }> {
  const payload: VaultPayload = {
    mnemonic: phrase,
    passphrase: bip39Passphrase,
    importedKeys: {},
  };
  const first = deriveAccount(phrase, bip39Passphrase, 0);
  const accounts: AccountMeta[] = [defaultFirstAccount(first.address)];
  const { cipher, kdf } = await encryptPayload(payload, password, DEFAULT_KDF_PARAMS);
  const vault: Vault = {
    version: 1,
    kdf,
    cipher,
    accounts,
    activeIndex: 0,
    createdAt: Date.now(),
  };
  _payload = payload;
  _accounts = accounts;
  _activeIndex = 0;
  return { vault, accounts, activeIndex: 0 };
}

function requireUnlocked(): void {
  if (!_payload) throw new Error("wallet locked");
}

function signerForActive(): Wallet {
  requireUnlocked();
  const acct = _accounts[_activeIndex];
  if (!acct) throw new Error("active account missing");
  if (acct.source === "hd") {
    const hd = deriveAccount(
      _payload!.mnemonic,
      _payload!.passphrase,
      acct.derivationIndex
    );
    return new Wallet(hd.privateKey);
  }
  const pk = _payload!.importedKeys[acct.address];
  if (!pk) throw new Error("imported key missing for active account");
  return new Wallet(pk);
}

// ─── Crypto core (Argon2id + AES-GCM via Web Crypto) ────────────────────

async function encryptPayload(
  payload: VaultPayload,
  password: string,
  kdfParams: Omit<VaultKdfParams, "salt">
): Promise<{ cipher: VaultCipherParams; kdf: VaultKdfParams }> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, kdfParams);
  const iv = randomBytes(12);
  const plaintext = encoder.encode(JSON.stringify(payload));
  // Pass the underlying ArrayBuffer to crypto.subtle so the type-system
  // narrowing (Uint8Array<ArrayBufferLike> vs ArrayBuffer) doesn't trip
  // on the BufferSource overload signatures.
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
      key,
      plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer
    )
  );
  return {
    cipher: {
      name: "AES-GCM",
      iv: bytesToHex(iv),
      ciphertext: bytesToHex(ciphertext),
    },
    kdf: { ...kdfParams, salt: bytesToHex(salt) },
  };
}

async function decryptVault(vault: Vault, password: string): Promise<VaultPayload> {
  if (vault.kdf.name !== "argon2id") {
    throw new Error(`unsupported KDF: ${vault.kdf.name}`);
  }
  if (vault.cipher.name !== "AES-GCM") {
    throw new Error(`unsupported cipher: ${vault.cipher.name}`);
  }
  const salt = hexToBytes(vault.kdf.salt);
  const iv = hexToBytes(vault.cipher.iv);
  const ct = hexToBytes(vault.cipher.ciphertext);
  const key = await deriveKey(password, salt, vault.kdf);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
      key,
      ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer
    );
  } catch {
    throw new Error("bad-password");
  }
  const json = decoder.decode(plaintext);
  const parsed = JSON.parse(json) as VaultPayload;
  if (
    typeof parsed.mnemonic !== "string" ||
    typeof parsed.passphrase !== "string" ||
    !parsed.importedKeys ||
    typeof parsed.importedKeys !== "object"
  ) {
    throw new Error("malformed vault payload");
  }
  return parsed;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  params: Pick<VaultKdfParams, "m" | "t" | "p">
): Promise<CryptoKey> {
  const raw = await argon2idAsync(encoder.encode(password), salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: 32,
  });
  // `raw` is a Uint8Array<ArrayBuffer>; Web Crypto importKey accepts a
  // BufferSource. Use the .buffer slice so we hand off the exact 32-byte
  // range (avoiding any view-offset surprises if @noble returned a slice).
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  return globalThis.crypto.subtle.importKey(
    "raw",
    buf,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// ─── Encoding helpers ──────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

function bytesToHex(bytes: Uint8Array): string {
  let h = "";
  for (const b of bytes) h += b.toString(16).padStart(2, "0");
  return h;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─── Test surface ──────────────────────────────────────────────────────

export const __test = {
  reset(): void {
    _payload = null;
    _accounts = [];
    _activeIndex = 0;
  },
  snapshot(): { unlocked: boolean; accountCount: number; activeIndex: number } {
    return {
      unlocked: _payload !== null,
      accountCount: _accounts.length,
      activeIndex: _activeIndex,
    };
  },
};
