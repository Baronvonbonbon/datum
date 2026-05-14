# Advertiser

The party funding campaigns. Locks DOT (and optionally an ERC-20
reward token) into a campaign budget; sets policy (AssuranceLevel,
tags, ZK gate, minStake, etc.); optionally posts a challenge bond;
optionally cosigns batches in the dual-sig path.

## On-chain footprint

An advertiser is just an EOA that calls `DatumCampaigns.createCampaign`.
No registration step like publishers — though if `advertiserStake` is
wired, an adequacy gate applies. The advertiser becomes identifiable
through their campaign ownership, their bonded campaigns in
`DatumChallengeBonds`, and (if wired) their staked DOT in
`DatumAdvertiserStake`.

## End-to-end flow

### Onboarding (optional but recommended for production)

1. **Acquire DOT** — campaign budget + advertiser stake (if wired) +
   challenge bond + gas.
2. **(Optional) Stake DOT in `DatumAdvertiserStake.stake()`** — required
   if `Campaigns.advertiserStake` is wired and you want to create campaigns.
   - `requiredStake = base + cumulativeBudgetSpent × perDOT`,
     capped at `maxRequiredStake`.
3. **(Optional) Set advertiser relay signer** via
   `DatumCampaigns.setAdvertiserRelaySigner(addr)`. Required only if
   running L2 (DualSigned) campaigns and you want a hot key cosigning
   batches rather than your cold key.
4. **(Optional) Get added to publisher allowlists.** If targeting
   allowlist-enabled publishers, those publishers must explicitly add
   you (off-chain coordination → publisher calls their allowlist
   setter).

### Campaign creation

`DatumCampaigns.createCampaign(publisher, pots, requiredTags,
allowlistEnabled, rewardToken, rewardPerImpression, bondAmount) payable`:

- `publisher`: a specific publisher EOA (closed campaign — populates
  the allowlist with that one publisher), or `address(0)` (open
  campaign, tag-matched). For multi-publisher campaigns, start with
  either initial publisher or `address(0)` and use
  `addAllowedPublisher` afterward.
- `pots`: array of `(actionType, budgetPlanck, dailyCapPlanck,
  ratePlanck, actionVerifier)`. One pot per action type the
  advertiser wants to fund (view / click / remote-action).
- `requiredTags`: taxonomy bitset that the serving publisher's tags
  must cover.
- `allowlistEnabled`: snapshot of `publishers.isAllowedAdvertiser(publisher,
  self)` for closed campaigns.
- `rewardToken` + `rewardPerImpression`: optional ERC-20 reward leg
  (view claims only).
- `bondAmount`: optional challenge bond, locked in
  `DatumChallengeBonds`.

`msg.value` must equal `bondAmount + sum(pots[].budgetPlanck)`.
Budget value flows into `DatumBudgetLedger.initBudget` for each pot;
bond flows into `DatumChallengeBonds.lockBond`. The campaign is created
in **Pending** state.

Constraints checked at creation:

- `msg.value > bondAmount`.
- `budgetValue >= MINIMUM_BUDGET_PLANCK` (10⁹ planck = 0.1 DOT).
- `budgetValue <= maxCampaignBudget` (governance-set ceiling).
- AdvertiserStake adequacy if wired (fail-CLOSED on revert).
- `requiredTags` are all approved (local map ∪ TagCurator).
- For closed campaigns, the publisher must be `isAllowedAdvertiser` if
  the publisher has allowlistEnabled.

### Multi-publisher campaign setup (optional)

For campaigns running across multiple pre-vetted publishers:

- **`addAllowedPublisher(campaignId, publisher) payable`** — adds a
  publisher to the campaign's serving allowlist. The publisher's
  current `takeRateBps` is snapshotted at this moment, so a later rate
  change by the publisher doesn't affect this campaign. Allowed in
  both Pending and Active.
  - If `msg.value > 0` is passed, that DOT is locked as a
    per-`(campaign, publisher)` bond. Each publisher in the set can
    have an independent bond.
- **`removeAllowedPublisher(campaignId, publisher)`** — hard cutoff.
  From the next block, claims from this publisher fail Check 3
  (reason 5). The publisher's already-submitted-but-not-yet-settled
  claims fail; the in-flight bond remains claimable at end-of-campaign.
- **`isAllowedPublisher(id, pub)`** + **`getCampaignPublisherTakeRate(id, pub)`** —
  read-side views.
- **`campaignAllowedPublisherCount(id)`** + **`campaignMode(id)`** —
  query the campaign's current mode (0 = OPEN, 1 = ALLOWLIST). The
  legacy single-publisher case is just allowlist with count=1.
