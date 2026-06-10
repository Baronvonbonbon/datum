# Extension RPC Refactor — Consumer Audit + Plan

Goal: bring the extension to the same "rpcEnabled default-off,
opt-in for historical data" posture the webapp adopted in
`web/src/components/EnableRpcCta.tsx`.

The extension is structurally further along than I expected — it
already has a single `getReadProvider(rpcUrl, usePine, pineChain)`
chokepoint in `shared/contracts.ts:138` that prefers pine and falls
back to RPC. The refactor is **gating that fallback on a new
`rpcEnabled` flag**, not partitioning every consumer.

## Existing state

```ts
// shared/contracts.ts:138
export async function getReadProvider(rpcUrl, usePine, pineChain): Promise<Provider> {
  if (usePine && pineChain) {
    const pine = await getPineProvider(pineChain, onStep);
    if (pine) return pine;   // pine ready → use it
  }
  return getProvider(rpcUrl); // fall through to RPC
}
```

Today: `usePine` defaults to **false** in extension settings (webapp
defaults to **true**). When `usePine=false` → straight to RPC. When
`usePine=true` but pine isn't ready yet → silently falls back to RPC.

## Per-consumer audit

| Consumer | Op | Read or write | Pine-capable? | What breaks if rpc disabled? |
|---|---|---|---|---|
| `campaignPoller.poll` | Discover new campaigns + sync existing | read | ✓ (uses `getReadProvider`) | Pine should serve. If pine offline, no new campaigns surfaced until pine recovers. |
| `campaignPoller.refreshStatus` | Refresh status of known campaigns | read | ✓ | Same as poll — pine-served. |
| `timelockMonitor.poll` | Watch timelock for upgrades | read | ✓ | Pine-served. |
| `earningsListener` (live) | Watch ClaimSettled events | read | ✓ (subscribes via pine) | Pine-served. |
| `earningsListener` (backfill) | Initial historical sweep | read | RPC currently, pine can serve **within its window** | If pine has caught up to the user's interesting history range, fine. Otherwise need RPC. |
| `index.ts:1250` settlement-submit | Broadcast user-signed tx | **write** | ✗ — writes always need RPC | Settlement submission breaks if rpc is hard-disabled. |
| `walletManager.ts:287` balance lookup | Read DOT balance | read | could be pine | Currently RPC. |
| `walletManager.ts:363` tx-send | Broadcast tx | **write** | ✗ — writes need RPC | Any user-initiated tx breaks if rpc is hard-disabled. |
| `Settings.tsx:131` ping check | Test RPC connectivity | read | n/a — explicitly tests RPC | The ping is the point; not a consumer to refactor. |

## Key insight

**Reads** can be pine-served via the existing `getReadProvider`. The
extension already gracefully degrades to RPC when pine isn't ready.

**Writes** (transaction broadcast) inherently need an RPC endpoint —
they can't go through smoldot. So any write path **must** be allowed
to use RPC even when `rpcEnabled = false` for reads, OR the user must
explicitly opt in via one-shot before each write.

This is the same tension as the webapp's CTA model: `rpcEnabled`
gates **reads** for historical fallback. Writes are a separate
authorization moment (the user signs the tx; they're already
explicitly opting in).

## Proposed design

### 1. New setting

```ts
// shared/types.ts WebAppSettings (extension's parallel)
interface ExtensionSettings {
  // ...existing fields...
  /** Pine smoldot light client as the primary read path. Default: true. */
  usePine?: boolean;
  /** Allow fallback to centralized RPC for reads beyond pine's window.
   *  Default: false. Writes (tx broadcast) always use RPC and aren't
   *  gated by this flag — the user's signature is their opt-in. */
  rpcEnabled?: boolean;
}
```

Migration: existing users who have a non-default `rpcUrl` configured
get `rpcEnabled: true` set on first run after the upgrade
(preserves their current behavior). New installs get
`rpcEnabled: false` and `usePine: true`.

### 2. `getReadProvider` becomes RPC-gated

```ts
export async function getReadProvider(
  rpcUrl: string,
  usePine: boolean,
  pineChain?: string,
  options?: { rpcAllowed?: boolean },  // NEW
  onStep?: (step: SyncStep) => void,
): Promise<Provider> {
  if (usePine && pineChain) {
    const pine = await getPineProvider(pineChain, onStep);
    if (pine) return pine;
  }
  if (options?.rpcAllowed === false) {
    throw new Error("rpc-disabled");
  }
  return getProvider(rpcUrl);
}
```

