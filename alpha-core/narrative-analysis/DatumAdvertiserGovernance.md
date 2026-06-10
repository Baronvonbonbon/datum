# DatumAdvertiserGovernance

Conviction-vote governance for advertiser fraud, mirroring
PublisherGovernance. Voters lock DOT to support or oppose a fraud
proposal; if aye wins, the advertiser is slashed via
`DatumAdvertiserStake`. Slashed DOT lands in this contract's treasury and
becomes pull-payable.

## Architecturally identical to PublisherGovernance

Same conviction curve, same quadratic weight function, same propose/vote/
resolve/withdraw lifecycle, same per-proposal curve snapshot (audit M-2),
same `MAX_LOCKUP_BLOCKS = 10_512_000` cap on lockups, same `_safeSend`
pull-payment pattern. The only structural difference is the slash target:
`advertiserStake.slash` instead of `publisherStake.slash`, and no
ChallengeBonds integration (advertiser slashes don't bonus-pool anywhere —
they just credit treasury).

## Slash percentage model

`slashBps` (governance-tunable, capped at 10000) defines the fraction of
the advertiser's *current* staked balance to slash on upheld fraud:

```
currentStake = advertiserStake.staked(advertiser)
slashed       = currentStake × slashBps / 10000
```

This contrasts with PublisherGovernance, which slashes a fixed amount
proportional to the campaign's cumulative payout. Here the slash is
percentage-of-stake — a cleaner model when there's no "campaign" in
the slash target's identity (advertisers run many campaigns, can't tie
the slash to any one).

## Treasury accounting

`receive() external payable` only credits `treasuryBalance` when
`msg.sender == address(advertiserStake)` (audit L-3 fix). Any other inbound
DOT reverts — mistransfers can't orphan value here. Owner-only
`sweepTreasury()` queues the balance for owner pull via `pendingGovPayout`.

## Proposer bond economics

`proposeBond` is forwarded to this contract on `propose()`. Refund logic:

- Quorum reached (any outcome) → proposer's bond goes to
  `pendingGovPayout[proposer]`.
- Quorum NOT reached → bond is forfeit to `treasuryBalance`.

The asymmetry incentivises serious proposals: speculative or spammy
proposals that fail to reach quorum lose the bond; substantive ones that
attract participation get refunded regardless of outcome.

## Grace period

`minGraceBlocks` after `lastNayBlock` (the last block a nay vote was cast)
must elapse before resolution. Tighter than the PublisherGov "first-nay"
gate — every late nay vote resets the clock, giving nay coalitions more
time to coordinate as new opposition trickles in.

## G-3 first close (2026-05-20): publisher-filed Council track

Mirror of `DatumPublisherGovernance.fileAdvertiserFraudClaim`. Closes
`gaps-in-checks-and-balances.md` G-3 (no publisher-side dispute
initiation). Pre-close, the conviction-vote track was symmetric
(anyone can propose on either side), but the fast Council-arbitrated
track existed only one-directionally (advertisers could file against
publishers). Now publishers can file with bond + evidence CID and
Council resolves on-chain.

```
publisher  ──filePublisherFraudClaim(adv, campaignId, evidence)──►
                                                  (locks publisherClaimBond)
                                                          │
                                                  Council off-chain review
                                                          │
council    ──councilResolvePublisherClaim(claimId, upheld)─►
                upheld   → advertiserStake.slash; bond → filer pending queue
                dismissed → bond → advertiser pending queue (anti-grief)
```

Lock-once `councilArbiter` setter (hot-swap = unilateral slash
backdoor). `publisherClaimBond` is tunable — 0 disables the track
entirely. Anti-self check: an advertiser cannot file against
themselves.

The on-chain filer field is recorded as `msg.sender` and not enforced
to be a publisher — the bond requirement gates the actor in practice.
Publishers are the natural filers (they're the parties who detect
advertiser welching first), but anyone with the bond can file. Same
shape as the PublisherGov sibling.

## What this contract doesn't have

- ~~No publisher-filed claim against advertiser~~ — **closed by G-3
  first close** (above).
- No bonus-pool integration (no ChallengeBonds for the advertiser side).
  Slashed funds accumulate as treasuryBalance via `receive()`;
  ChallengeBonds is publisher-side only.

## Pause behavior

`whenNotPaused` reads `pausedGovernance()`. Slash is in `nonReentrant`
context. The receive() function does NOT check pause — slash proceeds must
land regardless of governance pause state, because the slash side of the
flow (AdvertiserStake → this) is already past the gate.
