# E2E Client Design — Webapp · Extension · SDK · Relay

Planning doc for organizing the four client surfaces against the
alpha-5 contract tree on Paseo. Sized for follow-up implementation.

Date: 2026-05-21
Status: Design — not implementation

---

## 0. Goals + scope

1. **Complete E2E on alpha-5 Paseo.** Today's tree has 43 deployed
   contracts. Every client surface needs to be re-grounded on the
   alpha-5 addresses and the alpha-5 flow primitives (optimistic
   activation bonds, hybrid dual-sig settlement, ParameterRetuneGuard,
   ZK identity verifier, the upgrade-ladder registry, the People
   Chain identity cache, etc.).
2. **Per-system dashboards.** Each major client area (advertiser,
   publisher, governance, admin/protocol, me/user, token plane,
   identity bridge) gets a single dashboard route that is a global
   overview + recent telemetry. Same shape across all of them.
3. **Pine/smoldot first.** Every read path should be writable
   directly against the local smoldot light client (via `pine`)
   without changing call sites. The Paseo HTTP gateway is the
   fallback, not the default. Pine's session-scoped TxPool also
   fixes the Paseo null-receipt bug for writes routed through it.
4. **Telemetry, not analytics.** Each dashboard ships a rolling
   window of meaningful events (recent settlements, governance
   actions, pauses, locks fired, upgrades). Built from `eth_getLogs`
   against Pine. No off-chain database.
5. **No new contract changes for this doc.** All surfaces should
   work against the deployed 43-contract set as-is.

### Non-goals

- IPFS pinning service implementation (Pinata is fine for testnet)
- The relay-bot becoming multi-tenant SaaS (stays single-publisher
  Diana for testnet)
- Mainnet hardening of any of these surfaces — that's a separate
  pass once flows are validated on Paseo

---

## 1. Pine / smoldot — foundation

Pine is the *first* thing to ground because it changes how every
client reads chain state. The current matrix lives in
`pine/CAPABILITIES.md`. The relevant constraints for our surfaces:

| Capability | Pine status | Implication |
|------------|-------------|-------------|
| `eth_call` / `eth_estimateGas` | Full | All view reads + write-prep work |
| `eth_getBalance` / `getCode` / `getStorageAt` / `getNonce` | Full | Wallet UI, ownership/lock-state, address-already-set checks |
| `eth_sendRawTransaction` | Full | Writes flow through Pine's TxPool |
| `eth_getTransactionReceipt` | Session-scoped | Confirmations only for txs Pine submitted this session |
| `eth_getLogs` | Rolling ~10k-block window from connect time | Telemetry windows must be sized to Pine's window |
| Historical blocks | Stubbed pre-window | Cannot rely on `getBlockByNumber(oldBlock)` |

**Strategy: dual-rail provider with progressive smoldot adoption.**

- `web/src/lib/provider.ts` (new): exports `getProvider({ preferPine: true })`.
- When pine is available + warm, route reads/writes there.
- Fall back to `https://eth-rpc-testnet.polkadot.io/` for:
  - Historical receipts not in TxPool
  - Wide log windows that pre-date Pine connect time
  - First-load before pine has subscribed
- The fallback is the existing webapp default, so degrading is silent.

**Pine init flow (webapp + extension):**

```
on app start
  ├─ load pine WASM (deferred — first paint should not wait)
  ├─ start chainHead_v1_follow against `paseo-asset-hub`
  ├─ subscribe LogIndexer to Revive::ContractEmitted on alpha-5 addresses
  ├─ once first finalized block + LogIndexer ready → flip provider preference
  └─ keep an HTTP fallback ref for the gaps above
```

**Pine init flow (extension):**

- Service-worker context has no `wasm-eval` by default. Two options:
  - Option A: load pine inside the offscreen document (already exists
    for ZK proving). Offscreen owns smoldot. Service worker forwards
    JSON-RPC calls via `chrome.runtime.sendMessage`.
  - Option B: HTTP fallback only for the extension; pine for webapp
    + relay-bot.
  - Recommendation: **Option A.** The offscreen document is already a
    persistent runtime context we control; one more job (smoldot
    bridge) fits cleanly next to the existing Poseidon + Groth16 work.