- **`MAX_ALLOWED_PUBLISHERS = 32`** caps the set size; aligned with
  ChallengeBonds' iteration bound.

### Policy configuration (Pending state)

The advertiser can raise/lower these BEFORE activation (raising locks
once Active):

- `setCampaignAssuranceLevel(id, 0..2)` — `0` Permissive, `1`
  PublisherSigned, `2` DualSigned.
- `setCampaignMinStake(id, amount)` — DATUM minimum, clamped by
  `maxAllowedMinStake`.
- `setCampaignRequiredCategory(id, bytes32)` — required interest
  category for ZK gate.
- `setCampaignUserCapPerWindow(id, max, windowBlocks)` — per-user-per-window
  event cap.
- `setMinUserSettledHistory(id, count)` — sybil-history floor.

### Activation

`DatumCampaigns.activateCampaign(id)` — gated to the
`governanceContract`, which in production is `DatumGovernanceRouter` →
current phase governor (Admin/Council/OpenGov).

The advertiser must wait for governance to approve. Phase 0 is
immediate (admin governance); Phase 1 needs council quorum; Phase 2
needs conviction vote.

### Steady state

The advertiser is mostly passive after activation:

- **DualSigned campaigns (L2):** their hot key cosigns each batch
  envelope. The relay or publisher submits the dual-signed batch via
  `DatumSettlement.settleSignedClaims`. The advertiser monitors batches
  and refuses to cosign suspicious ones.
- **Open campaigns:** monitor analytics off-chain; if a publisher
  abuses the campaign, file a fraud claim via
  `DatumPublisherGovernance.proposeAdvertiserClaim` (council arbiter
  path) or `propose` (conviction-vote path).

Per-campaign monitoring data:
- `Campaigns.getCampaignForSettlement(id)` — status, publisher, rate.
- `BudgetLedger._budgets[id][actionType]` — remaining + daily-cap state.
- `Settlement.userCampaignSettled(user, id, actionType)` — settled
  events.
- `Settlement.getCampaignRepStats(publisher, id)` — per-publisher
  reputation for this campaign.

### Lifecycle exit

- **Completed:** budget exhausted naturally. Bond returned via
  `DatumChallengeBonds.returnBond` → `pendingBondReturn[advertiser]`.
- **Terminated:** governance-driven (fraud upheld). Bond returned if
  no fraud upheld against the campaign's publisher; OR converted into
  pool share for bonded advertisers if upheld against this campaign's
  serving publisher.
- **Expired:** anyone can call `expireCampaign(id)` after
  `inactivityTimeoutBlocks` (30 days). Bond returned.

After any exit, advertiser pulls:
- `BudgetLedger.claimRefund()` — pull pending refund.
- `ChallengeBonds.claimBondReturn()` — pull pending bond return.
- `ChallengeBonds.claimBonus(id)` — if fraud upheld and they're bonded
  for this publisher, claim pro-rata pool share (burns the bond).

### Reward-token pot cleanup

If a token-reward leg was funded, the advertiser pulls leftover via
`DatumTokenRewardVault.withdrawCampaignTokens(id)` after campaign
end. Tokens never auto-refund.

## Economic exposure

- **Budget at risk:** the full `budgetValue` is at risk of legitimate
  spend. If the campaign is **terminated for fraud upheld against the
  advertiser**, `DatumCampaignLifecycle.terminateCampaign` slashes
  `slashBps` (typically 10%) to governance treasury, refunds the rest.
- **Challenge bond at risk:** the bond is forfeit to the publisher's
  bonus pool if the advertiser claims a bonus (i.e., upheld fraud); it's
  returned cleanly on normal end.
- **Advertiser stake at risk:** if `DatumAdvertiserGovernance` upholds
  a fraud proposal, `slashBps` of the advertiser's stake is slashed
  (capped at 50% per call via H-2). Multi-call slashes possible.

## Who polices the advertiser

- **Publishers:** can refuse to serve via per-publisher advertiser
  allowlist.
- **Users:** can self-block advertisers via
  `Settlement.setUserBlocksAdvertiser`.
- **Governance:** terminate campaigns, slash stake (via
  AdvertiserGovernance), uphold publisher claims about advertiser
  fraud (via PublisherGovernance's advertiser-claim arbiter path).
- **The blocklist curator:** could block the advertiser's address.
- **Settlement gates:** AssuranceLevel/userMinAssurance forces
  high-trust campaigns to dual-sig; the advertiser can't unilaterally
  freeze user earnings mid-flight (raises lock at Pending).
