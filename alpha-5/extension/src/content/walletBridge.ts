// walletBridge.ts — ISOLATED-world content script.
//
// Sits between the MAIN-world `walletInjector` (which exposes
// window.datum to the page) and the extension service worker.
// Pure relay — no business logic. We:
//
//   1. Listen for `datum:rpc:request` postMessages from the page
//      context.
//   2. Forward each via `chrome.runtime.sendMessage` to background's
//      WALLET_PROVIDER_REQUEST handler (origin sourced from
//      `sender.origin` on the receiver side).
//   3. Post the reply back into the page context tagged with our
//      bridge `source` so the injector's response handler picks it
//      up and resolves the right Promise.
//
// We also forward background-pushed events (PROVIDER_EVENT broadcast
// — Stage 2c) into the page so accountsChanged / chainChanged
// behave per EIP-1193. Stage 2b doesn't wire those broadcasts yet;
// the relay-side plumbing is here so the page can subscribe today
// and start receiving as soon as background fires.

(() => {
  if ((window as any).__datumBridgeInstalled) return;
  (window as any).__datumBridgeInstalled = true;

  type PageRequest = {
    source: "datum:page";
    type: "datum:rpc:request";
    requestId: string;
    method: string;
    params: unknown[];
  };

  function isPageRequest(d: unknown): d is PageRequest {
    if (!d || typeof d !== "object") return false;
    const o = d as Record<string, unknown>;
    return (
      o.source === "datum:page" &&
      o.type === "datum:rpc:request" &&
      typeof o.requestId === "string" &&
      typeof o.method === "string"
    );
  }

  function reply(
    requestId: string,
    payload:
      | { ok: true; result: unknown }
      | { ok: false; error: { code: number; message: string; data?: unknown } }
  ): void {
    window.postMessage(
      {
        source: "datum:bridge",
        type: "datum:rpc:response",
        requestId,
        ...payload,
      },
      window.location.origin
    );
  }

  window.addEventListener("message", (evt: MessageEvent) => {
    // We deliberately don't check evt.source — even a same-origin
    // iframe sending bogus messages can only do what the page could
    // already do via window.datum.request(). Background's permission
    // gate enforces every meaningful boundary.
    if (!isPageRequest(evt.data)) return;
    const { requestId, method, params } = evt.data;

    // Forward to background. The background handler uses
    // sender.origin to gate permissions; we don't include any
    // origin in the request body because doing so would let a
    // hostile page lie about it.
    chrome.runtime.sendMessage(
      {
        type: "WALLET_PROVIDER_REQUEST",
        requestId,
        method,
        params,
      },
      (resp) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          reply(requestId, {
            ok: false,
            error: { code: -32603, message: lastErr.message ?? "Background unreachable" },
          });
          return;
        }
        if (!resp || resp.type !== "WALLET_PROVIDER_RESPONSE") {
          reply(requestId, {
            ok: false,
            error: { code: -32603, message: "Malformed provider reply" },
          });
          return;
        }
        if (resp.ok) {
          reply(requestId, { ok: true, result: resp.result });
        } else {
          reply(requestId, {
            ok: false,
            error: resp.error ?? { code: -32603, message: "Unknown provider error" },
          });
        }
      }
    );
  });

  // Subscribe to background-pushed provider events. Stage 2b
  // doesn't broadcast any yet, but installing the listener here means
  // when Stage 2c wires `chrome.tabs.sendMessage` calls for
  // accountsChanged / chainChanged, the page sees them with no
  // additional setup.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type !== "PROVIDER_EVENT") return false;
    window.postMessage(
      {
        source: "datum:bridge",
        type: "datum:event",
        event: msg.event,
        data: msg.data,
      },
      window.location.origin
    );
    return false;
  });
})();

// Force TypeScript to treat this file as a module (it's otherwise an
// IIFE with no top-level imports/exports, which would let dynamic
// import() callers type-check it as a non-module).
export {};