**Telemetry-window contract.** All dashboards declare their window
size upfront (`{ blocks: 14_400 }` ≈ 24 h on Paseo). The dashboard
hook reads `eth_getLogs(fromBlock = max(currentBlock - window,
pine.connectedAtBlock))` so the UI never asks pine for logs it can't
serve. When the available window is shorter than the requested
window, the dashboard shows a "Pine seeded N min ago — partial
window" banner.

**Pine missing pieces to flag (issues, not blockers):**

- `contractAddress` always null on receipts → deploy flows that
  parse contract address from the receipt (mostly extension token
  withdraw approvals, not core protocol) need to fall back to
  `getCreateAddress(sender, nonce)`.
- `logsBloom` always zero → don't filter on bloom in client code
  (we don't today).
- Heuristic `Revive::ContractEmitted` pallet-index discovery → for
  the dashboards' first few blocks, log results may be sparse. Show
  a `Warming up...` chip until LogIndexer has confirmed the pallet
  index and indexed ≥ 1 finalized block.

---

## 2. Webapp (`web/`)

### 2.1 Current state

- React 18 + Vite + react-router-dom.
- 50+ pages across `pages/{advertiser,publisher,governance,admin,me,token,explorer,settings}`.
- Wallet context + Settings context.
- Provider plumbing today: extension daemon bridge + plain wallet
  provider. **No pine integration.**
- Addresses load from `web/src/lib/networks.ts` (still alpha-4
  addresses likely — confirm + cut over to alpha-5 addresses).
- Per-role dashboards exist (Advertiser, Publisher, Governance) but
  predate several alpha-5 contracts (DatumActivationBonds,
  DatumDualSigSettlement, DatumPeopleChainIdentity, DatumStakeRootV2,
  DatumTagCurator, the upgrade-ladder GovernanceRouter registry).

### 2.2 Gaps for alpha-5 E2E

| Surface | Gap |
|---------|-----|
| Addresses | Webapp `ContractAddresses` shape needs the new alpha-5 entries (relayStake, relayGovernance, activationBonds, stakeRootV2, identityVerifier, emissionEngine, mintCoordinator, dualSig, peopleChainIdentity, peopleChainXcmBridge, peopleChainBondedReporter, blocklistCurator, tagSystem, council, parameterGovernance, campaignAllowlist, campaignCreative, settlementLogicA, settlementLogicB) |
| Provider | No pine; relies on injected wallet provider only |
| Dashboards | Each role's Dashboard.tsx is a static landing, not a telemetry surface |
| Activation flow | Advertiser create-campaign doesn't open an ActivationBonds bond |
| Dual-sig flow | Settlement UI assumes EOA / publisher-relaySigner only |
| Council pages | `Council.tsx` exists but predates the blocklist + tag appeal flows |
| Identity bridge | No surface for People-Chain identity request / response |
| Upgrade ladder | No surface for the GovernanceRouter registry / phase ladder beyond `PhaseLadder.tsx` (read-only) |

### 2.3 Target structure

Page tree, reorganized by audience. (Slugs = router paths.)

```
/                                     → role-aware landing → redirect to /explorer if cold visitor
/explorer                             → Overview (existing)
/explorer/campaigns
/explorer/publishers
/explorer/how-it-works
/explorer/philosophy

/me                                   → User dashboard *
/me/identity                          → identity attestation status, People-Chain bridge
/me/assurance                         → user min assurance level + dual-sig prefs
/me/history                           → settlement history (own user)
/me/dust                              → claim Paseo dust pools

/publisher                            → Publisher dashboard *
/publisher/register
/publisher/profile
/publisher/stake
/publisher/take-rate
/publisher/categories
/publisher/allowlist
/publisher/earnings
/publisher/sdk-setup
/publisher/dual-sig                   → new: relay/dualSig signer config

/advertiser                           → Advertiser dashboard *
/advertiser/create                    → ActivationBonds bond opening built in
/advertiser/campaigns                 → owned campaigns list with status badges
/advertiser/campaigns/:id             → detail w/ mute/challenge/settle activity
/advertiser/analytics
/advertiser/bulletin                  → Bulletin Chain creative storage
/advertiser/fraud-claims              → file claim against publisher

/governance                           → Governance dashboard *
/governance/vote
/governance/my-votes
/governance/parameters
/governance/protocol-params
/governance/publisher-fraud
/governance/advertiser-fraud
/governance/council                   → blocklist + tag appeals
/governance/phase-ladder              → registry + governor + phase floor
/governance/activation-bonds          → new: open / contest / mute pending campaigns

/protocol                             → Protocol dashboard *  (was /admin)
/protocol/pause-registry              → guardian set, category caps, recent pauses
/protocol/timelock
/protocol/parameter-governance
/protocol/blocklist
/protocol/tag-curator                 → new: tag approvals + G-6 appeals
/protocol/sybil-defense               → PowEngine, NullifierRegistry, RateLimiter, ZK
/protocol/publisher-stake
/protocol/challenge-bonds
/protocol/mint-authority
/protocol/protocol-fees
/protocol/upgrades                    → new: GovernanceRouter registry, lock status

/token                                → Token plane dashboard *
/token/wrapper
/token/bootstrap
/token/vesting
/token/fee-share
/token/mint-coordinator               → new: per-batch emissions log

/identity                             → Identity bridge dashboard *
/identity/people-chain                → request refresh, view oracle reporter, XCM status
/identity/zk                          → identity ZK proof tooling

/settings
/settings/house-ad-preview
```

`*` = each marked page has the dashboard template defined in §6.

### 2.4 Pine integration points

- `web/src/lib/provider.ts` (new): dual-rail Pine + HTTP.
- `web/src/hooks/useLogs.ts` (new): window-aware log fetcher with
  Pine warm-up handling.
- `web/src/hooks/useContractRead.ts` (refactor): default to Pine.
- `web/src/hooks/useBlockNumber.ts` (new): polls Pine's
  `eth_blockNumber` from chainHead subscription. Every dashboard
  pivots time displays on this hook.
- `web/src/components/PineStatus.tsx` (new): chip in the layout
  footer showing Pine connection state + indexed-blocks-since
  connect.

### 2.5 Dashboard surface (per the 7 starred pages)

See §6 for the shared template. The per-page widgets are:

**/me dashboard.** Active balance (DOT + DATUM + ERC-20 sidecars),
recent settlements (last 50 logs of `UserCredited`), active min
assurance, identity attestation freshness, dust balance.

**/publisher dashboard.** Earnings curve (24 h / 7 d), pending
withdrawals, current stake vs required, reputation score, recent
settlements, recent reports against this publisher, blocklist
status.

**/advertiser dashboard.** Active campaigns count + budget remaining,
pending activations (with countdown), challenges in progress,
mutes in progress, recent claims against me, recent settlements
debited from my campaigns.

**/governance dashboard.** Active proposals (count + nearest
deadline), my open votes, recent vote events, recent
ParameterRetuneGuard cooldown trips, Council pending appeals,
phase + governor.

**/protocol dashboard.** Pause status (any category), guardian set
hash, blocklist size + last action, tag curator size + appeals
pending, settlement rate-limit utilization, sybil defense:
PoW enforcement on/off, nullifier window, ZK verifier locked or
not, recent reports.

**/token dashboard.** Total DATUM minted (cumulative + last 24h),
wrapper balance (canonical-vs-wrapped invariant), fee-share
accumulated, vesting cliffs upcoming, bootstrap pool state.

**/identity dashboard.** Identity ZK VK hash, oracle reporter health
(latest block written), XCM bridge status (last successful
send + receive), bonded reporter cache hit-rate, last refresh per
user (own first, then optional admin view).

---

## 3. Extension (`alpha-5/extension/`)

### 3.1 Current state

- Service worker + content scripts + offscreen + popup (Manifest V3).
- Background: auction, behavior chain (per-user state machine),
  campaign poller, claim builder, claim queue, earnings listener,
  impression log, interest profile, Poseidon, PoW solver, PoW
  worker, publisher attestation (EIP-712), timelock monitor, user
  preferences, ZK proof + stub.
- Content: ad slot rendering, engagement (CPC), handshake with
  SDK, meta extractors, taxonomy.
- Popup: Filters tab + claim queue + brand mark.
- Test suite: 203 tests passing per memory.

### 3.2 Gaps for alpha-5 E2E

| Surface | Gap |
|---------|-----|
| Address sync | Extension `deployed-addresses.json` updated (already done by deploy.ts), but `shared/contracts.ts` needs the alpha-5 entries (relayStake, dualSig, activationBonds, peopleChainIdentity, mintCoordinator, etc.) |
| Pine | No light-client; uses extension daemon + window provider |
| Dual-sig | Claim builder always uses publisher-relay path; needs branch on `requireZkProof` + advertiser-cosig campaigns |
| User-min-assurance | Popup has filters but no L0/L1/L2/L3 selector |
| Identity attestation | Offscreen generates impression-claim ZK proofs; needs a second flow for identity proofs against IdentityVerifier |
| User recovery | No surface for `PaymentVault.setRecoveryAddress` (G-8) or `TokenRewardVault.setRecoveryAddress` (G-8 mirror) |
| Self-pause / blocklist | Popup has filters but no user-side blocklist (per-user `userMinAssurance` + self-pause) |

### 3.3 Target structure

```
src/
  background/
    auction.ts                       (existing)
    behaviorChain.ts                 (existing)
    behaviorCommit.ts                (existing)
    campaignMatcher.ts               (existing)
    campaignPoller.ts                (existing — re-target alpha-5 reads)
    claimBuilder.ts                  (existing — branch on assurance level)
    claimQueue.ts                    (existing)
    earningsListener.ts              (existing — wire Settlement event ABI)
    impressionLog.ts                 (existing)
    interestProfile.ts               (existing)
    poseidon.ts                      (existing)
    powSolver.ts                     (existing)
    powWorker.ts                     (existing)
    publisherAttestation.ts          (existing — extend for advertiser cosig)
    timelockMonitor.ts               (existing — extend for ActivationBonds challenge windows)
    userPreferences.ts               (existing — add userMinAssurance)
    zkProof.ts                       (existing)
    zkProofStub.ts                   (existing)
    identityProof.ts                 (NEW — identity circuit witness)
    pineBridge.ts                    (NEW — RPC over chrome.runtime → offscreen)
    recoveryAddress.ts               (NEW — G-8 staging UI hooks)
    selfPause.ts                     (NEW — CB1 self-pause hooks)

  offscreen/
    offscreen.ts                     (existing)
    smoldot.ts                       (NEW — pine worker; subscribes to alpha-5 events)

  popup/
    App.tsx                          (existing)
    BrandMark.tsx                    (existing)
    ClaimQueue.tsx                   (existing)
    FiltersTab.tsx                   (existing)
    EarningsTab.tsx                  (NEW)
    AssuranceTab.tsx                 (NEW — userMinAssurance picker)
    IdentityTab.tsx                  (NEW — proof status + refresh)
    RecoveryTab.tsx                  (NEW — G-8 staging)
```

### 3.4 Pine integration

- `background/pineBridge.ts` defines a single `pineRpc(method, params)`
  that posts to the offscreen document; offscreen's `smoldot.ts`
  owns the WASM client and is the only place pine lives.
- All chain reads (campaign poller, earnings listener, allowlist
  check, blocklist check) route through `pineRpc`. Existing wallet
  provider stays for writes; pine sends raw txs but signing remains
  with the user's injected wallet.
- Bundle impact: ~600 KB compressed for smoldot WASM. Lazy-load
  on first user interaction with the popup; the impression path
  doesn't need pine immediately (claims are local-queue first,
  flushed via relay).

