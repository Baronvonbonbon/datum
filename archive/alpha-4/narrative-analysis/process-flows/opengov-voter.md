# OpenGov Voter

Phase-2 governance: anyone holding DOT (or DATUM, depending on the
governance instance) can participate. There's no membership gate —
participation is open, but it's *conviction-weighted*: more DOT locked
for longer means more voting power.

## The four governance instances

The protocol has four conviction-vote contracts, each with its own
quorum and slash settings:

| Contract | Scope |
|---|---|
| `DatumGovernanceV2` | Campaign activate / terminate / demote |
| `DatumPublisherGovernance` | Publisher fraud proposals |
| `DatumAdvertiserGovernance` | Advertiser fraud proposals |
| `DatumParameterGovernance` | Generic parameter changes via target.call(data) |

A voter operates in whichever instance is relevant to the proposal
they care about.

## The conviction curve

`weight(c) = (convictionA · c² + convictionB · c) / 100 + 1`

Defaults (A=25, B=50):

| Conviction | Weight | Lockup |
|---|---|---|
| 0 | 1× | 0 |
| 1 | 1× | 1 day |
| 2 | 3× | 3 days |
| 3 | 4× | 7 days |
| 4 | 7× | 21 days |
| 5 | 9× | 90 days |
| 6 | 13× | 180 days |
| 7 | 16× | 270 days |
| 8 | 21× | 365 days |

Higher conviction = more weight but longer lockup. The voter chooses
based on how committed they are to the outcome.

## End-to-end flow

### Acquire DOT

The voter needs DOT to lock. (Or WDATUM for ParameterGovernance, in
some configurations.) Funds typically come from earnings (publisher
take, user share), purchase on an exchange, or stake-fee-share rewards.

### Watch the proposal queue

Off-chain UIs surface pending proposals:
- `DatumPublisherGovernance.proposals(id)` — active publisher fraud
  proposals.
- `DatumAdvertiserGovernance.proposals(id)` — advertiser fraud.
- For `GovernanceV2`, each Pending or Active campaign is implicitly a
  proposal (the campaignId is the proposalId).

### Cast a vote

```
gov.vote(proposalId, aye, conviction) payable
```

`msg.value` is the DOT being locked. The contract records:

```
votes[proposalId][voter] = Vote {
    direction: aye ? 1 : 2,
    lockAmount: msg.value,
    conviction,
    lockedUntilBlock: block.number + lockup[conviction]
}
```

And updates `ayeWeighted / nayWeighted` with `msg.value × weight(conviction)`.

### Snapshotted curve (M-2)

On the **first vote per proposal**, the contract snapshots the live
conviction curve into the proposal's local storage. Subsequent
votes use the same snapshot — even if governance retunes the curve
mid-vote-window. A voter casting later under the same conviction
gets the same weighting as the first voter.

### Grace period

After the first nay vote, `minGraceBlocks` must elapse before
`resolve()` can be called. This prevents aye majorities from
sniping resolution the moment opposition appears.

### Resolution

Anyone can call `resolve(proposalId)` (or `evaluateCampaign(id)` for
V2) once the grace period has elapsed:

- **Aye wins** (`ayeWeighted > nayWeighted && ayeWeighted >= quorum`):
  the action executes — slash publisher / advertiser / activate campaign
  / etc.
- **Nay wins** or no quorum: proposal fails. For V2: campaign stays
  Pending; eventually gets `evaluateCampaign` called for rejection.

### Withdrawal of locked stake

After `lockedUntilBlock`:

```
gov.withdrawVote(proposalId)  (PubGov / AdvGov / ParamGov)
gov.withdraw(campaignId)      (V2)
```

The contract returns the locked DOT, **minus a slash** if the voter
was on the losing side:

```
slash = lockAmount × slashBps / 10000
refund = lockAmount - slash
```

`slashBps` is governance-set (capped at 100% by the audit G-M2 fix,
typically 10%). The slashed pool accumulates in `slashCollected`.

### Claim slash share (winning voters)

Winners can pull their pro-rata share of the slash pool:

```
gov.claimSlashShare(proposalId)   (V2)
gov.claimGovPayout()              (PubGov / AdvGov payout queue)
```

Share = `voterWeight × pool / totalWinningWeight`.

### Sweep deadline

Unclaimed slash share is swept to owner (timelock) after
`SWEEP_DEADLINE_BLOCKS = 5_256_000` (~365 days). Stale unclaimed
shares don't accumulate forever.

## Economic exposure

- **Locked DOT for the conviction lockup.** Cannot withdraw early.
- **Slash on losing side.** `slashBps` of `lockAmount` is forfeit.
  At default 10% with conviction 8 (365-day lockup), this is a real
  cost.
- **Earnings on winning side.** Pro-rata share of the losing-side
  slash pool.

## Who polices the voter

- **The conviction-weight cap** (audit MAX 1000× via
  `setConvictionCurve` bounds) — a hostile governance can't push
  weights to absurd levels.
- **The lockup cap** (`MAX_LOCKUP_BLOCKS = 2 years`) — can't grief
  voters with longer-than-2-year locks.
- **Per-proposal curve snapshot (M-2)** — voters' weight can't be
  retroactively reduced by a mid-flight retune.

## Trust assumptions placed on the voter

- That they vote in good faith (no on-chain enforcement of "good
  faith" — the protocol just counts weight and slashes losers).
- That they don't bribe / collude (mitigations are the conviction
  costs + slash penalty, plus voter anonymity for some).

The protocol's stance: voters with skin in the game (via lockup +
slash exposure) are aligned with the protocol's economic health. The
quadratic weight curve mildly rewards conviction over capital,
limiting the influence of pure whale voters who only show up at
conviction 0.
