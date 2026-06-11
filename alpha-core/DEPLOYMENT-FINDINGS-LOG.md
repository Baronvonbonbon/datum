# DATUM alpha-core — Deployment Findings & Events Log

Chronological record of the full Phase-0 rollout on Paseo (2026-06-11): every
finding, fix, deploy event, and testnet-grade shortcut, captured to feed the
`MAINNET-LAUNCH-PLAN.md`. Newest events at the bottom. Commit hashes in `mono`.

---

## 1. Pre-deploy hardening

### 1.1 Security audit pass (`8aa0669`)
Internal focused audit (`SECURITY-AUDIT-2026-06-11.md`) over the post-2026-05-20
code. Findings fixed:
- **M-1 / M-2 / M-3 — incomplete 18-dec-wei denomination migration.** Three
  peripheral paths were still planck-scaled while their funding moved to wei:
  `DatumCampaignCreative` renewer reward (`10^8→10^16`, cap `10*10^10→10*10^18`),
  `DatumPublishers.MAX_STAKE_GATE_AT_LOCK` (`10^14→10^22`, was bricking
  `lockStakeGate()`), `DatumPeopleChainXcmBridge.refreshFee` (`10^9→10^17`).
- **MH-1 — U3 paginated migration window.** `DatumPublishers.migrate` now
  self-`frozen`s across the multi-batch window (unfreezes on the final batch) so
  a not-yet-copied publisher can't write state a later batch clobbers.
- **L-1 / L-2** — stale "planck" comments → wei; `nonReentrant` on the U3 migrate.
- **Process finding:** the CI **ABI-drift gate** caught stale committed ABIs after
  an interface change — re-sync ABIs (`web/scripts/sync-abis.mjs` +
  extension `copy-abis.js`) as part of any contract change, not after.

### 1.2 Fund-control trace → Option 2 (`1221e26`)
Tracing custody (`CONTROL-MATRIX-MEMO.md`) found the **deployer EOA is the sole
admin root in every phase**: `deploy.ts` transfers every contract's ownership to
the Timelock but **never the Timelock's own ownership** (it's only ever a
recipient). Since the Timelock owns the router + fund contracts and its
`propose` is `onlyOwner`, the deployer alone drives every `onlyOwner` lever +
`router.setGovernor`. **`renounceOwnership` is disabled** — the system is
**upgradable-via-governance forever**; "finalization" = firing `lock*()` +
`hardFloor`, not code immutability.
- **Remediation (Option 2):** router **adminGovernor/campaign-governor split** —
  `upgradeContract` + regression gated on a new `adminGovernor` (defaults to the
  governor) so the Council can own admin/upgrades while OpenGov governs campaigns;
  + `scripts/transfer-timelock-to-council.ts` to hand the Timelock to the Council.
  Needed because `GovernanceV2` (Phase-2 governor) has **no `upgradeContract` call
  path** — without the split, upgrades freeze at OpenGov.

### 1.3 Backlog consolidation + coverage refresh (`511bdb8`, `52bc433`)
Consolidated scattered checklists into `ALPHA-CORE-BACKLOG.md` (Paseo-launch
staged); archived superseded docs to `archive/alpha-core-docs/`; refreshed
`DEPLOY-COVERAGE.md` (58 `Datum*.sol`: 49 deploy.ts / 6 abstract / 2 token-deferred
/ 1 staged).

---

## 2. Core slim deploy + launch

### 2.1 Fresh slim redeploy (`5ea7957`, deployedAt 2026-06-11T15:56Z)
Backed up the live slim addresses, reset, ran `DATUM_MVP=1 deploy.ts` →
19-contract spine fresh; `validateConfiguration() == true`. Verified the session's
bytecode is live on-chain (`router.adminGovernor == governor == deployer`,
`Publishers.MAX_STAKE_GATE_AT_LOCK == 10^22`). Settlement layout gate passed.

### 2.2 Seed-tooling gap → `seed-slim.mjs` (`e54b64d`)
**Finding:** neither existing seed script runs on the slim spine —
`setup-testnet.ts` hard-requires 9 deferred contracts (governanceV2/zkVerifier/
council/tagSystem/campaignCreative/reports/campaignAllowlist/relayStake/
relayGovernance) and reads `governanceV2` unguarded; `reseed-demo.mjs` needs a
registered publisher + the deferred `campaignCreative`. Both target the full
deploy. Wrote `seed-slim.mjs` (open campaigns + `router.adminActivateCampaign`
Phase-0 path) — 6 campaigns Active.

### 2.3 End-to-end settle proven + PoW finding (`77eca76`)
`smoke-settle.mjs`: a gasless relay settle credits PaymentVault (user +0.000375
PAS, publisher +0.0005 PAS — correct 50% take + 75% user-share). **Finding: PoW is
enforced at launch** (`PowEngine.enforcePow == true`) — claims need a solved
`powNonce` (difficulty baseline-low, ~hundreds of iters for a fresh user). Diana
registered as publisher (`registerPublisher` 5000 bps + `setRelaySigner` → self).
Dress-rehearsal runbook (`CORE-DEPLOY-DRESS-REHEARSAL.md`).