### 3.5 Dashboard surface

The extension popup has limited real estate; "dashboard" here means
the **EarningsTab** as the catch-all overview:

- Lifetime DOT credit, lifetime DATUM credit, lifetime token
  sidecars credit
- Today (24 h) settled
- Pending withdraw (Pull queue)
- Recent settlements (last 10) — campaign, amount, time
- Next claim flush ETA (queue depth + relay cadence)
- AssuranceLevel selector (Always allow L0 … L3 ZK-only)
- Self-pause toggle (CB1 — opt-out without uninstalling)

---

## 4. SDK (`sdk/`)

### 4.1 Current state

- Single-file `datum-sdk.js` (~5 KB), v3.3.0.
- Drop-in script tag: `<script src="datum-sdk.js" data-publisher="0x…" data-tags="…">`.
- Two-party attestation handshake with extension.
- House-ad fallback if no extension responds within 1.5 s.
- Format-based slot targeting (leaderboard, medium-rectangle, etc.).
- No alpha-5 awareness — it just brokers the extension handshake.

### 4.2 Gaps for alpha-5 E2E

| Surface | Gap |
|---------|-----|
| Bulletin Chain creative | SDK loads house-ads from a hardcoded URL; advertiser creatives need to load from Bulletin Chain (or IPFS) per the `getCampaignCreative*` getters on Campaigns |
| Click registry | No CPC click event reporting (DatumClickRegistry) |
| Relay endpoint hint | `data-relay="https://..."` exists but doesn't fall back to a sensible default if the publisher relaySigner has been replaced |
| Multi-relay | SDK assumes one relay endpoint per publisher; the three-path architecture (publisher-direct, dual-sig, DatumRelay) needs to be expressed |
| Telemetry | No way for a publisher to see SDK-side metrics (impressions served, fallbacks fired, attestation roundtrip latency) |

