# DatumActivationBonds

Optimistic-activation collateral system. Lets routine campaigns go
Active without a governance vote: advertiser posts a bond at
`createCampaign`, a short timelock runs, and anyone may then
permissionlessly `activate()`. A challenger can dispute by posting
a counter-bond, escalating into a GovernanceV2 commit-reveal vote.
The losing side's bond is partially redistributed to the winner;
the remainder returns to the loser (refund floor — no wholesale
wipeouts).

Companion docs:
- [`proposal-stakeroot-optimistic.md`](./proposal-stakeroot-optimistic.md)
  — the original proposal
- [`optimistic-activation-phase-2b.md`](./optimistic-activation-phase-2b.md)
  — the mute extension

## State machine

Each campaign moves through a small state machine:

```
            openBond              challenge                 settle
   Idle ──────────────► Open ────────────────► Contested ──────────────► Resolved
                          │                       │
                          │ timelockExpiry        │
                          │ + activate            │
                          ▼                       │
                       Resolved ◄─────────────────┘
                       (creator
                        won)
```

`Phase` ∈ {Idle, Open, Contested, Resolved}.

## Phase A — Optimistic activation

1. **`openBond(campaignId, creator, creatorBond)`** — `onlyCampaigns`.
   Called from `DatumCampaigns.createCampaign` with the advertiser's
   bond. Records the bond, sets `timelockExpiry = block.number +
   _timelockBlocks`, snapshots `winnerBonusBps` + `treasuryBps`
   (audit-5 H1 anti-staleness — governance can't move them mid-flight),
   transitions to Open.
2. **`challenge(campaignId)`** payable — anyone within the timelock,
   not the creator. `msg.value >= creatorBond`. Transitions to
   Contested. The campaign goes through GovernanceV2's
   commit-reveal vote path; the protocol does NOT auto-activate.
3. **`activate(campaignId)`** — permissionless after `timelockExpiry`,
   provided the campaign is still Pending and not Contested.
   Calls `campaigns.activateCampaign(campaignId)`. Refunds the full
   `creatorBond` to creator via `_pending` (pull-pattern). Transitions
   to Resolved.
4. **`settle(campaignId)`** — reads campaign status after vote resolves:
   - Active (1): creator won. `_payoutCreatorWin` distributes
     `(challengerBond × winnerBonusBpsSnapshot)` to creator,
     `× treasuryBpsSnapshot` to treasury, remainder back to challenger.
   - Terminated (4): challenger won. `_payoutChallengerWin` does the
     mirror.
   - Expired (5): no-fault. Both sides refunded in full.
   - Anything else: revert E98.

## Phase B — Emergency mute

Runtime analogue: anyone can post a bond to mute an Active campaign
while a demote vote runs. ClaimValidator consults `isMuted(id)` to
reject claims during the mute.

1. **`mute(campaignId)`** payable — Active campaign only, `msg.value
   >= _muteMinBond` (default 10× minBond). Not the advertiser
   (audit-5 H2 fail-closed self-mute guard — if the advertiser
   getter reverts, mute is rejected).
2. While `m.active == true`, `isMuted(id) == true`. ClaimValidator
   rejects every claim for that campaign with the mute reason code.
3. **`settleMute(campaignId)`** — three exit branches:
   - Active still (vote rejected demote): mute bond paid to
     advertiser as compensation for the freeze period.
   - Terminated (vote upheld demote): mute bond refunded to muter
     with bonus from GovernanceV2 slash pool.
   - Timeout after `_muteMaxBlocks` (default 14400 ≈ 1 day): mute
     bond paid to advertiser, muter loses for prolonged grief.

Single-shot per campaign — `settleMute` must clear before a new
mute can open.

## Audit-5 hardening

- **H1: bps snapshot** — `winnerBonusBps` + `treasuryBps` are
  snapshotted into the campaign's `State` at openBond time, not
  read live at settle time. Governance can't move them between
  open and settle to favor one side.
- **H2: mute fail-closed** — `mute` reads the advertiser via
  try/catch and FAILS CLOSED on revert. A campaigns implementation
  lacking the getter cannot enable self-mute griefing.
- **M1: muter refund fallback** — `_payoutMuteRejected` refunds the
  muter when both advertiser and treasury are address(0), with
  `MuteBondReroutedToMuter` event. Prevents stranded bond + stuck
  mute when configuration is degenerate.

## Parameters (governable, bounded)

| Param | Default | Bound |
|---|---|---|
| `_minBond` | constructor | none (operational) |
| `_timelockBlocks` | constructor | `≤ MAX_TIMELOCK_BLOCKS` (1.2M ≈ 84d) |
| `_winnerBonusBps` | constructor | sum with treasuryBps ≤ 8000 |
| `_treasuryBps` | constructor | sum with winnerBonusBps ≤ 8000 |
| `_muteMinBond` | 10× minBond | none |
| `_muteMaxBlocks` | 14400 (~1d) | none |

The `MAX_PUNISHMENT_BPS = 8000` constant mirrors GovernanceV2 G-M2:
the loser always keeps ≥ 20% of their bond. No 100% slash is
expressible by design.

## Pull-pattern payouts

`_pending[address] → uint256` queue. All refunds + bonus payouts
write here; recipients call `claim()` or `claimTo(recipient)` to
pull. Matches `DatumChallengeBonds.pendingBondReturn` — avoids
hostile-advertiser-contract reentrancy blocking settlement.

## Governance surface

- **`setMinBond` / `setTimelockBlocks` / `setWinnerBonusBps` /
  `setTreasuryBps` / `setTreasury`** — owner-only,
  `whenNotFrozen`. Each emits its setter event.
- **`setMuteMinBond` / `setMuteMaxBlocks`** — owner-only, `whenNotFrozen`.
- **`setCampaignsContract(addr)` / `setLifecycleContract(addr)`** —
  owner-only, lock-once via `AlreadySet`.

## Trust assumptions

- DatumCampaigns is the authority for "did this campaign exist + is
  it still Pending" via `getCampaignForSettlement`.
- GovernanceV2 owns the contested-activation vote resolution; this
  contract just reads the status that the vote produced.
- Treasury is owner-set; operationally it should be the protocol
  treasury Safe, not the deployer EOA.
- Audit-5 H1 anti-staleness means a mid-flight governance retune
  of bps does not affect already-open campaigns.

## Upgrade

Upgradable via DatumGovernanceRouter. State to migrate includes the
`_state[id]` mapping (open bonds, snapshots), `_pending[address]`
queue, and `_mute[id]` mapping. A migration that drops `_pending`
balances would strand user funds — so a `_migrate` override must
copy the queue.
