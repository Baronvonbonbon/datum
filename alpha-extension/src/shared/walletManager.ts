// Embedded wallet manager for DATUM extension.
// Manages a single EVM private key encrypted at rest with AES-256-GCM.
// The key is derived from a user password via PBKDF2.
// The unlocked ethers.Wallet is held in memory only — cleared on lock/popup close.
//
// This exists because Chrome extension popups cannot access window.ethereum
// or window.injectedWeb3 from external wallet extensions (Polkadot.js, SubWallet).
// Post-MVP: WalletConnect or iframe bridge will add external wallet support.
//
// ⚠ WARNING: TESTING ONLY — NO SECURITY GUARANTEES
// This embedded wallet is for development and testing purposes only.
// Do NOT import or generate keys that control real funds.
// The encryption is best-effort but has NOT been independently audited.
// Use of this software is entirely at your own risk.

import { Wallet, JsonRpcProvider, randomBytes, hexlify, getBytes } from "ethers";

const STORAGE_KEY = "datumEncryptedWallet";
const PBKDF2_ITERATIONS = 310_000; // OWASP recommendation for SHA-256

interface EncryptedWalletData {
  ciphertext: string; // hex-encoded AES-GCM ciphertext
  iv: string;         // hex-encoded 12-byte IV
  salt: string;       // hex-encoded 32-byte salt
}

// In-memory state — lost on popup close or service worker restart
let unlockedWallet: Wallet | null = null;

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
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
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
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(privateKeyHex)
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
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

/** Import an existing private key (hex, with or without 0x prefix). Encrypts and stores it. */
export async function importKey(privateKeyHex: string, password: string): Promise<string> {
  // Validate key by creating a wallet
  const normalized = privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`;
  const wallet = new Wallet(normalized);

  const encrypted = await encryptKey(normalized, password);
  await chrome.storage.local.set({ [STORAGE_KEY]: encrypted });

  unlockedWallet = wallet;
  return wallet.address;
}

/** Generate a new random private key. Encrypts and stores it. Returns the address. */
export async function generateKey(password: string): Promise<{ address: string; privateKey: string }> {
  const privateKeyHex = hexlify(randomBytes(32));
  const wallet = new Wallet(privateKeyHex);

  const encrypted = await encryptKey(privateKeyHex, password);
  await chrome.storage.local.set({ [STORAGE_KEY]: encrypted });

  unlockedWallet = wallet;
  // Return private key so the user can back it up — shown once, never again
  return { address: wallet.address, privateKey: privateKeyHex };
}

/** Decrypt the stored key with the user's password. Returns the connected ethers.Wallet. */
export async function unlock(password: string, rpcUrl?: string): Promise<Wallet> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const data = stored[STORAGE_KEY] as EncryptedWalletData | undefined;
  if (!data) throw new Error("No wallet configured. Import or generate a key first.");

  const privateKeyHex = await decryptKey(data, password);
  let wallet = new Wallet(privateKeyHex);

  if (rpcUrl) {
    const provider = new JsonRpcProvider(rpcUrl);
    wallet = wallet.connect(provider) as Wallet;
  }

  unlockedWallet = wallet;
  return wallet;
}

/** Get the currently unlocked wallet, or null if locked. */
export function getUnlockedWallet(): Wallet | null {
  return unlockedWallet;
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

/** Check if an encrypted key is stored (wallet has been set up). */
export async function isConfigured(): Promise<boolean> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return !!stored[STORAGE_KEY];
}

/** Get the stored address without unlocking (reads from chrome.storage.local connectedAddress). */
export async function getStoredAddress(): Promise<string | null> {
  const stored = await chrome.storage.local.get("connectedAddress");
  return stored.connectedAddress ?? null;
}

/** Permanently delete the encrypted key. Irreversible. */
export async function clearKey(): Promise<void> {
  unlockedWallet = null;
  await chrome.storage.local.remove([STORAGE_KEY, "connectedAddress"]);
}

// -------------------------------------------------------------------------
// Exported encrypt/decrypt for reuse (B1: auto-submit key encryption)
// -------------------------------------------------------------------------

export { encryptKey as encryptPrivateKey, decryptKey as decryptPrivateKey };
export type { EncryptedWalletData };
