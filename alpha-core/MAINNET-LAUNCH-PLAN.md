# DATUM — Mainnet Launch Plan

Derived from the full Paseo Phase-0 rollout (2026-06-11). Captures the **current
testnet end-state**, the **per-feature testnet→production deltas**, the **custody /
governance progression**, and the **launch sequence + go/no-go**. Source records:
`DEPLOYMENT-FINDINGS-LOG.md`, `CORE-DEPLOY-DRESS-REHEARSAL.md`,
`MODULAR-DEPLOY-RUNBOOK.md`, `CONTROL-MATRIX-MEMO.md`, `ALPHA-CORE-BACKLOG.md`,
`RUNBOOK-CORE-LAUNCH.md`.

---

## 1. Current Phase-0 end-state (Paseo)

Fully functional, feature-complete Phase-0 deployment, **testnet-grade**:
- **Core spine** (19) + **all feature modules** (49 contracts) + **token plane**
  (5) layered on top, `validateConfiguration() == true`. Deployer is the Phase-0
  owner/governor; ownership staged (pendingOwner) to the Timelock.
- **Proven:** end-to-end gasless relay settle → PaymentVault credit (correct
  take-rate + user-share split), with PoW enforced.
- **Seeded:** 8 active campaigns (6 open, 1 publisher-pinned, 1 token-reward).
- **UI:** webapp + extension gate every feature on (deployed-address present) AND
  (correct governance phase) — undeployed/wrong-phase features are omitted from
  all views. Built; hosting deploy pending operator auth.

The system is **upgradable-via-governance permanently** — there is no immutable
end-state; "finalization" = firing the `lock*()` commitments + the `hardFloor`
ratchet (`renounceOwnership` is disabled).

---

## 2. Custody & governance progression (the gating sequence)

Mainnet must move the admin root off the deployer EOA. Per `CONTROL-MATRIX-MEMO.md`
§8 (Option 2, implemented):
1. **Multisig/Safe** owner; execute Timelock `acceptOwnership` on every upgradable
   (today owner is pendingOwner-only / deployer effective).
2. **`adminGovernor` → Council** (`scripts/transfer-timelock-to-council.ts`) +
   Timelock ownership → Council, so admin/upgrades are an N-of-M body behind the
   48h delay while OpenGov governs campaigns.
3. **Phase ladder** Admin → Council (`raisePhaseFloor`) → OpenGov; fire `lock*()`
   per tier. Council UI/wiring (`router.setCouncil`) activates at the Phase 0→1
   step (the gate already hides Council at phase 0).
4. Rotate all deployer-held roles (treasuries, oracle reporter, relay signer,
   SR threshold) to their production holders.

**Go/no-go:** no EOA holds owner/governor; `owner()`/`governor()`/`adminGovernor()`
read the Safe/Council; ladder doc signed off.

---

## 3. Per-feature testnet → production deltas

Each feature is live on Paseo with a testnet-grade shortcut; production swaps:

| Feature | Testnet-grade (now) | Production requirement |
|---|---|---|
| **Token plane** | `AssetHubPrecompileMock` + `devnetUnwrapShimEnabled=true` Wrapper; asset id 31337; single MintAuthority. **NOTE:** mock asset must be `registerAsset`-ed or emission mints fail-soft (DOT settles, 0 WDATUM) — see WDATUM-emission note / deploy-token-paseo.ts | XCM-aware Wrapper (`transferToSubstrate`, shim off), real Asset Hub asset, **parachain issuance pallet** + sunset sequence (`stageIssuerTransfer`→`acceptIssuerRole`, **irrevocable**). PRE-MAINNET §L3/§5.5. |
| **Token-reward sidecar (asset allowlist)** | `DatumTokenRewardVault` in **Allowlist mode** (compliant start), seeded **WDATUM + USDC + USDt** — the live, ERC-20-valid trust-backed asset precompiles on Paseo (`assetIdToAddress`, suffix `0120`); per-asset on-chain ERC-20 sanity check uses ONLY the guaranteed `totalSupply()`+`balanceOf()` — **NOT `decimals()`**, since the Hub assets ERC-20 precompile does not implement metadata (verified live: production vault built before this fix rejects a no-`decimals` native asset; fixed vault + `MockNativeAssetPrecompile` flow passes). `verify-native-asset.ts` → 9/32 live | **Re-derive + re-verify the allowlist against real Polkadot Asset Hub — do NOT copy the Paseo addresses.** Asset IDs + the `0120`(trust-backed)/`0220`(foreign) precompile addresses differ per chain; `foreign`(`0220`) assets that returned `CODE_BUT_CALL_FAILED` on Paseo (WETH/WBTC/GLMR/DOT-bridged/…) may be **live on mainnet**. Re-run `verify-native-asset.ts` against the production RPC, seed only addresses passing the on-chain ERC-20 check via `setAssetAllowed(...)`, and **keep Allowlist mode** for the compliant launch (flip to open later via governance `setAssetAllowlistEnabled(false)`; denylist `tokenRewardBlocked` stays available in both modes). |
| **ZK (impression + identity)** | single-party trusted setup; `WIRE_ZK_PREDICATE=1` | **N-party MPC ceremony** for `DatumZKVerifier` + `DatumIdentityVerifier`; reconcile deploy.ts skip-vs-validate. |
| **People Chain identity** | deployer-as-oracle, XCM/sovereign mocks; `lockOracleReporter` NOT fired | real XCM bridge + People Chain return-leg; dedicated bridge EOA; lock oracle/dispatcher/sovereign/pallet-indices post-validation. |
| **Stake-root oracle** | SR-V1 1-of-1 (deployer); **SR-V2 in shadow mode**; real DATUM `address(0)` | SR-V1 3-of-5 external reporters; promote V2 (`STAKE_ROOT_V2_SHADOW_MODE=false`); wire real DATUM ERC-20; rotate treasury. |
| **Governance ladder** | deployed at Phase 0, Council unwired, deployer = everything | Safes for Council members; lengthen Timelock windows; advance phases; fire parameter-floor locks. |
| **Relay accountability** | `relayMinStake` low/allowlist; treasury = deployer | calibrate `relayMinStake`; rotate `RelayGovernance.treasury`; relay daemon hardened (HTTPS/HSM/rate-limit/multi-publisher). |
| **FP (stakes/bonds)** | default bond/stake sizes; treasuries = deployer | calibrate bonding-curve constants + bond sizing vs real DOT price; rotate ActivationBonds/treasuries. |
| **Tags / curators** | council/curator = deployer; tags unapproved | Council-curated tag dictionary; fire curator locks once membership stable. |
| **PoW Sybil gate** | `enforcePow=true`, baseline difficulty | calibrate difficulty curve from observed abuse; keep enforced. |
| **Settlement / EIP-170** | EVM build under 24,576 B | re-confirm `npm run size:mainnet` on the mainnet build. |
| **Infra** | hardcoded Paseo gas price 10¹²; direct-RPC reads; auto-sign | dynamic `eth_gasPrice`; indexer/subgraph; per-session approval UX for real DOT. |

