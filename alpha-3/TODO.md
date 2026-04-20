# Datum Alpha-3 Pre-Launch TODO

> Non-committed implementation checklist. Delete before tagging v1.0.

---

## Tier 1 — Required Before Launch

### T1-A: Blocklist behind timelock [deploy.ts + Blocklist.tsx] ✓
- [x] Transfer `DatumPublishers` ownership to `DatumTimelock` in `deploy.ts` (line 922, PHASE 3 ownership transfer)
- [x] Update `Blocklist.tsx` to show timelock proposal flow (not direct tx)

### T1-B: DAO-governed fraud thresholds (FP-15) [new contract + UI] ✓
- [x] New `DatumParameterGovernance.sol` — conviction-vote governance for protocol parameters
- [x] Parameters: rateLimiter window/cap, publisherStake base/rate, nullifier windowBlocks, reputation anomaly factor/min sample
- [x] New `/admin/ParameterGovernance.tsx` page
- [x] New `test/parameter-governance.test.ts`
- [x] Wire into deploy.ts as 26th contract

### T1-C: FP-16 — On-chain reputation via Settlement [contracts + relay] ✓
- [x] Remove reporter pattern from `DatumPublisherReputation.sol` (reporters mapping + addReporter/removeReporter)
- [x] Add `settlement` address field + `setSettlement()` setter; change E25 check to `msg.sender == settlement`
- [x] Add `publisherReputation` address field + `setPublisherReputation()` to `DatumSettlement.sol`
- [x] Call `recordSettlement()` at end of `_processBatch()` after impressions are accumulated
- [x] Update `IDatumPublisherReputation.sol` interface
- [x] Update `relay-bot.mjs` — removed standalone BM-8 reputation calls + `reputation` contract + `REPUTATION_ABI` (Settlement calls it on-chain now; relay-bot was double-counting)
- [x] ABIs already synced (DatumSettlement.json, DatumPublisherReputation.json — M in git status)

### T1-D: Extension nullifier computation (FP-5 client side) [extension] ✓
- [x] New `extension/src/background/poseidon.ts` — getUserSecret() + computeWindowId()
- [x] `getUserSecret()` — random 32 bytes, persisted in `chrome.storage.local`
- [x] Add `nullifier` field to `Claim` + `SerializedClaim` interfaces in `claimBuilder.ts`
- [x] For ZK campaigns: compute `windowId = floor(blockNumber / windowBlocks)`; nullifier = publicSignals[1] from ZK circuit (Poseidon computed in-circuit via zkProof.ts)
- [x] For non-ZK campaigns: `nullifier = bytes32(0)` (ZeroHash default)

### T1-E: Deploy script expansion to 26 contracts [scripts] ✓
- [x] deploy.ts already had all 26 contracts + full FP wiring
- [x] setup-testnet.ts: 21 required keys (hard fail), FP keys graceful skip, step 5.8 Diana publisher stake (idempotent), all-26 summary
- [ ] NOTE: Re-run `node scripts/setup-zk.mjs` before next testnet deploy (circuit artifacts are stale — old 1-public-input build)

---

## Tier 2 — Strong Pre-Launch

### T2-A: Native Asset Hub token UI (ERC-20 precompile sidecar) [web] ✓
- [x] `assetRegistry.ts` in `web/src/shared/` and `extension/src/shared/`
- [x] Asset type toggle in `CreateCampaign.tsx`: "ERC-20 Contract" vs "Native Asset Hub Token"
- [x] When native: show `popularAssets()` dropdown + custom asset ID input
- [x] Derive precompile address via `assetIdToAddress()` from registry
- [x] Use registry metadata for decimal display (skip ERC-20 `decimals()` call for known assets)
- [x] Extension `UserPanel.tsx`: check `isNativeAssetAddress()` before ERC-20 `symbol()`/`decimals()` calls
- [x] 35 extension tests (203/203 passing)

### T2-B: Challenge bond UI in campaign creation [web] ✓
- [x] Add optional bond amount input to `CreateCampaign.tsx` (advertiser)
- [x] Call `DatumChallengeBonds.lockBond(campaignId, amount)` after campaign creation if amount > 0
- [x] Show bond status on `CampaignDetail.tsx`

### T2-C: FP contract state in extension Settings [extension] ✓
- [x] Show publisher stake balance + required stake in `Settings.tsx`
- [x] Show challenge bond status (if any active bond) in `Settings.tsx`

### T2-D: New admin pages for FP contracts [web] ✓
- [x] `web/src/pages/admin/PublisherStake.tsx`
- [x] `web/src/pages/admin/PublisherGovernance.tsx`
- [x] `web/src/pages/admin/ChallengeBonds.tsx`
- [x] `web/src/pages/admin/NullifierRegistry.tsx`
- [x] 4 routes added to `App.tsx`

### T2-E: E2E browser validation checklist
- [ ] Load extension with live v7 addresses
- [ ] Create impression → verify ZK nullifier submitted on-chain
- [ ] Create impression → verify reputation updated via Settlement (not relay bot)
- [ ] Create campaign with USDT precompile as rewardToken → deposit → settle → withdraw
- [ ] Publisher stake: under-staked publisher → claim rejected with code 15

---

## Tier 3 — Stretch

### T3-A: Wallet age floor in ZK circuit (FP-14 partial) [circuit] — DEFERRED
- [ ] Extend `impression.circom` with 3rd public input: wallet age witness
- [ ] Re-run `setup-zk.mjs` (invalidates existing proving key)
- [ ] Update `DatumZKVerifier.sol` for 4-arg verify (claimHash, nullifier, walletAgeFloor)
- [ ] Update extension `zkProof.ts` to pass wallet tx history witness

### T3-B: Merkle impression log (FP-8) [relay] — PARTIAL
- [x] Relay builds Merkle tree per epoch after each `settleClaimsFor()` TX
- [x] Persists to `impression-log.json`; 3 HTTP endpoints: `/relay/epoch/latest`, `/relay/epoch/:id`, `/relay/epoch/:id/proof/:leaf`
- [ ] On-chain `DatumMerkleImpressionLog.sol` root commitment — deferred for alpha-3

### T3-C: Watcher network (FP-11) [contract] — DEFERRED
- [ ] New `DatumWatcherNetwork.sol` — permissionless fraud proof submission with bonds
- [ ] Watcher posts fraud proof + bond; governance resolves; bounty from publisher stake on upheld

### T3-D: SDK v3.2 nullifier helper [sdk] — DEFERRED
- [ ] Export `computeNullifier(userSecret, campaignId, windowId)` from `@datum/sdk`
- [ ] Export `assetRegistry` utilities from sdk

### T3-E: BM-6 viewability dispute — DEFERRED (needs governance design)

---

## Deploy Checklist (pre-v1.0 tag)

1. [x] All T1 items complete
2. [x] All T2 items complete (T2-E pending, requires live redeploy)
3. [x] Run `node scripts/setup-zk.mjs` (refresh circuit artifacts for 2-public-input circuit)
4. [ ] Run `npx hardhat run scripts/deploy.ts --network polkadotTestnet` (26 contracts)
5. [ ] Run `npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet`
6. [ ] Update all contract addresses in `extension/src/shared/networks.ts` + `web/src/shared/networks.ts`
7. [x] `cd alpha-3/extension && npm run build` → 0 errors
8. [x] `cd web && npx vite build` → 0 errors
9. [x] `cd alpha-3 && npx hardhat test` → all passing
10. [ ] E2E browser validation (T2-E checklist)
11. [ ] Tag `v1.0-alpha3`
