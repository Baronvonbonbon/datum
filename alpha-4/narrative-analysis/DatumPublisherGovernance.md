# DatumPublisherGovernance

Conviction-vote governance targeting publishers. When fraud is suspected,
anyone can `propose(publisher, evidenceHash)` (paying a refundable bond);
the community votes aye/nay with conviction-weighted DOT; if aye wins,
PublisherGovernance calls `DatumPublisherStake.slash(publisher,
slashedAmount, address(this))` and forwards a share into `DatumChallengeBonds`'s
bonus pool for that publisher.

## Conviction curve

Same quadratic curve as GovernanceV2:
`weight(c) = (convictionA · c² + convictionB · c) / 100 + 1`
with default A=25, B=50 → weight(8) = 21x at 365-day lockup.

The curve is **per-proposal snapshotted** (audit M-2): `propose()` records
the live `convictionA / convictionB` into `proposalConvictionA[id]` /
`proposalConvictionB[id]`, and `_weight(proposalId, c)` reads from the
snapshot. A governance retune after votes are cast cannot retroactively
reweight an in-flight proposal.

Lockups are a 9-element array, also governance-tunable, capped at
`MAX_LOCKUP_BLOCKS = 10_512_000` (2 years at 6s/block). Each vote's
`lockedUntilBlock` is set at vote time, so lockup changes also don't
retroactively re-lock.

## Proposal flow

```
1. propose(publisher, evidenceHash) — caller pays proposeBond (refundable)
2. vote(id, aye, conviction) — caller stakes DOT, locked per conviction
3. (grace period after first nay vote)
4. resolve(id) — anyone calls
   - upheld = ayeWeighted > nayWeighted && ayeWeighted >= quorum
   - upheld: publisherStake.slash, split into challengeBonds bonus pool + treasury
   - quorum reached (either way): proposer's bond refunded via pendingGovPayout
   - quorum not reached: proposer's bond forfeit to treasury
5. withdrawVote — voter pulls stake back after their lockup elapses
```

## Self-protection: proposer cannot be target

`A6 audit`: the publisher being accused cannot be the proposer.
Without this, a publisher could self-propose, vote nay with high
conviction, accumulate the proposer's lost bond + push the bonus pool into
ChallengeBonds where they (qua advertiser) can later claim.

## Grace period

`minGraceBlocks` after the first nay vote must elapse before `resolve()`.
This prevents an aye majority from sniping resolution the moment opposition
appears, denying coordination time.

## Slash distribution

Slashed DOT splits two ways:

- `bondBonusBps` (governance-set, e.g. 5000 = 50%) → forwarded to
  `challengeBonds.addToPool(publisher, amount)`. Advertisers with active
  bonds against this publisher can later claim a pro-rata share.
- Remainder → treasury via `pendingGovPayout[owner()]`.

## Council arbiter path

Separate from the main fraud proposal flow, the contract exposes an
**advertiser fraud claim** mechanism that the Council can resolve. An
advertiser files a claim with a DOT bond; the council reviews evidence
off-chain, then calls `resolveAdvertiserClaim(id, upheld)`. If upheld,
the publisher is slashed; if dismissed, the advertiser's bond is forwarded
to the publisher as compensation for the false accusation. This dual track
(public conviction vote *or* council arbitration) lets the protocol handle
both decentralised disputes and faster council-mediated ones.

## Pause behavior

`whenNotPaused` reads `pausedGovernance()`. Settlement-only pauses don't
freeze governance — and governance-only pauses don't freeze settlement.
This separation is what the CB6 categorical pause categories are for.

## Pull-payment everywhere

- `claimGovPayout()` — proposer bond refunds and treasury sweeps.
- `withdrawVote(id)` — voter unlocks.
- `sweepTreasury()` — owner pulls accumulated treasury into the payout queue.

Direct pushes are avoided; every value transfer goes through `_safeSend`
(PaseoSafeSender) so contract-owners with reverting fallbacks can't DoS the
flow.

## Why one quorum, not two

Some governance models use separate "approval" and "termination" quorums.
This one uses a single `quorum` because the action it gates (publisher
slash) is unconditional. Either fraud is upheld or it isn't.
