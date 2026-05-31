# DATUM Test Network — demo publisher sites + creatives + on-chain wiring

A self-contained fixture for the **manual end-to-end test** of the DATUM ad
exchange on Paseo (alpha-5 v5): real publisher pages → SDK ad slots → on-chain
auction (in the extension) → IPFS creatives → claim → settlement.

Everything is driven from **`manifest.json`** (the single source of truth). The
four scripts read it; the static sites are generated from it. Contract addresses
come from `../../deployed-addresses.json`; account keys from `../../.env`.

```
manifest.json ──┬─ generate-creatives.mjs ─► creatives/<brand>/<format>.svg  (42 SVGs)
                ├─ pin-and-set-metadata.mjs ─► IPFS pins + CampaignCreative.setMetadata (24 campaigns)
                ├─ register-publishers.mjs ──► registerPublisher + tags + relaySigner + stake
                └─ build-testpages.mjs ──────► web/public/testpages/ (landing + 6 sites × 3 pages)
```

## What's deployed

- **Sites:** `web/public/testpages/` — served by the webapp at **`/testpages/`**
  (e.g. `https://datum.javcon.io/testpages/` or `http://localhost:5173/testpages/`
  in dev). Landing page links all six. Each site has a clear **TEST banner**, reads
  like a normal publication, and carries multiple IAB ad slots wired to its
  publisher address.
- **Creatives:** 6 brands × 7 IAB formats = **42 SVGs**, pinned to the local Kubo
  node, referenced by **24 campaigns'** on-chain creative metadata.

### Publisher ↔ site map

| Site | Account | Address | Take | Tags | On-chain |
|---|---|---|---|---|---|
| **ChainSignal** (crypto news) | Diana | `0xca5668…b58d0` | 50% | crypto-web3, news, polkadot | ✅ registered + staked |
| **DevForge** (dev tools) | Eve | `0xd633c4…35745` | 40% | computers-electronics, internet-telecom | ✅ registered + staked |
| **Salt & Ember** (recipes) | Frank | `0x926229…c7620` | 50%* | food-drink, hobbies-leisure | ✅ registered + staked |
| **PixelPit** (gaming) | Grace | `0xa9e2bd…bc92f` | 50% | gaming, online-communities | ✅ registered + staked |
| **FinFold** (finance) | Hank | `0x615bcb…b5bbd` | 40% | finance, business-industrial | ⏳ pending (see below) |
| **Wanderlux** (travel) | Iris | `0xc59101…065af` | 42% | travel, hobbies-leisure | ⏳ pending (see below) |

\* Frank was already registered at 50% from an earlier run; the manifest's 45% is
the intended value (re-run after `setTakeRate` if you want it changed).

