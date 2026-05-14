# DatumClaimValidator

A pure validation contract. Every claim passes through `validateClaim` on its
way through Settlement; this is where the protocol decides whether a claim
is *well-formed* — independent of payment, rate-limiting, or blocklist
concerns (those live in Settlement).

The contract is intentionally stateless (aside from a few owner-set wiring
slots): it reads `DatumCampaigns`, `DatumPublishers`, `DatumZKVerifier`,
`DatumClickRegistry`, `DatumSettlement`, `DatumStakeRoot`, and
`DatumInterestCommitments`, and returns a verdict tuple `(ok, reasonCode,
takeRate, computedHash)`.

## The check ladder

Inside `validateClaim`, the protocol runs the following in order. The first
failure short-circuits with a numeric reason code (mapped in
`error-codes.md`):

0. **Action type bounded.** 0 (view), 1 (click), 2 (action). Otherwise reason 21.
1. **Event count in range.** Non-zero, ≤ `MAX_CLAIM_EVENTS`.
2. **Campaign status == Active.** Read from `campaigns.getCampaignForSettlement`.
3. **Publisher match.** For closed campaigns (`cPublisher != 0`), `claim.publisher` must equal `cPublisher`, AND if `campaignAllowlistEnabled[id]` the advertiser must be in the allowlist snapshot. For open campaigns, `claim.publisher != 0` and `publishers.allowlistEnabled(claim.publisher) == false` (BM-7).
4. **S12 blocklist.** Calls `publishers.isBlocked(claim.publisher)` (fail-open path — see Settlement for fail-closed at L1+).
5. **Rate within pot bounds.** Reads `campaigns.getCampaignPot(id, actionType)`. Reverts if no pot; rejects if `claim.ratePlanck > potRate`.
6. **Nonce chain.** Strict `expectedNonce` match.
7. **Previous hash chain.** First claim must have `previousClaimHash == 0`; otherwise must match Settlement's `lastClaimHash`.
8. **Claim hash.** Computes `keccak256(abi.encode(campaignId, publisher, user, eventCount, ratePlanck, actionType, clickSessionHash, nonce, previousClaimHash, stakeRootUsed))`. The `stakeRootUsed` was added for Path A so the user's ZK proof commits to which stake-root the proof was generated against. Reason 10 on mismatch.
9. **PoW + sybil history.** Reads `settlement.enforcePow`, `settlement.powTargetForUser`, and the campaign's `minUserSettledHistory`. PoW failure → reason 27; history failure → reason 28.
10. **ZK proof (type-0 only, if campaign requires it).** Reads `getCampaignRequiresZkProof`. If true, requires a non-empty proof and calls `_verifyPathA` (see below). M-4 fail-closed: if the ZK flag is unreadable, reject (the user opted in to ZK-only and we can't risk silently downgrading).
11. **Click session check (type-1 only).** `clickRegistry.hasUnclaimed(user, campaign, clickSessionHash)` must return true.
12. **Action signature (type-2 only).** Recovers `actionSig` via `ecrecover` and verifies the signer matches the pot's `actionVerifier`. Includes EIP-2 low-S enforcement to prevent sig malleability.

## `_verifyPathA` — the 7-pub Groth16 path

For ZK-gated claims, builds the 7-element public-input array and forwards to
`zkVerifier.verifyA`:

```
pub0 = claimHash              (computed in Check 8)
pub1 = claim.nullifier
pub2 = claim.eventCount
pub3 = claim.stakeRootUsed    — must pass stakeRoot.isRecent
pub4 = campaignMinStake       — clamped by maxAllowedMinStake (audit M-4)
pub5 = interestCommitments.interestRoot(user)
       — must satisfy minInterestAgeBlocks (audit M-8)
pub6 = campaignRequiredCategory
```

M-8 freshness: if `block.number < lastSetBlock[user] + minInterestAgeBlocks`,
`_verifyPathA` returns false (reason 16). This defeats reactive interest-set
swaps right before submission.

M-4 clamp: even if a campaign's stored `minStake` was set under a generous
`maxAllowedMinStake`, the consumed proof uses the current cap. A governance
tightening of the cap retroactively protects users.

## Plumbing lock

Every ref (campaigns, publishers, zkVerifier, clickRegistry, settlement,
stakeRoot, interestCommitments) is set via owner; `lockPlumbing()` freezes
them permanently. The plumbing lock is the cypherpunk terminal state for
this contract — once flipped, the only mutable surface is
`minInterestAgeBlocks`, and even that is gated on plumbingLocked.

## Why it's a separate contract

Originally inlined in Settlement, extracted (alpha-3 SE-1) to keep
Settlement's bytecode under the PVM limit and to make claim-validation rules
swappable behind a single ref. Settlement's `setClaimValidator` is lock-once
— a hostile owner can't swap to a permissive validator.

## Reading the reason code

A failing claim emits `ClaimRejected(campaignId, user, nonce, reasonCode)`.
Off-chain observers (the relay bot, the extension, monitors) translate the
code via the shared `error-codes.md` table. Reason `7` (nonce mismatch) is
also a *gap signal* — Settlement sets `gapFound = true` and rejects all
subsequent claims in the batch, preserving the nonce chain.
