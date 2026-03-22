// P6: Claim state portability — encrypted export/import of claim queue + chain state.
// Uses AES-256-GCM with key derived from wallet signature of a fixed message.
// This allows users to migrate claim state between browsers/devices securely.

import { Wallet, getBytes } from "ethers";
import { ClaimChainState } from "./types";

// Queue-stored claim shape (includes userAddress, bigints as strings)
interface QueuedClaim {
  campaignId: string;
  publisher: string;
  impressionCount: string;
  clearingCpmPlanck: string;
  nonce: string;
  previousClaimHash: string;
  claimHash: string;
  zkProof: string;
  userAddress: string;
}

const EXPORT_VERSION = 1;
const SIGN_MESSAGE = "DATUM Claim Export Authentication";
const CHAIN_STATE_PREFIX = "chainState:";
const QUEUE_KEY = "claimQueue";

export interface ClaimExportData {
  version: number;
  userAddress: string;
  chains: Record<string, ClaimChainState>;  // keyed by campaignId
  queue: QueuedClaim[];
  exportTimestamp: number;
}

export interface ImportResult {
  imported: boolean;
  chainsImported: number;
  claimsImported: number;
  skippedStale: number;
  error?: string;
}

/**
 * Export all claim state for the current user as an encrypted Blob.
 * Encryption key derived from wallet signature of fixed message.
 */
export async function exportClaims(signer: Wallet): Promise<Blob> {
  const userAddress = await signer.getAddress();

  // Collect all chain states for this user
  const allStorage = await chrome.storage.local.get(null);
  const chains: Record<string, ClaimChainState> = {};
  const prefix = `${CHAIN_STATE_PREFIX}${userAddress}:`;

  for (const [key, value] of Object.entries(allStorage)) {
    if (key.startsWith(prefix)) {
      const campaignId = key.slice(prefix.length);
      chains[campaignId] = value as ClaimChainState;
    }
  }

  // Collect queued claims for this user
  const queueData = allStorage[QUEUE_KEY] as QueuedClaim[] | undefined;
  const queue = (queueData ?? []).filter(
    (c: QueuedClaim) => c.userAddress === userAddress
  );

  const exportData: ClaimExportData = {
    version: EXPORT_VERSION,
    userAddress,
    chains,
    queue,
    exportTimestamp: Date.now(),
  };

  // Derive encryption key from wallet signature
  const signature = await signer.signMessage(SIGN_MESSAGE);
  const encrypted = await encryptData(JSON.stringify(exportData), signature);

  return new Blob([encrypted], { type: "application/octet-stream" });
}

/**
 * Import claim state from an encrypted file.
 * Validates user address match and merges with existing state (keeps higher nonce).
 */
export async function importClaims(
  file: File,
  signer: Wallet,
  onChainNonceFn?: (userAddress: string, campaignId: string) => Promise<number>
): Promise<ImportResult> {
  const userAddress = await signer.getAddress();

  // Read file
  const arrayBuffer = await file.arrayBuffer();
  const encrypted = new Uint8Array(arrayBuffer);

  // Derive decryption key from wallet signature (same fixed message)
  const signature = await signer.signMessage(SIGN_MESSAGE);

  let decrypted: string;
  try {
    decrypted = await decryptData(encrypted, signature);
  } catch {
    return { imported: false, chainsImported: 0, claimsImported: 0, skippedStale: 0, error: "Decryption failed. Wrong wallet or corrupted file." };
  }

  let exportData: ClaimExportData;
  try {
    exportData = JSON.parse(decrypted);
  } catch {
    return { imported: false, chainsImported: 0, claimsImported: 0, skippedStale: 0, error: "Invalid export file format." };
  }

  // Validate version
  if (exportData.version !== EXPORT_VERSION) {
    return { imported: false, chainsImported: 0, claimsImported: 0, skippedStale: 0, error: `Unsupported export version: ${exportData.version}` };
  }

  // Validate user address match
  if (exportData.userAddress.toLowerCase() !== userAddress.toLowerCase()) {
    return { imported: false, chainsImported: 0, claimsImported: 0, skippedStale: 0, error: `Address mismatch: export is for ${exportData.userAddress}` };
  }

  let chainsImported = 0;
  let claimsImported = 0;
  let skippedStale = 0;

  // Merge chain states (keep higher nonce)
  for (const [campaignId, importedChain] of Object.entries(exportData.chains)) {
    const key = `${CHAIN_STATE_PREFIX}${userAddress}:${campaignId}`;
    const existing = await chrome.storage.local.get(key);
    const existingChain = existing[key] as ClaimChainState | undefined;

    // Check on-chain nonce if function provided
    if (onChainNonceFn) {
      try {
        const onChainNonce = await onChainNonceFn(userAddress, campaignId);
        if (importedChain.lastNonce <= onChainNonce) {
          skippedStale++;
          continue; // imported state is behind on-chain
        }
      } catch {
        // RPC failure — allow import but warn
      }
    }

    // Keep higher nonce
    if (!existingChain || importedChain.lastNonce > existingChain.lastNonce) {
      await chrome.storage.local.set({ [key]: importedChain });
      chainsImported++;
    } else {
      skippedStale++;
    }
  }

  // Merge queue (append claims with nonces not already present)
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const existingQueue: QueuedClaim[] = stored[QUEUE_KEY] ?? [];

  // Build a set of existing claim keys for dedup
  const existingKeys = new Set(
    existingQueue
      .filter((c) => c.userAddress === userAddress)
      .map((c) => `${c.campaignId}:${c.nonce}`)
  );

  const newClaims: QueuedClaim[] = [];
  for (const claim of exportData.queue) {
    const claimKey = `${claim.campaignId}:${claim.nonce}`;
    if (!existingKeys.has(claimKey)) {
      newClaims.push(claim);
      claimsImported++;
    }
  }

  if (newClaims.length > 0) {
    await chrome.storage.local.set({
      [QUEUE_KEY]: [...existingQueue, ...newClaims],
    });
  }

  return {
    imported: chainsImported > 0 || claimsImported > 0,
    chainsImported,
    claimsImported,
    skippedStale,
  };
}

// ---------------------------------------------------------------------------
// AES-256-GCM encryption helpers
// ---------------------------------------------------------------------------

async function deriveKeyFromSignature(signature: string): Promise<CryptoKey> {
  // Use first 32 bytes of signature as key material, then HKDF-derive an AES key
  const sigBytes = getBytes(signature);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    sigBytes.slice(0, 32),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("datum-claim-export-v1"),
      info: new TextEncoder().encode("aes-key"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptData(plaintext: string, signature: string): Promise<Uint8Array> {
  const key = await deriveKeyFromSignature(signature);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  // Format: [12 bytes IV] [ciphertext]
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

async function decryptData(data: Uint8Array, signature: string): Promise<string> {
  if (data.length < 13) throw new Error("Data too short");

  const key = await deriveKeyFromSignature(signature);
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}
