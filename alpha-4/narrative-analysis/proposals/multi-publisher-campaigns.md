# Proposal: Multi-Publisher Campaigns

**Status:** Design proposal, unimplemented.
**Author:** 2026-05-14 analysis.
**Motivation:** Let advertisers pre-vet a set of N publishers and run a
single campaign across all of them, without N separate campaign creations.

## Current state

`DatumCampaigns.Campaign.publisher` is a single address with two modes:

- **Closed campaign** (`publisher != 0`): only this designated publisher
  may serve the campaign. Take rate is snapshotted at campaign creation.
- **Open campaign** (`publisher == 0`): any registered publisher whose
  tag set covers `requiredTags` may serve, and the take rate snapshot
  falls back to `defaultTakeRateBps`.

Neither mode supports "I want exactly Publishers A, B, and C — no
others." Today, an advertiser running a brand campaign across three
partner publishers must create three near-identical campaigns. Three
budgets to fund, three sets of policy to keep in sync, three sets of
bonds and analytics to track. The operational overhead is high enough
that real cross-publisher brand campaigns on this protocol won't happen.

## Proposed addition

Add a third mode: **multi-publisher allowlist**. The advertiser
explicitly lists which publishers may serve.

### Tri-state semantics

| `publisher` field | `campaignPublisherCount[id]` | Mode |
|---|---|---|
| `!= 0` | n/a | Closed (current) |
| `== 0` | `0` | Open with tag match (current) |
| `== 0` | `> 0` | **Multi-publisher (new)** |

The `publisher` field stays for backward compatibility and as the
single-address anchor that subsystems like `DatumChallengeBonds`
already rely on.

### New storage in DatumCampaigns

```solidity
// Multi-publisher allowlist + count.
mapping(uint256 => mapping(address => bool)) public campaignPublisherAllowlist;
mapping(uint256 => uint16) public campaignPublisherCount;

// Per-publisher take-rate snapshot at allowlist-add time.
//   Prevents post-add publisher rate raises from changing the deal.
mapping(uint256 => mapping(address => uint16)) public campaignPublisherTakeRate;
```

### New entry points

```solidity
function addAllowedPublisher(uint256 campaignId, address publisher) external;
function removeAllowedPublisher(uint256 campaignId, address publisher) external;
```

Both are advertiser-only (`require(msg.sender == c.advertiser, "E21")`).

`addAllowedPublisher`:
- Reverts if campaign is in a single-publisher (`c.publisher != 0`) mode.
- Reverts if publisher not registered in `DatumPublishers`.
- Snapshots `publishers.getPublisher(publisher).takeRateBps` into
  `campaignPublisherTakeRate`.
- Increments `campaignPublisherCount`.

`removeAllowedPublisher`:
- Removes from the allowlist; decrements count.
- Hard cutoff: any subsequent claim from this publisher fails Check 3.

### ClaimValidator Check 3 update

```solidity
if (cPublisher != address(0)) {
    // Closed campaign (existing path).
    if (claim.publisher != cPublisher) return (false, 5, ...);
    // ... existing allowlist snapshot checks
} else if (campaignPublisherCount[id] > 0) {
    // Multi-publisher (new path).
    if (!campaignPublisherAllowlist[id][claim.publisher]) return (false, 5, ...);
    // Take rate: read snapshot for this specific publisher.
    cTakeRate = campaignPublisherTakeRate[id][claim.publisher];
} else {
    // Open campaign (existing path).
    if (claim.publisher == address(0)) return (false, 5, ...);
    if (publishers.allowlistEnabled(claim.publisher)) return (false, 15, ...);
    // ... existing default-take-rate fallback
}
```

The branch order is critical — `cPublisher != 0` takes precedence so
existing closed campaigns are completely unaffected.

## Design decisions

### D-1. Take-rate handling: snapshot at allowlist-add time

Three options were considered:

- **Snapshot at allowlist-add time (chosen).** Each publisher's
  `takeRateBps` is frozen the moment the advertiser adds them. Add-time
  vetting → no surprises mid-campaign.
- **Live at settle time.** Read current rate per claim. Cheaper storage,
  but a publisher can raise their rate within the take-rate update delay
  window (~100 blocks) without the advertiser's notice.
- **Single rate for the whole set.** Advertiser specifies one rate at
  creation; all publishers get that share. Simplest, but constrains
  advertiser-publisher pricing negotiations and forces the advertiser to
  pick a one-size-fits-all rate.

Add-time snapshot is the most defensive and aligns with the existing
behavior in single-publisher campaigns (which also snapshot at creation).

