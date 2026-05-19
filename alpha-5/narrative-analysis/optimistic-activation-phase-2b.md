# Optimistic Activation — Phase 2b Planning Notes

## Context

Phases 1 + 2a shipped (commits TBD on branch). Routine campaigns now flow
through an optimistic activation path with a creator bond and timelock;
contested campaigns escalate to a commit-reveal vote in DatumGovernanceV2.

What remains is **Phase 2b: emergency mute bond for Active campaigns** — a
collateralised pause mechanism that lets anyone instantly halt an Active
campaign during a demote vote, with the mute bond slashed on bad-faith mutes
and refunded with a bonus on upheld ones. This document captures the design
tension and the two viable implementations so a future session can resume
without re-deriving the trade-offs.

## Problem statement

Active demote votes intentionally **do not use commit-reveal** (open-tally
keeps the response fast — speed beats signal quality when a campaign is
actively misbehaving). But a vote still takes time, and during that time
the campaign keeps paying out. Mute mechanism: post a bond, instantly stop
settlement, and let the vote resolve.

Economics (decided):
- Mute upheld (campaign demoted/terminated) → muter refunded + bonus
- Mute rejected (campaign restored to Active) → muter bond slashed to
  advertiser as compensation for the freeze
- Bonus source: slash pool collected from losing voters in the demote vote
  (or a fraction of advertiser's challenge bond, TBD)

## Design tension

The mute needs three things to compose with the existing architecture:

1. **Stop settlement immediately** — claim validation must reject while muted.
2. **Trigger a resolution vote** — without inheriting stale state from any
   prior vote round on the same campaign.
3. **Be reversible** — restore the campaign to Active if the mute is rejected.

The existing GovernanceV2 vote state (`ayeWeighted`, `nayWeighted`,
`commitRevealWindow`, `_votes[cid][voter]`, `firstNayBlock`,
`lastSignificantVoteBlock`) is keyed by `campaignId` only. A campaign that
went `Pending → Active` via a contested commit-reveal vote already has
weights and per-voter state populated. If we mute that campaign and demote
it back to Pending, those weights are stale relative to the new vote round.

## Option 1: vote-round refactor + mute-as-demote

Add a per-campaign `round` counter. Re-key every vote state mapping by
`(campaignId, round)`:

```solidity
mapping(uint256 => uint256) public currentRound;
mapping(uint256 => mapping(uint256 => uint256)) public ayeWeightedRound;
mapping(uint256 => mapping(uint256 => uint256)) public nayWeightedRound;
mapping(uint256 => mapping(uint256 => CommitRevealWindow)) public commitRevealWindowRound;
// ... and so on for every per-campaign vote field
```

ActivationBonds.mute(cid):
- Calls `lifecycle.demoteCampaign(cid)` — Active → Pending
- Settlement naturally stops (validateClaim requires status == 1)
- Calls `v2.startNewRound(cid)` — increments `currentRound[cid]`, fresh vote state
- Marks campaign as mute-contested in ActivationBonds

When the new round resolves (campaign goes Active or Terminated), settleMute
pays out bonds based on outcome.

**Pros:** Clean architectural separation; mute reuses existing commit-reveal
machinery; settlement layer untouched.

**Cons:** ~200 LOC of GovernanceV2 churn. Every existing test that reads
vote state must be checked. ABIs change. Round-counter introduces a new
class of edge cases (vote-during-round-transition, round overflow, etc.).

## Option 2: standalone mute flag + validator check

Keep GovernanceV2 untouched. Add to DatumActivationBonds:

```solidity
mapping(uint256 => bool) public isMuted;
mapping(uint256 => address) public muterOf;
mapping(uint256 => uint128) public muteBondOf;
mapping(uint256 => uint64) public mutedAtBlock;
```

Modify `DatumClaimValidator.validateClaim`:

```solidity
if (activationBonds != address(0) && IDatumActivationBondsMinimal(activationBonds).isMuted(campaignId)) {
    return (false, /*reject-code*/, 0, bytes32(0));
}
```

Resolution: muter or anyone calls `settleMute(cid)` after a demote vote
concludes (or after a max-mute timeout to prevent indefinite grief). Reads
campaign status from DatumCampaigns; if status is Active → mute rejected;
if status is Terminated → mute upheld.

The demote vote itself uses the existing open-tally `vote()` flow on Active
status (already supported in GovernanceV2 today; commit-reveal does not
apply to status == 1).

**Pros:** GovernanceV2 untouched. Smaller blast radius. No round-counter
complications.

**Cons:** Hot settlement path takes a new staticcall to ActivationBonds.
ClaimValidator gains a new dependency. Mute timeout has to be carefully
tuned (too short → no time to vote; too long → griefing surface).

## Recommendation when resuming

Pick **Option 2**. The mute is conceptually a settlement-layer concern (it
suspends payment), not a governance-layer concern. Threading it through
GovernanceV2 mixes orthogonal responsibilities. The staticcall cost on the
settlement path is real but bounded (one extra view call); pallet-revive
specifically penalised this in alpha-3, but alpha-4 is EVM-only and the
cost is negligible.

If Option 2 is taken:
- Mute max duration: ~14400 blocks (1 day) before auto-resolution as
  "no demote happened" → muter bond slashed to advertiser.
- Mute bond floor: separately governable, default ≥ minBond × 10 (mute is
  more disruptive than challenge, so bar is higher).
- Tests: validator rejection path, settleMute outcomes (Active/Terminated/
  Expired/timeout), griefing scenarios.

## Files to touch (Option 2)

- `contracts/DatumActivationBonds.sol` — mute state + mute/settleMute
  functions + governable params (muteMinBond, muteMaxBlocks)
- `contracts/interfaces/IDatumActivationBondsMinimal.sol` — add isMuted view
- `contracts/DatumClaimValidator.sol` — consult isMuted before validating
- `test/activation-bonds.test.ts` — extend with AB-8 mute scenarios
- `test/claim-validator.test.ts` — extend with mute-rejection path
