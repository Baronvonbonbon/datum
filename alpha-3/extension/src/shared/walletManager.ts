// Embedded wallet manager for DATUM extension.
// Manages multiple named EVM accounts, each encrypted at rest with AES-256-GCM.
// The key is derived from a user password via PBKDF2.
// The unlocked ethers.Wallet is held in memory only — cleared on lock/popup close.
//
// This exists because Chrome extension popups cannot access window.ethereum
// or window.injectedWeb3 from external wallet extensions (Polkadot.js, SubWallet).
// Post-MVP: WalletConnect or iframe bridge will add external wallet support.
//
// WARNING: TESTING ONLY — NO SECURITY GUARANTEES
// This embedded wallet is for development and testing purposes only.
// Do NOT import or generate keys that control real funds.
// The encryption is best-effort but has NOT been independently audited.
// Use of this software is entirely at your own risk.

import { Wallet, JsonRpcProvider, randomBytes, hexlify, getBytes } from "ethers";

const WALLETS_KEY = "datumWallets";           // multi-account storage
const LEGACY_STORAGE_KEY = "datumEncryptedWallet"; // single-wallet legacy key
const PBKDF2_ITERATIONS = 310_000; // OWASP recommendation for SHA-256

export interface EncryptedWalletData {
  ciphertext: string; // hex-encoded AES-GCM ciphertext
  iv: string;         // hex-encoded 12-byte IV
  salt: string;       // hex-encoded 32-byte salt
}

export interface WalletEntry {
  name: string;
  address: string;
  encrypted: EncryptedWalletData;
}

// In-memory state — lost on popup close or service worker restart
let unlockedWallet: Wallet | null = null;
let activeAccountName: string | null = null;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptKey(privateKeyHex: string, password: string): Promise<EncryptedWalletData> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);

  const enc = new TextEncoder();
  const plainBytes = enc.encode(privateKeyHex);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    plainBytes.buffer as ArrayBuffer
  );

  return {
    ciphertext: hexlify(new Uint8Array(ciphertext)),
    iv: hexlify(iv),
    salt: hexlify(salt),
  };
}

async function decryptKey(data: EncryptedWalletData, password: string): Promise<string> {
  const salt = getBytes(data.salt);
  const iv = getBytes(data.iv);
  const ciphertext = getBytes(data.ciphertext);
  const key = await deriveKey(password, salt);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer
  );

  return new TextDecoder().decode(plaintext);
}

// -------------------------------------------------------------------------
// Multi-account storage helpers
// -------------------------------------------------------------------------

async function getWalletEntries(): Promise<WalletEntry[]> {
  const stored = await chrome.storage.local.get(WALLETS_KEY);
  return stored[WALLETS_KEY] ?? [];
}

async function setWalletEntries(entries: WalletEntry[]): Promise<void> {
  await chrome.storage.local.set({ [WALLETS_KEY]: entries });
}

