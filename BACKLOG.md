# DATUM Backlog — Bugs, Issues & Missing Features

_Review date: 2026-04-04 | Last updated: 2026-04-17_

---

## Bugs & Issues

### HIGH Priority (fix before mainnet)

| # | Issue | Location | Status | Detail |
|---|-------|----------|--------|--------|
| 1 | **Empty claims array OOB** | DatumRelay | ✅ Fixed | Added `require(sb.claims.length > 0, "E28")` before claims[0] access. |
| 2 | **No impressionCount upper bound** | DatumClaimValidator | ✅ Fixed | Added `MAX_CLAIM_IMPRESSIONS = 100000` + reason code 17 check. |
| 3 | **Blocklist staticcall silent skip** | DatumClaimValidator | ✅ Fixed | Changed to fail-safe: call failure treated as blocked. |
| 4 | **GovernanceV2 reentrancy gap** | DatumGovernanceV2 | ✅ Fixed | Added `require(_locked == 0, "E57")` at top of `vote()`. |
| 5 | **Benchmark test MockZKVerifier artifact** | `test/benchmark.test.ts` | Open | `MockZKVerifier` not in artifacts — benchmark suite fails `before all`. Needs mock contract or test refactor. |
| 6 | **Extension test failures (7)** | `extension/test/` | Open | `formatDOT` (6 cases), `auction.test.ts` (interest weighting), `userPreferences.test.ts` (suite fails to run). |

### MEDIUM Priority

| # | Issue | Location | Status | Detail |
|---|-------|----------|--------|--------|
| 7 | **AttestationVerifier open-campaign trust** | AttestationVerifier L89-96 | Open | For open campaigns (publisher=0x0), verifier trusts `claims[0].publisher` as signer identity |
| 8 | **Staticcall return length unchecked** | DatumClaimValidator | ✅ Fixed | Changed to `require(cOk && cRet.length >= 128)` before abi.decode |
| 9 | **Timelock no calldata validation** | DatumTimelock | ✅ Fixed | Added `require(data.length >= 4, "E36")` in `propose()` |
| 10 | **drainFraction precision loss** | DatumBudgetLedger L181 | Open | `(remaining * bps) / 10000` loses fractional planck on small balances |
| 11 | **No ZK proof size limit** | DatumClaimValidator | Open | Arbitrarily large `zkProof` bytes — low risk, but enforce limit before mainnet |
| 12 | **evaluateCampaign uses direct call** | DatumGovernanceV2 | Open | Calls `campaigns.getCampaignForSettlement()` via typed interface; campaigns is trusted. Low risk. |

### LOW Priority (design notes)

| # | Issue | Status | Detail |
|---|-------|--------|--------|
| 13 | `expireInactiveCampaign()` has no pause check | ✅ Fixed | Added `whenNotPaused` modifier to DatumCampaignLifecycle |
| 14 | `updateTakeRate()` allows setting same rate | ✅ Fixed | Added `require(newTakeRateBps != pub.takeRateBps, "E15")` |
| 15 | GovernanceHelper hardcodes status enum values (3, 4) | Open | Fragile if enum changes — acceptable with tests |
| 16 | TargetingRegistry tag deletion is O(n) per update | Open | Gas optimization, not critical |
| 17 | DatumReports counters have no overflow guard | Open | Theoretical only, economically impossible |

---

## Missing Features

### Pre-Mainnet Required

| Item | Status | Detail |
|------|--------|--------|
| **S12 Timelock gating for blocklist** | ✅ Fixed | `Publishers.transferOwnership(timelock)`. `blockAddress()` requires 48h delay. |
| **S12 Settlement blocklist check** | ✅ Fixed | Added `publishers` ref + `setPublishers()` to Settlement; staticcall check in `_processBatch()`. |
| **S12 Governance-managed blocklist** | Open | Hybrid: admin emergency-block + governance override (unblock via conviction vote) — needs contract changes |
| **ZK proof required above CPM threshold** | Open | High-CPM campaigns (>$2 CPM equivalent) should require `requireZkProof=true`. Currently opt-in per advertiser. Consider protocol-enforced floor. |
| **External security audit** | Open | Pre-mainnet requirement. No engagement started. |

### Bot Mitigation

