// User secret management for ZK nullifier computation (FP-5).
// userSecret is a 32-byte random value persisted in chrome.storage.local.
// nullifier = Poseidon(userSecret, campaignId, windowId) — computed inside the ZK circuit.

const USER_SECRET_KEY = "zkUserSecret";

/**
 * Returns the user's 32-byte secret, generating and persisting it on first use.
 * The secret is stable across extension restarts and is never sent off-device.
 */
export async function getUserSecret(): Promise<Uint8Array> {
  const stored = await chrome.storage.local.get(USER_SECRET_KEY);
  if (stored[USER_SECRET_KEY]) {
    const hex: string = stored[USER_SECRET_KEY];
    return hexToBytes(hex);
  }
  // Generate fresh secret
  const secret = crypto.getRandomValues(new Uint8Array(32));
  await chrome.storage.local.set({ [USER_SECRET_KEY]: bytesToHex(secret) });
  return secret;
}

/** Returns current window ID: floor(blockNumber / windowBlocks). */
export function computeWindowId(blockNumber: number, windowBlocks: number): bigint {
  return BigInt(Math.floor(blockNumber / windowBlocks));
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const arr = new Uint8Array(h.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
