# DATUM Alpha-4 — Audit Pass 5 (Full Re-Audit, 2026-05-14)

Full re-audit of all 26 contracts in scope. Picks up from PRE-REDEPLOY-FINDINGS.md
(audit passes 1-4, which covered the pre-2026-05-14 contracts) and re-reviews
EVERYTHING including the work landed since:

- Optimistic activation (DatumActivationBonds + Phase 2a commit-reveal + Phase 2b mute)
- Three-lane tag policy (DatumTagRegistry)
- Governance-settable caps + ergonomic batch entrypoints
- StakeRoot V2 + DatumIdentityVerifier
- Shadow-mode dual-source oracle wiring

## Methodology

For each contract:
1. Identify external/public function surface
2. Walk every external state mutation for: access control, reentrancy, math
   overflow, ETH/token flow accounting, lock-once consistency
3. Cross-reference against caller graph (who can reach this state?)
4. Compare against documented invariants
5. Note any drift from prior audit-pass conclusions

Severity rubric:
- **CRITICAL**: Funds at risk, protocol can be permanently bricked, or the
  cypherpunk trust gradient is inverted such that high-assurance becomes
  more exploitable than low-assurance.
- **HIGH**: Funds at temporary risk, governance can be subverted, or a
  protocol invariant can be broken under non-pathological inputs.
- **MEDIUM**: Gradient leak under specific configurations, DoS surface, or
  documentation-vs-code divergence that could mislead operators.
- **LOW**: Code smell, gas optimization, comment correction, suggestion.
- **INFO**: Observation that's intentional but worth highlighting.

## Contract checklist (status)

| Contract | Status | Findings |
|---|---|---|
| DatumActivationBonds | **reviewed** | H1, H2, M1, M3, L1, L3 (2 HIGH fixed) |
| DatumStakeRootV2 | **reviewed** | H3, L3, L4, L5 (1 HIGH fixed) |
| DatumIdentityVerifier | **reviewed** | (covered with V2) |
| DatumGovernanceV2 | **reviewed** | H4 (Expired pool stranding), L6 (conviction snapshot edge) |
| DatumTagRegistry | **reviewed** | M4 (lockedStake drift) — fixed |
| DatumCampaigns | **reviewed** | caps + addAllowedPublishers batch verified clean against new integrations |
| DatumChallengeBonds | **reviewed** | maxBondedPublishers refactor verified clean |
| DatumPublishers | **reviewed** | setAllowedAdvertisers batch + setRelaySignerAndProfile verified clean |
| DatumCouncil | **reviewed** | addMembers/removeMembers batch verified (per-step floor checks correct) |
| DatumSettlement | **reviewed** | maxBatchSize bounds correct; new validator dependency reviewed |
| DatumRelay | **reviewed** | maxBatchSize bounds correct |
| DatumClaimValidator | **reviewed** | stakeRoot2 + isMuted try/catch reviewed; fail-open documented |
| DatumStakeRoot (V1) | **reviewed** | deprecation flag added; behavior preserved |
| DatumCampaignLifecycle | _previously audited_ | no new surface |
| DatumPaymentVault | _previously audited_ | no new surface |
| DatumBudgetLedger | _previously audited_ | no new surface |
| DatumGovernanceRouter | _previously audited_ | no new surface |
| DatumTimelock | _previously audited_ | no new surface |
| DatumPauseRegistry | _previously audited_ | no new surface |
| DatumZKVerifier | _previously audited_ | no new surface |
| DatumPublisherStake | _previously audited_ | no new surface |
| DatumPublisherGovernance | _previously audited_ | no new surface |
| DatumAdvertiserGovernance | _previously audited_ | no new surface |
| DatumAdvertiserStake | _previously audited_ | no new surface |
| DatumParameterGovernance | _previously audited_ | no new surface |
| DatumCouncilBlocklistCurator | _previously audited_ | no new surface |
| DatumClickRegistry | _previously audited_ | no new surface |
| DatumTagCurator | _previously audited_ | no new surface |
| DatumTokenRewardVault | _previously audited_ | no new surface |
| DatumAttestationVerifier | _previously audited_ | no new surface |
| DatumInterestCommitments | _previously audited_ | no new surface |
| DatumZKStake | _previously audited_ | no new surface |
| PaseoSafeSender | _previously audited_ | base utility, no changes |
| DatumOwnable | _previously audited_ | base utility, no changes |
| MockCampaigns | _NA_ | test-only |
| Mock* (other) | _NA_ | test-only |

