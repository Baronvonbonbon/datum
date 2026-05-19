# DatumCampaignAllowlist

Per-campaign publisher allowlist + per-publisher take-rate snapshot.
Carved out of DatumCampaigns for mainnet EIP-170. The hot path
(`DatumClaimValidator`) reads from here for per-claim "is this
publisher allowed on this campaign" decisions.

Companion: [`proposals/multi-publisher-campaigns.md`](./proposals/multi-publisher-campaigns.md)
covers the multi-publisher design (per-publisher bonds, take-rate
overrides, removal flow).

## Two writer paths

1. **`initializeFor(campaignId, publisher, takeRate)`** — gated to
   `onlyCampaigns`. Called by `DatumCampaigns._createCampaign` when a
   single-publisher campaign seeds its allowlist with the named
   publisher at creation. The seed sets `allowed[id][pub] = true`,
   records the take-rate snapshot, and increments the count.
2. **`addAllowedPublisher` / `addAllowedPublishers` (batch up to 32) /
   `removeAllowedPublisher`** — advertiser-facing entry points
   (advertiser-only). The advertiser of a multi-publisher campaign
   adds or removes publishers after creation. Adds run validation
   (publisher registered, not blocked, has all required tags,
   stake threshold met if `publisherStake` is wired) and lock a
   per-publisher challenge bond if `challengeBonds` is wired.

## What "validation" means per add

`_validateAndSeat(campaignId, publisher, takeRate)`:

- `publishers.isRegistered(publisher)` else revert E21.
- Not blocked (curator + local) else revert E62.
- Tag match: if `tagSystem != address(0)`, the publisher must
  satisfy `hasAllTags(publisher, requiredTags)` for the campaign's
  required tags. Revert E71 otherwise.
- Per-publisher take-rate within [campaign.minTakeRate,
  campaign.maxTakeRate].
- Not already on the allowlist (`E22 AlreadyAllowed`).
- Capacity: `campaignAllowedPublisherCount[id] < maxAllowedPublishers`.
- Optional challenge-bond deposit per added publisher.

## State

- `allowed[campaignId][publisher] → bool` — membership flag.
- `campaignAllowedPublisherCount[campaignId] → uint16` — current
  count for the cap check.
- `takeRateSnapshot[campaignId][publisher] → uint16` — frozen at
  add time. ClaimValidator reads this for the publisher's
  effective take rate on this campaign, NOT the publisher's live
  take-rate setting. Anti-staleness on per-publisher economics.

## Constants

- **`MAX_ALLOWED_PUBLISHERS_CEILING = 256`** — hard ceiling on the
  tunable `maxAllowedPublishers`.
- **`MAX_ADD_PUBLISHERS_BATCH = 32`** — outer cap on the batch entry
  point to keep gas predictable.
- **`maxAllowedPublishers` (uint16, default 64)** — owner-tunable
  policy floor.

## Governance surface

- **`setMaxAllowedPublishers(value)`** — owner-only, `whenNotFrozen`,
  bounded by `MAX_ALLOWED_PUBLISHERS_CEILING`.
- **`setCampaigns(addr)`** / **`setPublishers(addr)`** /
  **`setChallengeBonds(addr)`** / **`setTagSystem(addr)`** — owner
  only, locked by `lockPlumbing`. The last three accept `address(0)`
  to disable their respective branches.
- **`lockPlumbing()`** — owner-only, `whenOpenGovPhase`.

## Removal flow

`removeAllowedPublisher(campaignId, publisher)`:

- Advertiser-only.
- Reverts E01 if not allowed.
- Decrements count, clears `allowed` and `takeRateSnapshot`.
- Refunds the per-publisher challenge bond if `challengeBonds` is wired.

After removal, claims from that publisher targeting this campaign
fail at ClaimValidator (allowlist miss = reject reason 21). The
publisher's prior earnings are unaffected.

## Trust assumptions

- DatumCampaigns is the seed authority for the initial publisher
  (the campaign creator named them on createCampaign).
- The advertiser EOA is the membership authority post-creation.
- Take-rate snapshots are frozen at add time; the publisher's later
  `Publishers.updateTakeRate` does NOT propagate to existing
  allowlist entries on existing campaigns. The advertiser opted in
  to the snapshotted rate.
- A captured DatumCampaigns upgrade could call `initializeFor`
  arbitrarily but is bounded by the existing creation path's checks
  (campaign must already exist with a Pending status — the
  `onlyCampaigns` guard doesn't bypass the seed semantics).

## Upgrade

Upgradable via DatumGovernanceRouter. State preservation in a
`_migrate` would copy the three mappings + the count map. The
challenge-bond integration is a per-deploy decision (zero address
allowed for testnet).
