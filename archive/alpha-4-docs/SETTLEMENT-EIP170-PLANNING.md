# DatumSettlement EIP-170 — planning doc for the remaining gap

## Status snapshot (after 9 commits, 2026-05-19)

| Contract            | Baseline | Now    | Δ           | Under EIP-170? |
|---------------------|---------:|-------:|------------:|----------------|
| DatumSettlement     | 41,262   | 34,368 | −6,894 (−16.7%) | ❌ 9,792 B over |
| DatumCampaigns      | 36,322   | 20,767 | −15,555 (−42.8%) | ✅ +3,809 B headroom |
| All 10 carve-outs   | n/a      | ~50 KB | new        | ✅ each under   |

Sizes above are `runs=200`. With `runs=1` Settlement is 34,211 B (157 B saving).

## What's been shipped (10 carve-out modules)

Each registered in `DatumGovernanceRouter`; each independently upgradable; each has its own
tests and deploy.ts wiring:

1. `DatumPowEngine` — per-impression PoW + leaky-bucket difficulty
2. `DatumPublisherReputation` — BM-8/BM-9 acceptance counters + anomaly detection
3. `DatumNullifierRegistry` — FP-5 per-campaign replay-prevention
4. `DatumSettlementRateLimiter` — BM-5 per-publisher window cap
5. `DatumCampaignCreative` — IPFS metadata + Bulletin Chain reference
6. `DatumReports` — community page/ad reports
7. `DatumCampaignAllowlist` — multi-publisher allowlist + take-rate snapshot
8. `DatumTagSystem` — tag dictionary + per-publisher tag sets + per-campaign required tags + lane mode
9. `DatumMintCoordinator` — DATUM emission orchestration (mint authority, engine, dust gate, split bps)
10. `DatumDualSigSettlement` — EIP-712 settleSignedClaims path

## Why Settlement still resists

The biggest chunk of Settlement's runtime bytecode is `_processBatch` — ~520 lines of dense per-claim logic:
- Hot-path gates (user pause, blocklists, identity, assurance level, ZK assurance)
- Per-claim chain-state writes (lastNonce, lastClaimHash)
- Per-claim window counters (userCampaignWindowEvents)
- Rate-limit check + nullifier consume
- ClaimValidator call + payment math + token reward credit
- Multi-actor stake hooks (publisher stake, advertiser stake)
- Mint coordination
- Reputation record

It's not "stuff that should be a module" — it's the actual settlement logic. Every external call site is bytecode-cheap (~50-200 B), but there are dozens of them. The function is structurally large and resists clean extraction.

## What we tried in 8d (and why it didn't ship)

**Library + DELEGATECALL with single Logic contract:**
- Created `DatumSettlementStorage.sol` (shared abstract base, all state)
- Created `DatumSettlementLogic.sol` (settleClaims + settleClaimsMulti + processVerifiedBatch + _processBatch + _isPublisherRelay)
- Rewrote `DatumSettlement.sol` as a thin shell: storage (via base) + setters + 3 delegatecall routers
- Demoted `pauseRegistry` from immutable to storage so Logic can read it via shared storage

**Result:**
- `DatumSettlement` shrank to **10,617 B** — under EIP-170 with 14 KB headroom ✅
- `DatumSettlementLogic` came in at **27,744 B** — over EIP-170 by 3,168 B ❌

The fundamental issue: moving bytecode to Logic just relocates the problem. Logic is itself a deployed contract; EIP-170 applies per-contract.

Plus 137 test fixtures break because they only deploy Settlement (not Logic + `setLogic`). Wiring those is mechanical but tedious work.

Rolled back to last known good (after C8c).

## Realistic options for the remaining 9.8 KB

### Option 1: Two-Logic split (retry 8d with smaller pieces)

Restore the storage-base + delegate-router framework, but split the impl into two Logic contracts:
- `DatumSettlementLogicA` — settleClaims + settleClaimsMulti (relay paths) + their auth checks
- `DatumSettlementLogicB` — processVerifiedBatch (dual-sig path) + `_processBatch` + the helpers

