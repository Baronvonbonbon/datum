// Pending-permission queue.
//
// When an unpermitted origin calls `eth_requestAccounts`, the provider
// handler:
//   1. Calls enqueue({ origin }) here and parks a Promise resolver.
//   2. Sets the extension action badge so the user sees a pending count.
//   3. Optionally opens the popup (chrome.action.openPopup is gated to
//      user-gesture contexts; we set the badge as a fallback signal).
//
// When the user opens the popup:
//   - The PermissionRequest overlay calls peekNext() to fetch the
//     oldest pending entry.
//   - They click Approve → grant(originPerm) → permissions.grantPermission
//     + resolve the awaiting Promise with the active address.
//   - They click Deny → resolve the awaiting Promise with `null`, which
//     the provider translates into `eth_requestAccounts → []`.
//
// State is in-memory only; if the service worker is killed mid-request
// the Promise is lost. The content script that originated the request
// observes a 60s timeout (mirroring the old provider) and surfaces a
// "request timed out" error to the dApp.

const PENDING_TIMEOUT_MS = 60_000;

export type PendingPermission = {
  id: string;
  origin: string;
  /// Unix ms when the pending entry was created. Surface to the user
  /// so they can spot stale requests at a glance.
  createdAt: number;
};

type PendingEntry = {
  pending: PendingPermission;
  resolve: (result: "approved" | "denied" | "timed-out") => void;
  timer: ReturnType<typeof setTimeout>;
};

const _queue: PendingEntry[] = [];

let _badgeListenersInstalled = false;

// ─── Public API ────────────────────────────────────────────────────

/// Enqueue a new pending permission for `origin`. Returns a Promise
/// that resolves once the user has approved or denied (or after the
/// 60s timeout, whichever comes first).
export function enqueue(origin: string): Promise<"approved" | "denied" | "timed-out"> {
  const id = newId();
  const pending: PendingPermission = {
    id,
    origin,
    createdAt: Date.now(),
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Race: the user may have approved milliseconds before the timer
      // fired. removeFromQueue is idempotent.
      removeFromQueue(id);
      resolve("timed-out");
      refreshBadge();
    }, PENDING_TIMEOUT_MS);

    _queue.push({ pending, resolve, timer });
    refreshBadge();
  });
}

/// Snapshot the queue (oldest first). The popup renders the head as the
/// active approval card.
export function peekQueue(): PendingPermission[] {
  return _queue.map((e) => e.pending);
}

/// Resolve a queued entry with "approved" — caller must follow up by
/// granting the permission in permissions.ts.
export function approve(id: string): boolean {
  const entry = _queue.find((e) => e.pending.id === id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  removeFromQueue(id);
  entry.resolve("approved");
  refreshBadge();
  return true;
}

/// Resolve a queued entry with "denied".
export function deny(id: string): boolean {
  const entry = _queue.find((e) => e.pending.id === id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  removeFromQueue(id);
  entry.resolve("denied");
  refreshBadge();
  return true;
}

/// Resolve every pending entry as denied. Used on wallet lock / reset
/// so awaiting Promises don't dangle indefinitely.
export function denyAll(): number {
  const n = _queue.length;
  while (_queue.length) {
    const entry = _queue[0];
    clearTimeout(entry.timer);
    _queue.shift();
    entry.resolve("denied");
  }
  refreshBadge();
  return n;
}

// ─── Internals ─────────────────────────────────────────────────────

function removeFromQueue(id: string): void {
  const i = _queue.findIndex((e) => e.pending.id === id);
  if (i >= 0) _queue.splice(i, 1);
}

let _idCounter = 0;
function newId(): string {
  _idCounter = (_idCounter + 1) | 0;
  return `perm-${Date.now()}-${_idCounter}`;
}

/// Sync the chrome.action badge with the queue depth. "1+" cap so the
/// badge stays readable when multiple sites are queued.
function refreshBadge(): void {
  if (!_badgeListenersInstalled && typeof chrome !== "undefined" && chrome.action) {
    _badgeListenersInstalled = true;
  }
  if (typeof chrome === "undefined" || !chrome.action) return;
  const n = _queue.length;
  const text = n === 0 ? "" : n > 9 ? "9+" : String(n);
  chrome.action.setBadgeText({ text }).catch(() => undefined);
  if (n > 0) {
    chrome.action.setBadgeBackgroundColor({ color: "#E6007A" }).catch(() => undefined);
  }
}

// ─── Test surface ──────────────────────────────────────────────────

export const __test = {
  reset(): void {
    while (_queue.length) {
      const e = _queue[0];
      clearTimeout(e.timer);
      _queue.shift();
    }
    _idCounter = 0;
  },
  queueLength(): number {
    return _queue.length;
  },
};
