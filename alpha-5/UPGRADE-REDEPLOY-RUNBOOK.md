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

# 5. re-point the web app (relay + indexer auto-read the canonical file)
node scripts/repoint-addresses.mjs

# 6. rebuild consumers
cd ../web && npx vite build && cd ../alpha-5
cd extension && npm run build && cd ..

# 7. restart the relay + indexer so they reload addresses
#    (datum-labs/relay + datum-labs/indexer read alpha-5/deployed-addresses.json
#     via DATUM_ADDRESSES; just restart the services)
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
| relay (`datum-labs/relay`) | reads `alpha-5/deployed-addresses.json` (DATUM_ADDRESSES) | restart |
| indexer (`datum-labs/indexer`) | reads `alpha-5/deployed-addresses.json` | restart |
| web `public/deployed-addresses.json` | runtime fetch | `repoint-addresses.mjs` |
| web `src/shared/networks.ts` | build-time map | `repoint-addresses.mjs` + rebuild |
| SDK (`sdk/datum-sdk.js`) | addresses passed in by caller | none |

## Demo gasless-relay seeding (2026-06-05 addendum)
`setup-testnet` creates 100 **open** campaigns (publisher = 0x0, relaySigner = 0x0)
— settleable only via the user's own wallet. The **gasless relay** (Diana, whose
publisher address == the relay key) can only settle campaigns whose publisher set
her as relaySigner, i.e. **closed campaigns under Diana**. Their relaySigner is
snapshotted immutably at creation, so it can't be retrofitted onto the open ones.

`setup-demo.ts` is **stale** (alpha-3 — expects merged satellites
targetingRegistry/reputation/etc. and bails). Until it's ported, seed the Diana
campaigns with:

```bash
node scripts/seed-diana-campaigns.mjs 5     # Bob → Diana, optimistic-activated
```

Verify with the relay preflight (reads the canonical addresses + on-chain state):
```bash
cd ../../datum-labs/relay
node scripts/preflight.mjs --campaign <id> --publisher 0xcA5668fB864Acab0aC7f4CFa73949174720b58D0
# expect "GO — no blockers" + publisherSig path relaySigner == relay key
```
