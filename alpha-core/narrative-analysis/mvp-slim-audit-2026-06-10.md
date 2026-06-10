# Adversarial audit — MVP slim deploy + SLIM-#2 wire + U1 router fix (2026-06-10)

Scope: the surfaces changed for the MVP release on `claim-slim-gas-ab`:
the `DATUM_MVP=1` slim deploy posture, the SLIM-#2 slim-claim wire format
(`firstNonce` replay redesign), and the U1 router freeze/migrate fix.

## Findings

### SLIM-AUDIT-1 (Medium) — relay publisher cosig replayable at the next nonce window — FIXED

`DatumRelay`'s `PUBLISHER_ATTESTATION_TYPEHASH` bound only
`(campaignId, user, claimsHash, deadlineBlock)`. Under the SLIM-#2 wire
format a claim is pure content (`publisher, eventCount, rateWei, actionType,
proof`) with no per-claim nonce or hash, so two consecutive batches with
identical content hash to an **identical `claimsHash`**. The publisher cosig
is therefore valid for both the batch it was issued for and a second
identical-content batch at the next nonce window. The user holds the cosig
and signs the fresh user envelope (the `ClaimBatch` range sig) themselves, so
they can settle the second batch and double-collect against the campaign
budget without the publisher re-attesting — until the deadline expires.

The dual-sig path (`DatumDualSigSettlement`) and the extension's
`DatumAttestationVerifier` path already bound `firstNonce` in their typehashes
(SLIM-#2). Only the relay path's publisher attestation was missing it.

**Fix:** add `uint256 firstNonce` to `DatumRelay.PUBLISHER_ATTESTATION_TYPEHASH`
and to the struct hash built in `settleClaimsFor`, mirroring the other two
paths. Off-chain: `docs/relay-bot-template/relay-bot.mjs` `signRelayAttestation`
now signs the 5-field anchored type and threads `firstNonce` from the batch.
The extension (`publisherAttestation.ts`) and web daemon
(`extensionDaemon.ts`) already signed the anchored type — no change.

**Test:** `test/settlement.test.ts` R11 — settle batch 1 with a valid cosig,
then replay that same cosig for an identical-content batch at nonce+1 and
assert `E34`; control re-attestation over the new `firstNonce` settles.

## Reviewed, no change required

- **U1 router co-authority.** `freeze()`/`migrate()` now accept
  `msg.sender == router` via `onlyGovernanceOrRouter`. The router only reaches
  these from `upgradeContract` (onlyGovernor) and the high-tier path
  (governor-staged, Council-vetoable, phase ≥ Council) — no authority the
  governor doesn't already hold. Non-governor EOAs still revert `E19`; the
  migrate hook still enforces version-increase + frozen-predecessor.
  `upgradeContract` now emits `UpgradeHooksFired` so silent hook failure is
  observable. Tests in `governance-router-registry.test.ts`.

- **Dual-sig one-chain-per-call.** Unlike the relay path (deferred single
  `settleClaims`), `DatumDualSigSettlement` and `DatumAttestationVerifier`
  settle per-iteration, re-reading `lastNonce` each loop, so a same-chain
  sibling in one call is naturally stale-skipped. The relay path needs and has
  the explicit E87 guard; the immediate-settle paths correctly don't.

- **MVP deferred modules fail closed/off, not open.** Every optional ref in
  `DatumSettlementLogicB` gates on `address(... ) != address(0)` and is a
  *deny-by-absence* gate (rate limiter, reputation, publisher stake, nullifier,
  click registry, identity registry, pow leaky-bucket consume): when the module
  is `address(0)` the corresponding restriction is simply not applied — it never
  flips a check to "allow". The settle-critical refs (`campaigns`, validator,
  budget ledger, vault, lifecycle) are non-optional and revert when unset.
  `Settlement.validateConfiguration()` asserts the required set at deploy time.

- **MVP ownership posture.** Spine ownership transfers to Timelock as
  *pendingOwner* only (2-step; `acceptOwnership` not called), leaving the
  deployer EOA the effective owner during Phase-0 Admin so it can fire
  deferred-module setters. This is the documented "upgradable today" alpha
  posture, not a regression. Pre-mainnet, the relay set must be locked
  (`PRE-MAINNET-CHECKLIST` L2) and the phase ladder advanced.

- **PowEngine now core.** Added to `MVP_CORE_KEYS`; deploy wires
  `PowEngine.settlement` / `Settlement.powEngine` / `ClaimValidator.powEngine`
  and flips `setEnforcePow(true)`, so the slim launch ships with the per-user
  Sybil gate enforced rather than activating it post-abuse.