Settlement holds two `logic` pointers and routes by selector.

**Pros:**
- Each Logic carries ~half the bytecode → both fit under EIP-170
- Pattern is verifiable: the 8d work proved the storage-base + delegatecall mechanics work
- Maintains the upgrade-ladder story (two independently upgradable Logic slots)

**Cons:**
- Heavier architectural surgery than a single Logic
- Storage-layout sanity test now spans 3 contracts (Settlement, LogicA, LogicB)
- 137+ test fixtures need updating to deploy both Logic contracts
- The fundamental split is awkward: `_processBatch` is called by ALL three settle entries, so it has to live somewhere shared. Putting it in LogicB means LogicA's settleClaims has to delegatecall LogicB internally — chained delegatecalls add gas and complexity.

**Estimated effort:** 6–10 hours, uncertain whether the split is clean. The chained-delegatecall path is the biggest risk.

### Option 2: Library with `internal` functions (won't help)

Solidity libraries with `internal` functions inline at compile time. **No bytecode savings on the caller.** Eliminated.

### Option 3: Aggressive function-level optimization

Refactor `_processBatch` itself to share more code via small internal helpers, use bytes packing tricks, etc. Squeeze 1–2 KB out of the dense body without changing the architecture.

**Pros:**
- No architectural change
- Tests don't need re-wiring
- Audit story unchanged

**Cons:**
- Optimization is fragile and hard to audit
- 1–2 KB savings isn't enough to close 9.8 KB
- Diminishing returns: viaIR is already aggressive

**Estimated effort:** 3–4 hours for ~2 KB max savings. Won't fully close.

### Option 4: Carve out user-policy cluster (cluster D from earlier discussion)

Move `userMinAssurance` / `userMinIdentityLevel` / `userBlocksPublisher` / `userBlocksAdvertiser` / `userPaused` / `identityRegistry` to a `DatumUserPolicy` module. We previously rejected this because the per-batch read multiplier was unfavorable (5 cold staticcalls per batch).

**Pros:** ~1.5–2 KB savings on Settlement; clean modular split
**Cons:** real production gas cost; would need to remerge pre-mainnet per the existing plan

**Estimated effort:** 3–4 hours

### Option 5: Accept the gap; document and defer

Settlement remains over EIP-170 on mainnet but works on Paseo (pallet-revive doesn't enforce). The current state is:
- 10 carve-outs shipped
- DatumCampaigns under EIP-170 with headroom
- All 1,224 tests passing
- Cypherpunk roadmap unchanged
- Pre-mainnet remerge plan documented in memory

Document the Settlement gap in `MAINNET-DEFERRED-ITEMS.md` and tackle it during mainnet prep with one of options 1, 3, or 4 (or some combination) when there's a dedicated session for it.

**Pros:** Ships the wins we have; no risk of breakage in this session
**Cons:** Defers the hardest piece

## Recommendation

**Option 5 + plan for Option 1 next.** The 10 carve-outs are a meaningful win independently of whether Settlement closes the EIP-170 gap. Shipping a clean version of what we have, documenting the gap, and returning to the two-Logic split in a fresh session is the lowest-risk path. The two-Logic split is the most likely successful approach for fully closing the gap.

If we go Option 1 next: budget a full dedicated session (~6-10 hours), start with the storage-base + Logic-split skeleton, get test fixtures wired to the new architecture before optimizing further.

## Action items before closing this thread

- [ ] Update `MAINNET-DEFERRED-ITEMS.md` (or equivalent) with the Settlement EIP-170 gap
- [ ] Update `project_eip170_remerge_plan.md` memory file to record the 8d attempt + the planned next step
- [ ] Confirm the 10 shipped commits are intact on `main` (commits `9e6f0ef` → `65138a6`)
- [ ] Decide whether to push a "checkpoint" tag for the alpha-4-EIP170-phase-1 work
