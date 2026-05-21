// Provider-event broadcasting.
//
// Whenever the wallet's externally-observable state changes (unlock,
// lock, active-account switch, reset), we push EIP-1193 events to
// every permitted dApp page so its window.datum.on listeners fire.
//
// Channel: `chrome.tabs.sendMessage(tabId, { type: "PROVIDER_EVENT",
// event, data })` → walletBridge in that tab → window.postMessage to
// the page → window.datum's event emitter.
//
// Privacy posture: we only broadcast to tabs whose origin is in the
// permissions allowlist. A page that hasn't been granted access
// should not learn about account changes — that would let an
// unauthenticated page silently track activity by registering an
// accountsChanged listener.

import { isPermitted, normalizeOrigin } from "./permissions";

/// Supported event names. Mirrors the EIP-1193 set we surface
/// through window.datum.
export type ProviderEvent =
  | "accountsChanged"
  | "chainChanged"
  | "connect"
  | "disconnect";

/// Broadcast `event` with `data` to every permitted tab.
///
/// Failures (invalid tab, missing content script, etc.) are logged
/// but never bubbled — a single tab being weird shouldn't block the
/// state change that triggered the broadcast.
export async function broadcastProviderEvent(
  event: ProviderEvent,
  data: unknown
): Promise<void> {
  // chrome.tabs is typed loosely — `query` returns Tab[] but each
  // tab may have a missing id (e.g. devtools tabs). Filter early.
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    console.warn("[wallet] broadcastProviderEvent: tabs.query failed", err);
    return;
  }

  for (const tab of tabs) {
    if (!tab.id) continue;
    const url = tab.url ?? tab.pendingUrl;
    const origin = normalizeOrigin(url ?? "");
    if (!origin) continue;
    // Don't pay the permissions-lookup cost for tabs whose URLs
    // can't possibly be permitted (chrome://, file://, etc. already
    // filtered by normalizeOrigin).
    if (!(await isPermitted(origin))) continue;
    // sendMessage is fire-and-forget here; if the tab has no
    // walletBridge installed (e.g. content scripts disabled) we
    // just lose the broadcast for that tab. That's acceptable —
    // the page will catch up on its next request().
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "PROVIDER_EVENT",
        event,
        data,
      });
    } catch {
      // Common case: the content script isn't loaded in this tab
      // yet (e.g. brand-new tab still loading), or the tab is in a
      // state where messaging is disabled. Ignore.
    }
  }
}

/// Convenience helpers — they centralize the event shape so callers
/// (unlock.ts, signing.ts, etc.) don't have to remember the EIP-1193
/// payload conventions for each event.

export async function broadcastAccountsChanged(addresses: string[]): Promise<void> {
  // EIP-1193 says the payload is an array of addresses (most-recent
  // account first). We always send a single-item array for the
  // active account (or [] for locked).
  await broadcastProviderEvent("accountsChanged", addresses);
}

export async function broadcastChainChanged(chainIdHex: string): Promise<void> {
  await broadcastProviderEvent("chainChanged", chainIdHex);
}

export async function broadcastConnect(chainIdHex: string): Promise<void> {
  // EIP-1193 `connect` payload is { chainId: hex }.
  await broadcastProviderEvent("connect", { chainId: chainIdHex });
}

export async function broadcastDisconnect(message: string): Promise<void> {
  // EIP-1193 `disconnect` payload is a ProviderRpcError shape.
  // 4900 = Disconnected.
  await broadcastProviderEvent("disconnect", { code: 4900, message });
}