### 4.3 Target structure

Keep it tiny. Single-file remains the discipline; ~7 KB ceiling.

```
sdk/
  datum-sdk.js               (extend; same drop-in shape)
  datum-sdk-debug.js         (NEW — same file + verbose tracing for publisher dev)
  example-publisher.html     (existing — update with format + cosig examples)
  preview.html               (existing)
```

New features inside `datum-sdk.js`:

1. **Bulletin creative loader.** When the extension provides a
   campaign ID, the SDK fetches `getCampaignCreativeCid(id)` from a
   read-only HTTPS gateway (the publisher-supplied relay endpoint
   doubles as the gateway) and renders the creative. Pine support
   in browsers without an extension is out of scope here — only
   webapp + extension speak pine.

2. **Click event reporting.** SDK fires a `clickRegistry.recordClick`
   request to the relay endpoint. Relay batches and submits
   on-chain. Today's CPC path is missing from the SDK.

3. **Relay-path hints.** SDK accepts `data-relay-mode="publisher" |
   "dualsig" | "datumrelay"` so the page can declare which of the
   three architectures it wants. Default `"publisher"`.

4. **Publisher telemetry hooks.** SDK exposes a `window.DATUM.metrics`
   readonly object: impressions served, last-claim ETA, attestation
   roundtrip ms. Optional dev console panel via
   `?datum-dev=1` query param.