---

## 3. Full feature layer (Phase 0 complete)

### 3.1 Full deploy on top of the spine (`27179b1`, deployedAt 2026-06-11T20:12Z)
Ran `deploy.ts` (non-MVP) against the **live slim addresses** → `deployOrReuse`
**reused all 19 spine contracts** and deployed + wired the ~30 deferred modules on
top. 49 keys, `validateConfiguration() == true`.
- **Finding: ZK-predicate validation inconsistency.** First run failed wiring
  validation — deploy.ts **skips** `ClaimValidator.setZKVerifier` by default
  (`WIRE_ZK_PREDICATE` dormant) but the **final validation expects it wired**.
  Incremental writes had persisted the 49 addresses, so the re-run with
  `WIRE_ZK_PREDICATE=1` reused everything (no redeploy) and passed. **Fix-forward:
  reconcile the skip-default vs validate-present mismatch in deploy.ts.**
- **Finding: StakeRootV2 shadow mode** — V2 oracle deployed but not wired into
  ClaimValidator (deliberate; promote via `STAKE_ROOT_V2_SHADOW_MODE=false`).
- **Finding: Council→router deferred** — `router.council` is UNSET; `setCouncil`
  belongs to the Phase 0→1 transition, not Phase 0. The UI gates Council on
  phase ≥ 1 regardless, so this is correct.

### 3.2 Feature-registry gating (`3c52923`)
`web/src/lib/features.ts` (registry) + `Layout.tsx` nav + Outlet route gating +
extension mirror. **Demonstrated both ways:** `/token` was hidden before the token
deploy (wrapper absent) and shows after; Council stays hidden at phase 0 even
though deployed (wrong-phase omission). Web vite + extension webpack green.

### 3.3 Token plane — Paseo port (`3368f2c`)
**Finding: `deploy-token.ts` is devnet-only** — its `waitForDeployment()`/`.wait()`
hang on Paseo's `getTransactionReceipt`-null bug. Ported to
`deploy-token-paseo.ts` (hybrid hardhat-factory + raw-provider + nonce-poll).
Deployed AssetHubPrecompileMock / MintAuthority / Wrapper(WDATUM) / Vesting /
FeeShare; wired mintAuthority↔coordinator↔wrapper/vesting, paymentVault↔feeShare.
Verified on-chain. **Testnet-grade stand-ins:** `devnetUnwrapShimEnabled = true` +
`AssetHubPrecompileMock` (mainnet = XCM-aware Wrapper + real Asset Hub asset).

### 3.4 Relay daemon port (gitignored infra)
Backed up the operator's pre-SLIM 1087-line `relay-bot.mjs` → `.pre-slim-bak`;
staged the slim template with the new addresses baked in. Needs
`PUBLISHER_KEY=<Diana>` + systemd restart (operator).

### 3.5 Feature seed (`83c0d83`)
`seed-features.mjs`: #7 publisher-pinned (Diana), #8 token-reward (WDATUM); both
Active (8 campaigns total). **Finding:** a userSig-only settle on the pinned
campaign is correctly **rejected** (open campaign settles) — the pinned campaign
enforces the publisher-attestation/assurance gate. Feature working as designed.

---

## 4. Frontend + relay (resolved 2026-06-11)

- **Webapp — deploys via push to `main`.** `web/dist` is **gitignored**, so the
  GitHub deploy **builds from source** on push (not `wrangler`/committed-dist). The
  pushed `features.ts` + `Layout.tsx` gating + `web/public/deployed-addresses.json`
  (55 keys) go live on push. No wrangler auth needed.
- **Relay — LIVE.** The live relay is the **datum-labs bench**
  (`~/Documents/datum-labs/relay/src/index.mjs`, already slim), NOT the stale
  `datum/relay-bot/` copy. **Finding:** its address source defaulted to the dead
  `../../datum/alpha-5/deployed-addresses.json` (alpha-5 was renamed to
  alpha-core). Fix: set `DATUM_ADDRESSES=…/alpha-core/deployed-addresses.json` in
  `~/.config/datum-relay/{diana,frank,bob,charlie}.env` + restarted
  `datum-relay@*` / `datum-cosigner@*`. `/health` → ok, signer = Diana, chainId
  420420417. (The `relay-bot/` edits were to an unused gitignored copy — harmless.)

## 4b. Remaining handoff

- **Pinata credential rotation** (still in git history — `SECRETS-SCRUB-2026-06-10.md`).
- **Pinata credential rotation** (still in git history — `SECRETS-SCRUB-2026-06-10.md`).
- **deploy.ts ZK-predicate** skip-vs-validate inconsistency — fix-forward.
- **Token follow-ups:** TagRegistry/ZKStake (need WDATUM wired), token-reward vault
  funding, Council grant-token + founder vesting grant via governance.
- **Per-feature settle smokes** (pinned-with-attestation, token-reward credit,
  ZK-required proof, tag validation) — see `MAINNET-LAUNCH-PLAN.md`.
