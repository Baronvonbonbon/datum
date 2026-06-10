# DATUM relay-bot (reference skeleton)

This is the **reference layout** for a DATUM relay operator. The
live `relay-bot/` sibling is gitignored (it holds keys); this
`relay-bot.example/` is the canonical, keyless skeleton checked
into the repo so new operators can clone it as a starting point.

```
cp -r relay-bot.example/ relay-bot/
cd relay-bot
cp .env.example .env       # fill in RELAY_PRIVATE_KEY, RPC_URL, …
npm install
node src/index.mjs
```

## What it does

A relay-bot brokers three things between publishers and the DATUM
contracts:

1. **Settlement** — receives claims from the publisher's SDK,
   batches them, and submits `DatumSettlement.settleSignedClaims`
   on the publisher's behalf.

2. **Clicks** — receives CPC click events from the SDK, batches,
   and submits `DatumClickRegistry.recordClick`.

3. **StakeRootV2 attestations** — the relay operator's staked
   reporter set posts publisher-stake roots periodically so the
   on-chain rate-limiter / reputation surfaces stay current.

The relay is the **publisher's trust anchor**. Most production
deployments will run their own; this skeleton is the canonical
shape so they all look alike.

## Architecture

```
                                          ┌──────────────┐
publisher page  ─ datum:sdk-ready ──►  SDK ─ POST /click   /metrics ◄── webapp
publisher page  ─ datum:click     ──►  SDK ─ POST /click       │       /publisher
                                          │                    │       dashboard
                                          ▼                    │
                                       relay-bot ──── pine ──► Paseo Hub
                                          │                    │
                                          │                    └─► Settlement
                                          │                    └─► ClickRegistry
                                          ├── cron ───────────►└─► StakeRootV2
                                          └── XCM oracle ─────►└─► PeopleChain
```

- **Reads** flow through pine (smoldot light client). No HTTP RPC
  hop on the critical path.
- **Writes** flow through pine's `eth_sendRawTransaction` + the
  TxPool receipt-watcher. This sidesteps the Paseo eth-rpc
  null-receipt bug, which is the #1 source of relay retries
  today.
- **Optional RPC fallback** is wired for periodic history jobs
  (monthly settlement digest, archive divergence checks) — never
  on the live path. Configurable via `RPC_URL` env.

## Directory layout

```
src/
  index.mjs              boot, signal handling, dependency wiring
  config.mjs             env + alpha-5 address loader
  provider.mjs           pine-only provider (+ optional RPC fallback)

  poll/
    campaigns.mjs        campaign list, status, metadata
    claims.mjs           incoming claims from publisher SDK
    identityRequests.mjs PeopleChain refresh requests

  submit/
    settlement.mjs       settleSignedClaims batcher
    clickRegistry.mjs    recordClick batcher
    stakeRootV2.mjs      reporter cron + retry
    bulletinRenewer.mjs  Bulletin creative escrow renewer
    identityOracle.mjs   PeopleChain oracle callback

  monitor/
    receipts.mjs         pine TxPool receipt waiter
    rateLimiter.mjs      settlement window stats
    divergence.mjs       StakeRoot V1 vs V2 cross-check

  logging/
    structured.mjs       JSON line logger (journalctl -o json friendly)
    telemetry.mjs        last-N events ring buffer for /metrics

scripts/                 (legacy diagnostic helpers — optional)
systemd/
  datum-relay.service    systemd unit template
```

## Configuration

`.env` (copy from `.env.example`):

