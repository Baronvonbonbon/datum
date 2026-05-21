# E2E Client Design — Webapp · Extension · SDK · Relay

Planning doc for organizing the four client surfaces against the
alpha-5 contract tree on Paseo. Sized for follow-up implementation.

Date: 2026-05-21
Status: Design — not implementation
Revision: r2 (2026-05-21) — extension is now a self-contained wallet
(BIP-39 HD, password-unlock, multi-account, send-to-external) and
the *only* wallet surface. Webapp uses the extension as its EIP-1193
provider. No HTTP RPC anywhere — pine/smoldot is the sole chain
access path across all client surfaces.

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
3. **Pine/smoldot only.** Every read and every write goes through
   the local smoldot light client (via `pine`). The Paseo HTTP
   gateway is *not* used anywhere — webapp, extension, and relay-bot
   all run pine. Pine's session-scoped TxPool also fixes the Paseo
   null-receipt bug for writes routed through it. Cypherpunk
   posture: the dApp never leaks a request to a centralized RPC
   gateway. Trade-off: cold-install UX shows a "syncing…" state
   until smoldot indexes its first finalized block (~10–30 s on
   Paseo with warm peers).
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

**Strategy: pine-only. No HTTP fallback anywhere.**

- `web/src/lib/provider.ts` (new): exports `getProvider()` — wraps
  pine, no alternative endpoint.
- Cold start shows a `Syncing…` overlay until pine reaches
  `peers ≥ 2 && finalizedHead != 0 && logIndexerReady`. Typically
  10–30 s on Paseo with warm peers; first-ever install needs to
  pull the chainspec checkpoint over P2P and can take up to ~60 s.
- The webapp embeds pine directly for read-only paths (Explorer,
  public dashboards). When the extension is installed, the webapp
  *also* gets the extension's EIP-1193 provider — but that provider
  is itself pine-backed (the extension routes everything through
  its own offscreen smoldot). Two pine instances exist in that
  case, which is fine: they're cheap to run and isolation is good
  cypherpunk discipline.

**Pine init flow (webapp):**

```
on app start
  ├─ render Explorer skeleton (no chain reads yet)
  ├─ start pine in a Web Worker (smoldot WASM, ~600 KB, fetched separately)
  ├─ chainHead_v1_follow against `paseo-asset-hub`
  ├─ LogIndexer subscribes to Revive::ContractEmitted on alpha-5 addresses
  ├─ once first finalized block + LogIndexer ready → flip to "connected"
  └─ if window.datum is present → register as a secondary signer/provider
```

**Pine init flow (extension):**

- Service-worker context has no `wasm-eval` by default. **Pine
  lives in the offscreen document** (same context that already
  hosts Poseidon + Groth16). Background service worker forwards
  JSON-RPC calls via `chrome.runtime.sendMessage`. The offscreen
  document also owns the keystore-unlock state machine — see §3.4.
- Cold first-install: the popup shows a "Syncing chain — pine
  fetching peers…" state. Earnings / impressions written *after*
  install start showing as soon as pine indexes them. Earnings
  *before* install are not visible (acceptable per "no HTTP, ever"
  decision). A subtle "history begins at block N" footnote in the
  popup makes the cutover explicit.

**Telemetry-window contract.** All dashboards declare their window
size upfront (`{ blocks: 14_400 }` ≈ 24 h on Paseo). The dashboard
hook reads `eth_getLogs(fromBlock = max(currentBlock - window,
pine.connectedAtBlock))` so the UI never asks pine for logs it
can't serve. When the available window is shorter than the
requested window, the dashboard shows a "Pine connected N min ago
— partial window" banner. There is no HTTP fall-through.

**Pine missing pieces to flag (issues, not blockers):**

- `contractAddress` always null on receipts → flows that parse
  the contract address from a receipt must fall back to
  `getCreateAddress(sender, nonce)`. (Used internally by the
  extension when it deploys a token approval proxy, if ever.)