/** Migrate legacy single-wallet to multi-wallet format on first load. */
export async function migrateIfNeeded(): Promise<void> {
  const stored = await chrome.storage.local.get([WALLETS_KEY, LEGACY_STORAGE_KEY, "connectedAddress"]);
  if (stored[WALLETS_KEY]) return; // already migrated
  if (!stored[LEGACY_STORAGE_KEY]) return; // no legacy wallet

  const legacyAddr = stored.connectedAddress ?? "Unknown";
  const entry: WalletEntry = {
    name: "Account 1",
    address: legacyAddr,
    encrypted: stored[LEGACY_STORAGE_KEY] as EncryptedWalletData,
  };
  await chrome.storage.local.set({
    [WALLETS_KEY]: [entry],
    activeWalletName: "Account 1",
  });
  await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/** List all wallet account names and addresses. */
export async function listWallets(): Promise<{ name: string; address: string }[]> {
  const entries = await getWalletEntries();
  return entries.map((e) => ({ name: e.name, address: e.address }));
}

/** Get the active wallet name from storage. */
export async function getActiveWalletName(): Promise<string | null> {
  const stored = await chrome.storage.local.get("activeWalletName");
  return stored.activeWalletName ?? null;
}

/** Get the active wallet's encrypted data (for re-encryption in background). */
export async function getActiveWalletEncrypted(): Promise<EncryptedWalletData | null> {
  const entries = await getWalletEntries();
  const name = await getActiveWalletName();
  if (!name) return null;
  const entry = entries.find((e) => e.name === name);
  return entry?.encrypted ?? null;
}

/** Import an existing private key into a named account. Encrypts and stores it. */
export async function importKey(privateKeyHex: string, password: string, accountName?: string): Promise<string> {
  const normalized = privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`;
  const wallet = new Wallet(normalized);

  const entries = await getWalletEntries();
  const name = accountName ?? `Account ${entries.length + 1}`;

  // Check for duplicate name
  if (entries.some((e) => e.name === name)) {
    throw new Error(`Account name "${name}" already exists.`);
  }

  const encrypted = await encryptKey(normalized, password);
  entries.push({ name, address: wallet.address, encrypted });
  await setWalletEntries(entries);
  await chrome.storage.local.set({ activeWalletName: name, connectedAddress: wallet.address });

  unlockedWallet = wallet;
  activeAccountName = name;
  return wallet.address;
}

/** Generate a new random private key into a named account. Returns the address + key for backup. */
export async function generateKey(password: string, accountName?: string): Promise<{ address: string; privateKey: string }> {
  const privateKeyHex = hexlify(randomBytes(32));
  const wallet = new Wallet(privateKeyHex);

  const entries = await getWalletEntries();
  const name = accountName ?? `Account ${entries.length + 1}`;

  if (entries.some((e) => e.name === name)) {
    throw new Error(`Account name "${name}" already exists.`);
  }

  const encrypted = await encryptKey(privateKeyHex, password);
  entries.push({ name, address: wallet.address, encrypted });
  await setWalletEntries(entries);
  await chrome.storage.local.set({ activeWalletName: name, connectedAddress: wallet.address });

  unlockedWallet = wallet;
  activeAccountName = name;
  return { address: wallet.address, privateKey: privateKeyHex };
}

/** Decrypt and unlock a specific named account. */
export async function unlock(password: string, rpcUrl?: string, accountName?: string): Promise<Wallet> {
  const entries = await getWalletEntries();
  const name = accountName ?? (await getActiveWalletName());

  if (!name || entries.length === 0) {
    throw new Error("No wallet configured. Import or generate a key first.");
  }

  const entry = entries.find((e) => e.name === name);
  if (!entry) {
    throw new Error(`Account "${name}" not found.`);
  }

  const privateKeyHex = await decryptKey(entry.encrypted, password);
  let wallet = new Wallet(privateKeyHex);

  if (rpcUrl) {
    const provider = new JsonRpcProvider(rpcUrl);
    wallet = wallet.connect(provider) as Wallet;
  }

  unlockedWallet = wallet;
  activeAccountName = name;

  // Update stored address + active name
  await chrome.storage.local.set({ activeWalletName: name, connectedAddress: wallet.address });

  return wallet;
}

/** Switch active account (without unlocking — just updates stored active name). */
export async function switchAccount(accountName: string): Promise<string> {
  const entries = await getWalletEntries();
  const entry = entries.find((e) => e.name === accountName);
  if (!entry) throw new Error(`Account "${accountName}" not found.`);

  // Lock current wallet — new account needs to be unlocked with password
  unlockedWallet = null;
  activeAccountName = accountName;
  await chrome.storage.local.set({ activeWalletName: accountName, connectedAddress: entry.address });
  return entry.address;
}

/** Rename an account. */
export async function renameWallet(oldName: string, newName: string): Promise<void> {
  if (!newName.trim()) throw new Error("Name cannot be empty.");
  const entries = await getWalletEntries();
  if (entries.some((e) => e.name === newName)) throw new Error(`Name "${newName}" already exists.`);
  const entry = entries.find((e) => e.name === oldName);
  if (!entry) throw new Error(`Account "${oldName}" not found.`);
  entry.name = newName;
  await setWalletEntries(entries);
  if (activeAccountName === oldName) {
    activeAccountName = newName;
    await chrome.storage.local.set({ activeWalletName: newName });
  }
}

/** Delete a specific named account. Irreversible. */
export async function deleteWallet(accountName: string): Promise<void> {
  let entries = await getWalletEntries();
  entries = entries.filter((e) => e.name !== accountName);
  await setWalletEntries(entries);

  if (activeAccountName === accountName) {
    unlockedWallet = null;
    activeAccountName = entries.length > 0 ? entries[0].name : null;
    if (activeAccountName) {
      const entry = entries.find((e) => e.name === activeAccountName)!;
      await chrome.storage.local.set({ activeWalletName: activeAccountName, connectedAddress: entry.address });
    } else {
      await chrome.storage.local.remove(["activeWalletName", "connectedAddress"]);
    }
  }
}

/** Get the currently unlocked wallet, or null if locked. */
export function getUnlockedWallet(): Wallet | null {
  return unlockedWallet;
}

/** Get the in-memory active account name. */
export function getActiveAccountNameInMemory(): string | null {
  return activeAccountName;
}

/** Get a signer connected to the given RPC. Throws if wallet is locked. */
export function getSigner(rpcUrl: string): Wallet {
  if (!unlockedWallet) throw new Error("Wallet is locked. Unlock it first.");
  const provider = new JsonRpcProvider(rpcUrl);
  return unlockedWallet.connect(provider) as Wallet;
}

/** Lock the wallet — clears the in-memory key. */
export function lock(): void {
  unlockedWallet = null;
}

/** Check if any wallets are configured. */
export async function isConfigured(): Promise<boolean> {
  const entries = await getWalletEntries();
  if (entries.length > 0) return true;
  // Check legacy key too (before migration)
  const stored = await chrome.storage.local.get(LEGACY_STORAGE_KEY);
  return !!stored[LEGACY_STORAGE_KEY];
}

/** Get the stored address without unlocking. */
export async function getStoredAddress(): Promise<string | null> {
  const stored = await chrome.storage.local.get("connectedAddress");
  return stored.connectedAddress ?? null;
}

/** Permanently delete all wallets. Irreversible. */
export async function clearKey(): Promise<void> {
  unlockedWallet = null;
  activeAccountName = null;
  await chrome.storage.local.remove([WALLETS_KEY, LEGACY_STORAGE_KEY, "connectedAddress", "activeWalletName"]);
}

// -------------------------------------------------------------------------
// Exported encrypt/decrypt for reuse (B1: auto-submit key encryption)
// -------------------------------------------------------------------------

export { encryptKey as encryptPrivateKey, decryptKey as decryptPrivateKey };