| key                          | required | default                                      | notes |
|------------------------------|----------|----------------------------------------------|-------|
| `RELAY_PRIVATE_KEY`          | yes      | —                                            | 0x-prefixed hex. Funds the submitter. |
| `NETWORK`                    | no       | `polkadotTestnet`                            | `polkadotTestnet`, `polkadotHub`, `local` |
| `RPC_URL`                    | no       | `https://eth-rpc-testnet.polkadot.io/`       | RPC fallback for history jobs only. |
| `HTTP_PORT`                  | no       | `3401`                                       | localhost bind for `/metrics`, `/events`, `/health`. |
| `HTTP_BIND`                  | no       | `127.0.0.1`                                  | Keep localhost on testnet. Mainnet adds HMAC. |
| `CLICK_BATCH_SIZE`           | no       | `25`                                         | Clicks per `recordClick` TX. |
| `CLICK_BATCH_MAX_AGE_MS`     | no       | `15000`                                      | Force-submit a partial batch after this idle gap. |
| `STAKE_ROOT_INTERVAL_BLOCKS` | no       | `600`                                        | StakeRootV2 cron interval — default ~1h on a 6s chain. |
| `SETTLEMENT_BATCH_SIZE`      | no       | `8`                                          | Claims per `settleSignedClaims` TX. |

## Pine bootstrap

On boot the relay refuses to submit any TX until:

- `peers ≥ 2`
- `finalizedHead != 0`

Status surfaces via `GET /health`. If pine never reaches that
threshold (peer storm, chainspec mismatch) the relay exits with
code 2 and the systemd unit's `Restart=on-failure` schedules a
retry.

## Submitting

| flow            | path                         | unit             |
|-----------------|------------------------------|------------------|
| Settlement      | poll/claims → submit/settlement  | `DatumSettlement.settleSignedClaims` |
| Clicks          | HTTP `/click` → submit/clickRegistry | `DatumClickRegistry.recordClick`     |
| Stake root      | cron → submit/stakeRootV2            | `DatumStakeRootV2.postRoot`          |
| Identity oracle | XCM watcher → submit/identityOracle  | `DatumPeopleChainIdentity.attest`    |

Each submitter wraps:

1. `provider.getNonce()` (cached + monotonic per submitter).
2. `provider.signAndSend(tx)` (writes via pine + tracks receipt
   via TxPool).
3. Retry on transient errors with exponential backoff (1s, 2s,
   4s, … capped at 60s, max 5 retries).
4. Structured log line on success/failure.

## Endpoints

| endpoint                | shape | purpose                          |
|-------------------------|-------|----------------------------------|
| `GET /metrics`          | JSON  | queue depths, last 10 TXs, last stake-root epoch |
| `GET /events?since=`    | JSON  | recent on-chain events the relay observed |
| `GET /health`           | JSON  | pine connected, signer balance, signer is approved |
| `POST /click`           | JSON  | SDK click reporter — see `sdk/datum-sdk.js` v3.4 |
| `GET /bulletin/<cid>`   | bytes | read-only Bulletin gateway proxy |

Authentication is **localhost-bind only** on testnet. Production
mainnet operators should add HMAC-signed requests + TLS — out of
scope here.

## Operational runbook

- **Tail logs:** `journalctl -u datum-relay -f -o json`
- **Force a stake-root post:** `node scripts/post-stake-root.mjs`
- **Drain settlement queue:** `node scripts/drain-claims.mjs`
- **Diagnose a stuck TX:** `node scripts/diagnose-tx.mjs <hash>`

The systemd unit at `systemd/datum-relay.service` is a template —
edit `User`, `WorkingDirectory`, and `EnvironmentFile` for your
host.

## Status of this skeleton

| Stage | Component                                       | State |
|-------|-------------------------------------------------|-------|
| 7a    | README + skeleton + config + structured logging | shipped |
| 7b    | pine provider + poll/* primitives                | shipped |
| 7c    | /metrics + /events + /health HTTP               | shipped |
| 7d    | StakeRootV2 cron + clickRegistry batcher        | shipped |
| —     | settleSignedClaims batcher                       | planned (`submit/settlement.mjs` stub for the live tree) |
| —     | identity-oracle XCM submit                       | planned (`submit/identityOracle.mjs` stub) |
| —     | bulletin gateway proxy                            | planned (`/bulletin/<cid>` 501s until wired) |

See `alpha-core/narrative-analysis/e2e-client-design.md` §5 for the
design discussion.
