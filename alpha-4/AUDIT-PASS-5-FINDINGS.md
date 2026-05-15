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
| DatumActivationBonds | **reviewed** | H1, H2, M1, M3, L1, L3 (3 HIGH fixed) |
| DatumStakeRootV2 | **reviewed** | H3, L3, L4, L5 (1 HIGH fixed) |
| DatumIdentityVerifier | **reviewed** | (covered with V2) |
| DatumGovernanceV2 | _next_ | commit-reveal additions are highest-priority remaining |
| DatumTagRegistry | _pending_ | Schelling jury + bonds + expiry GC |
| DatumCampaigns | _pending_ | caps refactor + batch entrypoints; pre-existing surface |
| DatumChallengeBonds | _pending_ | maxBondedPublishers refactor; pre-existing surface |
| DatumPublishers | _pending_ | setAllowedAdvertisers batch + tag mode |
| DatumCouncil | _pending_ | addMembers/removeMembers batch |
| DatumSettlement | _pending_ | maxBatchSize refactor; pre-existing surface |
| DatumRelay | _pending_ | maxBatchSize refactor |
| DatumClaimValidator | _pending_ | stakeRoot2 + activationBonds wiring |
| DatumStakeRoot (V1) | _pending_ | deprecation flag added; mostly pre-existing |
| DatumCampaignLifecycle | _pending_ | pre-existing surface |
| DatumPaymentVault | _pending_ | pre-existing surface |
| DatumBudgetLedger | _pending_ | pre-existing surface |
| DatumGovernanceRouter | _pending_ | pre-existing surface |
| DatumTimelock | _pending_ | pre-existing surface |
| DatumPauseRegistry | _pending_ | pre-existing surface |
| DatumZKVerifier | _pending_ | pre-existing surface |
| DatumPublisherStake | _pending_ | pre-existing surface |
| DatumPublisherGovernance | _pending_ | pre-existing surface |
| DatumAdvertiserGovernance | _pending_ | pre-existing surface |
| DatumAdvertiserStake | _pending_ | pre-existing surface |
| DatumParameterGovernance | _pending_ | pre-existing surface |
| DatumCouncilBlocklistCurator | _pending_ | pre-existing surface |
| DatumClickRegistry | _pending_ | pre-existing surface |
| DatumTagCurator | _pending_ | pre-existing surface |
| DatumTokenRewardVault | _pending_ | pre-existing surface |
| DatumAttestationVerifier | _pending_ | pre-existing surface |
| DatumInterestCommitments | _pending_ | pre-existing surface |
| DatumZKStake | _pending_ | pre-existing surface |
| PaseoSafeSender | _pending_ | base utility |
| DatumOwnable | _pending_ | base utility |
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


