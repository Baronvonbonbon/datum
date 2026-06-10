# DatumPublisherReputation

Publisher acceptance-rate tracker + per-campaign anomaly detector.
Carved out of DatumSettlement (alpha-4 EIP-170). Settlement is the
sole writer; the contract exposes views for governance dashboards,
the relay-bot, and an optional `minReputationScore` gate that gives
operators a one-knob rollout lever.

## Score model

Score is `(settled / (settled + rejected)) * 10000` — bps on `[0, 10000]`.
Publishers with no data at all (no claims yet) return 10000 so they
aren't blocked by the gate during bootstrap. The score is purely a
function of recorded counters; there is no decay term.

## Hot-path interface

Settlement calls `recordSettlement(publisher, campaignId, settled,
rejected)` once per batch after the per-claim loop:

- Gated to `msg.sender == settlement` (revert `OnlySettlement`).
- No-op on `publisher == address(0)` and on `settled + rejected == 0`.
- Updates four counters: global settled/rejected for the publisher,
  per-campaign settled/rejected.

Settlement also reads `canSettle(publisher)` before processing the
batch. If the global rep gate is enabled (`minReputationScore > 0`),
a publisher whose score is below the floor gets the entire batch
rejected with reason code 20.

## Anomaly detection (BM-9)

`isAnomaly(publisher, campaignId)` returns true when:

```
rejection_rate_on_campaign > 2× global_rejection_rate
AND campaign_total_claims >= 10
```

The minimum sample threshold (`REP_MIN_SAMPLE = 10`) prevents false
positives on tiny campaigns. The 2× factor (`REP_ANOMALY_FACTOR`)
is a constant; tuning it requires a contract upgrade.

The anomaly view is consumed off-chain (relay-bot for monitoring,
PublisherGovernance for fraud proposals). It is NOT consulted by
Settlement's hot path — anomaly status is observational, not enforcing.
The enforcing path is the `minReputationScore` gate.

## Why the external reporter EOA was removed

Alpha-3 had a relay-bot EOA that called a separate
`recordSettlement` entry point. That endpoint was deliberately NOT
restored in this carve-out. Threat-model #4: a compromised reporter
EOA could poison every publisher's reputation arbitrarily, then
trigger the `minReputationScore` gate to reject all settlements
protocol-wide. The reputation data now flows exclusively from
Settlement's authoritative counters.

## Governance surface

- **`setMinReputationScore(score)`** — owner-only, `whenNotFrozen`.
  0 disables the gate; any non-zero value is the floor. Recommended
  rollout: start at 0, ramp slowly once anomaly data accumulates.
- **`setSettlement(addr)`** — owner-only; locked by `lockPlumbing`.
- **`lockPlumbing()`** — owner-only, `whenOpenGovPhase`. Permanent.

## Views consumed downstream

- `getReputationScore(publisher) → uint16` (relay-bot, dashboards)
- `getPublisherStats(publisher) → (settled, rejected, score)` (dashboards)
- `getCampaignRepStats(publisher, campaignId) → (settled, rejected)`
- `isAnomaly(publisher, campaignId) → bool`

## Trust assumptions

- The counters are authoritative because Settlement is the sole
  writer. A captured Settlement upgrade could submit fake recordings,
  but the upgrade itself goes through the governance ladder.
- Score `10000` for empty data is a deliberate bootstrap choice;
  a malicious publisher who's never been caught looks identical to
  a genuine new publisher. This is the intended slack-during-rollout
  posture.
- The 2× anomaly factor is hardcoded; calibration is via off-chain
  observation, not on-chain parameter.