### 4.4 Pine integration

None — the SDK is the *publisher's page*. We don't want to ship a
600 KB WASM blob there. The SDK uses the publisher-supplied relay
endpoint for reads (campaign metadata, creatives) and for
click/impression reporting. The relay can pine internally; the SDK
doesn't see it.

### 4.5 Dashboard surface

Not in the SDK itself. The publisher's view of SDK telemetry lives
in **`/publisher` dashboard** (see §2.5) and pulls from:

- Relay-bot's optional logging endpoint (if the publisher runs one)
- On-chain logs (DatumClickRegistry events for CPC, Settlement
  events for CPM)

---

## 5. Relay-bot (`relay-bot/`)

### 5.1 Current state

- Diana systemd service, single-publisher, localhost.
- Scripts: bulletin-renewer, check-budget, check-campaigns,
  check-diana, check-selectors, check-settlement-config,
  check-settlement-params, check-stake, diagnose-real-tx,
  diagnose-settlement, diagnose-trap, diana-identity,
  fix-diana-reporter.
- No README — onboarding is tribal.
- Whole directory is gitignored (which is fine for the production
  relay; the testnet skeleton should be checked in).

### 5.2 Gaps for alpha-5 E2E

| Surface | Gap |
|---------|-----|
| Documentation | No README, no architecture sketch |
| Alpha-5 wiring | Addresses, ABIs, and event names refer to alpha-3/alpha-4 era in places |
| Multiple paths | Built for path-1 (publisher relaySigner) only; dual-sig + DatumRelay paths not exercised |
| Click batching | Bulletin renewer is the only batching path; no DatumClickRegistry batcher |
| StakeRootV2 reporter | Diana posts roots to StakeRootV2 in shadow mode; need a reliable cron + retry policy |
| People Chain bridge | Diana acts as identity oracle reporter (current testnet posture); needs hardening of the request → XCM → callback loop |
| Pine | Currently uses ethers + Paseo HTTP RPC; should be pine-first for reads |

### 5.3 Target structure (checked into repo)

A canonical, gitignore-exempt skeleton under `relay-bot/` (currently
fully gitignored). Add:

```
relay-bot/
  README.md                          (NEW — architecture + operational runbook)
  package.json
  src/
    index.mjs                        (boot, signal handling)
    config.mjs                       (env + alpha-5 addresses load)
    provider.mjs                     (pine + HTTP dual-rail)
    poll/
      campaigns.mjs                  (campaign list, status, metadata)
      claims.mjs                     (incoming claims from publisher SDK)
      identityRequests.mjs           (PeopleChain refresh requests)
    submit/
      settlement.mjs                 (settleSignedClaims batcher)
      clickRegistry.mjs              (NEW — recordClick batcher)
      stakeRootV2.mjs                (NEW — reporter cron + retry)
      bulletinRenewer.mjs            (existing — wrap with retry)
      identityOracle.mjs             (PeopleChain oracle callback)
    monitor/
      receipts.mjs                   (Paseo null-receipt workaround → pine TxPool)
      rateLimiter.mjs                (settlement window stats)
      divergence.mjs                 (StakeRoot V1 vs V2 cross-check)
    logging/
      structured.mjs                 (NEW — JSON line logs for `journalctl -o json`)
      telemetry.mjs                  (NEW — last-N events for /publisher dashboard fetch)
  scripts/
    diagnose-*.mjs                   (existing — keep)
    fix-*.mjs                        (existing — keep)
  systemd/
    diana-relay.service              (NEW — checked-in unit template)
```

A second skeleton, `relay-bot.example/`, that's identical without
keys and gets shipped to the repo. The live `relay-bot/` stays
gitignored.

### 5.4 Pine integration

- `provider.mjs` exposes `getProvider({ preferPine: true })` same
  shape as webapp.
- Pine in Node ships via `pine/dist` consumed as a normal package.
  Smoldot WASM is loaded once at startup; the relay process is
  long-lived so the 600 KB warm-up cost is amortized.
- Receipt waits route through pine's session TxPool (this is the
  big win — the Paseo eth-rpc null-receipt bug is the #1 source
  of relay-bot retries today).

### 5.5 Dashboard surface

Relay-bot exposes a localhost HTTP endpoint
(`http://127.0.0.1:3401/metrics`) with a structured snapshot for
the `/publisher` dashboard to read. Read path: webapp → publisher's
relay endpoint → relay-bot localhost → JSON.

Endpoints:

- `GET /metrics` — current queue depth, last 10 settlement TXs,
  StakeRootV2 last-posted epoch, identity refresh queue depth
- `GET /events?since=<block>` — relay's view of recent on-chain
  events
- `GET /health` — pine connected, signer balance, deployer
  approvals OK

Authentication: localhost-bind only on testnet. Mainnet would add
HMAC-signed requests; out of scope here.

---

## 6. Dashboard template (shared across systems)

Every dashboard is the same three-block layout, parameterized by
config. This is the implementation primitive.

```
+--------------------------------------------------+
| HERO STATS                                       |
|   4–6 big-number cards                           |
|   each card: { label, value, delta24h, sparkline}|
+--------------------------------------------------+
| TELEMETRY STREAM                                 |
|   rolling window of recent events                |
|   filterable by event type                       |
|   click any row → routes to the detail page     |
+--------------------------------------------------+
| ACTION HOOKS                                     |
|   2–4 buttons to the most common next actions    |
+--------------------------------------------------+
```

### 6.1 Hero-stat config

```ts
type HeroStat = {
  label: string;
  value: () => Promise<bigint | number | string>;
  delta24h?: () => Promise<{ value: bigint | number; sign: "up" | "down" | "flat" }>;
  sparkline?: () => Promise<number[]>; // 24 hourly buckets
  formatter?: (v: any) => string;
  link?: string; // route on click
};
```

Each Dashboard.tsx declares its `HeroStat[]` and the template
component handles fetching, refresh, and rendering.

### 6.2 Telemetry stream config

```ts
type TelemetryStream = {
  windowBlocks: number;            // size of log window (capped to pine warm-up)
  sources: Array<{
    address: string;               // contract address
    eventFragment: ethers.EventFragment;
    formatter: (log: ethers.Log) => StreamRow;
  }>;
  pollIntervalBlocks?: number;     // default: every new block
};

type StreamRow = {
  ts: number;       // block timestamp
  type: string;     // "settlement" | "vote" | "pause" | …
  title: string;    // "Campaign #42 activated"
  subtitle?: string;
  route?: string;
};
```

A single `useTelemetryStream(config)` hook drives the stream and is
shared by every dashboard.

### 6.3 Action-hooks config

