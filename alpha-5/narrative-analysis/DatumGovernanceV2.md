# DatumGovernanceV2

The Phase-2 (OpenGov) governance for campaign lifecycle decisions:
activate Pending campaigns, terminate Active ones for fraud, demote Active
ones to terminated for non-fraud reasons. Voters lock DOT with a conviction
multiplier (1x to 21x) for a corresponding lockup (0 to 365 days). Quorum-
and threshold-based resolution; losing voters forfeit a configurable
fraction of their stake (slashBps); winners can claim a proportional share
of the slash pool.

This contract is the most complex governance instrument in the protocol —
569 LOC, several integrated machineries: voting, resolution, lockup,
slash distribution, sweep queue, audit-fix snapshots.

## The conviction curve (quadratic, governable)

`weight(c) = (convictionA · c² + convictionB · c) / 100 + 1`

Defaults: A=25, B=50. So:

| c | weight | lockup (blocks @ 6s) |
|---|---|---|
| 0 | 1× | 0 |
| 1 | 1× | 14_400 (1 d) |
| 2 | 3× | 43_200 (3 d) |
| 3 | 4× | 100_800 (7 d) |
| 4 | 7× | 302_400 (21 d) |
| 5 | 9× | 1_296_000 (90 d) |
| 6 | 13× | 2_592_000 (180 d) |
| 7 | 16× | 3_888_000 (270 d) |
| 8 | 21× | 5_256_000 (365 d) |

The curve replaced a hardcoded step-function in the alpha-4 governable-gating
refactor. `setConvictionCurve(a, b)` retunes; `setConvictionLockups(uint256[9])`
rewrites the lockup table (each entry ≤ MAX_LOCKUP_BLOCKS = 2 years).

**Audit-5 L6 fix.** `setConvictionCurve(0, 0)` now reverts E11. The
`(A == 0 && B == 0)` sentinel is what `proposalConvictionA/B[id]`
uses as "not yet snapshotted"; allowing a (0,0) curve would let a
malicious governance retune defeat the M-2 snapshot defense by
making the sentinel match. The fix is mirrored on
`DatumPublisherGovernance` and `DatumAdvertiserGovernance` for
consistency.

## M-2 audit: per-proposal curve snapshot

Each campaignId is itself a "proposal" in this design. On the *first vote*
against a campaign, the contract snapshots the current curve into
`proposalConvictionA[campaignId]` / `proposalConvictionB[campaignId]`.
Subsequent votes and the resolve()/withdraw() reads use the snapshot — a
mid-vote-window curve retune by governance cannot retroactively reweight
an in-flight proposal.

Lockups are already snapshotted per-vote in `lockedUntilBlock`, so changing
the lockup table doesn't retroactively re-lock or release.

## Voting flow

Two voting styles coexist:

### Legacy open-tally `vote()`

```
vote(campaignId, aye/nay, conviction) payable
   → check status is Pending or Active
   → snapshot curve on first vote
   → record Vote { direction, lockAmount, conviction, lockedUntilBlock }
   → add weight to ayeWeighted or nayWeighted
   → track firstNayBlock + lastSignificantVoteBlock
```

Used for non-contested paths: Active campaign demote / terminate votes
where no `DatumActivationBonds` challenge is active.

### Commit-reveal (optimistic activation contested path)

For campaigns whose Pending → Active path was *contested* via
`DatumActivationBonds.challenge`, voting switches to commit-reveal
to prevent last-minute strategic alignment with the leading side.

```
commitVote(campaignId, hash) payable
   → require activationBonds.isContested(campaignId)
   → lazy-open the CommitRevealWindow on first commit
   → record Commit { hash, lockAmount } per voter
   → adds value to the commit pool (no aye/nay revealed yet)

revealVote(campaignId, aye, conviction, salt)
   → require block.number > commitDeadline && <= revealDeadline
   → recompute _hashCommit(campaignId, msg.sender, aye, conviction, salt)
   → match against the stored commit hash
   → unlock the commit → record a normal Vote with the same conviction
   → fold lockAmount into the appropriate side

sweepUnrevealed(campaignId, voter)
   → require block.number > revealDeadline
   → unrevealed lockAmount → slashCollected (audit-5 H4: now safe to route)
   → marks voter as swept (idempotent)
```

