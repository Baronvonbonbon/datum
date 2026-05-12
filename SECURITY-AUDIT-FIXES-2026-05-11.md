# DATUM Alpha-4 Security Audit — Fixes Applied & Architectural Decisions

**Last updated:** 2026-05-12
**Companion to:** `SECURITY-AUDIT-TRIAGE-2026-05-11.md` (35 vectors triaged).
**Test status:** 619/619 passing after every change.

---

## Part 1 — Fixes applied (in order of implementation)

### First pass — easy mechanical fixes

| Ref | File:line | Change |
|---|---|---|
| **T19** | `DatumCouncil.sol:337` | `veto()` now also blocks veto on cancelled proposals (state-consistency). |
| **T21** | `DatumPublisherStake.sol:188-203` | `requiredStake` uses saturating evaluation so high `cumulativeImpressions × planckPerImpression` cannot overflow before the cap. |

### Architectural batch 1 — narrow, well-bounded

| Ref | File:line | Change |
|---|---|---|
| **A6** | `DatumPublisherGovernance.sol:152` | `propose()` requires `msg.sender != publisher` — the proposer can no longer file a fraud proposal against themselves and capture bond-bonus into their own pool. |
| **A10** | `DatumGovernanceRouter.sol:39-44, 89-110` | Two-step governor handoff. `setGovernor` stages `pendingGovernor`; the staged address must call `acceptGovernor()` from its own context to complete the transition. Mirrors Ownable2Step. |
| **A13** | `DatumSettlement.sol:241-245` | `setClickRegistry` locks once non-zero. Re-pointing to a fresh registry would re-open replay on previously-claimed click sessions; deploy a new Settlement if a swap is genuinely needed. |
| **A14** | `DatumCampaigns.sol:99-105, 451-470` | Metadata mutations bump a per-campaign `campaignMetadataVersion` counter and (when status != Pending) enforce a 24-hour cooldown. Publishers can detect mid-flight creative swaps via the version in `CampaignMetadataSet`. |

### Architectural batch 2 — pervasive

| Ref | File | Change |
|---|---|---|
| **A2** | new `contracts/PaseoSafeSender.sol` + integrated into 6 contracts | Shared base contract. Every native-DOT send routes through `_safeSend(to, amount)`, which checks `amount % 10^6` and, if in the eth-rpc-rejected range, rounds down to the nearest `10^6` planck and queues the remainder in `pendingPaseoDust[to]`. Recipients pull dust via `claimPaseoDust[To]()`. **Funds can no longer be locked by the Paseo denomination bug** on any settlement-related contract. |
| | `DatumPaymentVault`, `DatumBudgetLedger`, `DatumChallengeBonds`, `DatumPublisherStake`, `DatumPublisherGovernance`, `DatumGovernanceV2` | Inherit `PaseoSafeSender`; every `call{value:}` payment site routed through `_safeSend`. |
| **A7** | `token/DatumFeeShare.sol:62-79, 110-129` | One-time `bootstrap(amount)` (owner-gated, min `1000 WDATUM`) parks the bootstrap stake under `address(0)` — permanently unwithdrawable. With `totalStaked > 0` from day one, the classic first-staker inflation attack (1-wei staker captures all orphan DOT) is uneconomic; flash-stakers can only capture a tiny share of new fees, proportional to their stake vs. the bootstrap. |
| **A1** | `DatumSettlement.sol:158-168, 380-419, 290-301` + `interfaces/IDatumSettlement.sol:49-57` + `DatumRelay.sol:21-23, 143, 158` | (a) `SignedClaimBatch` typehash now binds `deadlineBlock` and `expectedRelaySigner`. Publisher rotating `relaySigner` after sign time can no longer invalidate the advertiser's cosig retroactively, and the strict path (`expectedRelaySigner = 0`) requires the publisher's own EOA sig. (b) `validateConfiguration()` now fails when `nullifierWindowBlocks == 0`, blocking the deploy-time misconfiguration that would collapse all windowed nullifiers into one. |
| **A9** | Same as A1 — typehash + struct field | Dual-sig and relay paths now both use `deadlineBlock` (block.number). Eliminates the unit-ambiguity between paths and makes deadlines harder to manipulate than timestamps. |

### Architectural batch 3 — guardian-cypherpunk overhaul

| Ref | File | Change |
|---|---|---|
| **A5** | `DatumPauseRegistry.sol` (full rewrite) | (a) Any sitting guardian can solo-pause via `pauseFast()` — fast-pause distributed across N guardians, not concentrated on the owner. (b) Unpause still requires 2-of-3 guardian approval. (c) Sitting guardians can rotate the set 2-of-3 via `proposeGuardianRotation` + `approve`. (d) Owner `setGuardians` retained for bootstrap; `lockGuardianSet()` permanently disables that path once a real guardian set is in place. (e) Owner `pause()` retained as an additional fast-pause lane — but the guardian set is no longer owner-controlled after lock, so the owner cannot indefinitely brick the system. |
| **A8** | `DatumCampaigns.sol:78-89, 249-291` | Tag-removal grace window (~24h at 6s blocks). Dropped tags remain effective for `hasAllTags()` until `block.number >= effectiveBlock`. Re-adding a pending tag aborts its removal. Prevents the grief pattern where a publisher pulls a required tag mid-campaign to strand budget. |