### D-2. Mid-campaign mutations: add anytime, remove with hard cutoff

- **Adding while Active.** Allowed. Adding capacity doesn't strand
  anyone; existing publishers keep operating, new one starts.
- **Removing while Active.** Allowed, with hard cutoff: from the next
  block, the removed publisher's claims fail Check 3 (reason 5,
  publisher mismatch).

The soft-cutoff alternative — letting in-flight claims (already mid-nonce-sequence)
continue to settle — was rejected because it requires a "removed-at-block"
mapping and complicates the validation branch. The hard cutoff is
consistent with the protocol's principle that *advertisers* bear the
friction of their own policy changes, not users.

If the advertiser wants to gracefully wind down a publisher, they
coordinate off-chain with the publisher to drain their claim queue
before calling `removeAllowedPublisher`.

### D-3. Challenge bonds: forbidden on multi-publisher (v1)

`DatumChallengeBonds` is per-`(campaignId, publisher)`. Three options:

- **Forbid bonds on multi-publisher campaigns (chosen).** Simplest.
  Advertisers running multi-publisher campaigns opt out of the bond
  mechanism. They can still pursue fraud via `DatumPublisherGovernance`
  conviction-vote path.
- **Per-publisher bonds.** Advertiser locks a separate bond per
  publisher. ChallengeBonds storage becomes per-`(campaignId, publisher)`.
  Tractable but requires ChallengeBonds rework.
- **Campaign-level bond, distributed.** One bond; on fraud upheld
  against any publisher in the set, that publisher's bonus pool gets a
  pro-rata share. Cleaner economically but conflates publishers' fraud
  risk — a publisher who's clean is exposed to the bond getting tied up
  in another publisher's fraud proposal.

Forbidding bonds in v1 is the smallest-blast-radius decision. Per-publisher
bonds can be layered in v2 if there's demand.

Enforcement: `createCampaign` reverts if `bondAmount > 0` is supplied
together with multi-publisher intent. Since multi-publisher campaigns
are added via `addAllowedPublisher` after creation, a cleaner check is:

```solidity
function addAllowedPublisher(uint256 campaignId, address publisher) external {
    require(challengeBonds.bondAmount(campaignId) == 0, "no-bond-multi");
    // ... rest
}
```

### D-4. No mixing with open campaign

Open campaign (tag-matched) and multi-publisher allowlist are mutually
exclusive. A campaign is either:
- Closed to one specific publisher, OR
- Open to any tag-matched publisher, OR
- Multi-publisher with an explicit allowlist.

Combining tag-match + allowlist would be overkill — the allowlist
already means "advertiser pre-vetted these N." If you want
tag-targeted discovery, use open mode.

### D-5. Per-publisher policy: deferred to v2

Currently AssuranceLevel, `campaignMinStake`, `campaignRequiredCategory`,
and `userEventCapPerWindow` are all per-campaign. With multi-publisher,
an advertiser might want different L1 vs L2 stances per publisher
("trust Publisher A at L1; demand L2 from Publisher B").

Recommend: keep per-campaign in v1. Per-publisher policy doubles the
complexity (storage, validation branches, governance signaling) for a
narrower use case. Land multi-publisher first; revisit per-publisher
policy if real demand emerges.

## Subsystems affected

### Unchanged
- `DatumSettlement` — already keys per `claim.publisher`. The
  publisher's reputation, stake adequacy, rate limit, and per-batch
  aggregate work transparently. No changes needed.
- `DatumPublisherStake` — bonding curve is per-publisher; serving N
  campaigns instead of 1 raises their cumulative impressions and
  therefore their requiredStake. Working as designed.
- `DatumPublisherGovernance` — fraud proposals target one publisher;
  in a multi-publisher campaign, a fraud proposal against Publisher X
  doesn't affect Publishers Y and Z in the same set.
- `DatumPublishers` — registry is per-publisher; unaffected.
- `DatumBudgetLedger` — budget is per-`(campaignId, actionType)`,
  not per-publisher. Multi-publisher campaigns share a single budget
  pool. Whichever publisher's claims settle first wins the funds —
  same dynamics as open campaigns today.

### Modified
- `DatumCampaigns` — new storage, two new setters, one constructor /
  createCampaign check.
- `DatumClaimValidator` — Check 3 branch addition. `validateClaim`
  returns the per-publisher snapshotted take rate when in multi-publisher
  mode.
- `IDatumCampaigns` — new view methods exposed.

