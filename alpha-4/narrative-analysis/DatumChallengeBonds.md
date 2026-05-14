# DatumChallengeBonds

Optional skin-in-the-game for advertisers. At campaign creation, the
advertiser can lock a DOT bond. The bond does nothing visible day-to-day,
but two things can happen to it:

1. Campaign ends cleanly (Completed or Expired) → bond is returned.
2. PublisherGovernance upholds fraud against the campaign's serving
   publisher → a slice of the slash proceeds flows into a *bonus pool*
   associated with that publisher. Bonded advertisers can claim a
   pro-rata share — but the bond itself is *burned* (forfeit to the
   pool, not returned) when they claim the bonus.

## Why advertisers would do this

Two reasons:

- **Signal.** Posting a bond communicates seriousness to publishers and
  to the protocol. A high-bond campaign is more likely to be allowlisted
  by quality publishers.
- **Insurance against publisher fraud.** If a publisher cheats you, the
  governance slash can recover *more* than your bond if the publisher's
  total slashable balance is large enough. The bonus-pool share is your
  payout for being among the early-warning advertisers.

## State

```
_bondOwner[campaignId]     — who owns the bond
_bond[campaignId]          — bond amount
_bondPublisher[campaignId] — which publisher the bond is associated with
_totalBonds[publisher]     — sum of all bonds for this publisher (denominator for claims)
_bonusPool[publisher]      — slash proceeds awaiting distribution
_bonusClaimed[campaignId]  — single-claim guard
pendingBondReturn[addr]    — pull-queue for normal returns (M-1 audit pattern)
```

## Entry points

- **`lockBond(campaignId, publisher)`** — payable; callable only by
  `campaignsContract` during createCampaign. Records the bond.
- **`returnBond(campaignId)`** — callable only by `lifecycleContract`
  during normal campaign end. Credits `pendingBondReturn[advertiser]`
  rather than pushing — a contract-advertiser with a reverting fallback
  can't DoS Lifecycle.
- **`addToPool(publisher, amount)`** — callable only by
  `governanceContract` (PublisherGovernance) when fraud is upheld.
  Increments `_bonusPool[publisher]`.
- **`claimBonus(campaignId)`** — callable by the bond owner. Computes
  `share = bond × bonusPool / totalBonds`, burns the bond, transfers
  the share. Single-shot per bond.
- **`claimBondReturn()`** — pulls accumulated `pendingBondReturn`.

## Pull-payment doctrine

Everything outbound is pull. `_safeSend` is used so the Paseo
denomination bug can't strand value. The "M-1 audit pattern" note in the
source: `returnBond` was previously a push and a reverting advertiser
fallback could DoS the entire Lifecycle. Now it queues and the advertiser
pulls.

## Three authorization slots

- `campaignsContract` — only the Campaigns contract may lock bonds.
- `lifecycleContract` — only Lifecycle may return them.
- `governanceContract` — only PublisherGovernance may add to bonus pools.

All set via owner; the pattern is the standard lock-once (set to non-zero
once, can't change after).

## Why bond is burned on bonus claim

The bond's job is to absorb risk. If you claim the bonus, you've decided
the publisher was fraudulent and you want the payout. You no longer need
the bond as a "stake on this campaign's outcome" — it's already concluded.
Burning the bond (forfeit to pool) lets remaining bonded advertisers
share a slightly larger pool, and prevents double-recovery (bond return
+ bonus claim) from the same campaign.

## The math

`share = bond × bonusPool / totalBonds`. Critical: `totalBonds` is the
denominator at *claim time*, not at slash time. Late claimers see a
shrunken pool but also a shrunken denominator (as earlier claimers burn
their bonds), so the math approximately preserves pro-rata. The "approximately"
is the rounding floor; the contract caps at pool balance to prevent under-funding.

## Why optional

`address(0) = disabled`. Many campaigns won't bother with bonds —
particularly small advertisers or low-value campaigns where the bond
overhead is more than the implied insurance value. The optionality keeps
this from being a tax on every campaign while still giving high-value
advertisers a tool.
