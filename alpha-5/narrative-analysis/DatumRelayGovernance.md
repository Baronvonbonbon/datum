# DatumRelayGovernance

G-1 first close: conviction-vote fraud proposals against relays.
Symmetric to `DatumPublisherGovernance` and `DatumAdvertiserGovernance`.
Voters lock DOT aye/nay on a proposal accusing a relay of one of
four offenses; resolution slashes the relay's stake via
`DatumRelayStake.slash` and distributes the proceeds.

Companion: [`proposals/relay-accountability.md`](./proposals/relay-accountability.md)
covers the design + the future Approach A/B upgrade scaffold.

## Offense taxonomy

`reasonCode ∈ [1, 4]`:

1. **Censorship** — relay accepted a batch and didn't submit it
   on-chain, or selectively dropped specific users' batches.
2. **Front-running / reordering** — relay reordered competing
   batches within their bundle to favor specific parties.
3. **MEV / timing extraction** — relay timed submissions for MEV
   capture (sandwich attacks, etc.).
4. **Collusion** — relay coordinated with a publisher or advertiser
   to forge settlements.

Reason 0 and reasons > 4 revert E68. The codes are observational —
they govern dashboard categorization and slash-pool tagging, not
the slash math itself. All four route through the same conviction
vote.

## Proposal lifecycle

```
propose(relay, reasonCode, evidenceHash) {proposeBond} ──► Proposal Active
       │
       ├── conviction snapshot taken at this moment
       │   (proposalConvictionA/B[id] = current A/B)
       │
voters ──► vote(id, aye/nay, conviction) {payable lockAmount}
       │
       │   grace period = minGraceBlocks after firstNayBlock
       │
       ├──► resolve(id)
       │    ├── ayes > nays AND ayes >= quorum  → FRAUD UPHELD
       │    │   ├── relayStake.slash(relay, slashAmount, address(this), reasonCode)
       │    │   ├── challengerBonusBps → proposer pending queue
       │    │   ├── treasuryBps        → treasury pending queue
       │    │   └── residue            → contract treasuryBalance (owner sweep)
       │    └── otherwise              → NOT FRAUD
       │
       └── voters withdraw their lockAmount after personal lockup expires
```

## Conviction curve

Quadratic, matches `DatumPublisherGovernance`:

```
weight(c) = (convictionA · c² + convictionB · c) / 100 + 1
```

Defaults A=25, B=50, lockup table identical to `DatumGovernanceV2`
(0d/1d/3d/7d/21d/90d/180d/270d/365d). Per-proposal snapshot of A
and B prevents mid-flight retunes from retroactively reweighting
in-flight votes (M-2 fix).

**L-6 audit mirror.** `setConvictionCurve(0, 0)` reverts E11. The
`(0, 0)` pair is reserved as the "not yet snapshotted" sentinel for
the per-proposal storage; allowing it as a live curve would defeat
the snapshot defense.

## Slash distribution

Once the relay is slashed and funds arrive in this contract:

```
challengerCut = slashed × challengerBonusBps / 10000  → proposer pending queue
treasuryCut   = slashed × treasuryBps        / 10000  → treasury pending queue
residue       = slashed - challengerCut - treasuryCut  → contract treasuryBalance
```

`challengerBonusBps + treasuryBps ≤ 10000` is enforced at setter
time. The residue is owner-claimable via `sweepTreasury` →
`pendingGovPayout[owner]`. This residue accounts for the gap
between the per-call refund floor on `RelayStake` and the
configured challenger+treasury splits — typically small, but
explicit.

## Bond accounting

`proposeBond` is required at `propose()` time. Disposition at
`resolve()`:

- **Quorum reached** (ayeWeighted ≥ quorum OR nayWeighted ≥ quorum):
  bond refunded to the proposer's pending queue.
- **Quorum not reached** (neither side hit threshold): bond
  forfeited to the owner's pending queue (treasury sweep).

