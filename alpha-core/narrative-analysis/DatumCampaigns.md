# DatumCampaigns

The campaign object. Every advertiser who wants to pay for impressions, clicks,
or actions starts here. This contract holds campaign state — who created it,
who the designated publisher is (if any), how much budget remains per action
type, what AssuranceLevel the advertiser demands, what minimum DATUM stake
users must prove to claim, what reward token (if any) supplements the DOT
payout. Settlement, ClaimValidator, and Lifecycle all read campaign state
from here.

Campaign **satellites** carved out for EIP-170 each own a slice of the
per-campaign policy:

- [`DatumCampaignAllowlist.md`](./DatumCampaignAllowlist.md) —
  per-campaign publisher allowlist + take-rate snapshots
- [`DatumCampaignCreative.md`](./DatumCampaignCreative.md) — IPFS +
  Bulletin Chain creative reference, renewer trust gradient
- [`DatumTagSystem.md`](./DatumTagSystem.md) — tag dictionary,
  per-publisher tag sets, per-campaign required tags, the
  three-lane tag-policy selector
- [`DatumReports.md`](./DatumReports.md) — community page / ad
  reports

The carve-outs are independently upgradable via DatumGovernanceRouter.
Campaigns retains the structural anchors (campaign struct, pots,
status, the policy knobs that influence settlement directly) and a
write-callback surface (`initializeFor`, `initializeCampaignTags`)
that seeds the satellites at creation.

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
- **Required tags + tag-policy lane.** A campaign asserts a set of
  taxonomy tags (`requiredTags`) that the serving publisher's tags must
  cover. As of 2026-05-14, tag *policy* is no longer single-track:
  each campaign picks a `campaignTagMode` (0 = Any, 1 = StakeGated,
  2 = Curated, default 0). The chosen mode determines what the
  `requiredTags` are validated against — see `DatumTagRegistry.md` and
  `DatumTagCurator.md` for the StakeGated and Curated lanes. Tightening
  the mode (Any → StakeGated/Curated) is done via
  `setCampaignTagMode(campaignId, mode)` pre-activation; the call
  re-validates every existing requiredTag under the new lane.
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
- `setCampaignTagMode(id, mode)` — advertiser-only; Pending-only; tightening only (Any → StakeGated/Curated). Re-validates every `requiredTags[i]` under the new lane.
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
- **Three-lane tag policy** with `lockLanes()` pinning the menu permanently.
  `lockLanes()` replaced the older `lockPolicy()` with a deliberately
  narrower scope: it locks lane *availability* (Any / StakeGated /
  Curated all stay selectable forever) but does **not** lock lane
  *parameters*. `maxCampaignBudget`, `defaultTakeRateBps`,
  `bulletinRenewerReward`, `maxAllowedMinStake`, and all
  `DatumTagRegistry` gov knobs remain governance-tunable indefinitely.
  This is the cypherpunk move: freeze the menu, free the dials.
  Sibling locks: `lockTagCurator()` (curator pointer) and the lock that
  `lockLanes()` applies to `tagRegistry` and the curated `approveTag`
  mutations.
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

## Fail-closed safe getters

Settlement's hot path reads campaign state via non-reverting safe
variants (audit-hedge #4): `getCampaignAdvertiserSafe`,
`getCampaignAssuranceLevelSafe`, `getCampaignMinIdentityLevelSafe`,
`getCampaignRequiresZkProofSafe`, `getCampaignUserCapSafe`,
`getCampaignRewardTokenSafe`, `getCampaignRewardPerImpressionSafe`.
Each returns `(bool ok, value)` instead of reverting on unknown
campaigns. A captured Campaigns upgrade can't selectively revert a
specific getter to silently downgrade L2 → L0 for targeted users —
revert behavior is no longer an in-band signal.

The non-safe variants remain for off-chain consumers and for paths
where a revert IS the desired signal.

## Carve-out history

Alpha-3's `DatumCampaignValidator` + `DatumTargetingRegistry` +
`DatumReports` merged into Campaigns during the alpha-4 satellite
consolidation. Mainnet EIP-170 then forced four carve-outs back out:
allowlist, creative, reports, tag system. The current shape:

```
              ┌──────────────────────┐
              │   DatumCampaigns      │  ← struct + pots + status
              └────────┬─────────────┘
                       │ initializeFor / initializeCampaignTags
                       │ on createCampaign
       ┌───────────────┼───────────────────────────┐
       ▼               ▼                ▼          ▼
   Allowlist      Creative         TagSystem    Reports
```

Each satellite is independently upgradable. The carve-outs trade
per-claim gas (cross-contract reads in the hot path) for contract
size — needed to fit under EIP-170 on mainnet. The pre-mainnet
remerge plan (`PRE-ALPHA-5-BACKLOG §1.7`) tracks which carve-outs
should be re-merged for gas recovery once audit confidence + lock
fires are complete.

## Lock-once references

The remaining external dependencies (Lifecycle, BudgetLedger,
ChallengeBonds, TagCurator, AdvertiserStake, Settlement, plus the
satellite pointers) are swappable lock-once references. Setters
revert `LockedAlready` after the corresponding `lock*()` fires
post-OpenGov.