---

## Part 2 — False positives confirmed and not fixed

| Ref | Reason |
|---|---|
| **T1** | OZ `ECDSA.recover` already enforces low-s (`InvalidSignatureS` revert). Both call sites in `DatumSettlement.settleSignedClaims` go through it. |
| **T10** | Council `executed = true` is set *before* the multi-call loop (`DatumCouncil.sol:316`), not after. `nonReentrant` further closes any race. |
| **T15** | `DatumWrapper.unwrap` is safe: a revert in `precompile.transfer` reverts the whole tx including the prior `_burn`; the post-call invariant check catches silent no-op cases. |
| **T31** | `DatumPaymentVault` open `receive()` is required — BudgetLedger pushes DOT into it via `deductAndTransfer`. Closing it would break settlement. |
| **T28** | BootstrapPool dust remainder is by-design and documented. Worst-case loss < one grant (~3 DATUM out of 1M reserve). |
| **T3** | PaymentVault dust-sweep is already capped at 1e16 planck (0.001 DOT, sub-ED). Agent overstated the threshold scale. |
| **T27** | Reputation counter uses Solidity 0.8 checked math; overflow requires 2^256 settlements. Not exploitable. |
| **T35** | Constructor already requires `maxGrace >= baseGrace`. |
| **T17 (partial)** | ZK verifier correctly loads IC3 and constrains `impressionCount`. Public-input truncation modulo SCALAR_ORDER is the only valid encoding. |
| **A4** | Timelock `cancel()` only sets `p.cancelled = true`; the timestamp stays non-zero, so `propose()`'s `timestamp == 0` check correctly blocks re-scheduling the same ID. No salt-collision replay primitive. |
| **A11** | GovV2 `ayeWeighted`/`nayWeighted` are intentionally "active stake" aggregates; slash distribution uses the separate frozen `resolvedWinningWeight` snapshot. There is no invariant divergence. |
| **A12** | ChallengeBonds path ordering is correct: `claimBonus` after `returnBond` reverts via the zero-bond guard; `returnBond` after `claimBonus` is a documented silent no-op (bond is burned on `claimBonus` per design). |

---

## Part 3 — A3 (AssuranceLevel system) — implemented

After discussion, A3 was re-scoped from "force publisher attestation on open campaigns" to **"let the advertiser choose the fraud-prevention tier; let publishers self-declare what they support; let the market price it."** This better fits the cypherpunk ethos — no protocol-imposed authority, advertisers and publishers freely opt into stronger guarantees.

