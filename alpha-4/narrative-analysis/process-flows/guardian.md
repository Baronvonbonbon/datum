# Guardian

One of three addresses with fast-pause authority on
`DatumPauseRegistry`. The protocol's emergency-response role. Designed
for live-exploit triage: any single guardian can pause the system
instantly; two-of-three must agree to unpause.

## On-chain footprint

Three addresses stored in `DatumPauseRegistry.guardians[3]`. Set at
deploy by the constructor; rotatable thereafter via the 2-of-3
self-rotation flow.

## End-to-end flow

### Onboarding

1. **Be chosen at deploy** — the deployer picks an initial set of three
   distinct addresses for the PauseRegistry constructor.
2. **Pre-`lockGuardianSet`:** the deployer can call `setGuardians` to
   rotate the entire set unilaterally — useful during early bootstrap
   if a key needs replacing before the community has reviewed the
   set.
3. **Post-`lockGuardianSet`:** rotation requires 2-of-3 of the
   sitting guardians via `proposeGuardianRotation + approve`. The
   owner permanently loses authority.

### Steady state (nothing happens)

The role is mostly idle. Guardians:

- Watch on-chain events for anomalies.
- Monitor off-chain dashboards (Grafana, etc.) for protocol-level
  metrics — settled volume, rejection rate, slashing activity,
  unusual address activity.
- Are notified by oncall systems if anomalies trip thresholds.

### Emergency: pause

If a guardian detects an exploit or critical bug, they pause
unilaterally. Two granularities:

```
pauseFast()            — pause ALL categories (CAT_ALL = 15)
pauseFastCategories(catMask) — pause specific subset:
    CAT_SETTLEMENT        (1)  ← halt settlement
    CAT_CAMPAIGN_CREATION (2)  ← halt createCampaign + setPublisherTags
    CAT_GOVERNANCE        (4)  ← halt vote / propose / resolve / activate
    CAT_TOKEN_MINT        (8)  ← halt mint paths
```

A surgical pause (e.g. just CAT_SETTLEMENT) is preferable when the
category is known. Pausing CAT_ALL is the panic button when uncertain.

### Coordination for unpause

Unpausing is **two-of-three**. The proposing guardian calls
`propose(action = 2)` for full unpause, or `proposeCategoryUnpause(catMask)`
for a subset. A second guardian calls `approve(proposalId)` which
executes if the action was 2 or 4.

The third guardian can do nothing — two yes-votes is enough.

If one guardian's key is compromised, the other two can both unpause
without their concurrence AND rotate the guardian set to remove them:

```
proposeGuardianRotation(newG0, newG1, newG2)
approve(rotationProposalId) → set replaced
```

### Auto-expiry safety net

Even if no guardian ever unpauses, `MAX_PAUSE_BLOCKS = 201_600` blocks
(~14 days at 6s) caps the pause duration. After that window, `paused()`
returns false. The raw bitfield remains set internally but can be
cleaned by anyone via the permissionless
`expireStaleCategories()` (audit M-7).

This caps the worst-case damage of a compromised guardian set: 14
days of frozen settlement before the system auto-recovers.

### Re-engagement

A guardian can re-pause after expiry. This costs gas and is visible
on-chain. A pattern of repeated re-pauses would be evidence of a
compromised guardian set; the community could push a governance
proposal to rotate (which the remaining honest guardians would
execute).

### Bootstrap exit

After community vetting:

```
owner.lockGuardianSet()  — irreversible
```

After this call, the protocol's emergency-pause authority is fully
delegated to the guardian set. The deployer can no longer rotate it.

## Economic exposure

- **None directly.** Guardians don't stake.
- **Reputation:** rotation by the other two guardians is the
  accountability mechanism for misbehavior.

A future protocol upgrade could add guardian staking (e.g. lock DOT
that's slashable on bad-faith pauses). Currently it's reputation-only.

## Who polices the guardian

- **The other two guardians:** can rotate or unpause unilaterally
  against a single bad actor (since they form a 2-of-3 quorum
  without them).
- **The community:** can push timelock proposals to influence the
  guardian set pre-`lockGuardianSet`, or apply social pressure
  post-lock.
- **The 14-day auto-expiry:** caps the impact of a compromised set
  freezing the protocol.

## Trust assumptions placed on guardians

- That they will pause only on real emergencies, not for censorship.
- That at least two of three will be reachable to coordinate
  unpause.
- That they won't be a coordinated cabal able to indefinitely re-pause
  (mitigated by the auto-expiry pattern + community ability to fork).

The 3-guardian topology is a deliberately small committee. Larger
guardian sets would resist a single-guardian compromise better but
make coordination slower and harder to verify. Three is the smallest
number that supports two-of-three quorum.