| Item | Status | Detail |
|------|--------|--------|
| **BM-2 Per-user impression cap** | ✅ Done | Wired in ClaimValidator (reason 13). |
| **BM-3 Relay PoW challenge** | Open | `GET /relay/challenge` nonce + expiry; `POST /relay/submit` verifies PoW. Relay-side only, no contract changes. Critical for high-CPM campaigns. |
| **BM-5 Rate limiter** | ✅ Done | DatumSettlementRateLimiter deployed; window-based per-publisher cap. |
| **BM-6 Viewability dispute** | Open | Needs governance design; deferred post-mainnet. |
| **BM-7 Advertiser allowlist** | ✅ Done | Wired in ClaimValidator (reason 15). |
| **BM-8 Publisher reputation** | ✅ Done | DatumPublisherReputation: per-publisher settlement acceptance rate score. |
| **BM-9 Anomaly detection** | ✅ Done | Cross-campaign rejection rate anomaly; MIN_SAMPLE=10; `isAnomaly()`. |

### User Economics & UX

| Item | Status | Detail |
|------|--------|--------|
| **Token reward withdrawal UI** | Open | User-facing balance display + `TokenRewardVault.withdraw(token)` button. Needed in extension Earnings tab and web dashboard. |
| **ERC-20 approve flow UI** | Open | Advertiser must `approve()` TokenRewardVault before `depositCampaignBudget()`. UI flow not implemented. |
| **Auto-sweep at balance threshold** | Open | Extension could auto-trigger `withdrawUser()` when accumulated balance exceeds a configurable threshold. Eliminates withdrawal friction for users. |
| **Cross-campaign claim batching** | Open | `settleClaims` is currently per-campaign. Batching claims across multiple campaigns in one tx shares the ~65K fixed gas overhead, reducing relay cost by ~39% vs separate txs — savings flow to user and relay margin. Requires contract change to Settlement. |
| **Variable publisher take rate market** | Open | Publishers competing on take rate (e.g., auction-based) could improve user share on high-quality inventory. Currently fixed per-publisher. |
| **Withdrawal aggregation (multi-token)** | Open | Single call to sweep all DOT + all ERC-20 token balances. Reduces withdrawal to one user action. |

### Pine RPC — `pine/`

| Item | Status | Detail |
|------|--------|--------|
| **eth_subscribe / WebSocket push** | Open | smoldot exposes no WebSocket to consumer; requires architectural change or polling adapter. |
| **Filter subscriptions** | Open | `eth_newFilter`, `eth_getFilterChanges` etc. Not implemented; polling workaround for most dApp use cases. |
| **eth_getLogs historical range** | Open | Fundamental smoldot limit — no archive. Needs external indexer for pre-connect logs. |
| **eth_getTransactionReceipt cross-session** | Open | TxPool is session-scoped; receipts unavailable for txs submitted before Pine connected. |
| **Production hardening** | Open | Pine is alpha; reconnect logic, memory bounds, and error surface need review before production use. |
| **Polkadot Hub mainnet gas price** | Open | `eth_gasPrice` hardcoded to Paseo value (10¹² wei/gas). Mainnet may differ; needs dynamic query or chain-specific config. |

### Targeting Backlog

| Item | Description |
|------|-------------|
| **TX-5** | Tag dictionary trimming — reduce tag set to high-signal subset |
| **TX-6, TX-8+** | Remaining targeting items from tag-based redesign |

### Deployment

| Item | Status | Detail |
|------|--------|--------|
| **Testnet re-seed** | Open | Run `setup-testnet.ts` to re-seed publishers, campaigns, Diana as reporter. ZK VK already set on-chain. |
| **E2E browser validation** | Open | Full flow on Paseo: extension + relay + on-chain settlement confirmation. |
| **Kusama deployment** | Open | Planning not started. Staging environment before Polkadot Hub mainnet. |
| **Polkadot Hub mainnet** | Open | Post-Kusama. Requires external audit. |

### Deferred / Post-Mainnet

| Item | Description |
|------|-------------|
| **Pine eth_subscribe** | Requires smoldot WebSocket exposure or a long-poll adapter — not feasible short-term |
| **BM-6 Viewability dispute** | Requires governance design for on-chain viewability challenges |
| **Full historical eth_getLogs** | Requires external block indexer (subquery/squid); fundamental smoldot limit |
| **XCM cross-chain fee routing** | Future: DOT settlement routed across parachains via XCM |
| **MPC ZK trusted setup** | Current setup is single-party (testnet only). Mainnet requires multi-party ceremony. |

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