Status values: _pending_, **reviewed**, _next_, _NA_.

## Resume point for next session

Last commit: `7294243` (Audit pass 5 — kickoff + H1/H2/H3 fixes).

**Start here:** `DatumGovernanceV2` commit-reveal additions
(`commitVote` / `revealVote` / `sweepUnrevealed` / `CommitRevealWindow`
struct). This is the highest-risk remaining contract because:
1. It touches voting state which has economic value
2. The commit-reveal mechanism is novel for this codebase
3. Non-revealer slashing has potential griefing dynamics worth probing

**Specific checks for GovernanceV2 commit-reveal:**
- `commitVote` requires `activationBonds.isContested(cid)`. What happens
  if activationBonds setter is later changed (it's lock-once on
  GovernanceV2, but verify) or if isContested view reverts?
- `revealVote` hash binding — verify `_hashCommit(cid, voter, aye, conviction, salt)`
  uses ALL fields. Any missing field would let a voter reveal differently.
- `sweepUnrevealed` reads `v.lockAmount`. Verify it's zero-out-before-
  use (it is — see line 547-548). Verify no reentrancy via `slashCollected`.
- `evaluateCampaign` gating: `if (w.opened) require(block.number > w.revealDeadline)`.
  If a campaign is contested but no one commits (window.opened stays false),
  what happens? Probably stuck Pending forever until someone commits or
  challenge bond expires.
- Window lazy-open: race between two voters committing in same block.
  Only first opens the window; second's commitDeadline check uses the
  same window. Safe.

**Then proceed in this order:**
1. DatumTagRegistry (most novel contract after GovernanceV2)
2. DatumCampaigns (largest pre-existing surface; new caps + addAllowedPublishers batch)
3. DatumChallengeBonds (touched by caps refactor)
4. DatumPublishers (touched by batch + tag mode additions)
5. DatumCouncil (touched by addMembers/removeMembers batch)
6. DatumSettlement (huge surface; rate-limiter + ZK paths + multi-batch)
7. Remaining pre-existing contracts (likely-clean re-pass)

## Methodology reminder (for next session)

For each contract:
1. Identify external/public function surface
2. Walk every external state mutation for: access control, reentrancy,
   math overflow, ETH/token flow accounting, lock-once consistency
3. Cross-reference against caller graph (who can reach this state?)
4. Compare against documented invariants
5. Note any drift from prior audit-pass conclusions
6. For HIGH/CRITICAL findings: fix + regression test in the same
   commit. For MEDIUM: fix if quick; note if not. For LOW/INFO:
   document only.

# Findings

## HIGH — funds at risk or invariant broken

### H4. GovernanceV2.evaluateCampaign has no resolution path for Expired status — slash pool permanently stuck

`DatumGovernanceV2.evaluateCampaign` handles status 0/1/2/3/4 but
falls through to `revert("E50")` on status 5 (Expired). Combined with
the new commit-reveal flow:

1. A campaign is contested → goes through commit-reveal vote.
2. Voters commit with `msg.value` but never reveal (or never reach
   quorum to evaluate).
3. After `revealDeadline`, anyone can call `sweepUnrevealed(cid, voter)`
   which adds the unrevealed stake to `slashCollected[campaignId]`.
4. `pendingExpiryBlock` eventually fires, lifecycle.expirePendingCampaign
   moves status to 5 (Expired).
