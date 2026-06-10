// Wallet TX history — per-(account address) ring buffer of the
// last 50 transactions the wallet has broadcast. Persisted to
// chrome.storage.local so it survives popup close/reopen.
//
// Records the local view: what the wallet sent + the hash. On-chain
// confirmation status isn't tracked here (pine doesn't give us a
// stable "succeeded" / "reverted" flag for every hash); we treat
// "broadcast accepted" as the recorded event and let the user
// cross-link to the explorer for the on-chain status.

const STORAGE_PREFIX = "wallet:tx-history:";
const MAX_ENTRIES = 50;

export type WalletTxEntry = {
  /// 0x-prefixed transaction hash.
  hash: string;
  /// What kind of TX the wallet broadcast. "send" for native
  /// transfers; "dapp" for arbitrary eth_sendTransaction calls
  /// routed through the EIP-1193 provider.
  kind: "send" | "dapp";
  /// Recipient address (lowercased).
  to: string;
  /// Value in wei as a decimal string (so it survives JSON).
  /// Empty string for zero-value calls.
  valueWei?: string;
  /// Origin that initiated the TX, for "dapp" kinds. Empty for "send".
  origin?: string;
  /// Optional short label — populated for known DATUM actions when
  /// recordWalletTx() is called with one.
  label?: string;
  /// Ms timestamp.
  ts: number;
};

function key(address: string): string {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

export async function getWalletTxHistory(address: string): Promise<WalletTxEntry[]> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
  try {
    const res = await chrome.storage.local.get(key(address));
    const raw = res[key(address)];
    if (!Array.isArray(raw)) return [];
    return raw.filter(isEntry).sort((a, b) => b.ts - a.ts).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export async function recordWalletTx(
  address: string,
  entry: Omit<WalletTxEntry, "ts"> & { ts?: number }
): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  const ts = entry.ts ?? Date.now();
  const next: WalletTxEntry = {
    hash: entry.hash,
    kind: entry.kind,
    to: entry.to.toLowerCase(),
    valueWei: entry.valueWei,
    origin: entry.origin,
    label: entry.label,
    ts,
  };
  try {
    const existing = await getWalletTxHistory(address);
    // Dedupe by hash.
    const filtered = existing.filter((e) => e.hash !== next.hash);
    const merged = [next, ...filtered].slice(0, MAX_ENTRIES);
    await chrome.storage.local.set({ [key(address)]: merged });
  } catch {
    /* swallow — chrome.storage may be unavailable in test contexts */
  }
}

export async function clearWalletTxHistory(address: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    await chrome.storage.local.remove(key(address));
  } catch {/* swallow */}
}

function isEntry(x: unknown): x is WalletTxEntry {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as WalletTxEntry).hash === "string" &&
    typeof (x as WalletTxEntry).to === "string" &&
    typeof (x as WalletTxEntry).ts === "number" &&
    typeof (x as WalletTxEntry).kind === "string"
  );
}
