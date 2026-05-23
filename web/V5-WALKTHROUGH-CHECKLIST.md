# Webapp v5 Walkthrough Checklist

Manual sanity-check of every page after the alpha-5 v5 redeploy
(2026-05-23T12:23Z). Goal: confirm chain reads work, no stale
addresses leak through, no broken navigation, no UI desync from the
fresh contract surface.

Time budget: ~15-20 min for a focused pass.

## Setup (1 min)

1. Open the webapp (local dev or deployed instance).
2. Confirm the network selector shows **Paseo Testnet** (Chain ID 420420417).
3. Pine status chip in the header — should turn green ("ready") within
   30s. If it doesn't, smoldot is broken; nothing below will pass.
4. RPC chip should default to **off** — leave it off for now.

## Anonymous (no wallet) walk — ~5 min

### Explorer

- [ ] **`/` (Overview)** — Hero stats populate within ~5s. Active /
      Pending / Impressions / DOT settled should all be non-zero
      (re-seeded campaigns). Confirm "Live network stats" is **not**
      stuck at "—".
- [ ] **`/campaigns`** — Paginated list of ~100 campaigns. Each row
      shows status, CPM, advertiser. Click into one — campaign detail
      loads with budget, votes, creative preview.
- [ ] **`/publishers`** — Diana + Eve listed. Click into one — profile
      page loads with tags + relay signer.
- [ ] **`/how-it-works`** — Static page, should always render.
- [ ] **`/philosophy`** — V/M/V section renders + the essay below.
- [ ] **`/about`** + each persona page (`/about/me`, `/advertiser`,
      `/publisher`, `/governance`, `/token`, `/identity`, `/protocol`).

### Wallet-required pages (anonymous preview)

- [ ] **`/me`** — Should show `<AnonymousPreviewBanner>` and a global
      activity stream (not address-scoped).
- [ ] **`/advertiser`** — Same banner; global campaign-creation stream.
- [ ] **`/publisher`** — Same banner; global settlement stream.
- [ ] **`/governance`** — Hero stats populate (phase, council members).

## Connected-wallet walk — ~5 min

Connect a wallet with PAS funding (use the deployer or one of the
seeded test accounts: Hank `0x615B…B5BbD`, Iris `0xC591…65af`,
Jack `0x705f…71d3` if funded).

- [ ] **`/me`** — DOT balance shows correctly. AssuranceLevel reads
      (likely 0 / Permissive). Identity status ("Not verified").
- [ ] **`/me/history`** — Page loads. Should show "Enable RPC" CTA
      because historical scan needs RPC. Don't enable yet.
- [ ] **`/me/identity`** — People Chain identity card. Cached
      attestation should show level 0 ("None") with the refresh
      button visible.
- [ ] **`/me/assurance`** — Current floor reads from chain.
- [ ] **`/me/dust`** — Pending vault balance (probably 0 unless this
      wallet has settled claims).
- [ ] **`/advertiser`** — Hero counts show 0/0/0 for a fresh wallet.
      Action hooks (Create Campaign, View campaigns, Analytics) all
      route to valid pages.
- [ ] **`/advertiser/create`** — Multi-pot form renders. The
      `minimumCpmFloor` read from the new Campaigns v2 contract
      (10,000,000 planck = 0.001 DOT/1000 imps) should appear as the
      minimum-CPM hint somewhere on the form.
- [ ] **`/publisher`** — Pending DOT / Stake / Reputation / Blocklist
      hero cards. If wallet isn't a registered publisher, register
      should be the obvious next action.
- [ ] **`/governance`** — Phase shows "0 (Admin)" with the deployer
      address. Pending campaigns visible.
- [ ] **`/protocol`** — All ~36 contracts enumerated. Spot-check a few
      tile links — `/protocol/parameter-governance` should load the PG
      admin page.

## Address-drift checks — ~3 min

Pages that surface a contract address inline — confirm they show the
v5 address, not a stale v3/v4.

- [ ] **Header → click any chain-relative number** (e.g., block ticker)
      — should not surface any old contract refs.
- [ ] **`/governance/phase-ladder`** — Lists every router-registered
      contract with current addr. Spot-check: Campaigns =
      `0x3a7A…E149`, MintCoordinator = `0xAb66…9aF2`,
      ParameterGovernance = `0xE288…3102`.
- [ ] **`/protocol`** dashboard — Same list, different presentation.
      Should match the phase-ladder addresses.
- [ ] **`/me/identity` → "Refresh" button** — Even if you don't fire
      the XCM, the target address in the confirmation should be the
      v5 `peopleChainXcmBridge = 0x4118…1230`.

## RPC toggle on — ~2 min

Now flip the RPC chip in the header to **on**.

- [ ] **`/me/history`** — CTA disappears. Historical scan kicks off.
      A "scanning blocks N to M" indicator should appear briefly.
- [ ] **`/explorer/campaigns/:id`** — Settlement history table should
      load older entries that pine alone couldn't reach.
- [ ] **`/governance/my-votes`** — Past votes (if any) load.
- [ ] Hover the RPC chip — tooltip should clearly state "rpc is
      provided for historical lookup but may expose metadata".
- [ ] Flip RPC back off — historical sections should fall back to
      "Enable RPC" CTAs again.

## Failure modes to watch for

- A page hangs on a skeleton loader for >30s → pine subscription is
  pointed at a stale address.
- A page renders "Error: contract address not configured" → an entry
  in `web/src/shared/networks.ts` is missing.
- A contract page loads but every value is `—` → the address is set
  but the contract has no code at that address (wrong network or
  drift).
- A transaction submission fails with `function ... is not a function`
  → ABI ↔ deployed contract mismatch (the ABIs were re-synced as part
  of the redeploy; if anything was missed it surfaces here).
- The webapp's "What is this page?" explainer banners default to
  expanded on first visit (localStorage was likely cleared) — that's
  expected, not a bug.

## After the walk

If everything passes: the webapp is consistent with alpha-5 v5. Commit
the verification.

If anything fails: capture the page URL + wallet state + console error
and decide whether to patch in-place or roll-forward. None of this is
"critical-path" — Paseo testnet is a soft surface — but each finding is
worth a memory entry so it doesn't reoccur on the next redeploy.