Just a flat list of `{ label, route, when?: (state) => boolean }`.
Hidden when `when` returns false (e.g., "Stake DOT" only shows when
not yet staked).

### 6.4 Implementation order

1. Build the dashboard template (`web/src/components/Dashboard*.tsx`)
2. Wire `/me` dashboard first (smallest hero-stat surface; tightest
   loop for getting the pattern right)
3. Wire `/publisher`, `/advertiser`, `/governance` next
4. Wire `/protocol`, `/token`, `/identity` last (highest data
   density — finalize the patterns first)

---

## 7. Telemetry plumbing

Per dashboard log windows hit `eth_getLogs` against ~5–10 contracts
each. Pine's LogIndexer handles fan-out, but to avoid hammering
the indexer:

- A single `web/src/lib/eventBus.ts` (new) keeps one subscription
  per `(address, topic0)` pair, multicasted to interested hooks.
- Hooks declare interest at mount, unsubscribe on unmount.
- New blocks tick once and refresh every active subscription via
  `pine.getLogs(prevHigh+1, newBlock)`.
- Backpressure: if pine is warming up, fall back to HTTP RPC for a
  one-shot fill, then resume pine.

This pattern is required because Pine's `getLogs` is in-memory but
not free — one call per dashboard per block ≈ 1.5 s of WASM work
on bigger windows. Multicasting cuts that to one call per block
total.

---

## 8. Rollout sequence

Order matters because each layer assumes the one before it is in
place.

### Stage 1 — Foundation

1. `web/src/lib/provider.ts` (Pine + HTTP dual-rail).
2. `web/src/lib/eventBus.ts` (multicasted log subscriptions).
3. `web/src/lib/networks.ts` (re-grounded on alpha-5 addresses).
4. Shared dashboard template (`Dashboard.tsx` + hooks).

### Stage 2 — User + Publisher surfaces

5. `/me` dashboard.
6. `/publisher` dashboard.
7. Extension popup `EarningsTab` + `AssuranceTab` + `RecoveryTab`.
8. Extension `pineBridge` + offscreen `smoldot.ts`.

### Stage 3 — Advertiser + Governance

9. `/advertiser` dashboard + ActivationBonds create-bond flow.
10. `/governance` dashboard + new sub-pages (activation-bonds,
    advertiser-fraud).
11. SDK Bulletin creative loader + click reporter.

### Stage 4 — Protocol + Token + Identity

12. `/protocol` dashboard + sub-pages (tag curator + upgrades).
13. `/token` dashboard + mint-coordinator log.
14. `/identity` dashboard + extension `IdentityTab`.

### Stage 5 — Relay-bot

15. Relay-bot README + skeleton (`relay-bot.example/`).
16. Relay-bot pine wiring.
17. Relay-bot `/metrics` HTTP endpoint.
18. StakeRootV2 reporter cron + clickRegistry batcher.

### Stage 6 — Polish

19. Pine status chip across all surfaces.
20. Warm-up banners + partial-window indicators.
21. Per-dashboard recent-action shortcuts.

---

## 9. Open design questions

These need answers before / during implementation:

1. **Pine bundle hosting.** Webapp ships pine via Vite; do we
   inline the WASM blob (~600 KB) or ship as a separate fetch?
   Inline is simpler but worsens TTI. Recommendation: separate
   fetch + service-worker cache for repeat visits.
2. **Extension log-window seed.** When the extension first
   installs, pine has zero history. Should the extension prime
   its log window from a public HTTP RPC backfill (one-shot 24 h
   window pull), then switch to pine? Recommendation: yes —
   ~3 MB of logs, one-time.
3. **Relay-bot multi-publisher.** The mainnet design (per backlog
   §1.8) is multi-publisher with HSM keys. For Paseo we stay
   single-publisher Diana. Should the checked-in skeleton expose
   the multi-publisher shape now (just disabled), or strictly
   single-publisher? Recommendation: multi-publisher shape from
   day one, with `publishers: [{ address, signerEnv }]` defaulting
   to a single entry. Cheap to add; expensive to retrofit.
4. **Dashboard data-freshness UX.** Block-level refresh (every ~6 s
   on Paseo) is the right cadence for telemetry streams but feels
   chatty for hero stats. Recommendation: hero stats poll on
   block intervals but only re-render when a value changes;
   telemetry stream re-renders every block.
