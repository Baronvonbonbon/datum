// Phishing list management — fetches polkadot.js/phishing deny list and caches locally.
// Also manages a local H160 address blocklist for advertiser/publisher filtering.

const PHISHING_DOMAINS_KEY = "phishingDomains";
const PHISHING_DOMAINS_TS_KEY = "phishingDomainsTs";
const BLOCKED_ADDRESSES_KEY = "blockedAddresses";
const FETCH_INTERVAL_MS = 6 * 3600_000; // 6 hours
const PHISHING_LIST_URL = "https://polkadot.js.org/phishing/all.json";

// XM-8: Baseline phishing domains bundled at build time — ensures deny list is never empty
// even if remote fetch fails on first run. Source: top Polkadot ecosystem phishing domains.
const BASELINE_PHISHING_DOMAINS: string[] = [
  "polkadot-js.online",
  "polkadot-js.co",
  "polkadotjs.live",
  "polkadot-airdrop.org",
  "polkadot-event.com",
  "polkadot-rewards.com",
  "polkadot-bonus.com",
  "polkadot-claim.com",
  "polkadotstaking.com",
  "dot-claim.com",
  "dot-reward.com",
  "kusama-airdrop.com",
  "kusama-rewards.com",
  "polkadot-network.com",
  "moonbeam-airdrop.com",
  "acala-airdrop.com",
];

/**
 * Refresh the phishing domain deny list from polkadot.js if stale (>6h).
 * On fetch failure, keeps stale cache (fail-open for availability).
 */
export async function refreshPhishingList(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([PHISHING_DOMAINS_TS_KEY]);
    const lastFetch = (stored[PHISHING_DOMAINS_TS_KEY] as number) ?? 0;
    if (Date.now() - lastFetch < FETCH_INTERVAL_MS) return;

    const resp = await fetch(PHISHING_LIST_URL, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      console.warn(`[DATUM] Phishing list fetch failed: ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const deny: string[] = Array.isArray(data?.deny) ? data.deny : [];

    await chrome.storage.local.set({
      [PHISHING_DOMAINS_KEY]: deny,
      [PHISHING_DOMAINS_TS_KEY]: Date.now(),
    });
    console.log(`[DATUM] Phishing deny list updated: ${deny.length} domains`);
  } catch (err) {
    console.warn("[DATUM] Phishing list refresh failed:", err);
  }
}

/**
 * Check if a domain (or any parent domain) is in the cached phishing deny list.
 * e.g. "evil.example.com" matches if "example.com" is in the deny list.
 */
export async function isDomainPhishing(domain: string): Promise<boolean> {
  const stored = await chrome.storage.local.get([PHISHING_DOMAINS_KEY]);
  const deny: string[] = stored[PHISHING_DOMAINS_KEY] ?? [];
  // XM-8: Merge baseline domains so list is never empty (fail-closed)
  const merged = deny.length > 0 ? deny : BASELINE_PHISHING_DOMAINS;

  const denySet = new Set(merged.map((d) => d.toLowerCase()));
  const parts = domain.toLowerCase().split(".");

  // Check exact match and all parent domains
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    if (denySet.has(candidate)) return true;
  }
  return false;
}

/**
 * Parse a URL and check if its hostname is on the phishing deny list.
 */
export async function isUrlPhishing(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    return isDomainPhishing(parsed.hostname);
  } catch {
    return false; // invalid URL — handled elsewhere by sanitizeCtaUrl
  }
}

/**
 * Check if an H160 address is in the local blocklist (case-insensitive).
 */
export async function isAddressBlocked(address: string): Promise<boolean> {
  if (!address) return false;
  const stored = await chrome.storage.local.get([BLOCKED_ADDRESSES_KEY]);
  const blocked: string[] = stored[BLOCKED_ADDRESSES_KEY] ?? [];
  const lower = address.toLowerCase();
  return blocked.some((a) => a.toLowerCase() === lower);
}

/** Return current H160 blocklist. */
export async function getBlockedAddresses(): Promise<string[]> {
  const stored = await chrome.storage.local.get([BLOCKED_ADDRESSES_KEY]);
  return stored[BLOCKED_ADDRESSES_KEY] ?? [];
}

/** Add an H160 address to the local blocklist. */
export async function addBlockedAddress(address: string): Promise<void> {
  const current = await getBlockedAddresses();
  const lower = address.toLowerCase();
  if (current.some((a) => a.toLowerCase() === lower)) return; // already present
  current.push(address);
  await chrome.storage.local.set({ [BLOCKED_ADDRESSES_KEY]: current });
}

/** Remove an H160 address from the local blocklist. */
export async function removeBlockedAddress(address: string): Promise<void> {
  const current = await getBlockedAddresses();
  const lower = address.toLowerCase();
  const filtered = current.filter((a) => a.toLowerCase() !== lower);
  await chrome.storage.local.set({ [BLOCKED_ADDRESSES_KEY]: filtered });
}
