# DatumTagSystem

The carved-out tag plumbing. Owns the local tag dictionary, the
per-publisher tag sets (with post-removal grace), the per-campaign
required tags + publisher-tags snapshot, and the per-campaign tag
mode that selects which of the three lanes is enforced. Carved out
of DatumCampaigns for EIP-170.

See [`DatumTagRegistry.md`](./DatumTagRegistry.md) for the
WDATUM-staked Schelling-jury lane and
[`DatumTagCurator.md`](./DatumTagCurator.md) for the Council-curated
lane. This contract is the *integration point* between all three.

## The three lanes

`campaignTagMode[id] ∈ {Any (0), StakeGated (1), Curated (2)}`.
Set at campaign creation; not mutable after.

- **Any (0).** Tags are advisory metadata. ClaimValidator does not
  enforce tag match — any publisher may serve.
- **StakeGated (1).** Tags must exist in `DatumTagRegistry` (the
  WDATUM-staked namespace). The registry is the source of truth;
  this contract's local `approvedTags` is irrelevant. Tags can be
  challenged via Schelling-jury arbitration in the registry.
- **Curated (2).** Tags must be in the local `approvedTags`
  mapping. The mapping is owner-mutable until `tagCuratorLocked`
  fires (post-OpenGov), then frozen to whatever the curator set.
  Alternatively if `tagCurator != address(0)`, the curator
  contract's view is OR'd with the local mapping for the approval
  check.

When `enforceTagRegistry == false` (the kill-switch), Curated mode
is permissive — every tag passes regardless of the local mapping.
This is the "tag system disabled in alpha posture" state.

## Per-publisher tag sets

Publishers register tags via `setPublisherTags(bytes32[])`. The
contract:

- Validates count ≤ `maxPublisherTags` (default 64, ceiling 256).
- Validates each tag is either currently held by the publisher
  (idempotent re-set) OR in the active lane's approved set.
- For tags being REMOVED: schedules removal effective at
  `block.number + TAG_REMOVAL_GRACE_BLOCKS` (~24h) so in-flight
  claims aren't suddenly invalidated.
- For tags being ADDED: immediately effective.

`hasAllTags(publisher, tags[])` and `hasAllRequiredTags(publisher,
campaignId)` are the per-claim views consumed by
DatumClaimValidator and DatumCampaignAllowlist.

## Post-removal grace

`tagRemovalEffectiveBlock[publisher][tag]` records when a scheduled
removal takes effect. The grace window prevents a publisher's
in-flight claims from suddenly failing the tag gate when the
publisher mid-flight drops a tag. From the protocol's point of view,
the tag is still held until that block.

## Per-campaign required tags

`initializeCampaignTags(campaignId, publisher, requiredTags[])` —
gated to `onlyCampaigns`. Called once per campaign at creation.
Snapshots:

- `_campaignTags[campaignId]` — the campaign's required tags.
- `_campaignPublisherTags[campaignId]` — the named publisher's tag
  set at creation time (so the validator can confirm "the named
  publisher could serve at creation").

The snapshot is immutable per campaign. Subsequent
`setPublisherTags` calls don't propagate to existing campaigns.

## Caps + ceilings

| Knob | Default | Ceiling |
|---|---|---|
| `maxPublisherTags` | 64 | 256 (constant) |
| `maxCampaignTags` | 16 | 64 (constant) |
| Grace window | 14,400 blocks (~24h) | — |

The ceilings are constants — changing them requires a contract upgrade.

## Governance surface

- **`approveTag(tag)` / `removeApprovedTag(tag)` / `approveTags(tags[])`** —
  owner-only, `whenNotFrozen`. Reverts `CuratorLocked` if
  `tagCuratorLocked == true`. Local Curated-lane dictionary.
- **`setEnforceTagRegistry(bool)`** — owner-only, `whenNotFrozen`.
  Master kill-switch.
- **`setTagRegistry(addr)`** — owner-only, locked by `lanesLocked`.
  StakeGated lane.
- **`setTagCurator(addr)`** — owner-only, locked by
  `tagCuratorLocked`. Curated lane delegation.
- **`lockTagCurator()`** — owner-only, `whenOpenGovPhase`.
- **`lockLanes()`** — owner-only, `whenOpenGovPhase`. Freezes both
  `tagRegistry` and `tagCurator` pointers.
- **`setMaxPublisherTags(value)` / `setMaxCampaignTags(value)`** —
  owner-only, `whenNotFrozen`. Bounded by ceiling constants.
- **`setCampaigns(addr)` / `setPublishers(addr)` / `setPauseRegistry(addr)`** —
  owner-only, locked by `lockPlumbing`.
- **`lockPlumbing()`** — owner-only, `whenOpenGovPhase`.

## Trust assumptions

- DatumCampaigns is the authority for `initializeCampaignTags`
  (campaign creation).
- The publisher is the authority for their own tag set.
- The active lane (Any / StakeGated / Curated) is fixed per campaign,
  so an advertiser can't be surprised by a mid-flight policy switch.
- A captured governance setting `enforceTagRegistry = false` makes
  Curated mode permissive but doesn't affect StakeGated mode
  (`DatumTagRegistry` is the source of truth there, not local state).

## Upgrade

Upgradable via DatumGovernanceRouter. `_migrate` copies the four
state clusters: local dictionary (`approvedTags` +
`_approvedTagList` + index), per-publisher tag sets (with grace
mappings), per-campaign snapshots, per-campaign modes. Owning all
the tag state in one module makes this migration self-contained.
