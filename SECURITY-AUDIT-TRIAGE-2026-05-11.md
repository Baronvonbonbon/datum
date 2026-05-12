# DATUM Alpha-4 Security Audit — Triage Pass

**Date:** 2026-05-11
**Status:** Untracked working doc. Survey/triage only — no fixes proposed.
**Scope:** All 22 alpha-4 core contracts + `token/` sidecar.
**Method:** Four parallel domain-scoped reviewers (settlement+ZK signature path, value flows, governance & access control, campaigns/identity/ZK soundness). Output consolidated and re-ranked.

---

## Tier 1 — Critical / high-confidence, immediately exploitable

| # | Vector | File:line | One-line scenario |
|---|---|---|---|
| **T1** | **ECDSA signature malleability in dual-sig path** — no low-s check; OZ check used in `DatumRelay` but absent here | `DatumSettlement.sol:391, 412` | Flip `s → n-s` to mint a second valid signature → cross-fork / cross-batch replay of the same advertiser+publisher cosig. |
| **T2** | **Nullifier window zero-init replay** — `nullifierWindowBlocks` defaults to 0; if `setNullifierWindowBlocks` is skipped, every proof for a campaign shares one nullifier | `DatumSettlement.sol:~110, 614-620`; `DatumZKVerifier.sol:114-129` | One ZK proof settles unbounded claims for that (user, campaign). Open question: is windowId bound in the circuit or only on-chain? |
| **T3** | **PaymentVault owner dust-sweep** — `sweepPublisher/UserDust` can drain near-ED balances if owner key is compromised; threshold cap is 1e16 planck (very large) | `PaymentVault.sol:165-180` | Compromised owner key → mass small-balance theft, users locked below ED. |
| **T4** | **Paseo eth-rpc denomination bug propagates to every `_send` site** — any payout where `value % 10^6 >= 500_000` is rejected, funds stay locked | `PaymentVault.sol:208`, `BudgetLedger.sol:282`, `ChallengeBonds.sol:129,183`, `PublisherStake.sol:120` | Craft settlement so totalPayment ends with rejected fraction → permanent lock; high-impact griefing or accounting DoS. |
| **T5** | **Open-campaign self-attribution** — `claims[0].publisher` is trusted for open campaigns; fake-publisher registration drains budget | `DatumCampaigns.sol:403-404`, `DatumClaimValidator.sol:104-116`, `DatumAttestationVerifier.sol:99` | Register attacker-controlled publisher, attribute open-campaign claims to self. |

## Tier 2 — High, conditional on extra capability or governance state

| # | Vector | File:line | Capability needed |
|---|---|---|---|
| T6 | Timelock salt-collision / cancel-then-re-schedule — `hashProposal(target,data,salt)` collides on re-use; cancellation sets timestamp=0, re-propose allowed | `DatumTimelock.sol:35-46, 60-90` | Predict owner's salt; race re-propose after cancel. |
| T7 | Relay-signer hotswap window — 600-block cooldown; Settlement reads *current* relay signer, not snapshot | `DatumPublishers.sol:293-302`; `DatumAttestationVerifier.sol:137-138` vs `DatumCampaigns.sol:410` (snapshot) | Compromised relay key OR publisher rotation mid-batch invalidates advertiser cosig retroactively. |
| T8 | PauseRegistry asymmetric pause — owner-only pause; 2-of-3 guardian unpause; in-flight approvals not revoked on guardian rotation | `DatumPauseRegistry.sol:118-121, 46-102` | Brief owner compromise → indefinite pause; or compromised guardian's pre-approved proposal executes after rotation. |
| T9 | PublisherGov self-slashing economic loop — anyone can propose fraud on any publisher (incl. themselves); slashBps capped only by governance | `DatumPublisherGovernance.sol:148, 255-279` | Coordinated voter → slashes self → claims proportional bond-pool bonus. |
| T10 | Council batch re-execution on partial failure — `executed=true` set *after* loop; mid-batch revert leaves proposal re-executable | `DatumCouncil.sol:307-328` | Construct batch where call-N fails initially, fix env, re-execute → double effect of calls 0..N-1. |
| T11 | FeeShare first-mover inflation via orphan DOT fold — orphan accumulates before stakers; flash-stake captures inflated `accDotPerShare` | `token/DatumFeeShare.sol:130-181, 226` | Stake 1 wei right after first non-empty `notifyFee` → outsize claim share. |
| T12 | Settlement DATUM mint multiplication — `agg.total * mintRatePerDot` no overflow guard pre-division | `DatumSettlement.sol:719` | Gov-tunable rate × accumulated total → revert (DoS) or, if rate logic ever changes, mint distortion. |
| T13 | Campaign tag-grief via post-creation publisher tag changes — `requiredTags` snapshot, but publisher tags mutable; can make campaign unsettleable | `DatumCampaigns.sol:314-383`, `DatumPublishers.sol:241-263` | Strand campaign budget until expiry. |
| T14 | Dual-sig deadline semantic ambiguity — `block.timestamp` here vs `block.number` in relay path; same field name, no type tag | `DatumSettlement.sol:377`; `DatumRelay.sol:143`; `IDatumSettlement.sol:53` | Off-chain signer using wrong unit → DoS, or attacker locks signatures far in future. |
| T15 | Wrapper unwrap precompile failure path — burn precedes precompile transfer; if transfer reverts mid-call peg breaks until invariant re-check | `token/DatumWrapper.sol:101, 121-124` | Force the precompile path to fail (bad recipient / gas) → soft un-peg. |
| T16 | ZK public-input truncation modulo SCALAR_ORDER — possible collisions / IC-count mismatch with circuit | `DatumZKVerifier.sol:127-129`; `DatumClaimValidator.sol:146-156` | Requires circuit/verifier mismatch; if real, breaks ZK soundness. |

