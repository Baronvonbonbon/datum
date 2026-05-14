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

## What this contract doesn't have

- No advertiser-fraud-claim arbiter path (PublisherGov has one for Council
  resolution of advertiser-filed claims; the symmetric "publisher-filed
  claim against advertiser" doesn't exist here — publishers have less
  recourse than advertisers in the current design, partly intentional
  since the protocol's economic asymmetry already favors them via the
  take rate).
- No bonus-pool integration (no ChallengeBonds for the advertiser side).

## Pause behavior

`whenNotPaused` reads `pausedGovernance()`. Slash is in `nonReentrant`
context. The receive() function does NOT check pause — slash proceeds must
land regardless of governance pause state, because the slash side of the
flow (AdvertiserStake → this) is already past the gate.