The window is **lazy-opened** on the first `commitVote`. Subsequent
commits within the same block share the same window. Auditable
property (audit-5 commit-reveal review): the hash binding covers
all five fields — campaignId, voter, aye, conviction, salt — so a
voter can't reveal differently than they committed.

`evaluateCampaign` for contested paths gates on `block.number >
revealDeadline` before reading the (now-final) tallies.

`withdraw(campaignId)`:
```
   → require lockedUntilBlock has passed
   → compute slash if resolved and voter lost
   → refund (lockAmount - slash) via _safeSend
   → slashCollected[campaignId] += slash
```

## Resolution

`evaluateCampaign(campaignId)` is the resolver. Inputs: ayeWeighted,
nayWeighted, the campaign's current status, the grace period, the relevant
quorums. Decision tree:

- **Pending → Active** if ayeWeighted ≥ `quorumWeighted` and ayes > nays.
- **Pending → Rejected** if grace elapsed and ayes < quorum.
- **Active → Terminated** if nay-side quorum (`terminationQuorum`) is met
  AND ayes < nays. Routes through Lifecycle for the actual slash+refund.
- **Active → Demoted** if ayes drop relative to nays without termination
  quorum being met (intermediate path).
- **Status == 5 (Expired)** — *audit-5 H4 fix*. Routes the
  `slashCollected[campaignId]` residue to `pendingOwnerSweep` and
  marks `totalSlashClaimed` fully consumed. Before the fix this
  branch reverted E50, stranding the pool forever after a
  contested-but-unresolved campaign expired.
- **Status == 4 (Terminated) with zero nay-weighted votes** — same
  H4 routing. A high-tier governance proposal that calls
  `lifecycle.terminateCampaign` directly (bypassing aye/nay)
  produced a stuck pool under the old `require(w > 0)` check; now
  it routes to `pendingOwnerSweep` too.

Scaled grace: `baseGrace + (totalWeight / quorum) × gracePerQuorum`, capped
at `maxGrace`. The bigger the vote, the longer the grace window — keeps
small-quorum proposals from sniping resolution.

## Slash distribution (S1-S6, inlined from old GovernanceSlash)

When a campaign resolves, losing-side voters forfeit `slashBps` of their
locked stake. The slashed pool accumulates in `slashCollected[campaignId]`.
Winning voters can later call `claimSlashShare(campaignId)` to pull their
share, computed as `voterWeight × pool / winningWeight[campaignId]`.

- `slashFinalized[campaignId]` is set after the resolution + first
  `claimSlashShare`, freezing `winningWeight`.
- After `SWEEP_DEADLINE_BLOCKS` (~365 days) the unclaimed remainder can be
  swept to owner via `sweepSlashPool(campaignId)` → routed through
  `pendingOwnerSweep` (audit G-M3: pull-only, no push).

## Pause behavior

`pausedGovernance()` blocks vote() and evaluateCampaign(). withdraw() is
NOT paused — voters can always reclaim their stake (modulo lockup).

## Lock-once

`lifecycle` ref is lock-once. `campaigns` ref is set in constructor and
mutable only via owner pre-policy-lock — typical when the lifecycle gets
swapped for a real one after the bootstrap mock. The owner is the
Router/Timelock in production.

## Why 569 lines

It carries everything: vote machinery, resolution math, slash distribution,
sweep queue, governable parameters, audit snapshots, EIP-712-free design
(no signatures here — votes are direct tx). The complexity is the *price*
of a real OpenGov-grade conviction system; a simpler counted-vote model
would be 100 LOC.