## Tier 3 — Medium / design smells / narrow windows

| # | Vector | File:line |
|---|---|---|
| T17 | Router governor race during Phase 0→1 transition; no interface check on forwarded calls | `DatumGovernanceRouter.sol:75, 88-93, 122-134` |
| T18 | GovernanceV2 post-resolve weight tracking divergence on withdraw | `DatumGovernanceV2.sol:225-234` |
| T19 | Council guardian veto on dead (never-thresholded) proposals | `DatumCouncil.sol:332-342` |
| T20 | ChallengeBonds claimBonus vs returnBond race; pendingBondReturn double-path; division-rounding leak | `DatumChallengeBonds.sol:92-111, 154-186, 167` |
| T21 | PublisherStake bonding-curve cumulative-impressions overflow before cap | `DatumPublisherStake.sol:130, 189-190` |
| T22 | BudgetLedger daily-cap on `block.timestamp` (cross-chain portability risk) | `DatumBudgetLedger.sol:138-144` |
| T23 | MintAuthority concurrent mint paths share cap check non-atomically | `token/DatumMintAuthority.sol:129-150` |
| T24 | TokenRewardVault non-standard ERC-20 (Asset-Hub) return semantics | `DatumTokenRewardVault.sol:57, 99, 110, 132` |
| T25 | ClickRegistry session-hash key only `(user, campaignId, nonce)`; relay nonce reuse risk; disable→re-enable loses claimed-state | `DatumClickRegistry.sol:118-123`; `DatumClaimValidator.sol:180-188`; `DatumSettlement.sol:68-69, 635-636` |
| T26 | Vesting linear-interpolation rounding on `endTime` extension | `token/DatumVesting.sol:71, 75-81` |
| T27 | Settlement reputation counter unbounded `+=` | `DatumSettlement.sol:760-764` |
| T28 | BootstrapPool dust remainder lock | `token/DatumBootstrapPool.sol:73-79` |
| T29 | ParameterGovernance whitelist via 4-byte selector only | `DatumParameterGovernance.sol:187-191, 245-256` |
| T30 | Campaign metadata mutable post-Active, no version/nonce | `DatumCampaigns.sol:451-456` |

## Tier 4 — Low / informational

- **T31** PaymentVault open `receive()` — accepts stray ETH (`PaymentVault.sol:216`).
- **T32** EIP-712 fork re-sign UX — domain separator rebuilds on chainid mismatch but no in-code warning.
- **T33** Report-counter storage griefing via many addresses (`DatumCampaigns.sol:285-307`).
- **T34** Possible alpha-3 → alpha-4 `categoryId` uint256→uint8 width drift in legacy callers.
- **T35** GovernanceV2 grace = 0 if owner sets `maxGraceBlocks = 0` (intentional, but worth flagging).

---

## Recommended deep-dive sequence

1. **T1 — ECDSA malleability in `DatumSettlement.settleSignedClaims`.** Narrow scope, exploitable today. Confirm: low-s normalization on both recovers, chainId in EIP-712 envelope, per-batch nonce, any nullifier covering the cosig tuple.
2. **T2 — Nullifier windowing.** Requires reading `impression.circom` + on-chain windowId derivation together. If windowId is baked into the proof off-chain rather than re-derived from block context, replay is unbounded regardless of `nullifierWindowBlocks`. Largest blast radius.
3. **T4 — Paseo denomination 10^6 rounding.** Cheapest possible griefing primitive on every value-moving path; one helper would close it.
4. **T5 — Open-campaign self-attribution.** Either prove the AttestationVerifier check on `claims[0].publisher` is sound, or this is a budget-drain primitive.
5. **T6 / T10 — Governance state-machine flaws** (Timelock salt reuse, Council partial-execute). Lower exploitability but high impact if reachable.

## Open questions to resolve before next pass

- Does the EIP-712 domain in `DatumSettlement` and `DatumAttestationVerifier` include `chainId`, `verifyingContract`, and a salt distinguishing dual-sig from relay envelopes?
- Is `windowId` a public input to the `impression.circom` circuit, and is it re-derived from `block.number / nullifierWindowBlocks` on-chain before verification?
- Does `setup-testnet.ts` (or `deploy.ts`) call `setNullifierWindowBlocks` with a non-zero value?
- For Asset-Hub-native ERC-20s via precompile, does `SafeERC20` actually wrap correctly (return data length 0 vs bool)?
- Confirm whether `categoryId` was fully removed from the alpha-4 `createCampaign` signature, ABI, and webapp callers.

---

## Provenance

Four parallel `general-purpose` reviewers, each with file-scoped scope and category checklist. Each produced its own ranked list and "highest-leverage next dive." Items above are de-duplicated with severity/confidence merged conservatively (kept the lower of two confidences on overlap). No fixes applied; no tests run.