This mirrors `DatumPublisherGovernance`'s G-M5 mechanic and prevents
griefing — opening a proposal that no one cares about costs the
proposer.

## Losing voters

Losing voters' locked DOT is NOT slashed — they simply can't
withdraw until their personal `lockedUntilBlock` expires. Matches
the publisher/advertiser governance pattern (and diverges from
`DatumGovernanceV2`'s campaign-vote slash). Reason: voters voting
honestly against a fraud proposal that turns out wrong shouldn't
lose their stake — the upside of "join the vote" must remain
asymmetric to encourage participation.

## Pull-payment queue

All payouts flow through `pendingGovPayout[address] → uint256`:

- Challenger bonus (on fraud upheld)
- Treasury cut (on fraud upheld)
- Proposer bond refund (on quorum reached)
- Bond forfeit (on quorum NOT reached → owner)
- Treasury sweep residue (after fraud upheld → owner)
- Vote refunds from `withdrawVote` send directly, not via queue

`claimGovPayout()` and `claimGovPayoutTo(recipient)` pull. Pattern
matches `DatumPublisherGovernance`.

## Parameter surface

| Param | Setter | Bound |
|---|---|---|
| `quorum` | `setQuorum` | none (DOT amount) |
| `minGraceBlocks` | `setMinGraceBlocks` | none |
| `proposeBond` | `setProposeBond` | none |
| `slashAmountBps` | `setSlashAmountBps` | ≤ 10000 |
| `challengerBonusBps` | `setChallengerBonusBps` | sum with treasuryBps ≤ 10000 |
| `treasuryBps` | `setTreasuryBps` | sum with challengerBonusBps ≤ 10000 |
| `convictionA` / `convictionB` | `setConvictionCurve` | reject (0,0); maxWeight ≤ 1000 |
| `convictionLockup` | `setConvictionLockups` | each ≤ MAX_LOCKUP_BLOCKS (~2y) |

`slashAmountBps` can be set to 10000, but the actual slash is still
capped at 80% by `DatumRelayStake.slash`'s refund floor — the
on-chain math compounds the two bps values harmlessly.

## Cypherpunk locks

- `setRelayStake(addr)` — lock-once on first non-zero set
  (revert `AlreadySet`).
- `setPauseRegistry(addr)` — same.
- `lockPlumbing()` — owner-only, `whenOpenGovPhase`. Freezes both
  refs permanently.
- `setTreasury(addr)` — not lock-once; remains tunable post-deploy
  for treasury rotation (matches `DatumActivationBonds.setTreasury`).

## Trust assumptions

- The conviction vote is the source of truth for fraud. A captured
  governance contract can't single-handedly slash a relay — only
  voters can.
- The proposer must put up `proposeBond`; the bond is forfeited
  if no one cares enough to reach quorum. This is the rate-limiter
  on frivolous proposals.
- Voters' locked stake is at risk only via the lockup — the contract
  cannot slash a vote that's currently on the winning side.
- Pre-OpenGov, lock-once refs can be rotated by the owner. Once
  `lockPlumbing` fires, the wiring is permanent.

## Storage layout

Inherits `DatumUpgradable` + `PaseoSafeSender` (which extends
`ReentrancyGuard`). Adds:

- conviction curve (uint256 A, B, lockup[9])
- per-proposal conviction snapshots (mapping)
- wiring (relayStake, pauseRegistry, treasury)
- parameters (quorum, minGraceBlocks, proposeBond, three bps values)
- `pendingGovPayout[address] → uint256`
- `treasuryBalance` (uint256)
- `nextProposalId` + `_proposals` + `_votes`

## Upgrade

Upgradable via DatumGovernanceRouter. Migration must preserve at
minimum `pendingGovPayout` (in-flight claims) and `_proposals` /
`_votes` (in-flight proposals). The conviction-curve state copies
trivially.
