// Workstream A, Phase 0 — message-routing contract test (anti-drift gate).
//
// The demo daemon (web/src/lib/extensionDaemon.ts) mirrors the extension background's
// message router by hand. When they drift, the demo silently no-ops a message the
// popup/content actually sends — the exact class of bug that broke PINE_INIT/
// PINE_RPC_REQUEST and the WALLET_CONNECTED handshake this cycle.
//
// This test pins the invariant: every protocol message type the real background
// handler dispatches must ALSO be handled by the demo daemon — unless it's on the
// curated SW_ONLY allowlist (with a reason). Adding a new background case without a
// daemon handler (or an allowlist entry) fails the build. It's the regression gate
// the full router extraction (Phases 1–3) will preserve once both call one routeMessage.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BG = resolve(__dirname, "../src/background/index.ts");
const DAEMON = resolve(__dirname, "../../../web/src/lib/extensionDaemon.ts");

/** Extract `case "FOO":` switch labels from a source file. */
function caseLabels(file: string): Set<string> {
  const src = readFileSync(file, "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/case\s+"([A-Z_]+)"/g)) out.add(m[1]);
  return out;
}

// Background-handled types the daemon legitimately doesn't need — each with a reason.
// Anything NOT here must be handled by the daemon, or this test fails.
const SW_ONLY: Record<string, string> = {
  // window.datum EIP-1193 provider — the demo's content bridge doesn't inject the
  // page provider, so these never reach the daemon. (PROVIDER_RPC_PROXY is handled.)
  PROVIDER_CONNECT: "no injected page provider in the demo",
  PROVIDER_DISCONNECT: "no injected page provider in the demo",
  PROVIDER_GET_ADDRESS: "no injected page provider in the demo",
  PROVIDER_GET_CHAIN_ID: "no injected page provider in the demo",
  PROVIDER_PERSONAL_SIGN: "no injected page provider in the demo",
  PROVIDER_SEND_TRANSACTION: "no injected page provider in the demo",
  PROVIDER_SIGN_TYPED_DATA: "no injected page provider in the demo",
  PROVIDER_APPROVAL_RESPONSE: "no injected page provider in the demo",
  // The demo serves view (CPM) impressions only — no click/action claim simulation.
  AD_CLICK: "demo serves view impressions only",
  REMOTE_ACTION: "demo serves view impressions only",
  // Engagement-quality telemetry — non-critical, not wired in the demo.
  ENGAGEMENT_RECORDED: "engagement telemetry not wired in the demo",
  ENGAGEMENT_QUALITY_RESULT: "engagement telemetry not wired in the demo",
  // Impression-log viewer — a popup debug surface not in the demo's tab set.
  GET_IMPRESSION_LOG: "impression-log debug surface not in the demo",
  CLEAR_IMPRESSION_LOG: "impression-log debug surface not in the demo",
  // Earnings one-shot refresh — the demo Earnings tab reads balances via wallet RPC.
  EARNINGS_REFRESH_ONESHOT: "demo earnings reads balance via wallet RPC directly",
  // Nonce-bounded queue pruning — the daemon prunes via removeSettled after settle.
  PRUNE_SETTLED_UP_TO_NONCE: "daemon prunes via removeSettled post-settle",
};

describe("message-routing parity (daemon mirrors background)", () => {
  const bg = caseLabels(BG);
  const daemon = caseLabels(DAEMON);

  it("the background actually dispatches a non-trivial switch", () => {
    expect(bg.size).toBeGreaterThan(40);
  });

  it("daemon handles every background protocol type (or it's an explicit SW-only)", () => {
    const missing = [...bg].filter((t) => !daemon.has(t) && !(t in SW_ONLY)).sort();
    expect(missing).toEqual([]);
  });

  it("SW_ONLY allowlist has no stale entries (each is a real background case the daemon lacks)", () => {
    const stale = Object.keys(SW_ONLY).filter((t) => !bg.has(t) || daemon.has(t)).sort();
    // If this fails: the type was removed from background, or the daemon now handles
    // it — drop it from SW_ONLY so the allowlist stays honest.
    expect(stale).toEqual([]);
  });
});
