// Workstream A — message-routing contract test (anti-drift gate).
//
// Background: the demo daemon (web/src/lib/extensionDaemon.ts) used to hand-mirror
// the extension background's 60-arm message switch. When the two drifted, the demo
// silently no-oped a message the popup/content actually sends — the exact class of
// bug that broke PINE_INIT/PINE_RPC_REQUEST and the WALLET_CONNECTED handshake.
//
// Phases 1–3 are now landed. The single switch lives in background/router.ts
// (`routeMessage(msg, sender, env)`), which BOTH the service worker and the demo
// daemon call. The daemon keeps a *thin pre-router* (its own switch) only for
// genuinely demo-only or intentionally-overridden messages, and delegates every
// other type to routeMessage via demoEnv. Drift is now structurally impossible for
// delegated messages: a new background case is handled by the demo the moment it's
// added to routeMessage, because the daemon falls through to it.
//
// This test pins the two remaining invariants:
//   1. The daemon still delegates to the shared router (import + call present).
//   2. The daemon's pre-router stays honest: every case it intercepts is a known
//      demo-only message or a justified override (DEMO_PRE_ROUTER, each with a
//      reason). A new pre-router case without a reason fails the build — that's the
//      guard against the demo silently re-accumulating a full mirror.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROUTER = resolve(__dirname, "../src/background/router.ts");
const DAEMON = resolve(__dirname, "../../../web/src/lib/extensionDaemon.ts");

/** Extract `case "FOO":` switch labels from a source file. */
function caseLabels(file: string): Set<string> {
  const src = readFileSync(file, "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/case\s+"([A-Z_]+)"/g)) out.add(m[1]);
  return out;
}

// The cases the demo daemon legitimately intercepts BEFORE delegating to the shared
// router — each with a reason. Two kinds:
//   • demo-only messages with no background equivalent (in-page pine + offscreen-
//     wallet emulation, the local gasless-relay settle path, the demo relay signer);
//   • intentional overrides of a real background case where the demo behaves
//     differently on purpose.
// Anything in the daemon's switch that is NOT here fails the test — that prevents the
// pre-router from silently growing back into a hand-maintained mirror.
const DEMO_PRE_ROUTER: Record<string, string> = {
  // In-page pine emulation (the real extension runs smoldot in an offscreen doc).
  PINE_INIT: "demo has no offscreen smoldot — routes pine init to the page",
  PINE_RPC_REQUEST: "demo has no offscreen smoldot — routes pine RPC to the page",
  // Offscreen wallet ops — the real SW forwards these to the offscreen document;
  // the demo runs the same handlers in-page (no offscreen doc exists).
  WALLET_CREATE: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_IMPORT: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_UNLOCK: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_LOCK: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_IS_UNLOCKED: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_ADD_HD_ACCOUNT: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_ADD_IMPORTED: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_SET_ACTIVE: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_REENCRYPT: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_SIGN_TRANSACTION: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_SIGN_TYPED_DATA: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  WALLET_PERSONAL_SIGN: "offscreen wallet op run in-page (no offscreen doc in the demo)",
  // The demo plays the relay/publisher locally — these have no SW equivalent.
  DAEMON_SUBMIT_CLAIMS: "demo-only local gasless-relay settleClaims path",
  DRAIN_CLAIMS_ONLY: "demo-only: drain aggregated raw impressions into the queue",
  GET_RELAY_SIGNER: "demo-only: read the in-page demo relay signer address",
  SET_RELAY_SIGNER_KEY: "demo-only: override the in-page demo relay signer key",
  SET_CLAIM_BUILDER_MODE: "demo-only: toggle per-impression vs aggregated building",
  // Intentional overrides of real background cases (demo behaves differently).
  IMPRESSION_RECORDED: "override: demo aggregated mode + no rate-limit (delegates per-impression to the real claimBuilder)",
  SETTINGS_UPDATED: "override: demo persists msg.settings (no chrome.alarms to re-arm)",
  CHECK_PUBLISHER_ALLOWLIST: "override: demo conservatively returns allowlistEnabled=false",
  REPORT_PAGE: "override: demo reports are a no-op (no on-chain report tx)",
  REPORT_AD: "override: demo reports are a no-op (no on-chain report tx)",
  // REQUEST_PUBLISHER_ATTESTATION now delegates to the shared router →
  // demoEnv.requestAttestation (Diana key, correct alpha-5 typehash), so it is no
  // longer a daemon pre-router case.
};

describe("message-routing parity (one router, shared by SW + demo)", () => {
  const routerCases = caseLabels(ROUTER);
  const daemonCases = caseLabels(DAEMON);
  const daemonSrc = readFileSync(DAEMON, "utf8");

  it("the shared router dispatches a non-trivial switch", () => {
    expect(routerCases.size).toBeGreaterThan(40);
  });

  it("the daemon delegates to the shared routeMessage (import + call present)", () => {
    expect(daemonSrc).toMatch(/import\s*\{[^}]*\brouteMessage\b[^}]*\}\s*from\s*["']@ext\/background\/router["']/);
    expect(daemonSrc).toMatch(/routeMessage\s*\(/);
  });

  it("every daemon pre-router case is a justified demo-only/override (no silent re-mirroring)", () => {
    const unjustified = [...daemonCases].filter((t) => !(t in DEMO_PRE_ROUTER)).sort();
    // If this fails: the daemon added a switch case that isn't delegated to the shared
    // router. Either delegate it (delete the case), or — if the demo genuinely must
    // handle it differently — add it to DEMO_PRE_ROUTER with a reason.
    expect(unjustified).toEqual([]);
  });

  it("DEMO_PRE_ROUTER has no stale entries (each is a real daemon pre-router case)", () => {
    const stale = Object.keys(DEMO_PRE_ROUTER).filter((t) => !daemonCases.has(t)).sort();
    // If this fails: a pre-router case was deleted (now delegated) — drop it from
    // DEMO_PRE_ROUTER so the allowlist stays honest.
    expect(stale).toEqual([]);
  });
});