5. **Mobile.** Webapp is desktop-first. The dashboard template
   assumes a wide hero-strip + side-by-side stream/actions. Mobile
   reshuffles to vertical stack. Doable, but worth deciding the
   responsive breakpoints up front.

---

## 10. Out-of-scope items (tracked elsewhere)

These came up while scoping but belong in other docs:

- IPFS pinning hardening — `PRE-ALPHA-5-BACKLOG.md §1.8`
- ZK proving-key distribution — `PRE-ALPHA-5-BACKLOG.md §1.8`
- External audit — `PRE-ALPHA-5-BACKLOG.md §1.5`
- MPC ceremony — `PRE-ALPHA-5-BACKLOG.md §1.3`
- Relay-bot HSM + multi-publisher hardening — `PRE-ALPHA-5-BACKLOG.md §1.8`

---

## Appendix A — Contract → client owner matrix

Which client(s) talk to each alpha-5 contract:

| Contract | Webapp | Extension | SDK | Relay |
|----------|--------|-----------|-----|-------|
| DatumPauseRegistry | R/W (guardian, protocol dashboard) | R | — | R |
| DatumTimelock | R (protocol dashboard) | — | — | — |
| DatumPublishers | R/W (publisher) | R | — | R/W (relaySigner) |
| DatumCampaigns | R/W (advertiser) | R | R (creative CID) | R |
| DatumBudgetLedger | R | — | — | R |
| DatumPaymentVault | R/W (me — recovery, dust) | R/W (withdraw, recovery) | — | R |
| DatumCampaignLifecycle | R | R | — | R |
| DatumAttestationVerifier | R | R/W (cosig flow) | — | R |
| DatumGovernanceV2 | R/W (governance) | — | — | — |
| DatumSettlement | R | R (settlement events) | — | R/W (submit) |
| DatumRelay | R | — | — | R |
| DatumZKVerifier | R | R/W (proof gen) | — | — |
| DatumRelayStake | R/W (relay operator page) | — | — | R/W |
| DatumRelayGovernance | R/W | — | — | R |
| DatumClaimValidator | R | R | — | R |
| DatumTokenRewardVault | R/W (me — sidecar withdraw, recovery) | R | — | R |
| DatumPublisherStake | R/W (publisher) | R | — | R |
| DatumChallengeBonds | R (campaign detail) | — | — | R |
| DatumPublisherGovernance | R/W (governance) | — | — | — |
| DatumParameterGovernance | R (protocol) | — | — | — |
| DatumGovernanceRouter | R (phase ladder, upgrades) | — | — | — |
| DatumCouncil | R/W (council page) | — | — | — |
| DatumClickRegistry | R | R | R (record click) | R/W (batch) |
| DatumPowEngine | R | R/W (PoW solving) | — | R |
| DatumPublisherReputation | R (publisher profile) | — | — | — |
| DatumNullifierRegistry | R | R | — | R |
| DatumSettlementRateLimiter | R (rate-limiter admin) | — | — | R |
| DatumCampaignCreative | R/W (bulletin manager) | R | R (loader) | R |
| DatumReports | R/W (report submit + admin) | R/W (popup report) | — | — |
| DatumCampaignAllowlist | R/W (publisher allowlist) | R | — | R |
| DatumTagSystem | R | R | R | R |
| DatumCouncilBlocklistCurator | R/W (council, governance) | R | — | R |
| DatumActivationBonds | R/W (advertiser, governance) | R | — | R |
| DatumStakeRoot | R (protocol — V1 deprecation tracking) | — | — | R/W |
| DatumStakeRootV2 | R/W (reporter page) | — | — | R/W |
| DatumIdentityVerifier | R (identity dashboard) | R/W (proof gen) | — | — |
| DatumEmissionEngine | R (token dashboard) | — | — | — |
| DatumMintCoordinator | R (token dashboard) | R (mint-credit events) | — | R |
| DatumDualSigSettlement | R | R/W (cosig flow) | — | R/W |
| DatumPeopleChainIdentity | R/W (identity dashboard) | R/W (refresh trigger) | — | R/W (oracle reporter) |
| DatumPeopleChainXcmBridge | R (identity dashboard) | — | — | R |
| DatumBondedIdentityReporter | R (identity dashboard) | — | — | R |
| DatumTagCurator | R/W (governance, protocol) | R | — | R |

(R = read, R/W = read + write surface.)