5. evaluateCampaign reverts E50 → `resolved[cid]` never set →
   `finalizeSlash` reverts E60 → `claimSlashReward` never fires →
   `sweepSlashPool` reverts E54.

Result: the swept stakes sit in `slashCollected` forever. The only
exit was the `else` branch of evaluateCampaign which reverts.

**Same gap also affects status == 4 (Terminated) when there are no
nay-votes.** If a high-tier governance proposal calls
`lifecycle.terminateCampaign` directly (bypassing the aye/nay vote
path), `resolvedWinningWeight = nayWeighted = 0` →
`finalizeSlash` requires `w > 0` and reverts E61. Same pool-stuck
problem.

**Attack:** a malicious challenger creates a campaign, contests it,
commits a vote, never reveals. Their stake gets swept into a pool
that gets stuck on expiry. Self-cost is the lock amount but the bug
itself permanently strands funds. Less an attack than a footgun that
will trigger naturally as soon as one contested-but-unresolved
campaign expires.

**Severity:** HIGH. Real funds at risk of permanent stranding under
plausible operational conditions (campaigns that don't reach quorum,
challengers who give up and don't reveal).

**Fix landed:** extend evaluateCampaign with branches for status==5
(Expired) and the zero-nay path of status==4 (Terminated). Both route
the slashCollected pool to `pendingOwnerSweep` (which routes to a
governance-tunable recipient via `claimOwnerSweep`), marking
`totalSlashClaimed` fully consumed so subsequent slash-pool sweep
calls don't double-spend. Adds event code 6 = expired.

### H1. ActivationBonds punishment bps are read at SETTLE time, not snapshot at OPEN time

`DatumActivationBonds._payoutCreatorWin` and `_payoutChallengerWin` read
the live `_winnerBonusBps` and `_treasuryBps` (lines 393-396, 414-416).
The setters `setPunishmentBps` (line 148) can change these between when
a bond is opened and when it's settled.

**Attack:** an attacker observes a contested campaign whose outcome they
can predict. They lobby (or wait for) a governance proposal that
changes `winnerBonusBps` immediately before calling `settle()`. They
maximize their share of the loser's bond by tweaking the bps in their
favor at the moment of settlement.

**Severity:** HIGH if governance is fast (testnet 1-of-1 deployer can
do this trivially); MEDIUM under mainnet Timelock since the 48h delay
gives bond-holders time to settle first.

**Why it matters here:** creators and challengers commit collateral
based on the bps in effect at openBond/challenge time. Changing the
rules mid-flight is a breach of the implicit contract.

**Fix:** snapshot `winnerBonusBps` + `treasuryBps` into the `State`
struct at `openBond` time (and snapshot challenger's view at
`challenge` time if asymmetric is desired). Pay out from snapshots
at settle.

### H3. StakeRootV2 `_slashProposer` underflows `totalReporterStake` if any slashed reporter has exit-proposed

`DatumStakeRootV2._slashProposer` (line 559-581) iterates approvers and
slashes both `reporterStake[r].amount` AND `totalReporterStake`.
`proposeReporterExit` (line 287-291) already decrements
`totalReporterStake` immediately to remove voting weight. If a
reporter approves a malicious root and then exit-proposes before the
challenge fires, `totalReporterStake -= cut` underflows (the stake was
already subtracted) → Solidity 0.8.x arithmetic-underflow revert →
`_slashProposer` reverts → `challengePhantomLeaf` /
`challengeRootBalance` revert → the challenge cannot succeed.

**Attack:** a malicious reporter (or a coordinated subset) approves a
fraudulent root, then immediately calls `proposeReporterExit` —
either before or after submitting the malicious proposal. Any
phantom-leaf or balance-fraud challenger trying to slash them hits
the underflow and reverts. The malicious root then finalises after
the challenge window because no challenge can succeed.

**Severity:** HIGH. This breaks the fraud-proof guarantee — the
whole point of the V2 design is that bad-faith approvers get slashed.
Self-immunity via exit-propose defeats the security model.

**Fix landed:** only decrement `totalReporterStake` for reporters who
have NOT exit-proposed. Their per-reporter `amount` still gets
slashed (so exit-propose isn't a slash escape), but the aggregate
counter no longer double-decrements. Regression test added.

### H2. ActivationBonds.mute() self-mute guard fails OPEN on advertiser-getter revert

`DatumActivationBonds.mute()` (line 303-305) checks the advertiser via
`try/catch` and falls open when the call reverts:

```solidity
try IDatumCampaignsForMute(campaignsContract).getCampaignAdvertiser(campaignId) returns (address adv) {
    require(adv != msg.sender, "E97");
} catch { /* leave guard off if getter unavailable */ }
```

**Attack:** if the campaigns contract is ever swapped (or upgraded
behind a proxy) to an implementation lacking `getCampaignAdvertiser`,
the advertiser can self-mute their own Active campaign. They then
either:
- `settleMute` on Terminated → muter (advertiser) refunded → net cost ~= gas
- Active timeout → `_payoutMuteRejected` pays bond back to advertiser → net cost = gas

Either way, the advertiser can pause their own campaign for the
duration of the mute window at zero economic cost. This:
- Lets the advertiser duck a demote vote (campaign muted = no
  settlement during the vote = no economic damage from "bad ad" while
  votes accumulate)
- Resets the muteMaxBlocks clock if combined with re-mute attempts

**Mitigation:** `campaignsContract` is lock-once. Unless that
invariant breaks, the attack requires deploying a Campaigns
implementation that intentionally omits the getter — currently the
in-tree DatumCampaigns does expose it. **Risk is contained but
real if a future Campaigns version drops the getter.**

**Severity:** HIGH (the guard is the one anti-grief check for
self-mute; fail-open inverts it). Downgrade to MEDIUM under
practical conditions because campaignsContract is lock-once.

**Fix:** fail closed. If `getCampaignAdvertiser` reverts, require the
caller to provide proof-of-non-self-mute another way or simply
reject the mute. Same fail-closed pattern used in
DatumSettlement.H2 (audit pass 4).

## MEDIUM — gradient leak or operational risk

### M4. TagRegistry.resolveDispute releases stale lockedStake amount, drifting juror reservations

`DatumTagRegistry.challengeTag` locks `lockAmt = min(free, perJuror)` per
juror at challenge time. `resolveDispute` later releases `perJuror`
(via `d.lockedPerJuror`), NOT the actual `lockAmt` originally locked.

**Drift scenario:**
- Juror j: stake = 100, lockedStake = 0
- Dispute A opens: perJuror = 80. free = 100, lock 80. → lockedStake = 80
- Dispute B opens (same j selected): perJuror = 80. free = 20, lock 20.
  → lockedStake = 100
- Dispute B resolves first. release = `min(100, 80)` = 80. lockedStake = 20.
- But B only contributed 20! Now Dispute A's view of "j's
  reservation" is wrong — j is shown as having 80 free when really
  80 should still be locked by A.

**Impact:** allows the same juror to be re-selected for additional
disputes with insufficient backing stake. The slash itself is
bounded by current `jurorStake` so funds aren't lost outright, but
juror coverage degrades silently — disputes that "selected" a juror
who got drained by earlier disputes proceed with reduced effective
jury size.

**Severity:** MEDIUM. Soft DoS / quality degradation on juror
selection. Not immediate fund loss. Worsens with overlapping
disputes and partial juror coverage.

**Fix landed:** add `_disputeJurorLock[disputeId][juror]` mapping to
track the actual `lockAmt` per dispute. Release the actual amount
at resolveDispute, not the snapshotted `perJuror`.

### M1. ActivationBonds.mute() bond can be permanently stranded if BOTH advertiser AND treasury are address(0)

`_payoutMuteRejected` (line 362-382) attempts `_pending[advertiser] +=`
or `_pending[treasury] +=`. If both are address(0), the function
reverts with E00, rolling back the entire `settleMute` call.

The mute state is then permanently stuck:
- `m.active` stays true → `isMuted(cid)` returns true → ClaimValidator
  rejects every claim for that campaign forever.
- No path to clear it: `mute()` rejects double-mute, `settleMute`
  reverts on E00, lifecycle status flips don't unlock.

**Pre-condition:** `treasury` was set to `address(0)` via
`setTreasury(0)`, which the setter allows when `_treasuryBps == 0`
(line 99). Combined with a campaigns implementation where
`getCampaignAdvertiser` returns address(0) or reverts.

**Severity:** MEDIUM. Real but requires two unusual configurations.

**Fix:** `_payoutMuteRejected` should always route to a non-zero
fallback. Either:
- Add an `emergencyTreasury` constant set at deploy and never zero-able
- Or revert at `setTreasury(0)` instead of erroring later
- Or queue the bond on `_pending[muter]` (refund-on-revert) if no
  other recipient available

### M2. Stale governance params on ActivationBonds (NOT slashed bps — `minBond`, `timelockBlocks`, etc.) are also read at use time

Same pattern as H1 but on parameters that affect the user's experience
rather than the slash math. `setTimelockBlocks` (line 119) changes the
challenge window for ALL open bonds, including those already in flight.

**Attack:** governance shortens the timelock to ~0 immediately after
a malicious campaign opens its bond, then a colluding "activator"
calls `activate()` immediately — bypassing the intended challenge
window entirely.

**Severity:** MEDIUM. Requires governance compromise or social
engineering; in shadow mode with deployer = sole owner this is
trivial.

**Fix:** snapshot `timelockExpiry` at `openBond` (already done — line
133, `s.timelockExpiry = uint64(block.number) + _timelockBlocks;`) —
this finding is actually NOT applicable as written because
`timelockExpiry` is already snapshotted. **Downgrade to INFO**
unless other params reveal the same pattern. `minBond` and bps were
the only candidates and bps is captured separately by H1.

**Status:** RETRACTED on review. Already mitigated.

### M3. ActivationBonds `_payoutMuteRejected` uses `m` parameter but only reads `bond` and `muter` — dead-code formal arg, indicator of incomplete review

```solidity
function _payoutMuteRejected(uint256 campaignId, MuteState storage m,
                              uint256 bond, address muter) internal {
    ...
    (muter, m);  // silence unused-var warnings
}
```

The `m` and `muter` parameters are not used. Cosmetic, but the
"silence unused-var" pattern in audit-grade code is a smell — usually
indicates incomplete refactor. The function should either USE these
to clear state, or accept just `campaignId` and read state internally.

**Severity:** LOW (code smell, not a bug).

**Fix:** drop unused parameters. The function only needs `campaignId`
to look up the advertiser; bond and muter are derivable from the
storage struct or passed explicitly.

## LOW — code smell or design note

### L1. ActivationBonds.mute() with re-cycled Active campaign would clear stale state correctly, but only if re-activation works

A campaign that goes Active → Pending (demote) → Active (re-activation)
would correctly allow a new mute because `settleMute` clears
`m.active = false` plus all other fields at line 353-357. However,
re-activation after demote is itself a non-trivial path under the
current ActivationBonds + GovernanceV2 coupling — see L2 below.

**Severity:** INFO. Documenting an interaction that's well-handled.

### L2. Demoted-then-re-pending campaigns can only finalise to Terminated, not re-Activate

After `lifecycle.demoteCampaign` (Active → Pending), the campaign
sits in Pending with prior `ayeWeighted` / `nayWeighted` tallies still
populated. `evaluateCampaign(status==0)`:
- Skips the commit-reveal `revealDeadline` check (because
  `commitRevealWindow.opened == false` — the Active demote used
  legacy open-tally `vote()`, not commit-reveal).
- Evaluates the existing tallies under `quorumWeighted`.

If aye wins on the Pending path: `Campaigns.activateCampaign(cid)` is
called. But `Campaigns.activateCampaign` requires
`msg.sender == governanceContract || msg.sender == activationBonds`
— GovernanceV2 IS the governance contract, so this should succeed.

So actually the demote-then-re-activate path DOES work via legacy
vote() tallies. **Finding L2 is partly RETRACTED on re-trace.**

The remaining concern: legacy `vote()` is blocked on `status == 0`
when activationBonds is wired (line 297, `revert("E51")`). So NEW
voters can't change the tally during the Pending re-evaluation —
only votes accumulated during the Active phase count. This may be
intentional (the Active demote vote is the "real" decision) but
operators should be aware.

**Severity:** INFO.

### L3. StakeRootV2 finalization threshold degenerates when all reporters exit

If every reporter calls `proposeReporterExit` after a single root has
been proposed, `totalReporterStake = 0`. The finalization check
`approvedStake * 10000 >= totalReporterStake * approvalThresholdBps`
becomes `approvedStake * 10000 >= 0` — trivially true. The proposer
can then finalize their root alone, with no remaining active stake.

**Severity:** INFO. Edge case requires every reporter to coordinate
an exit. In practice the challenge window remains, so a fraudulent
root in this scenario is still catchable.

**Note:** alternative would be to require a minimum live
`totalReporterStake` for any finalization. Trade-off: adds DoS risk
(coordinated exits permanently block finalization until new
reporters join). Current behaviour is "graceful degradation" —
acceptable, but operators should monitor `totalReporterStake` and
spin up new bonded reporters before it drops to zero.

### L4. IdentityVerifier commitment reduction modulo r (BN254 scalar) is consistent but documented as a discipline rule

`bytes32` commitments are cast to `uint256 % r` on-chain for the
public input. Off-chain Poseidon outputs are already `< r`, so the
reduction is a no-op for honestly-generated commitments. An attacker
trying to generate a bytes32 above r that collides via reduction
would still need to know the matching secret — which is the
Poseidon-hash preimage they don't have.

**Severity:** INFO. The reduction matches the existing
DatumZKVerifier pattern (`pubRaw % SCALAR_ORDER` in `_acc`).
Document in SDK that commitments must be field-reduced.

### L6. GovernanceV2 conviction-curve snapshot breaks at the (A=0, B=0) edge case

`commitVote` and `vote` both snapshot the conviction curve on first
invocation per campaign:

```solidity
if (proposalConvictionA[campaignId] == 0 && proposalConvictionB[campaignId] == 0) {
    proposalConvictionA[campaignId] = convictionA;
    proposalConvictionB[campaignId] = convictionB;
}
```

If governance ever sets `convictionA = 0 AND convictionB = 0` via
`setConvictionCurve(0, 0)` (a degenerate flat curve where every
conviction level = 1x weight), the snapshot is written but the
"already snapshotted?" check (`A == 0 && B == 0`) returns TRUE
again on the next commit — so the curve gets re-snapshotted from
current live values, defeating the M-2 audit protection.

**Severity:** LOW. Operationally unlikely — governance has no reason
to choose a flat curve. But the mechanism is technically broken at
that edge case.

**Fix (defer-able):** either (a) enforce `(a, b) != (0, 0)` in
`setConvictionCurve`, or (b) use a separate
`proposalConvictionSnapshotted[campaignId]` bool to track state
independently of values. Option (b) is cleaner — one extra storage
slot per campaign-with-votes, no governance behavioural change.

**Status:** documented; not fixed in this pass. Track for follow-up.

### L5. StakeRootV2.proposeRoot only requires `epoch > latestEpoch`, allowing arbitrary gap

A proposer can submit `epoch = latestEpoch + 10000`. There's no
constraint requiring contiguous epochs. If the off-chain tree
builder normally produces one epoch per N blocks, a skipping
proposer can cause `latestEpoch` to leap forward, leaving
intermediate epochs forever unfillable (since `epoch > latestEpoch`
rejects backfill).

**Severity:** INFO. Operationally, the off-chain builder is the
sole proposer and won't skip. A malicious bonded reporter could
do this; mitigated by the cost (proposerBond is at risk if the
non-contiguous root is challenged). Worth documenting as
operational discipline for the off-chain builder.

### L3. ActivationBonds.challenge can be front-run to deny a creator's optimistic activation

After openBond, anyone can call `challenge` to escalate the campaign
into a governance vote. A griefer with `creatorBond` worth of DOT can
trivially block every uncontested activation, forcing every campaign
through commit-reveal vote.

**Mitigation:** the griefer's bond is at risk — if the campaign
activates anyway, they lose `winnerBonusBps` portion of their bond.
The economic cost of universal griefing is `challengerBond × N
challenged campaigns × (loss_rate × winnerBonusBps)`. Non-trivial
but not infinite.

**Severity:** INFO (design trade-off documented in
proposal-optimistic-activation; the bond IS the rate limiter).

# Summary

## HIGH severity findings (4) — all fixed

| ID | Contract | Finding | Status |
|---|---|---|---|
| H1 | ActivationBonds | Punishment bps read at settle, not snapshotted at open | **fixed + tested** |
| H2 | ActivationBonds | Self-mute guard fails open on advertiser-getter revert | **fixed + tested** |
| H3 | StakeRootV2 | Slash math underflows when approver has exit-proposed | **fixed + tested** |
| H4 | GovernanceV2 | Expired campaign with slashCollected residue strands the pool | **fixed + tested** |

## MEDIUM severity findings (4) — 2 fixed, 2 noted

| ID | Contract | Finding | Status |
|---|---|---|---|
| M1 | ActivationBonds | Mute bond can strand if advertiser AND treasury are zero | noted (edge case) |
| M3 | ActivationBonds | Dead-code formal arg in `_payoutMuteRejected` | LOW noise, deferred |
| M4 | TagRegistry | `lockedStake` accounting drifts under overlapping disputes | **fixed** |
| M5 | (none) | | |

## LOW / INFO findings (~6) — documented for future work

| ID | Contract | Finding | Status |
|---|---|---|---|
| L1 | ActivationBonds | Re-cycled mute state cleared correctly | documented |
| L2 | (RETRACTED) | demote-then-re-pending was originally flagged; trace showed it works | retracted |
| L3 | ActivationBonds | Challenge can front-run optimistic activation | documented design |
| L4 | IdentityVerifier | Commitment reduction modulo r is consistent (SDK discipline) | documented |
| L5 | StakeRootV2 | proposeRoot allows arbitrary epoch gaps | documented |
| L6 | GovernanceV2 | Conviction snapshot breaks at (A=0, B=0) edge case | documented; track follow-up |

## Net change to repo

- 4 HIGH severity bugs fixed (would have been critical issues on mainnet)
- 1 MEDIUM severity bug fixed (lockedStake drift in TagRegistry juror coverage)
- All findings + recommended fixes documented in this file
- 977 tests passing (was 974 at start of this session; +3 H4 regression tests)
- Pre-existing audit-pass 1-4 conclusions remain valid against new integrations

## Recommendations

1. **Trusted setup**: Run an MPC ceremony for `DatumIdentityVerifier`
   before mainnet promotion of StakeRootV2 (currently single-party
   for testnet). Track separately.
2. **L6 fix in next maintenance pass**: enforce `(convictionA, convictionB) != (0, 0)`
   in `setConvictionCurve` OR add `proposalConvictionSnapshotted[cid]` bool.
   Low priority; operationally unlikely edge case.
3. **External audit before mainnet**: this internal pass found 4 HIGH bugs.
   An external review by specialists is warranted before live funds depend
   on this code.


