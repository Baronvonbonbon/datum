// walletInjector.ts — MAIN-world content script.
//
// Runs in the page's JavaScript context (NOT the extension's
// isolated content-script world) so it can attach `window.datum`
// where dApps can see it. The page can call our methods directly;
// we relay them to the ISOLATED-world walletBridge via
// window.postMessage and the bridge forwards to background.
//
// Discovery:
//   - EIP-6963 announceProvider event broadcast on init + on
//     request. The DATUM-aware webapp filters by `rdns` and
//     never reaches MetaMask's window.ethereum.
//   - Legacy window.datum binding kept for ergonomic ethers v6
//     usage (new ethers.BrowserProvider(window.datum)).
//
// We deliberately do NOT touch window.ethereum. dApps that only
// know that key can install MetaMask; we coexist.
//
// MV3 / Manifest world: this file is loaded with `world: "MAIN"` in
// the manifest's content_scripts entry. It executes in the page
// context with no access to chrome.runtime.

(() => {
  // Idempotent — Chrome re-injects content scripts on prerender /
  // history navigation in some edge cases; the second invocation
  // must noop.
  if ((window as any).datum) return;

  type Listener = (data: unknown) => void;
  type PendingMsg = {
    resolve: (result: unknown) => void;
    reject: (error: ProviderRpcError) => void;
  };

  type ProviderRpcError = {
    code: number;
    message: string;
    data?: unknown;
  };

  const REQUEST_TIMEOUT_MS = 60_000;

  const _pending = new Map<string, PendingMsg>();
  const _listeners = new Map<string, Set<Listener>>();

  function newId(): string {
    // Math.random + Date.now is enough — collisions across the same
    // page are improbable, and we use a Map for lookup so duplicates
    // would only blow up if both fire concurrently.
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function emit(event: string, data: unknown): void {
    const set = _listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(data);
      } catch (err) {
        console.error("[DATUM provider] event listener threw", err);
      }
    }
  }

  function request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T> {
    if (!args || typeof args !== "object" || typeof args.method !== "string") {
      return Promise.reject({
        code: -32602,
        message: "Invalid request — expected { method, params? }",
      });
    }
    const requestId = newId();
    return new Promise((resolve, reject) => {
      _pending.set(requestId, {
        resolve: resolve as (r: unknown) => void,
        reject: reject as (e: ProviderRpcError) => void,
      });
      // Auto-cancel after the global timeout so a dropped bridge or
      // killed service worker doesn't leak the Promise.
      const timer = setTimeout(() => {
        if (_pending.has(requestId)) {
          _pending.delete(requestId);
          reject({
            code: 4001,
            message: "DATUM provider request timed out",
          });
        }
      }, REQUEST_TIMEOUT_MS);
      // window.postMessage to the ISOLATED-world bridge. The page can
      // see this too (and so can other content scripts), so we tag
      // every message with `source: "datum:page"` and verify origin
      // on the receiving end.
      window.postMessage(
        {
          source: "datum:page",
          type: "datum:rpc:request",
          requestId,
          method: args.method,
          params: args.params ?? [],
        },
        window.location.origin
      );
      // Hold the timer so the response handler can clear it.
      _timers.set(requestId, timer);
    });
  }

  const _timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Listen for replies from the bridge.
  window.addEventListener("message", (evt: MessageEvent) => {
    const d = evt.data;
    if (!d || typeof d !== "object") return;
    // We don't check evt.source — only the bridge tags messages
    // with `source: "datum:bridge"`, and the tag itself is the
    // discriminator. Any page-supplied message that forges the tag
    // would only resolve requests the page itself initiated, which
    // is no different than the page calling request() with bogus
    // params.

    // We accept two shapes: rpc-response (reply to a request we
    // issued) and event (background-driven push, e.g. accountsChanged).
    if (d.source === "datum:bridge" && d.type === "datum:rpc:response") {
      const pending = _pending.get(d.requestId);
      if (!pending) return;
      _pending.delete(d.requestId);
      const timer = _timers.get(d.requestId);
      if (timer) {
        clearTimeout(timer);
        _timers.delete(d.requestId);
      }
      if (d.ok) {
        pending.resolve(d.result);
      } else {
        // Surface the EIP-1193 error shape — `code`, `message`, `data`.
        pending.reject(
          d.error ?? { code: -32603, message: "Unknown provider error" }
        );
      }
      return;
    }
    if (d.source === "datum:bridge" && d.type === "datum:event") {
      // Background notifies us of EIP-1193 events (accountsChanged,
      // chainChanged, etc.). We re-emit to local listeners.
      if (typeof d.event === "string") {
        emit(d.event, d.data);
      }
      return;
    }
  });

  function on(event: string, listener: Listener): void {
    const set = _listeners.get(event) ?? new Set();
    set.add(listener);
    _listeners.set(event, set);
  }

  function removeListener(event: string, listener: Listener): void {
    const set = _listeners.get(event);
    if (set) set.delete(listener);
  }

  // ── EIP-1193 provider object ──────────────────────────────────────

  const provider = {
    /// EIP-1193 — the canonical entry point.
    request,
    /// Event subscriptions. We mimic EventEmitter-ish surface so
    /// existing dApp code (ethers.BrowserProvider, wagmi connectors,
    /// etc.) finds what it expects.
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    /// EIP-1193 says providers SHOULD expose a `chainId` getter, but
    /// it's actually `eth_chainId` via request that's load-bearing.
    /// Most libs call request; we leave the bare property out to keep
    /// the surface tight.
    /// Discovery hint for DATUM-aware code paths.
    isDatum: true,
  };

  Object.freeze(provider);
  (window as any).datum = provider;

  // ── EIP-6963 announce ─────────────────────────────────────────────

  // Stable UUID per page-load. dApps key off this to track our
  // provider across re-announces.
  const providerUuid = newId();

  // Minimal SVG-based icon. Mirrors the brand mark used elsewhere.
  // Stays inline so the page can render it without a CSP exception.
  const iconSvg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>" +
    "<path d='M2 5 L2 2 L5 2 M11 2 L14 2 L14 5 M14 11 L14 14 L11 14 M5 14 L2 14 L2 11' " +
    "fill='none' stroke='%23ffffff' stroke-width='1.4' stroke-linecap='round'/>" +
    "<circle cx='8' cy='8' r='2.6' fill='%23E6007A'/>" +
    "</svg>";

  const info = Object.freeze({
    uuid: providerUuid,
    name: "DATUM",
    icon: "data:image/svg+xml;utf8," + iconSvg,
    rdns: "io.javcon.datum",
  });

  function announce(): void {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info, provider }),
      })
    );
  }

  // Re-announce on any future `eip6963:requestProvider`. dApps fire
  // this when they boot up in case they missed our initial announce.
  window.addEventListener("eip6963:requestProvider", announce);

  // Initial announce. We do it after the current task so any dApp
  // that subscribes on the same tick can still receive us.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announce, { once: true });
  } else {
    setTimeout(announce, 0);
  }
})();

// Force TypeScript to treat this file as a module so the test
// suite's dynamic import() resolves cleanly.
export {};
