# Demo Daemon Refactor — single source of truth for message routing

**Status:** plan (not started). **Owner:** Kasey.
**Goal:** stop the in‑browser demo daemon from re‑implementing the extension's
message router by hand, so the two can't drift.

---

## Problem

The `/demo` page runs the *real* extension popup (`web/src/components/ExtensionApplet.tsx`
→ `@ext/popup/App`) backed by an in‑page "daemon" + a `chrome.*` shim
(`web/src/lib/extensionDaemon.ts`, `web/src/lib/chromeShim.ts`). The daemon stands
in for the extension's **service worker + offscreen document**.

The trouble: message routing exists in **two hand‑maintained copies**:

| | file | `case` arms |
|---|---|---|
| real background (service worker) | `alpha-5/extension/src/background/index.ts` → `handleMessage` | **56** |
| demo daemon (in‑page) | `web/src/lib/extensionDaemon.ts` → `handleMessage` | **60** |

They have already drifted, and every drift is a silent demo‑only break:

- **`PINE_INIT` / `PINE_RPC_REQUEST`** — popup Pine reads (AssuranceLevel, recovery)
  errored with `pineRpc(eth_call): missing or malformed reply` until the daemon
  case was added by hand.
- **`WALLET_CONNECTED`** — the wallet‑shell popup stopped emitting it (a regression
  the legacy popup didn't have); the daemon faithfully "handled" a message that
  never arrived, so the ad slot stayed on "connect a wallet to serve ads".
- General: any new popup/background message silently no‑ops in the demo.

Interim mitigation already shipped: a **visible fallback** in the daemon's `default`
case (ignore reply‑shaped types; log every other unhandled type to the activity
log + return a structured error) so future gaps are loud, not silent. That's a
safety net, not a fix — the duplication remains.

---

## Goal / invariant

**One router.** Message‑type → handler logic lives in exactly one place and is
invoked by both the service worker and the demo daemon. Environment differences
(provider, offscreen transport, relay submission, scheduling) are injected, not
branched per message. A new message type is handled in both contexts by adding
one case in one file.

---

## Current architecture (what's shared vs duplicated)

Already shared (the daemon imports these `@ext` modules and reuses them):
- `campaignPoller` (`@ext/background/campaignPoller`)
- `claimQueue` (`@ext/background/claimQueue`)
- wallet RPC dispatcher (`@ext/background/wallet/rpcDispatcher`)
- offscreen wallet handler (`@ext/offscreen/wallet-dispatch`)
- userPreferences / interestProfile / auction / campaignMatcher / contentSafety

Duplicated / diverged (the actual problem):
- **The `switch (msg.type)` router itself** — reimplemented in `extensionDaemon.ts`.
- **Pine reads** — real uses `getReadProvider`/`getPineProvider` → `pineBridge` →
  *offscreen* smoldot (`@ext/offscreen/smoldot` `handlePineMessage`); demo routes to
  the page's own `pineRpc` (`web/src/lib/provider.ts`).
- **Offscreen transport** — real `sendToOffscreen` posts to `chrome.offscreen`
  document; demo runs the offscreen handlers in‑page.
- **Relay submission** — demo has its own `DAEMON_SUBMIT_CLAIMS` path + relay key;
  real submits differently.
- **Scheduling** — real uses `chrome.alarms`; demo uses the shim's alarm emulation.

Env‑specific calls baked into the real `handleMessage` today (these are the seam to
abstract): `getReadProvider(...)`, `getPineProvider()`, `sendToOffscreen(...)`,
`chrome.alarms.*`, `startEarningsListener(...)`, relay/settlement submission.

---

## Two candidate architectures

### Option A — Extracted pure router + injected `EnvContext`  ⭐ recommended
Pull the `switch` out of `background/index.ts` into a side‑effect‑free
`routeMessage(msg, env): Promise<Reply>` in a shared module (e.g.
`@ext/background/router`). Handlers reach env‑specific capabilities only through
`env`. Both contexts build an `env` and call `routeMessage`.

- **Pros:** explicit seam; unit‑testable without a browser; no import‑time side
  effects; SW lifecycle (alarms, `onInstalled`) stays in `index.ts` where it
  belongs; demo provides a tiny `env` and deletes its 60‑arm switch.
- **Cons:** upfront work to thread ~a dozen handlers through `env`; must audit each
  handler for inline `chrome.*`/provider calls.

### Option B — Faithful `chromeShim` + run the real background module in‑page
Make the shim emulate enough of `chrome.*` (offscreen, alarms, runtime lifecycle)
that the demo can `import "@ext/background/index"` and let its real
`onMessage.addListener` handle everything; the shim's `sendMessage` dispatches to it.

- **Pros:** zero router duplication, including future handlers.
- **Cons:** fragile. `background/index.ts` has **import‑time side effects**
  (`installIdleLockListener()`, `onInstalled`/`onStartup` listeners,
  `immediateInitialPoll()`), and deeply assumes `chrome.offscreen` for the
  pine/wallet round‑trips. The shim would have to fully + faithfully emulate the SW
  + offscreen lifecycle; small infidelities resurface as demo‑only bugs — the same
  class of problem, moved into the shim.

**Recommendation: Option A**, treating B's "no duplication" as the goal achieved via
a single `routeMessage` rather than via a faithful shim. (A hybrid is fine: A for
message routing, plus the shim staying responsible only for storage/runtime/alarms
primitives — which it already does.)

---

## `EnvContext` sketch (the seam)

```ts
// @ext/background/router — env captures everything that differs between the
// service worker and the demo daemon. Message handlers use ONLY these.
export interface EnvContext {
  // Read provider for contract reads (SW: getReadProvider→pineBridge/offscreen;
  // demo: page pineRpc / JsonRpcProvider).
  readProvider(): Promise<import("ethers").Provider>;
  // Raw JSON-RPC passthrough for the page-provider proxy + pine reads.
  rpc(method: string, params: unknown[]): Promise<unknown>;
  // Offscreen round-trips (pine init/rpc, wallet ops). SW: chrome.offscreen;
  // demo: in-page handlers.
  offscreen: { pineRpc(method: string, params: unknown[]): Promise<unknown>;
               wallet(msg: unknown): Promise<unknown> };
  // Shared singletons (already reused today).
  poller: typeof import("@ext/background/campaignPoller").campaignPoller;
  claimQueue: typeof import("@ext/background/claimQueue").claimQueue;
  walletDispatcher: { dispatchWalletRpc(id: string, op: string, args: unknown): Promise<unknown> };
  // Relay submission strategy (SW vs demo relay key/flow).
  submitClaims(batches: unknown[]): Promise<unknown>;
  // Settings + storage (chrome.storage works in both; keep as a method for tests).
  getSettings(): Promise<import("@shared/types").StoredSettings>;
}

export async function routeMessage(msg: any, env: EnvContext): Promise<unknown> {
  switch (msg.type) { /* the ONE switch */ }
}
```

Note: `chrome.alarms`, `onInstalled`, idle‑lock, and `immediateInitialPoll` are
**scheduling/lifecycle**, not message routing — they stay in `index.ts` (SW) and
have their own (already‑shimmed) equivalents in the daemon. `routeMessage` must
stay free of those.

---

## Migration plan (staged, each step independently shippable)

**Phase 0 — pin behavior. ✅ DONE (2026-06-01, `alpha-5/extension/test/messageRouting.test.ts`).**
Static contract test: extracts the `case` labels from the background router and the
demo daemon and asserts the daemon handles every background protocol type, except a
curated `SW_ONLY` allowlist (16 entries, each with a reason: PROVIDER_* page-provider,
AD_CLICK/REMOTE_ACTION view-only demo, ENGAGEMENT_* telemetry, *_IMPRESSION_LOG debug,
EARNINGS_REFRESH_ONESHOT, PRUNE_SETTLED_UP_TO_NONCE). A new background case without a
daemon handler or allowlist entry fails the build. A third assertion keeps the
allowlist honest (no stale entries). This is the regression gate the extraction below
must preserve.

**Phase 1 — extract, no behavior change.** Move `background/index.ts`'s
`handleMessage` switch into `routeMessage(msg, env)` in a new `@ext/background/router`
module with **no top‑level side effects**. `index.ts` keeps `onMessage`/alarms/
lifecycle and calls `routeMessage(msg, swEnv)` where `swEnv` wraps today's inline
calls verbatim. Ship; the SW behaves identically.

**Phase 2 — define the seam.** Replace inline `getReadProvider` / `sendToOffscreen`
/ relay / settlement calls inside handlers with `env.*`. Build `swEnv` to satisfy
`EnvContext`. Still SW‑only; still identical behavior. This is the bulk of the work
(audit each of the ~56 handlers).

**Phase 3 — demo delegates.** In `extensionDaemon.ts`, build `demoEnv`:
`readProvider`/`rpc`/`offscreen.pineRpc` → page `pineRpc`; `offscreen.wallet` →
in‑page `wallet-dispatch`; `submitClaims` → the existing demo relay path;
`poller`/`claimQueue`/`walletDispatcher` → the instances it already holds. Replace
the daemon's 60‑arm `handleMessage` with `routeMessage(msg, demoEnv)`, keeping a
**thin pre‑router** only for genuinely demo‑only messages (`DAEMON_SUBMIT_CLAIMS`,
`SET_RELAY_SIGNER_KEY`, `SET_PUBLISHER_RELAY`) and the page‑provider mapping
(`PROVIDER_* → env.rpc` / wallet). Delete the mirror.

**Phase 4 — keep the net + lock it.** Keep the visible `default` fallback (shipped)
as defense‑in‑depth. The Phase‑0 contract test now guards against re‑drift.

---

## Demo‑only vs real‑only messages

- **Demo‑only** (stay in the daemon pre‑router): `DAEMON_SUBMIT_CLAIMS`,
  `SET_RELAY_SIGNER_KEY`, `SET_PUBLISHER_RELAY`, `SET_CLAIM_BUILDER_MODE` — these
  exist because the demo plays relay/publisher locally.
- **Real‑only / content‑origin** (`PROVIDER_*` from the injected `window.datum`):
  in the SW these go through a separate content‑message path; in the demo they map
  to `env.rpc` (reads) or `env.offscreen.wallet` (sign/send). Encode this mapping
  once in the shared router behind `env`, so both contexts agree.

---

## Risks & mitigations

- **Import‑time side effects** in `index.ts` would run in‑page if the demo imported
  it — Phase 1 explicitly extracts a *pure* router to avoid this. Don't import
  `index.ts` from the daemon.
- **Provider semantics differ** (offscreen pine vs page pine; finalized‑state lag).
  `env.readProvider`/`env.rpc` localize this; the Pine `eth_call` decoder is already
  shared (`pine/src/methods/eth_call.ts`), so reads behave the same once routed.
- **Relay/settlement divergence** — `env.submitClaims` is the seam; keep the demo's
  local‑relay behavior behind it, don't leak it into the router.
- **Test coverage** — Phase 0's contract test + reusing existing extension unit
  tests against `routeMessage` with a mock `env` gives confidence before deleting
  the mirror.

---

## Effort & definition of done

- **Effort:** ~Phase 1 (0.5–1d), Phase 2 (1–2d, the audit), Phase 3 (0.5–1d),
  Phase 0/4 tests (0.5d). Medium.
- **Done when:** there is exactly one `switch (msg.type)`; `extensionDaemon.ts`
  contains only `demoEnv` + a thin demo‑only pre‑router + `routeMessage`; the
  contract test passes in CI; and adding a new message requires editing one file.

---

## Workstream B — claim-building (the higher-impact half, added 2026-06-01)

The router duplication (above) is Workstream A. Live testing surfaced a second, more
damaging reimplementation: the daemon **inlines its own claim-building** because it
can't import `@ext/background/claimBuilder.ts` (that pulls in `zkProof.ts` → snarkjs,
which isn't web-bundled). That inline copy has drifted from the contracts repeatedly:

- `policyId` — daemon/web ABI carried an alpha-4 field the alpha-5 chain dropped (ethers "missing value for component policyId").
- `lastNonce`/`lastClaimHash` — daemon called the 2-arg alpha-4 signature; alpha-5 added `actionType`.
- **claim hash** — daemon hashed a **9-field** alpha-4 preimage; alpha-5 `DatumClaimValidator` hashes **10 fields** (adds `stakeRootUsed`) → every claim rejected (code 10), nothing settled.

Each was a silent settlement-breaker found only by reading reverts. The fix so far has
been to hand-match the schema — exactly the drift the refactor must end.

**Goal:** the daemon must *consume* the canonical claim-building, not re-derive it.

**Approach:** factor the snarkjs-free core out of `claimBuilder.ts` into a shared
module (e.g. `@ext/background/claimCore`) — the claim-hash preimage (the 10-field
`AbiCoder.encode` schema), the field layout, and the `settleClaims`/`lastNonce` call
shapes — with ZK proof generation kept behind an injected, optional `proveZk?(...)`
hook (null in the demo, snarkjs-backed in the extension/relay). Both the real
`claimBuilder` and the daemon import `claimCore`; the daemon passes `proveZk: null`.
Delete the daemon's inline `computeClaimHash` sites + the hardcoded 9/10-field arrays.

**Regression gate:** a unit test that hashes a fixed claim with `claimCore` and asserts
it equals `DatumClaimValidator`'s `keccak256(abi.encode(...))` for the same inputs
(derive the field list from one source of truth). This would have caught all three
drifts above at build time.

**Sequence:** Workstream A (router) and B (claim-building) are independent; do **B
first** — it's where the real bugs live and it's smaller (one module + the daemon's
3 hash sites + the submit/validate call shapes), then A.

---

## Interim state (already shipped — not the refactor)

- Visible fallback `default` case in the daemon (`extensionDaemon.ts`).
- `PINE_INIT` / `PINE_RPC_REQUEST` daemon handlers → page pine.
- `PROVIDER_RPC_PROXY` → page pine.
- `WALLET_CONNECTED`/`WALLET_DISCONNECTED` restored in the wallet‑shell popup
  (`@ext/popup/App`).

These keep the demo working today; the refactor above removes the reason they were
needed as one‑offs.
