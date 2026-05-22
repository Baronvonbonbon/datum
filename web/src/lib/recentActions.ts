// Per-dashboard recent-action shortcut store.
//
// Each dashboard role (me / publisher / advertiser / governance /
// protocol / token / identity) keeps its own list of the most
// recent actions a wallet has taken on that surface, persisted to
// localStorage so the chip strip survives reloads.
//
// Actions are keyed by `{ role, address }` — the same wallet on a
// different role sees a different list, and a different wallet on
// the same role sees a different list. Anonymous (no wallet) keeps
// a single "anon" bucket so visitors still see the chips for
// public-page actions they triggered before connecting.
//
// Storage cap: 5 actions per (role, address) bucket. Older entries
// are dropped on insert.

export type Role =
  | "me"
  | "publisher"
  | "advertiser"
  | "governance"
  | "protocol"
  | "token"
  | "identity";

export type RecentAction = {
  /// Display label — short imperative phrase ("Voted aye", "Filed appeal").
  label: string;
  /// Router target the chip links to (usually the sub-page that
  /// performed the action, or a detail view).
  route: string;
  /// Optional TX hash for explorer cross-links + dedupe.
  txHash?: string;
  /// Ms timestamp of when the action was recorded.
  ts: number;
};

const STORAGE_PREFIX = "datum:recent-actions:";
const MAX_PER_BUCKET = 5;

function bucketKey(role: Role, address: string | null): string {
  const addr = address ? address.toLowerCase() : "anon";
  return `${STORAGE_PREFIX}${role}:${addr}`;
}

export function getRecentActions(role: Role, address: string | null): RecentAction[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(bucketKey(role, address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isAction)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_PER_BUCKET);
  } catch {
    return [];
  }
}

export function recordAction(
  role: Role,
  address: string | null,
  action: Omit<RecentAction, "ts"> & { ts?: number }
): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  const ts = action.ts ?? Date.now();
  const next: RecentAction = {
    label: action.label,
    route: action.route,
    txHash: action.txHash,
    ts,
  };
  try {
    const existing = getRecentActions(role, address);
    // Dedupe by txHash if present; otherwise by (label + route).
    const filtered = existing.filter((a) =>
      next.txHash
        ? a.txHash !== next.txHash
        : !(a.label === next.label && a.route === next.route)
    );
    const merged = [next, ...filtered].slice(0, MAX_PER_BUCKET);
    window.localStorage.setItem(bucketKey(role, address), JSON.stringify(merged));
    // Notify any subscribers so live chip strips can re-read.
    for (const sub of subscribers) {
      try {
        sub();
      } catch (err) {
        // Best-effort; one subscriber blowing up shouldn't stop the others.
        // eslint-disable-next-line no-console
        console.warn("[recentActions] subscriber threw", err);
      }
    }
  } catch {
    /* swallow — localStorage may be full / blocked */
  }
}

export function clearRecentActions(role: Role, address: string | null): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.removeItem(bucketKey(role, address));
    for (const sub of subscribers) sub();
  } catch {/* swallow */}
}

const subscribers = new Set<() => void>();

export function subscribeRecentActions(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function isAction(x: unknown): x is RecentAction {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as RecentAction).label === "string" &&
    typeof (x as RecentAction).route === "string" &&
    typeof (x as RecentAction).ts === "number"
  );
}