Background consumers (campaignPoller etc.) call this with
`rpcAllowed: settings.rpcEnabled ?? false`. If pine is ready, the
flag is moot. If pine isn't ready and rpc isn't allowed, the consumer
catches the throw and either skips this cycle or surfaces a state to
the popup.

### 3. Writes get a separate one-shot pattern

```ts
// shared/walletManager.ts
export async function getWriteProvider(rpcUrl: string): Promise<JsonRpcProvider> {
  // Writes always use RPC. No pine fallback; the caller already
  // opted in by clicking "submit" or equivalent. Returns the cached
  // provider; doesn't itself flip rpcEnabled.
  return getProvider(rpcUrl);
}
```

Writes don't gate on `rpcEnabled`. The act of submitting a tx is the
user's authorization moment, comparable to clicking "Pull once via
RPC" in the webapp.

If we wanted to be paranoid we could add a one-shot wrapper around
writes — but the user already pressed a button to broadcast; adding
a "and confirm RPC use for this submission" dialog would be
ergonomically broken.

### 4. Popup UX

**Settings tab** gets two toggles:
- `usePine` (default on) — checkbox + explainer
- `rpcEnabled` (default off) — checkbox + tradeoff explainer matching
  the webapp's tooltip ("rpc is provided for historical lookup but
  may expose metadata")

**HistoryTab** gets a "Refresh history" button. When clicked:
1. If `rpcEnabled = true`: directly trigger the backfill.
2. If `rpcEnabled = false`: temporarily enable rpc, trigger the
   backfill, disable rpc when done. Same try/finally as webapp's
   `EnableRpcCta.handleOneShot`.

**First-run prompt** in HistoryTab: if the user has never run a
backfill AND `rpcEnabled = false`, show a banner: "Pull your earnings
history once via RPC? After the scan completes, RPC turns off
automatically."

### 5. Background consumer changes

```ts
// background/index.ts (initial poll path)
const rpcAllowed = settings.rpcEnabled ?? false;
try {
  await campaignPoller.poll(
    settings.rpcUrl, settings.contractAddresses, settings.ipfsGateway,
    pineChain,
    { rpcAllowed },  // pass through
  );
} catch (err) {
  if (String(err).includes("rpc-disabled")) {
    console.warn("[DATUM] Pine not ready and RPC disabled — skipping poll cycle");
  } else {
    throw err;
  }
}
```

Each background consumer's call signature grows by one optional
`{ rpcAllowed }` parameter. They propagate it into `getReadProvider`.
On a "rpc-disabled" error, they log + skip; no crash.

## What this gives you

- **Default state (new install):** pine handles all reads. No RPC
  traffic until the user explicitly opts in or submits a tx.
- **Opt-in for historical pulls:** "Refresh history" button enables
  rpc just for the backfill, then disables.
- **Writes always work:** user-initiated submissions broadcast via
  RPC regardless of the read-side gate.
- **Existing users unaffected:** migration sets `rpcEnabled: true`
  for anyone with a custom RPC, so the behavior they're used to
  continues.

## What this does NOT do

- Doesn't refactor any consumer's logic, only its provider
  acquisition.
- Doesn't add any new background jobs or change existing job cadence.
- Doesn't change how writes are signed or broadcast.
- Doesn't touch the wallet, the offscreen document, or the content
  scripts.

## Sequencing for implementation

1. Add `rpcEnabled` field to extension settings (default off; migrate
   existing users to true).
2. Update `getReadProvider` to accept and enforce `rpcAllowed`.
3. Plumb `rpcAllowed` through every consumer that calls
   `getReadProvider`. Catch the "rpc-disabled" error path; log + skip
   gracefully.
4. Add Settings UI: rpcEnabled checkbox with tradeoff explainer.
5. Add HistoryTab "Refresh history" button + first-run prompt.
6. Manual smoke test: fresh install → pine reads only; click
   "Refresh history" → one-shot scan completes; flip rpcEnabled on
   → background polls resume even when pine slow; submit a tx → goes
   through regardless of rpcEnabled.

## Risk

- **Pine reliability.** If pine takes >30s to be ready (cold start)
  and `rpcEnabled = false`, the extension's first 30s after install
  will show empty state. Mitigation: surface pine status in the
  popup so the user knows what's happening.
- **Backfill window mismatch.** Pine indexes from when it connected.
  A user installing today won't be able to see their historical
  earnings via pine alone — they need the RPC backfill. The
  first-run prompt covers this.
- **Migration of existing users.** Need a one-time check on
  extension startup: "did this user upgrade from a pre-rpcEnabled
  build?" If yes, set `rpcEnabled = true`. The flag itself reading
  `undefined` is the marker.
