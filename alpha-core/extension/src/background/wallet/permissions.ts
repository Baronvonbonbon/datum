// Per-origin permission store for the EIP-1193 provider surface.
//
// Default-deny: an origin can't see the active address, request signing,
// or trigger the popup until the user explicitly grants it via the
// approval flow (background/wallet/permissionQueue.ts).
//
// Storage:
//   chrome.storage.local["walletPermissions"] = OriginPermission[]
//
// We keep this list small (no per-method scope) for stage 2a. Future
// refinements (per-method scopes, expiry, account-bound permissions)
// extend the OriginPermission shape — make any new fields optional so
// old vault snapshots keep deserializing.

const STORAGE_KEY = "walletPermissions";

export type OriginPermission = {
  /// Origin string per the Web Platform: scheme + host + (optional port).
  /// Lower-cased before storage so case-variation doesn't ghost-grant.
  origin: string;
  /// Unix ms at grant time. Surfaced in the SettingsTab list for the
  /// user; not used for expiry (no expiry in stage 2a).
  grantedAt: number;
  /// Lower-case 0x-prefixed address that was active at grant time.
  /// Informational — the provider always returns the *current* active
  /// account on `eth_accounts`. If the user has changed accounts since
  /// the grant, the dApp sees the new one on the next `accountsChanged`
  /// broadcast.
  grantedForAccount: string;
};

// ─── Read ───────────────────────────────────────────────────────────

/// Return all granted origin permissions, sorted by `grantedAt` desc.
export async function listPermissions(): Promise<OriginPermission[]> {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  const v = got[STORAGE_KEY];
  if (!Array.isArray(v)) return [];
  // Defensive normalize — older entries may not have the full shape.
  const normalized = v
    .filter((p) => p && typeof p.origin === "string")
    .map((p: OriginPermission) => ({
      origin: p.origin.toLowerCase(),
      grantedAt: typeof p.grantedAt === "number" ? p.grantedAt : 0,
      grantedForAccount:
        typeof p.grantedForAccount === "string"
          ? p.grantedForAccount.toLowerCase()
          : "",
    }));
  normalized.sort((a, b) => b.grantedAt - a.grantedAt);
  return normalized;
}

/// True iff `origin` is currently granted.
export async function isPermitted(origin: string): Promise<boolean> {
  const target = normalizeOrigin(origin);
  if (!target) return false;
  const all = await listPermissions();
  return all.some((p) => p.origin === target);
}

// ─── Write ──────────────────────────────────────────────────────────

/// Grant `origin` access. Idempotent — re-granting just refreshes
/// `grantedAt` + `grantedForAccount` so the user can see the most
/// recent approval in SettingsTab.
export async function grantPermission(
  origin: string,
  account: string
): Promise<void> {
  const target = normalizeOrigin(origin);
  if (!target) throw new Error("invalid origin");
  const all = await listPermissions();
  const without = all.filter((p) => p.origin !== target);
  without.push({
    origin: target,
    grantedAt: Date.now(),
    grantedForAccount: account.toLowerCase(),
  });
  await chrome.storage.local.set({ [STORAGE_KEY]: without });
}

/// Revoke an origin. Silent no-op if it wasn't granted.
export async function revokePermission(origin: string): Promise<void> {
  const target = normalizeOrigin(origin);
  if (!target) return;
  const all = await listPermissions();
  const next = all.filter((p) => p.origin !== target);
  if (next.length === all.length) return;
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

/// Wipe all origin permissions. Called by resetWallet to ensure no
/// origin keeps lingering access after a vault wipe.
export async function clearAllPermissions(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

// ─── Origin normalization ───────────────────────────────────────────

/// Coerce a sender URL/origin to the canonical scheme+host+port form.
/// Returns null on invalid input — callers should reject the request.
export function normalizeOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    // URL parser handles `https://example.com:8080/path?x` and
    // bare `https://example.com` equally.
    const u = new URL(origin);
    if (!u.protocol.startsWith("http")) {
      // chrome-extension://, file://, ws://: out of scope — only
      // page-context origins make sense here.
      return null;
    }
    // u.origin already strips path/query.
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}
