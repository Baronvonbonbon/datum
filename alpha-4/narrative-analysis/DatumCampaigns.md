# DatumCampaigns

The campaign object. Every advertiser who wants to pay for impressions, clicks,
or actions starts here. This contract holds campaign state — who created it,
who the designated publisher is (if any), how much budget remains per action
type, what targeting tags are required, what AssuranceLevel the advertiser
demands, what minimum DATUM stake users must prove to claim, what reward
token (if any) supplements the DOT payout. Settlement, ClaimValidator, and
Lifecycle all read campaign state from here.

## The mental model

A campaign is a budget bucket plus a policy bundle. The bucket is partitioned
into up to three **action pots**: view (`actionType=0`), click (`1`), and
remote-action (`2`). Each pot has its own budget, daily cap, and rate.
Settlement charges the right pot based on the claim's `actionType`.

The policy bundle covers:

- **Publisher targeting.** Tri-state:
  - **Open** — `campaignAllowedPublisherCount == 0`. Any registered
    publisher whose tags cover `requiredTags` may serve.
  - **Allowlist (single)** — `count == 1`. The single-publisher
    legacy case; `createCampaign(publisher=A)` populates the allowlist
    with A. Backward-compatible with all existing closed-campaign flows.
  - **Allowlist (multi)** — `count > 1`. Advertiser explicitly enumerates
    N publishers via `addAllowedPublisher`. Each publisher's take rate
    is snapshotted at the moment they're added, so a later rate change
    by the publisher doesn't affect this campaign.
- **Advertiser allowlist.** When `allowlistEnabled`, only advertisers in
  `_allowedAdvertisers[publisher]` may run on a publisher's inventory.
- **AssuranceLevel** (0=Permissive, 1=PublisherSigned, 2=DualSigned). Locks
  raises at `Pending`; lowering is always allowed.
- **Required tags.** A campaign asserts a bitset of taxonomy tags
  (`requiredTags`) that the serving publisher's tags must cover. Tag approval
  flows through `DatumTagCurator` if wired.
- **ZK gate knobs (Path A).** `campaignMinStake` (DATUM threshold the user
  must prove via ZK) and `campaignRequiredCategory` (interest category the
  user must prove they've committed to). Both feed `DatumZKVerifier.verifyA`
  as public inputs 4 and 6. Governance caps the maximum allowed minStake via
  `maxAllowedMinStake`.
- **User-cap window.** Optional per-user-per-window event cap (`#1` setter)
  so advertisers can prevent farming by a single wallet.
- **Sybil history floor.** `minUserSettledHistory` requires the user to have
  N settled events across the protocol before claiming.

## Lifecycle states

`Pending → Active → (Completed | Terminated | Expired)`. Pending is the only
state in which most settings can be raised (lowering is always allowed at any
state). Activation flows through the governance contract — typically the
`DatumGovernanceRouter`, which in the bootstrap phase is the AdminGovernance,
later a Council, finally OpenGov.

## Key entry points

- `createCampaign(publisher, pots, requiredTags, allowlistEnabled, rewardToken, rewardPerImpression, bondAmount)` — payable; locks `msg.value > bondAmount` into the budget ledger across the supplied pots and stages a campaign as `Pending`. If `publisher != 0`, populates the multi-publisher allowlist with that one publisher. If `advertiserStake` is wired (CB4), caller must be adequately staked.
- `addAllowedPublisher(campaignId, publisher) payable` — adds a publisher to the campaign's allowlist; `msg.value > 0` optionally locks a per-`(campaign, publisher)` bond. Allowed in Pending and Active.
- `removeAllowedPublisher(campaignId, publisher)` — hard cutoff: from the next block, claims from this publisher fail Check 3.
- `setCampaignAssuranceLevel(id, level)` — advertiser-only; lock-raise at Pending.
- `setCampaignMinStake(id, amount)` — advertiser-only; clamped by `maxAllowedMinStake`; lock-raise at Pending.
- `setCampaignRequiredCategory(id, category)` — advertiser-only; Pending only.
- `setAdvertiserRelaySigner(signer)` — advertiser hot-key delegation for dual-sig settlement.
- `activateCampaign(id)` — governance-only; transitions Pending → Active.
- Snapshot getters (`getCampaignForSettlement`, `getCampaignAdvertiser`, `getCampaignPot`, etc.) — read paths for Settlement and ClaimValidator.

## Security model

- Budget value (`msg.value - bondAmount`) is held in `DatumBudgetLedger`,
  not this contract.
- The challenge bond (`bondAmount`) goes into `DatumChallengeBonds` if wired.
- Lock-once on the AdvertiserStake reference: a hostile owner can't redirect
  the gate to a permissive contract.
- TagCurator and policy lock are lockable via `lockTagCurator` and
  `lockPolicy`.
- The `userEventCapPerWindow` and `minUserSettledHistory` setters can lower
  but not raise once Active — same principle as AssuranceLevel.
- Settlement's pause check is on **`pausedSettlement`** (the Settlement
  category), but `createCampaign` and `setPublisherTags` gate on
  **`pausedCampaignCreation`**. `activateCampaign` gates on
  **`pausedGovernance`**. The CB6 category split means an emergency in one
  domain doesn't freeze the others.

## Notable storage

- `_campaigns[id]` — the canonical Campaign struct (advertiser, publisher, status, etc.).
- `_pots[id][actionType]` — pot config.
- `campaignAssuranceLevel[id]`, `campaignMinStake[id]`, `campaignRequiredCategory[id]` — policy knobs.
- `campaignAllowlistSnapshot[id][advertiser]` — frozen at campaign creation so advertiser-allowlist toggles by the publisher after activation don't strand in-flight claims.
- `userEventCapPerWindow[id]`, `userCapWindowBlocks[id]` — per-user rate-limit knobs.
- `maxCampaignBudget`, `maxAllowedMinStake` — governance-set ceilings.

## Why it's the biggest contract

DatumCampaigns at 1365 LOC carries the bulk of advertiser-facing policy. It
absorbed the old `DatumCampaignValidator`, `DatumTargetingRegistry`, and
`DatumReports` satellites in the alpha-4 merge to reduce cross-contract
staticcall overhead. The remaining external dependencies (Lifecycle,
BudgetLedger, ChallengeBonds, TagCurator, AdvertiserStake) are still
swappable lock-once references.
