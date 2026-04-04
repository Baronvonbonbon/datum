# Alpha-3 Contract Review — Bugs & Missing Features

_Review date: 2026-04-04 | Last updated: 2026-04-04_

## Bugs & Issues

### HIGH Priority (fix before mainnet)

| # | Issue | Location | Status | Detail |
|---|-------|----------|--------|--------|
| 1 | **Empty claims array OOB** | DatumRelay | ✅ Fixed | Added `require(sb.claims.length > 0, "E28")` before claims[0] access. AttestationVerifier already had this. |
| 2 | **No impressionCount upper bound** | DatumClaimValidator | ✅ Fixed | Added `MAX_CLAIM_IMPRESSIONS = 100000` constant + reason code 17 check before payment calc. |
| 3 | **Blocklist staticcall silent skip** | DatumClaimValidator | ✅ Fixed | Changed to fail-safe: `if (!blOk \|\| blRet.length < 32 \|\| abi.decode(...))` — treats call failure as blocked. |
| 4 | **GovernanceV2 reentrancy gap** | DatumGovernanceV2 | ✅ Fixed | Added `require(_locked == 0, "E57")` at top of `vote()`. |

### MEDIUM Priority

| # | Issue | Location | Status | Detail |
|---|-------|----------|--------|--------|
| 5 | **AttestationVerifier open-campaign trust** | AttestationVerifier L89-96 | Open | For open campaigns (publisher=0x0), verifier trusts `claims[0].publisher` as signer identity |
| 6 | **Staticcall return length unchecked** | DatumClaimValidator | ✅ Fixed | Changed `require(cOk)` → `require(cOk && cRet.length >= 128)` before abi.decode of 4-field campaign struct |
| 7 | **Timelock no calldata validation** | DatumTimelock | ✅ Fixed | Added `require(data.length >= 4, "E36")` in `propose()` |
| 8 | **drainFraction precision loss** | DatumBudgetLedger L181 | Open | `(remaining * bps) / 10000` loses fractional planck on small balances — acceptable for current use |
| 9 | **No ZK proof size limit** | DatumClaimValidator L136 | Open | Arbitrarily large `zkProof` bytes — low risk until ZK verifier is real |
| 10 | **evaluateCampaign uses direct call** | DatumGovernanceV2 L260 | Open | Calls `campaigns.getCampaignForSettlement()` via typed interface; campaigns is trusted. Low risk. |

### LOW Priority (design notes)

| # | Issue | Status | Detail |
|---|-------|--------|--------|
| 11 | `expireInactiveCampaign()` has no pause check | ✅ Fixed | Added `whenNotPaused` modifier + defined modifier in DatumCampaignLifecycle |
| 12 | `updateTakeRate()` allows setting same rate, resetting delay timer | ✅ Fixed | Added `require(newTakeRateBps != pub.takeRateBps, "E15")` |
| 13 | GovernanceHelper hardcodes status enum values (3, 4) | Open | Fragile if enum changes — acceptable with tests |
| 14 | TargetingRegistry tag deletion is O(n) per update | Open | Gas optimization, not critical |
| 15 | DatumReports counters have no overflow guard | Open | Theoretical only, economically impossible |

---

## Missing Features

### Pre-Mainnet Required

| Item | Status | Detail |
|------|--------|--------|
| **S12 Timelock gating for blocklist** | ✅ Fixed | deploy.ts: Added `Publishers.transferOwnership(timelock)` + validation check. `blockAddress()`/`unblockAddress()` now require 48h timelock delay. |
| **S12 Settlement blocklist check** | ✅ Fixed | Added `publishers` ref + `setPublishers()` to Settlement; blocklist staticcall check in `_processBatch()` before ClaimValidator call (reason 11, sets gapFound). deploy.ts wires + validates. ABIs synced. |
| **S12 Governance-managed blocklist** | Open | Hybrid: admin emergency-block + governance override (unblock via conviction vote) — needs contract changes |

### Planned Next Steps

| Item | Status | Detail |
|------|--------|--------|
| **B5: Settings cleanup** | ✅ Done | Blocked-tags toggle was never added to Settings.tsx — already clean. FiltersTab owns topic filtering. |
| **B6: In-ad dismiss** | ✅ Done | ✕ button + popover (Hide ad / Hide topic ads / Not interested) already implemented in content/index.ts L308-385 |
| **E2E on Paseo** | Open | Extension + relay end-to-end validation — run setup-testnet.ts to re-seed |
| **BM-3** | Open | Bot mitigation — needs spec |
| **BM-6** | Open | Bot mitigation — needs spec |
| **BM-8** | Open | Bot mitigation — needs spec |
| **BM-9** | Open | Bot mitigation — needs spec |

### Targeting Backlog

| Item | Description |
|------|-------------|
| **TX-2 through TX-7** | Remaining targeting items from tag-based redesign |
| **TX-5** | Tag dictionary trimming |

### Deferred / Post-Mainnet

| Item | Description |
|------|-------------|
| **Smoldot light client** | Blocked — smoldot has zero `eth_` RPC support for pallet-revive. Revisit when ecosystem catches up (6-12 months) |
| **Kusama/Polkadot Hub deploy** | Planning not started |

---

## Error Code Registry

| Code | Meaning |
|------|---------|
| E00 | Zero address |
| E01 | Not found / staticcall failed |
| E02 | Transfer failed |
| E03 | Zero balance |
| E11 | Zero value |
| E12 | Invalid daily cap |
| E13 | Not authorized caller |
| E14 | Invalid status |
| E15 | No change (same rate) |
| E16 | Budget validation |
| E18 | Not owner |
| E19 | Not governance/slash |
| E25 | Not authorized satellite |
| E27 | Below CPM floor |
| E28 | Batch limit / empty array |
| E29 | Deadline passed |
| E30 | Bad signature encoding |
| E31 | User signature mismatch |
| E32 | Caller not authorized (settlement) |
| E33 | Publisher signature wrong length |
| E34 | Publisher signature mismatch |
| E35 | Pending already exists |
| E36 | No function selector in calldata |
| E37 | Timelock delay not elapsed |
| E40–E56 | Governance |
| E57 | Reentrancy |
| E58 | Dust (below existential deposit) |
| E62 | Blocked address |
| E63 | Not on allowlist |
| E64 | Inactivity timeout not elapsed |
| E65 | Invalid slash action |
| E66 | Too many tags |
| E68 | Invalid report reason |

### Claim Rejection Reason Codes (ClaimValidator)

| Code | Meaning |
|------|---------|
| 0 | Campaign ID mismatch in batch |
| 1 | Gap in nonce chain (claim after gap) |
| 2 | Zero impressionCount |
| 3 | Zero bid CPM |
| 4 | Campaign not active |
| 5 | Publisher mismatch |
| 6 | Clearing CPM exceeds bid |
| 7 | Nonce mismatch (gap-causing) |
| 8 | Invalid prev hash (nonce=1 should be 0x0) |
| 9 | Invalid prev hash chain |
| 10 | Claim hash mismatch |
| 11 | Publisher blocked (S12) |
| 13 | BM-2: User per-campaign impression cap exceeded |
| 14 | BM-5: Publisher rate limit exceeded |
| 15 | BM-7: Allowlist violation (open campaign, publisher has allowlist) |
| 16 | ZK proof missing or invalid |
| 17 | impressionCount exceeds MAX_CLAIM_IMPRESSIONS (100,000) |