> **Hank & Iris are display-ready now** (their pages render and the extension will
> auction/inject creatives on them) but were **not finishable on-chain** during the
> build because the public Paseo eth-rpc gateway was degraded (funding transfers
> didn't land; `eth_call` intermittently returned `0x`). Settlement *on those two
> publishers* needs them registered + staked. Finish them with one idempotent
> command once the gateway is healthy:
> ```bash
> node register-publishers.mjs            # funds (from deployer) + registers + tags + relaySigner + stakes Hank & Iris
> node register-publishers.mjs --dry      # preview first
> ```

### Advertiser ↔ campaign ↔ brand ↔ creative map

Creatives were set on **24 active campaigns** (the seed alternates owners: **odd
ids = Bob `0xfe091a…`, even ids = Charlie `0x09ce34…`** — both keys held in
`.env`). Brands rotate every 6 campaigns:

| Brand | Campaigns | Metadata JSON CID (IPFS) |
|---|---|---|
| Nimbus Wallet (crypto) | 1, 7, 13, 19 | `QmbCwaTi5CnmGDG4SwVUDozXFZT1doCV58aFT1yJCkaxVu` |
| Quanta DEX (defi) | 2, 8, 14, 20 | `QmQArTv2LQAt6XZKfojTEWZT6SLb5he5wGf7xNxLGKCFDa` |
| ForgeCloud (tech) | 3, 9, 15, 21 | `QmWunXaWR9aZvLppFM6jtFLeKaT1eXRhfdjcn2cZwUBBGY` |
| Aera Travel | 4, 10, 16, 22 | `QmeqEXqa4acERxtKgzkq2qHMELrPHsaBJ79Mb5B3w66e2a` |
| Lumen Energy (finance) | 5, 11, 17, 23 | `QmQniJaRw1nXRMtY5TL7WSBxr6KexVnEtQwKDRVDZZGems` |
| PixelQuest (gaming) | 6, 12, 18, 24 | `Qmb1VJitSiwKQGSaGHQ8FzvKsWYXrbaxyvC9E6zhL2gXfV` |

Every per-format SVG CID is in `manifest.json` → `creatives.<brand>.<format>`.
The metadata JSON is the [`CampaignMetadata`](../../../web/src/shared/types.ts)
shape (`creative.images[]` = one URL per IAB format) and is stored on-chain as
`cidToBytes32(cid)` via `DatumCampaignCreative.setMetadata(campaignId, hash)`.

## Contracts touched (alpha-5 v5)

| Purpose | Contract | Address |
|---|---|---|
| Creative metadata (`setMetadata`) | DatumCampaignCreative | `0xBfA458a72d86860973697ac5291DC1C5fEFFbC81` |
| Campaign advertiser lookup | DatumCampaigns | `0x3a7AB32f47f789A59c0dd659fd2DB08E4662E149` |
| Publisher registry / relaySigner | DatumPublishers | `0xAAED2e515574b330A16320A6Df5669274c6Abb80` |
| Publisher tags | DatumTagSystem | `0xA3548857670E5DF54cc06ab3bBBbf0F12233a406` |
| Publisher stake | DatumPublisherStake | `0x1A7903Af6B47E6d0a071DD7a70Ffb89Fe5A39147` |

## IPFS

- Local Kubo node: API `http://127.0.0.1:5001`, gateway `http://127.0.0.1:8090/ipfs/`.
- All SVGs + metadata JSONs are **pinned CIDv0** (`Qm…`) so the digest fits the
  on-chain `bytes32`. The gateway serves them with `Content-Type: image/svg+xml`.
- Image URLs in the metadata use the **local gateway** (`127.0.0.1:8090`) — fine
  for a same-machine manual test. For remote testing switch `gateway` in the
  manifest to the tunnel (`gatewayPublicAlt`: `https://ipfs-datum.javcon.io/ipfs/`)
  and re-run `pin-and-set-metadata.mjs` (which rewrites the on-chain metadata).

## Rebuild from scratch

```bash
cd alpha-5/scripts/demo-network
node generate-creatives.mjs                 # 42 SVGs (no chain, no IPFS)
node pin-and-set-metadata.mjs --pin-only    # pin to IPFS + build metadata JSON, write CIDs to manifest
node pin-and-set-metadata.mjs               # ... and setMetadata on-chain (needs BOB/CHARLIE keys)
node register-publishers.mjs                # register/stake Frank/Grace/Hank/Iris (needs their + DEPLOYER keys)
node build-testpages.mjs                    # regenerate web/public/testpages/
```

## Manual e2e flow (what to do in the browser)

1. **IPFS** running (creatives) and, to settle, the **lab relay** running
   (`datum-labs/relay`, `http://127.0.0.1:3400`) holding the publisher's
   relaySigner key. For display only, neither the relay nor registration is needed.
2. **Build + load the extension** (`alpha-5/extension`, `npm run build`, load
   `dist/` unpacked) pointed at the alpha-5 v5 addresses.
3. **Serve the webapp** (`cd web && npm run dev`) and open
   `http://localhost:5173/testpages/`. Pick a site.
4. The SDK declares the page's slots; the extension classifies the page, runs a
   second-price auction over the active campaigns, fetches the winning creative
   from IPFS, and injects it at the exact IAB size. (No extension → you see the
   SDK's house-ad fallback, which still proves the layout.)
5. Claims auto-submit to the relay → `settleSignedClaims` on-chain. Watch
   `datum-labs/indexer` (`/api/summary`, `ClaimSettled`) for the settlement and
   the payment split.

> Because the 24 creatived campaigns are **open** (no publisher binding, no
> required tags) they compete in every page's auction; whichever wins shows its
> SVG. The other ~150 seeded campaigns have no creative and fall back to the
> extension's default. To bias toward creatives, give metadata to more campaigns
> (extend `campaignAssignments` and re-run `pin-and-set-metadata.mjs`).

## Paseo gotchas baked into these scripts

- **Decimal asymmetry:** `eth_getBalance` returns **18-decimal wei**; tx `value`
  and on-chain `msg.value`/`requiredStake` are **10-decimal planck** (1e8 gap).
  Scripts read balances in wei, send values in planck.
- **Max-fee reserve:** with `gasLimit 5e8 × gasPrice 1e12`, an account must hold
  **> 500 PAS** just to broadcast a tx (the fee actually charged is tiny). The
  register script funds candidates to 700 PAS first.
- **Null receipts:** confirmation falls back to nonce-advance.
- **Gateway flakiness:** the public eth-rpc intermittently drops calls / returns
  `0x`. All on-chain scripts are **idempotent** — just re-run.
- **Denomination rounding:** transfer values are clean multiples of 1e6 planck.