### Tier enum (orthogonal to ZK / attestation flags)
| Level | Name | Submission paths accepted |
|---|---|---|
| 0 | Permissive | Any registered publisher, any settle path (today's default) |
| 1 | PublisherSigned | Relay path *with* publisher cosig, publisher's `relaySigner` direct-submit, or dual-sig path |
| 2 | DualSigned | `settleSignedClaims` only (publisher + advertiser cosigs) |

Levels strictly nest — a dual-sig batch satisfies every level.

### Files touched
| File | Change |
|---|---|
| `interfaces/IDatumCampaigns.sol` | New event `CampaignAssuranceLevelSet`, new view `getCampaignAssuranceLevel`. |
| `interfaces/IDatumCampaignsSettlement.sol` | New view `getCampaignAssuranceLevel` for Settlement/Relay consumption. |
| `interfaces/IDatumPublishers.sol` | New event `PublisherMaxAssuranceSet`, new view `publisherMaxAssurance`, new setter `setPublisherMaxAssurance`. |
| `DatumCampaigns.sol` | New storage `campaignAssuranceLevel`; setter `setCampaignAssuranceLevel(id, level)` with raise-locked-at-Pending semantics; view OR-merges legacy `campaignRequiresDualSig`. Default at creation = L0 for all campaigns. |
| `DatumPublishers.sol` | New storage `publisherMaxAssurance`; self-declared setter `setPublisherMaxAssurance(level)`. Pure discovery signal — no on-chain enforcement. |
| `DatumSettlement.sol` (`_processBatch`) | Reads campaign level. L2: existing dual-sig gate (reason 24). L1: requires `msg.sender == relayContract` OR `_isPublisherRelay(claims)` OR dual-sig — else reject all claims with new reason **25**. L0: no extra check. Legacy `requiresDualSig` path retained as safety-net fallback. |
| `DatumRelay.sol` (`settleClaimsFor`) | For campaigns at L1+, requires non-empty `sb.publisherSig`. |
| `MockCampaigns.sol` | Added `setCampaignAssuranceLevel` + `getCampaignAssuranceLevel` mirrors for test infrastructure. |
| `test/audit-fixes.test.ts` | 9 new tests covering L0 default, L1 rejection of direct settle, L1 via dual-sig, L1 via publisher's relaySigner, L2 backward-compat, raise/lower semantics, legacy-flag cleanup, publisher max-assurance. |

### Design notes recorded
- **Permissive default (L0).** Advertisers opt into higher tiers explicitly. No mild paternalism on closed campaigns. Confirmed by user during implementation: "permissive by default."
- **Lowering allowed any time; raising locked at Pending.** Less proof never invalidates past claims and gives the advertiser an escape if their cosign pipeline breaks. Raising mid-flight could freeze user earnings if the advertiser then refuses to cosign.
- **`publisherMaxAssurance` is pure discovery.** On-chain claim acceptance is decided per-batch by cryptographic proof. A publisher who declares L0 but happens to deliver an L1 batch is accepted; one who declares L2 but never cosigns sees their L2 claims rejected.
- **Market pricing.** Take rates are already per-publisher. Publishers running cosign infrastructure can charge more; advertisers pay for the tier they want. No new pricing logic.
- **ZK / attestation flags stay orthogonal.** A campaign can independently choose `(L1, ZK-required)` etc.

### What's *not* in A3
- Per-claim user-attestation binding the user's session to a specific publisher (the original audit framing). The current system addresses the same threat economically (PublisherStake bonding curve) at all tiers and cryptographically (publisher cosig) at L1+. A future addition could be an L3 "UserWitnessed" tier where the user signs an attestation that *this specific publisher* served them — useful for the open-campaign Sybil scenario where attacker controls both user and publisher addresses. Deferred until there's a concrete deployment need; the data model change would require an off-chain coordinated rollout.

### Lower-priority items still on the list (informational)
- **T22** BudgetLedger timestamp-based daily cap — Paseo's timestamp is consensus-bounded; acceptable. Flag for non-Polkadot ports.
- **T23** MintAuthority concurrent mint cap-check — both call sites are external onlyOwner; same tx can't span them. Mitigated by call ordering.
- **T24** TokenRewardVault Asset-Hub return semantics — `SafeERC20` handles missing return data correctly in modern OZ. Verify on devnet.
- **T25** ClickRegistry session-hash — A13 now locks `setClickRegistry` once set, killing the disable/re-enable replay surface. Session-hash dedup itself is per-(user, campaign, nonce) which is sufficient assuming the relay generates unique nonces.
- **T26** Vesting linear-interp rounding — loss is ≤ 1 base unit per extend call. Cosmetic.
- **T29** ParameterGovernance 4-byte selector — birthday collision ~ 2^-32; not exploitable.
- **T32** EIP-712 fork re-sign UX — documentation, not code.
- **T33** Report-counter storage griefing — add a small `proposeBond`-style fee if it becomes a problem.
- **T34** `categoryId` width drift — audit the webapp + SDK; not contract-side.

---

## Summary

- **1 new base contract** (`PaseoSafeSender.sol`).
- **14 contracts modified** across 15 audit items (T19, T21, A1, A2, A5, A6, A7, A8, A9, A10, A13, A14, plus A3's three-tier system).
- **8 test files updated** to track interface changes (typehash, struct fields, two-step governor, tag grace, A3 levels).
- **619/619 tests passing** continuously throughout (610 baseline + 9 new A3 tests).
- **9 false positives** identified and documented (T1, T10, T15, T31, T28, T3, T27, T35, T17 partial, plus A4, A11, A12).

### Cypherpunk-alignment notes
- A5 redistributes pause authority across the guardian set rather than concentrating it on the owner, and gives guardians a self-rotation path. The owner's pause power is retained but is no longer load-bearing for protocol safety after `lockGuardianSet()`.
- A13 removes a settable-after-deploy admin lever on Settlement (matches the existing `setMintAuthority` immutability pattern).
- A1, A9 strengthen sign-time intent capture and reduce reliance on mutable on-chain state at claim-execution time.
- A2 protects the smallest balances on the network from getting locked by a network-level bug, with no privileged claim path — anyone can pull their own dust.
- A6 closes an economic exploit that would have abused permissionless propose() to launder slashed stake into the proposer's own bond-bonus claim.
- A7 prevents a value-capture attack on stakers without introducing a centralized authority over the FeeShare contract.

### Next session candidates
1. Front-end / SDK rev to match the new `SignedClaimBatch` struct (`deadlineBlock` + `expectedRelaySigner`) and the A3 AssuranceLevel surface (campaign creation UI, publisher self-declaration UI, level-aware claim submission).
2. Devnet smoke test of `PaseoSafeSender` against the real eth-rpc gateway.
3. Trusted-setup ceremony plan for the ZK circuit (testnet single-party setup is acknowledged-unsafe per `MEMORY.md`).
4. Indexer / discovery layer exposing `(campaign.assuranceLevel, publisher.maxAssurance)` so the market signal A3 enables is actually surfaced to advertisers and publishers.