### Forbidden until v2
- `DatumChallengeBonds` interaction — `addAllowedPublisher` reverts
  if a bond exists.

## Implementation cost

- **Contract LOC:** ~100 in `DatumCampaigns`, ~30 in
  `DatumClaimValidator`, ~10 in `IDatumCampaigns`. No changes to
  `DatumSettlement`.
- **Test surface:** ~15 tests covering:
  - Cannot add publisher to closed campaign (E21 / E22).
  - Add publisher works in Pending and Active.
  - Take rate is snapshotted at add time.
  - Publisher's later rate raise doesn't affect campaign's snapshot.
  - Claim from allowlisted publisher passes Check 3.
  - Claim from non-allowlisted publisher fails reason 5.
  - Remove publisher → next-block claims fail.
  - Cannot create multi-publisher campaign with a bond.
  - Bond rejection at `addAllowedPublisher` if `createCampaign` allowed
    a bond (defense-in-depth).
  - Settlement aggregates per-publisher correctly in multi-publisher
    batches.
  - Per-publisher reputation tracks correctly in multi-publisher campaigns.
  - Stake adequacy enforced per-publisher (not per-campaign).
  - Tag-match path remains unaffected (open campaign regression).
  - Closed campaign path remains unaffected (closed campaign regression).
  - Settlement.settleSignedClaims with multi-publisher campaign +
    dual-sig works (advertiser signs once per batch; each batch is
    per-(user, campaign) so multi-publisher doesn't affect signing).

- **Bytecode budget:** `DatumCampaigns` is currently at ~37KB. New
  storage + setters + getters add roughly 1KB. Comfortably fits.
- **Audit surface:** small. The novel logic is contained in one
  `DatumClaimValidator` branch and two `DatumCampaigns` setters.
  Main concern is the tri-state branch ordering — once written, it
  needs an audit-pass focus on "all three modes are mutually exclusive
  and the branch order in Check 3 matches creation-time invariants."

## Backward compatibility

Existing campaigns are unaffected:
- Closed campaigns (current `publisher != 0`) use the existing
  Check 3 first branch.
- Open campaigns (current `publisher == 0` + tag match) use the
  existing third branch.
- The new branch is only entered when `campaignPublisherCount > 0`,
  which is zero for all existing campaigns.

No migration needed. The new ABIs (added setters and views) extend
the existing interface; old SDKs see the existing methods only.

## Operational impact

Advertisers running multi-publisher campaigns get:
- One budget to fund and monitor.
- One set of policy (AssuranceLevel, minStake, requiredCategory).
- One set of analytics queries.
- One governance termination decision if the campaign goes wrong.

Publishers get:
- Same per-publisher stake-curve dynamics.
- Reputation tracked per-(campaign, publisher) — multi-publisher
  campaigns produce more granular reputation data, not less.
- Possible upside: more campaigns to participate in (advertisers
  more willing to spin up campaigns).

Relays get:
- No protocol-level changes. Same EIP-712 envelopes, same submission
  paths, same per-batch (user, campaign) keying.

## Open questions worth flagging

- **Per-publisher policy in v2.** When demand actually emerges, do we
  layer per-publisher AssuranceLevel + minStake into the existing
  storage, or split into a `MultiPublisherCampaign` extension contract?
- **Per-publisher bonds in v2.** Same question for ChallengeBonds.
- **Take-rate update propagation.** When a publisher updates their
  take rate via `DatumPublishers.updateTakeRate`, do we offer
  advertisers a way to "refresh" the campaign's snapshot? Probably
  via an opt-in `refreshTakeRate(campaignId, publisher)` that only the
  advertiser can call.
- **Discovery UX.** Off-chain SDK / UI needs a way for publishers to
  enumerate "which multi-publisher campaigns am I allowlisted on?"
  This is an indexer concern, not a contract concern — events
  (`PublisherAllowed`, `PublisherRemoved`) drive the off-chain index.

## Next steps if approved

1. Decide on D-1 through D-5 (recommended answers in this doc).
2. Write the contract changes in DatumCampaigns + ClaimValidator +
   IDatumCampaigns.
3. Add 15 regression tests covering both new behavior and
   single/open campaign non-regression.
4. Run full test suite (must remain 753+ passing).
5. Update narrative-analysis docs:
   - `DatumCampaigns.md` — mention tri-state semantics.
   - `DatumClaimValidator.md` — note Check 3 branch addition.
   - `process-flows/advertiser.md` — add the multi-publisher flow.
6. Update SDK + extension for the new mode.