- `logsBloom` always zero → don't filter on bloom in client code
  (we don't today).
- Heuristic `Revive::ContractEmitted` pallet-index discovery → for
  the dashboards' first few blocks, log results may be sparse.
  Show a `Warming up…` chip until LogIndexer has confirmed the
  pallet index and indexed ≥ 1 finalized block.
- Receipt waits only work for txs submitted through *this* pine
  instance. The extension's pine and the webapp's pine each have
  their own TxPool. A tx the extension signed shows its receipt
  in the extension's pine immediately; the webapp learns about
  it via finalized log subscription (≤ 12 s extra).

---

## 2. Webapp (`web/`)

### 2.1 Current state

- React 18 + Vite + react-router-dom.
- 50+ pages across `pages/{advertiser,publisher,governance,admin,me,token,explorer,settings}`.
- Wallet context + Settings context.
- Provider plumbing today: extension daemon bridge + plain wallet
  provider. **No pine integration.** Both go away in r2 — see
  §2.4 for the new shape.
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

### 2.4 Provider + wallet integration

The webapp does *not* ship its own wallet. Signing and account
management belong to the extension. The webapp's role is:

- Render read-only pages (Explorer, public dashboards) for visitors
  with no extension installed. Pine is the only chain access path.
- When the extension is detected (`window.datum` injected on page
  load by the extension's content script), bind it as the signer
  and as a secondary read provider. Reads can come from either the
  webapp's own pine or the extension's pine — they're equivalent.

Files:

- `web/src/lib/provider.ts` (new): wraps a single pine instance.
  No HTTP rail. Throws cleanly if pine fails to connect after a
  warm-up timeout (60 s).
- `web/src/lib/walletConnector.ts` (new): detects `window.datum`,
  exposes `connect()` / `getAccounts()` / `signAndSend()`. Uses the
  same EIP-1193 message shape the extension serves. Falls through
  to a "Install the DATUM extension" CTA when absent.
- `web/src/hooks/useLogs.ts` (new): window-aware log fetcher with
  Pine warm-up handling.
- `web/src/hooks/useContractRead.ts` (refactor): default to pine.
- `web/src/hooks/useContractWrite.ts` (new): always routes through
  `walletConnector.signAndSend()`. Pages that need signing
  short-circuit with a "Install DATUM to use this page" panel when
  no extension is bound.
- `web/src/hooks/useBlockNumber.ts` (new): polls pine's
  `eth_blockNumber` from chainHead subscription.
- `web/src/components/PineStatus.tsx` (new): chip in the layout
  footer showing pine connection state + indexed-blocks-since
  connect.
- `web/src/components/WalletStatus.tsx` (new): chip showing
  connected extension account + chain.
- **Removed:** `web/src/lib/extensionDaemon.ts`,
  `web/src/lib/walletProvider.ts`, and any reliance on injected
  `window.ethereum` from MetaMask-style wallets. The DATUM
  extension's provider lives at `window.datum` so it never
  collides with other wallets the user has installed.

### Read-only fallback (no extension)

Pages that don't require signing work without the extension. Pages
that do (any `/advertiser/*`, `/publisher/*`, `/governance/vote`,
`/me/*` writes) render a `<NeedsExtension>` panel instead of the
form:

```
You need the DATUM extension to take this action.
[ Install extension ]   [ Browse as visitor ]
```

The extension install link points at the unpacked-extension dev
flow on testnet; the Chrome Web Store listing follows post-mainnet.

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

The extension is **the wallet**. It holds the user's keys, signs
every tx, and exposes an EIP-1193 provider at `window.datum` for
the webapp and SDK to talk to. It does *not* rely on any injected
wallet (MetaMask, etc.) and does *not* rely on the existing webapp
daemon bridge. It is its own self-contained client.

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
- **No keystore.** Today's extension presupposes an injected wallet
  for any signing operation. The webapp daemon bridge fills the gap
  on the webapp side. Both go away.

### 3.2 Gaps for alpha-5 E2E

| Surface | Gap |
|---------|-----|
| Wallet | No keystore at all — needs full BIP-39 HD wallet, password unlock, multi-account, send-to-external |
| EIP-1193 provider | Extension doesn't expose a provider — needs `window.datum` injection + JSON-RPC bridge |
| Pine | No light-client — needs offscreen-hosted smoldot, no HTTP fallback |
| Address sync | `shared/contracts.ts` needs the alpha-5 entries (relayStake, dualSig, activationBonds, peopleChainIdentity, mintCoordinator, etc.) |
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
    campaignPoller.ts                (existing — re-target alpha-5 reads via pineBridge)
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
    recoveryAddress.ts               (NEW — G-8 staging helpers)
    selfPause.ts                     (NEW — CB1 self-pause helpers)
    wallet/                          (NEW — self-contained wallet, §3.4)
      keystore.ts                    — AES-GCM encrypted vault format
      mnemonic.ts                    — BIP-39 generation + validation
      derivation.ts                  — BIP-32 secp256k1 derivation
      accounts.ts                    — multi-account state, active selection
      signing.ts                     — sign EIP-1559 tx, EIP-712 typed data, raw messages
      unlock.ts                      — password unlock + idle timeout + auto-lock
      send.ts                        — high-level send-token + send-DOT helpers
      provider.ts                    — EIP-1193 provider implementation
      transport.ts                   — chrome.runtime / postMessage RPC transport
      ratelimit.ts                   — per-origin signing rate limit

  offscreen/
    offscreen.ts                     (existing)
    smoldot.ts                       (NEW — pine WASM worker; subscribes to alpha-5 events)

  content/
    walletInjector.ts                (NEW — runs in MAIN world, injects window.datum)
    walletBridge.ts                  (NEW — relays postMessage ↔ chrome.runtime)
    adSlot.ts                        (existing)
    engagement.ts                    (existing)
    handshake.ts                     (existing — wallet handshake separate path)
    index.ts                         (existing)
    metaExtractors.ts                (existing)
    provider.ts                      (existing — keep for SDK handshake; rename if conflicts)
    sdkDetector.ts                   (existing)
    taxonomy.ts                      (existing)

  popup/
    App.tsx                          (existing — routes by wallet state: locked / no-wallet / unlocked)
    BrandMark.tsx                    (existing)
    UnlockScreen.tsx                 (NEW — password entry)
    OnboardingScreen.tsx             (NEW — first-run; generate or import wallet)
    GenerateMnemonic.tsx             (NEW — generate + confirm 12/24-word phrase)
    ImportWallet.tsx                 (NEW — import mnemonic or raw private key)
    AccountsTab.tsx                  (NEW — list, switch, derive, label)
    SendTab.tsx                      (NEW — send DOT + ERC-20 sidecars to external addr)
    ReceiveTab.tsx                   (NEW — show address + QR + copy)
    SettingsTab.tsx                  (NEW — change password, idle timeout, lock now, export, reset)
    EarningsTab.tsx                  (NEW — protocol earnings & history)
    AssuranceTab.tsx                 (NEW — userMinAssurance picker, self-pause toggle)
    IdentityTab.tsx                  (NEW — identity proof status + refresh)
    RecoveryTab.tsx                  (NEW — G-8 staging)
    ClaimQueue.tsx                   (existing)
    FiltersTab.tsx                   (existing)
```

### 3.4 Self-contained wallet

#### 3.4.1 Cryptography

- **Mnemonic:** BIP-39, 12-word default with 24-word option at
  generate time. Entropy from `crypto.getRandomValues`.
- **Seed:** PBKDF2(mnemonic, "mnemonic" + passphrase, 2048) per
  BIP-39. Passphrase (optional 25th word) supported on import +
  generate.
- **Derivation:** BIP-32 / BIP-44 on secp256k1, path
  `m/44'/60'/0'/0/N` (Ethereum-compatible — matches what
  Polkadot Hub's pallet-revive expects).
- **At-rest vault:** AES-GCM-256, key derived from user password
  via Argon2id (interactive params: 64 MB / 3 iters / 1 thread on
  desktop; tunable). Salt + nonce per vault. Vault holds the
  encrypted seed + account metadata; never holds raw keys outside
  the unlock window.
- **In-memory key handling:** raw private keys live in the
  offscreen document while unlocked, derived on demand from the
  in-memory seed. Service worker never holds raw keys.

#### 3.4.2 Unlock + lock UX

- First-run: user picks "Generate new wallet" or "Import existing".
  Generate flow shows the 12-word phrase, requires confirmation
  before proceeding, then asks the user to set a password.
- Subsequent sessions: popup opens to `UnlockScreen` if locked.
  Password unlocks the vault in the offscreen document.
- Auto-lock: configurable idle timeout (default 30 min). Browser
  close also locks. "Lock now" button in SettingsTab.
- "Forgot password" path: only recoverable via mnemonic re-import.
  The vault is destroyed; user supplies the phrase again.

#### 3.4.3 Accounts + addresses

- Multi-account from one seed. Default: 1 account on first install.
- "Add account" derives the next path index (`m/44'/60'/0'/0/N+1`).
- Labels are stored encrypted in the vault.
- "Import additional key" (raw 0x… private key) — stored alongside
  HD accounts in the vault, flagged as `source: "imported"` so the
  UI can warn the user that this key isn't in their mnemonic backup.
- Switching active account is a single click in AccountsTab and
  emits an `accountsChanged` event on the EIP-1193 provider.

#### 3.4.4 Send to external address

`SendTab.tsx` supports:

- **Native DOT (PAS on testnet):** standard EIP-1559 tx.
- **ERC-20 tokens:** any token where the wallet has a non-zero
  balance, surfaced from the user's interaction history. Users can
  also paste an arbitrary token contract address to send tokens not
  yet auto-discovered.
- **Asset Hub native sidecars** (USDT, USDC) via the precompile
  addresses in `assetRegistry.ts` — same `transfer(to, amount)`
  shape since they're behind ERC-20 precompiles.

The send flow:

1. User picks token, recipient address, amount.
2. Wallet runs `eth_estimateGas` (via pine) and shows fee.
3. Wallet prompts for confirmation; PoW-style anti-misclick delay
   (1 s minimum) on first-time recipients.
4. User confirms; wallet signs EIP-1559 tx with the active account's
   private key (derived in the offscreen document from the unlocked
   seed), broadcasts via pine's `eth_sendRawTransaction`.
5. Popup shows the receipt as soon as pine's TxPool sees it
   (Paseo null-receipt bug doesn't apply because pine has the tx).

#### 3.4.5 EIP-1193 provider

The extension exposes `window.datum` (not `window.ethereum`,
avoiding collision with MetaMask). Implements the minimum useful
subset:

- `datum_requestAccounts` (with permission prompt)
- `eth_accounts`
- `eth_chainId`
- `eth_sendTransaction` (asks user to confirm in popup)
- `eth_signTypedData_v4` (for EIP-712 — settlement cosigs, etc.)
- `personal_sign`
- `wallet_switchEthereumChain` / `wallet_addEthereumChain`
  (return chain-not-supported gracefully on testnet; alpha-5 is
  Paseo-only)
- `eth_getBalance` / `eth_call` / `eth_getLogs` / etc. — read RPC
  passed through to pine

Plumbing:

```
webapp dApp page
  │  window.datum.request({ method, params })
  ▼
content/walletInjector.ts        (MAIN world)
  │  window.postMessage to ISOLATED world
  ▼
content/walletBridge.ts          (ISOLATED world)
  │  chrome.runtime.sendMessage
  ▼
background/wallet/transport.ts   (service worker)
  │
  ├─ if read RPC          → background/pineBridge.ts → offscreen pine
  └─ if signing required  → background/wallet/signing.ts (needs unlocked vault)
       │
       └─ unlocked? sign + send; locked? open popup, return after unlock
```

Origin permissioning: a per-origin allowlist in the vault. First
time a site calls `datum_requestAccounts`, the popup pops up with a
"Allow datum.example to see your accounts?" prompt. Allowed origins
are remembered until revoked from SettingsTab.

#### 3.4.6 Pine integration

- `background/pineBridge.ts` defines `pineRpc(method, params)` that
  forwards to the offscreen document; offscreen's `smoldot.ts` owns
  the WASM client and is the only place pine lives.
- **All chain reads route through pineRpc. No HTTP fallback.**
- Cold install: popup boots into Onboarding (no pine needed yet);
  once the user has a wallet + password, the EarningsTab is shown
  with a "Syncing chain — N peers, M blocks finalized" indicator
  until pine warms up.
- Smoldot lifetime: the offscreen document persists across popup
  open/close so pine keeps syncing in the background. Browser
  restart cold-starts pine again (acceptable; ~30 s warm-up).
- Bundle impact: ~600 KB smoldot WASM + chainspec, fetched once
  on first install and cached in `chrome.storage.local`.

### 3.5 Dashboard surface (popup)

The popup is a multi-tab UI; the "dashboard" equivalent is
**EarningsTab**, with the wallet-y tabs (Accounts, Send, Receive,
Settings) as siblings. Top-bar:

- Active account avatar + truncated address (click → AccountsTab)
- Balance summary (DOT + DATUM headline)
- Lock button + connection chip (Pine syncing / Pine ready)

EarningsTab content:

- Lifetime DOT credit, lifetime DATUM credit, lifetime ERC-20
  sidecars credit
- Today (24 h) settled
- Pending withdraw (PaymentVault pull queue + TokenRewardVault per
  token)
- Recent settlements (last 10) — campaign, amount, time
- Next claim flush ETA (queue depth + relay cadence)
- AssuranceLevel selector (L0 / L1 publisher-signed / L2 dual-sig /
  L3 ZK-only)
- Self-pause toggle (CB1 — opt-out without uninstalling)
- "Stage recovery address" button (G-8) — opens RecoveryTab

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
| Pine | Currently uses ethers + Paseo HTTP RPC; must move to pine-only (no HTTP) for reads + writes |

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
    provider.mjs                     (pine-only — no HTTP)
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

- `provider.mjs` exposes `getProvider()` backed by pine only.
  Same single-rail shape as the webapp.
- Pine in Node ships via `pine/dist` consumed as a normal package.
  Smoldot WASM is loaded once at startup; the relay process is
  long-lived so the 600 KB warm-up cost is amortized.
- Receipt waits route through pine's session TxPool (this is the
  big win — the Paseo eth-rpc null-receipt bug is the #1 source
  of relay-bot retries today, and pine fixes it).
- On boot, relay refuses to submit any tx until pine has reached
  `peers ≥ 2 && finalizedHead != 0` to avoid sending into a
  half-synced view. Status emitted via the `/health` endpoint.

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
- Backpressure: if pine is warming up, hooks return a `loading`
  state until pine reaches the requested `fromBlock`. No HTTP
  fall-through.

This pattern is required because Pine's `getLogs` is in-memory but
not free — one call per dashboard per block ≈ 1.5 s of WASM work
on bigger windows. Multicasting cuts that to one call per block
total.

---

## 8. Rollout sequence

Order matters because each layer assumes the one before it is in
place. The wallet is now first — every other client surface depends
on it (extension owns signing; webapp talks to extension; pine
config + chainspec are loaded once by the extension and re-used).

### Stage 1 — Extension foundation (wallet + pine)

1. Extension `offscreen/smoldot.ts` — pine WASM, chainspec, peer
   bootstrap, event subscriptions on alpha-5 addresses.
2. Extension `background/pineBridge.ts` — single RPC entry point.
3. Extension `background/wallet/{keystore,mnemonic,derivation,accounts,unlock,signing}.ts`
   — encrypted vault, BIP-39/BIP-32, multi-account, sign tx + EIP-712.
4. Extension popup `OnboardingScreen`, `UnlockScreen`,
   `GenerateMnemonic`, `ImportWallet` — first-run flows.
5. Extension popup `AccountsTab`, `SendTab`, `ReceiveTab`,
   `SettingsTab` — wallet UI.

### Stage 2 — Extension as EIP-1193 provider

6. Extension `background/wallet/provider.ts` + `transport.ts` —
   provider implementation, per-origin permission prompt.
7. Extension `content/walletInjector.ts` + `walletBridge.ts` —
   inject `window.datum`, postMessage relay to background.
8. Webapp `lib/walletConnector.ts` — detect `window.datum`,
   `connect()` / `signAndSend()` API.
9. Webapp `<NeedsExtension>` panel + read-only fallback.

### Stage 3 — Webapp foundation

10. Webapp `lib/provider.ts` — pine-only.
11. Webapp `lib/eventBus.ts` — multicasted log subscriptions.
12. Webapp `lib/networks.ts` — re-ground on alpha-5 addresses.
13. Shared dashboard template (`Dashboard.tsx` + hooks).

### Stage 4 — User + Publisher surfaces

14. `/me` dashboard.
15. `/publisher` dashboard.
16. Extension popup `EarningsTab`, `AssuranceTab`, `RecoveryTab`.

### Stage 5 — Advertiser + Governance

17. `/advertiser` dashboard + ActivationBonds create-bond flow.
18. `/governance` dashboard + new sub-pages (activation-bonds,
    advertiser-fraud).
19. SDK Bulletin creative loader + click reporter.

### Stage 6 — Protocol + Token + Identity

20. `/protocol` dashboard + sub-pages (tag curator + upgrades).
21. `/token` dashboard + mint-coordinator log.
22. `/identity` dashboard + extension `IdentityTab`.

### Stage 7 — Relay-bot

23. Relay-bot README + skeleton (`relay-bot.example/`).
24. Relay-bot pine wiring (no HTTP).
25. Relay-bot `/metrics` HTTP endpoint.
26. StakeRootV2 reporter cron + clickRegistry batcher.

### Stage 8 — Polish

27. Pine status chip across all surfaces.
28. Warm-up banners + partial-window indicators.
29. Per-dashboard recent-action shortcuts.
30. Wallet polish: account avatars (blockies), QR codes on Receive,
    transaction history view.

---

## 9. Open design questions

These need answers before / during implementation:

1. **Smoldot chainspec source.** The chainspec for `paseo-asset-hub`
   needs to ship with the extension + webapp. Pine already vendors
   one in `pine/src/chainspecs/`; we'll consume it directly. Open:
   how often does the spec need to be refreshed (Paseo runtime
   upgrades), and what's the update channel (extension auto-update
   for Chrome Web Store, manual for unpacked)? Recommendation:
   pin a known-good spec per release and rev with each protocol
   upgrade.
2. **History cutoff UX.** "No HTTP, ever" means earnings before
   install are invisible. Popup must be explicit: "History begins
   at block N (installed 2026-05-21)". Open: do we *also* offer a
   "scan from genesis" power-user button that lets pine sync
   backward? Pine doesn't support backward fills today; we'd need
   to add it (out of scope for first cut). Recommendation: ship
   without backward sync; add later if user demand justifies.
3. **Vault password reset.** No recovery path other than the
   mnemonic. If a user forgets both, funds are lost. Open: do we
   offer a "destroy vault + re-import mnemonic" UI explicitly, or
   require the user to uninstall + reinstall the extension?
   Recommendation: explicit "Reset wallet" button in SettingsTab,
   gated behind a "Type RESET to confirm" prompt. Same outcome as
   uninstall, lower friction.
4. **EIP-1193 namespace.** `window.datum` avoids MetaMask
   collision but means existing dApps don't auto-discover us.
   Open: do we also implement EIP-6963 (multi-injected-provider
   discovery) so the webapp's wallet picker can list both DATUM
   and other wallets, even though we only support DATUM ourselves?
   Recommendation: yes — EIP-6963 announce-event, even though our
   provider is the only one our webapp actually supports. Future-
   proofs the interface.
5. **Send-tab token discovery.** Auto-discover ERC-20 holdings via
   pine event logs (Transfer events to this address). Open: do we
   subscribe to *all* Transfer logs and filter (expensive), or
   maintain a curated allowlist of tokens (DATUM, USDT, USDC, etc.)
   plus user-pasted addresses? Recommendation: allowlist + paste,
   no global subscription. Auto-discovery is a follow-on.
6. **PoW + signing concurrency.** The extension already does PoW
   solving in a worker. With the wallet in the offscreen document
   too, we now have several long-running CPU consumers in one
   place. Open: do we move PoW solving to a separate worker pool,
   or keep it in offscreen with cooperative yielding?
   Recommendation: keep in offscreen, add yield points to PoW
   solver every N hashes so wallet unlock + signing stays
   responsive.
7. **Relay-bot multi-publisher.** The mainnet design (per backlog
   §1.8) is multi-publisher with HSM keys. For Paseo we stay
   single-publisher Diana. Recommendation: multi-publisher shape
   from day one, with `publishers: [{ address, signerEnv }]`
   defaulting to a single entry. Cheap to add; expensive to
   retrofit.
8. **Dashboard data-freshness UX.** Block-level refresh (every ~6 s
   on Paseo) is the right cadence for telemetry streams but feels
   chatty for hero stats. Recommendation: hero stats poll on
   block intervals but only re-render when a value changes;
   telemetry stream re-renders every block.
9. **Mobile.** Webapp is desktop-first. The dashboard template
   assumes a wide hero-strip + side-by-side stream/actions. Mobile
   reshuffles to vertical stack. The extension is desktop-only
   for now (no mobile Chrome extension support yet). Open:
   commit to a mobile-friendly webapp (read-only, since no
   extension = no signing) or punt? Recommendation: responsive
   read-only webapp; mobile signing waits for a future RN/PWA
   wallet companion.

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

Which client(s) talk to each alpha-5 contract. Note: every "R/W"
entry on Webapp routes signing through the extension via
`window.datum`; the webapp never holds a key. The Extension column
is the canonical signer in every row where it appears as R/W.

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
