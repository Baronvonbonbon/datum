# DATUM Alpha-4 — Pre-Mainnet Checklist

Required hardening steps that are correct to defer on testnet but **must** run
before any mainnet (Polkadot Hub) deploy. Each item is gated by a separate
follow-up; the testnet deploy script does not call these.

## Permission lock-downs

### L2 — Relay: lockRelayerOpen
After vetting the production relayer set, call `DatumRelay.setRelayerAuthorized(relayer, true)` for each authorized address, then `DatumRelay.lockRelayerOpen()`. This converts the relay from open-mode (any EOA passing the stateless sig+liveness checks) to a curated set.

Why this matters: at AssuranceLevel 1, `_processBatch` accepts batches where `msg.sender == relayContract`. While Relay's per-batch publisher sig check is the real L1 enforcement, the open-mode relayer set is an unnecessary attack surface — a vetted set narrows the field.

**Verify:** `await relay.relayerOpen()` returns `false`.

### Curator locks
Once Council membership is stable, lock the curator pointers so even Timelock can't reroute policy authority:
- `DatumCouncilBlocklistCurator.lockCouncil()`
- `DatumTagCurator.lockCouncil()`
- `DatumPublishers.lockBlocklistCurator()`
- `DatumCampaigns.lockTagCurator()`

### Phase floor
After the Phase 1 (Council) transition, call `DatumGovernanceRouter.raisePhaseFloor()` — this prevents any future `setGovernor` from regressing back to Phase 0. Repeat after Phase 2 (OpenGov).

## Code paths requiring mainnet-real implementations

### L3 — Wrapper unwrap XCM path
`DatumWrapper._ahAddressOf(bytes32 accountId)` is a devnet-only shim that derives an EVM-shaped address from a 32-byte AccountId for the mock precompile (`token/DatumWrapper.sol:109-111`). On mainnet (real XCM-backed precompile), this must be replaced with an XCM-aware precompile call that accepts the raw AccountId.

**Fix before mainnet:** swap `precompile.transfer(canonicalAssetId, _ahAddressOf(...), amount)` in `unwrap()` for the production precompile's `transferToSubstrate(canonicalAssetId, accountId, amount)` (or equivalent).

**Verify:** integration test that an `unwrap` to a known Asset Hub AccountId produces a balance increase on Asset Hub.

## Token plane sunset (§5.5)

When the DATUM parachain native issuance pallet is live:

1. Deploy the parachain pallet as the new issuer.
2. `DatumMintAuthority.stageIssuerTransfer(parachainPalletAddress)` from Timelock.
3. Parachain pallet calls `acceptIssuerRole()` from its own context.
4. **Irrevocable** — after step 3, the EVM-side authority can never reclaim issuance. `issuerLocked` is permanently true.

This is the intended endpoint of the sunset path. Do NOT call it before parachain readiness — there is no rollback.

## House-ad campaign bootstrap

Before enabling `DatumBootstrapPool`:
- Set the house-ad campaign to AssuranceLevel ≥ 1 (publisher cosig required).
- Wire `DatumBootstrapPool.setCampaigns(campaignsAddr)` so the L1 floor check has a backing reader.
- Confirm `bootstrapPool.minHouseAdAssuranceLevel >= 1`.
