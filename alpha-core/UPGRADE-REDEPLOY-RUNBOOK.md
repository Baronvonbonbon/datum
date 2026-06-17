# Paseo redeploy runbook — migrate-friendly contracts

Upgrades the live Paseo deployment to the migration/cypherpunk contracts (merged
in PR #2). The current live contracts (2026-05-23) **predate the `_migrate`
enumeration getters**, so they can't serve as a migrate source — this is a
**fresh redeploy + re-seed**, not an in-place migrate. Live state (campaigns,
stakes, votes) is **not** carried over. The *new* deployment is migrate-friendly,
so future upgrades carry state via `migrate()` / `migrateFundsTo()` /
`migrateDelegate()`.

## Pre-staged in this branch (already done)
- `deploy.ts` deploys **`DatumCampaignsMigrationLogic`** and wires
  `campaigns.setMigrationLogic(...)` (lock-once) + validates the new key.
- **66 consumer ABIs re-synced** from the new artifacts (`scripts/sync-abis.mjs`)
  — web + extension. (Orphans `DatumBrandCurator/Registry` are stale pre-rename
  leftovers; `tagCurator`/`tagSystem` are the live ones.)
- `scripts/repoint-addresses.mjs` — post-deploy address propagation to the web
  app's two spots.

## Deploy sequence (fire when ready)

```bash
cd alpha-5

# 1. fresh artifacts + ABIs in sync with the merged code
npx hardhat compile
node scripts/sync-abis.mjs

# 2. archive the current live addresses, then start fresh
cp deployed-addresses.json deployed-addresses.$(date +%Y%m%d)-pre-migrate.json
rm deployed-addresses.json            # deployOrReuse reuses if present — must clear for new code

# 3. fresh deploy (~48 contracts + wiring; ~150-300 PAS, 30-60 min on Paseo)
#    raw-provider + nonce-poll + getCreateAddress workaround is built in.
npx hardhat run scripts/deploy.ts --network polkadotTestnet
#    -> writes deployed-addresses.json (canonical) + extension/deployed-addresses.json

# 4. seed demo data (campaigns, publishers, stakes, votes)
npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet
#    (or scripts/setup-demo.ts for the lighter demo seed)

# 5. re-point the web app (networks.ts + public json + bump DEPLOY_VERSION)
cd ../web && node resync-addresses.mjs && cd ../alpha-core

# 6. rebuild consumers
cd ../web && npx vite build && cd ../alpha-core
cd extension && npm run build && cd ..

# 7. restart the relay + indexer so they reload addresses
#    (datum-labs/relay + datum-labs/indexer read alpha-core/deployed-addresses.json
#     via DATUM_ADDRESSES; they resolve live from the router — just restart)
systemctl --user restart datum-relay@diana
systemctl --user stop    datum-relay@frank   # obsolete in single-publisher demo

# >>> THEN run the mandatory "Demo refresh" checklist below (DEMO_RELAY wiring is
#     handled on-chain by setup-testnet step 2.6/2.6b; verify /relay/publishers).
```

## Post-deploy verification
- `deployed-addresses.json` has **`campaignsMigrationLogic`** + 48 others.
- `campaigns.migrationLogic()` returns the logic address (carve-out wired).
- Spot-check on Blockscout: a few contracts have code; `setup` seeded campaigns.
- Web demo (`web/public/deployed-addresses.json`) + `networks.ts` show the new
  addresses; `npx vite build` clean.
- Extension `npm run build` clean.
- Relay preflight (`datum-labs/relay/scripts/preflight.mjs`) green against new
  addresses.

## Rollback
The previous addresses are in `deployed-addresses.<date>-pre-migrate.json`.
To revert the demo, restore that file, re-run `repoint-addresses.mjs`, rebuild.
The old contracts remain live on Paseo (nothing is destroyed by a fresh deploy).

## Downstream re-point matrix
| Consumer | Mechanism | Action |
|---|---|---|
| extension `deployed-addresses.json` | deploy.ts writes it | auto |
| relay (`datum-labs/relay`) | reads `alpha-core/deployed-addresses.json` (DATUM_ADDRESSES) | restart |
| indexer (`datum-labs/indexer`) | reads `alpha-core/deployed-addresses.json` | restart |
| web `public/deployed-addresses.json` | runtime fetch | `repoint-addresses.mjs` |
| web `src/shared/networks.ts` | build-time map | `repoint-addresses.mjs` + rebuild |
| SDK (`sdk/datum-sdk.js`) | addresses passed in by caller | none |

## Demo refresh — MANDATORY on every redeploy / contract upgrade (2026-06-17)

The demo settles under a **single registered publisher (Diana)** whose on-chain
`relaySigner` is a dedicated **throwaway key, DEMO_RELAY**
(`0xC96435014293396BA7F6dC63687A9432441C4e0e`). DEMO_RELAY is shared by the browser
demo daemon (`web/src/lib/extensionDaemon.ts`) and the live relay
(`datum-labs/relay` `RELAY_PRIVATE_KEY`); its key is public by design (zero value,
gitleaks-allowlisted) so the rotated live keys stay out of source. Demo campaigns
are **open** (publisher = 0x0), so the settle path resolves the expected signer to
the claim's publisher (Diana) → her relaySigner (DEMO_RELAY). After a key rotation
or fresh redeploy the demo breaks unless **every layer below** is refreshed.

**On-chain — automated by `setup-testnet.ts` steps 2.6/2.6b (runs in step 4 above):**
- register Diana; `diana.setRelaySigner(DEMO_RELAY)`
- `relay.setRelayerAuthorized(DEMO_RELAY, true)`; fund DEMO_RELAY (≥ 1000 PAS — it
  self-submits + pays gas in both the daemon and the live relay)
- *(For a router `upgradeContract` that does NOT re-run setup-testnet, re-run just
  these — `npx hardhat run scripts/setup-testnet.ts` is idempotent and skips the rest.)*

**Off-chain — operator, after deploy + setup:**
```bash
# 1. webapp/extension addresses + DEPLOY_VERSION
cd web && node resync-addresses.mjs          # networks.ts + public json + bump version
npx vite build && (cd ../alpha-core/extension && npm run build)

# 2. live relay publisher policy — ONLY changes if Diana's ADDRESS changes (it does
#    NOT across redeploys that keep the same .env accounts). If it did:
#      ~/.config/datum-relay/diana.config.json  -> publishers:[diana], publisherMeta
#      ~/.config/datum-relay/diana.env          -> RELAY_PRIVATE_KEY = DEMO_RELAY key

# 3. restart the live relay (re-resolves contract addresses from the router via
#    DATUM_ADDRESSES). frank is obsolete in the single-publisher demo.
systemctl --user restart datum-relay@diana
systemctl --user stop    datum-relay@frank

# 4. verify
curl -s localhost:3400/relay/publishers      # -> single Diana (current addr) + CryptoHub meta
cd ../datum-labs/relay && node scripts/preflight.mjs --campaign <id> --publisher <diana-addr>
# expect "GO — no blockers" + publisherSig relaySigner == DEMO_RELAY
```

**Router `upgradeContract` (not a fresh deploy):** addresses behind the router
change but `deployed-addresses.json` may not — re-run `resync-addresses.mjs` against
the new/router-resolved addresses, restart the relay (auto-resolves from the
router), and rebuild consumers. Diana + DEMO_RELAY wiring survives (same accounts).
