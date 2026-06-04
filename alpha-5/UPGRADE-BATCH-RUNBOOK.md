# Batch upgrade runbook — AdvertiserRegistry + PaymentVault (+ cypherpunk fix)

Status: **staged** (contracts + tests landed; not yet deployed to Paseo).

## What's in this batch

1. **DatumAdvertiserRegistry** (new, pure addition) — advertiser relay-signer +
   profile-hash registry, the symmetric counterpart of `DatumPublishers`.
   Drives off-chain co-signer endpoint discovery for the relay
   (campaign → advertiser → profileHash → metadata → cosigner URL), retiring the
   interim static `ADVERTISER_COSIGNERS` map. Migration-capable
   (enumeration + `_migrate`).
2. **DatumPaymentVault** upgrade — gasless `withdrawUserBySig` + full migration
   support: holder enumeration, `_migrate` (copies user/publisher/protocol
   balances + nonces + recovery state from a frozen predecessor), and a
   governance-gated, frozen-only `migrateFundsTo` native-DOT sweep so a successor
   is solvent.
3. **Cypherpunk-posture fix** (the regression flagged 2026-06): see below.

Deploy/wire: `scripts/deploy-batch-upgrade.ts`
(`MIGRATE_VAULT=1` to also run freeze→migrate→sweep when the predecessor is
migration-capable).

## The cypherpunk regression (fixed)

**Roadmap (2026-05-18):** *upgradable today, locked tomorrow* — every contract
stays governance-replaceable through Admin/Council; `lock*()` revert pre-OpenGov
so the system stays malleable while iterating; OpenGov fires locks per-contract
to ratify the cypherpunk end-state.

**The regression (B8-fix, 2026-05-12):** `DatumSettlement`'s structural-reference
setters (`configure`'s budgetLedger/paymentVault/lifecycle/relay,
`setClaimValidator`, `setAttestationVerifier`, `setPublishers`, `setCampaigns`,
`setPublisherStake`, `setAdvertiserStake`, `setRateLimiter`, `setNullifierRegistry`,
`setReputationContract`, `setIdentityRegistry`, `setPowEngine`, `setClickRegistry`,
`setMintCoordinator`, `setDualSig`, `setTokenRewardVault`) and
`DatumPaymentVault.setSettlement` were **unconditional lock-once** — they reverted
`AlreadySet` on the *first* re-write, freezing the plumbing at **deploy time**
regardless of governance phase. That made Settlement "locked today," contradicting
the later-ratified roadmap, and forced a **full Settlement redeploy** to re-point
the vault (the cascade that surfaced during the vault-upgrade staging).

**The fix:** convert to **phase-conditional lock-once**, matching the pattern
`DatumClaimValidator` (`plumbingLocked` + `lockPlumbing()@OpenGov`) and
`DatumPublishers` already use:
- Settlement gains a `_plumbingLocked` umbrella + `lockPlumbing() onlyOwner
  whenOpenGovPhase` + `plumbingLocked()` view. Every structural setter now gates
  on `!_plumbingLocked` (governance-re-pointable until OpenGov locks it).
- Vault gains `settlementRefLocked` + `lockSettlementRef() whenOpenGovPhase`;
  `setSettlement` gates on `!settlementRefLocked`.

The rug surface B8 worried about (owner hot-swapping a permissive validator/vault)
stays bounded: re-pointing is governance-gated (owner = Timelock/Council in later
phases) and the OpenGov lock is irreversible.

**Consequence:** once Settlement carries this fix, a vault swap is just
`settlement.configure(ledger, NEW_VAULT, lifecycle, relay)` — **no redeploy**.

## Migration model (redeploy-migrate-rewire) + risk

Not a storage proxy. Upgrade = deploy successor (higher `version()`) →
`governor.freeze(old)` → `new.migrate(old)` (copies state via `_migrate`, lock-once,
old must be frozen) → `old.migrateFundsTo(new)` for fund-holders → rewire refs.

Risk surface, per step:
- **New contracts (registry):** zero migration risk (pure addition).
- **Fund migration (vault):** the *currently deployed* vault predates the
  enumeration, so it can't be an on-chain `_migrate` source — its first transition
  is **coexist + drain** (keep the old vault live for existing-balance withdrawals;
  route new credits to the new vault). Every vault from THIS version forward
  migrates cleanly (enumeration + `_migrate` + `migrateFundsTo`).
- **Write-pause window:** `creditSettlement` is now `whenNotFrozen`, so settlement
  fails-closed during the freeze window rather than stranding credits in a dead
  vault. Rewire Settlement → new vault, then unfreeze/resume.
- **Phase gating:** all `lock*()` are OpenGov-gated; deferred on Paseo (Admin
  phase). Production fires them via governance.

## Deployment order (Paseo, today)

1. `deploy-batch-upgrade.ts` → registry LIVE; new vault deployed.
2. Vault goes live by EITHER (script auto-detects):
   - **live re-point** if the deployed Settlement already carries the fix, OR
   - **one last full `deploy.ts` redeploy** to bake the fix into Settlement (the
     deployed one predates it); after that, surgical re-points forever.
3. Re-copy `deployed-addresses.json` → `web/public/` + `extension/`.
4. Relay: `ADVERTISER_REGISTRY=<addr>`; advertisers publish `setAdvertiserProfile(cid)`.