Full inventory: `ALPHA-CORE-BACKLOG.md` §2.

---

## 4. Launch sequence (maps to `RUNBOOK-CORE-LAUNCH.md`)

The Paseo rollout **is** the rehearsal of this sequence:
1. **External professional audit** (longest pole; covers the DELEGATECALL
   Settlement split, dual-sig/relay sig paths, the upgrade/migrate authority +
   the Option-2 router authority change). No open Crit/High.
2. **Migration machinery** proven (U1/U2/U3/U5/U6 ✓) — re-run against the migrated
   set; indexer/relay partial-migration guards live.
3. **Wire-format SSOT + CI gates** (clean recompile, ABI-drift, gitleaks) — done.
4. **Mainnet-real code paths** — token XCM unwrap, ZK MPC (§3).
5. **Custody** — §2.
6. **Ops** — monitoring/alerting on `validateConfiguration` + invariants; pause
   drill; rotate Pinata + any committed key.
7. **Dress rehearsal** — fresh Hub instance: deploy spine → layer modules
   (`MODULAR-DEPLOY-RUNBOOK.md`) → seed → run U5 migration → exercise the phase
   ladder, zero manual fixups.
8. **Core launch** — mainnet deploy → custody → monitor → advance ladder + fire
   locks → wire any remaining modules via the proven machinery. Tag `v1.0.0`.

Mainnet removes the testnet redeploy-and-reseed escape hatch — every step above is
about making the deferred work *proven* before real funds.

---

## 5. Per-feature go/no-go (rollup)

Launch a feature on mainnet when its row in §3 is satisfied AND its on-chain smoke
passes. Minimum for the **core ad-exchange** (the v1.0 launch surface): spine +
reputation/rate-limiter + PoW + tags + FP + relay-accountability + governance
ladder wired to a Safe-backed Council, external audit closed, custody handed off.
**Token plane + People Chain are the most-deferred** (parachain sunset, real XCM)
and are the natural "wire-in post-launch via the upgrade ladder" features — the
feature-gate hides them until their production deltas are met.

## 6. Open follow-ups carried from Paseo

- Per-feature settle smokes: pinned-with-publisher-attestation, token-reward credit
  (fund the vault), ZK-required (proof gen), tag-gated validation.
- TagRegistry/ZKStake deploy (need WDATUM wired); token-reward vault funding;
  Council grant-token + founder vesting grant via governance.
- deploy.ts ZK-predicate skip-vs-validate reconciliation.
- **Asset-allowlist re-verification (token-reward sidecar)** — see §3. Before
  launch: re-run `scripts/verify-native-asset.ts` against the production Asset
  Hub RPC; re-seed `DatumTokenRewardVault` via `setAssetAllowed(addr,true)` with
  the **mainnet-valid** token set (Paseo addresses are NOT portable — different
  asset IDs + precompile addresses); confirm `assetAllowlistEnabled == true`
  (compliant start). Per-asset adds are governance-gated (owner/PG/Council) and
  the on-chain `decimals()`+`totalSupply()` check rejects non-ERC-20 addresses.
- Hosting deploy (operator auth) + relay daemon restart + Pinata rotation.
