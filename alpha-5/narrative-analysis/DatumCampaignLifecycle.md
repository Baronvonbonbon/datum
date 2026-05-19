# DatumCampaignLifecycle

The state-machine that ends campaigns. Settlement starts campaigns; Lifecycle
finishes them. Three exit paths: **Completed** (budget exhausted), **Terminated**
(governance kill via fraud upheld), **Expired** (inactivity timeout).

## Why a separate contract

Originally inline in Campaigns; extracted to keep Campaigns' bytecode under
PVM limits and to make the lifecycle transitions independently testable.
Lifecycle owns the cross-contract orchestration; Campaigns owns the data.

## The three exit paths

### `completeCampaign(id)`
Called by `DatumSettlement` when a budget deduction returns `exhausted = true`,
or by the governance contract on a fraud-not-upheld outcome that the
advertiser wants to wind down. Drains all remaining pots back to the
advertiser via `BudgetLedger.drainToAdvertiser`, returns the challenge bond
(if wired) via `challengeBonds.returnBond`, and flips the campaign to
`Completed`.

### `terminateCampaign(id)`
Called by the governance contract (typically `GovernanceRouter` →
`GovernanceV2` or Council). Drains the remaining budget with a slash: 10%
to the governance contract's slash pool, 90% back to the advertiser. The
exact slash bps is read from GovernanceV2's `slashBps` parameter. Marks the
campaign `Terminated`.

### `expireCampaign(id)`
Permissionless. Anyone can call after `inactivityTimeoutBlocks` (default 30
days at 6s/block = 432,000 blocks) have elapsed since the last settlement
on this campaign. Refunds advertiser, returns bond, marks Expired. The bot
incentive to call it: keeps the protocol clean and frees the advertiser's
challenge bond which would otherwise sit idle.

## Pause check

`whenNotPaused` reads `pauseRegistry.pausedSettlement()` — same category as
Settlement itself. Termination by governance is a settlement-domain action
(it touches budget escrow); a governance-only pause shouldn't block it.

## Plumbing lock

All refs (campaigns, budgetLedger, governanceContract, settlementContract,
challengeBonds) are set via owner; `lockPlumbing()` freezes them. The
challengeBonds ref is optional — leaving it at `address(0)` disables the
bond return / slash flow.

## Authorization matrix

| Function | Caller |
|---|---|
| `completeCampaign` | Settlement (on exhaust) or governance |
| `terminateCampaign` | Governance only |
| `expireCampaign` | Anyone, after inactivity timeout |
| `setX` setters | Owner, pre-plumbingLock |

## Notable design choices

- **Inactivity timeout immutable.** Set at construction (constructor takes
  `inactivityTimeoutBlocks`). Not governance-tunable. The design intent:
  this is a backstop, not a policy lever. 30 days is enough headroom that
  legitimate slow-burn campaigns won't get expired on their first dry
  patch, but short enough that abandoned campaigns don't tie up bonds
  forever.
- **No `pause()` on individual campaigns.** Pausing happens globally via
  `DatumPauseRegistry`. A campaign-level pause would create governance
  complexity (who can pause? what about a publisher pausing the campaigns
  on their own inventory?) that the protocol opted out of.
- **No `restart` from Completed/Terminated/Expired.** Once you exit Active,
  you cannot re-enter. Run a new campaign. This keeps the state machine a
  DAG.

## Why call it from Settlement

`completeCampaign` is fired by Settlement at the moment a deduction
exhausts the last pot. This is the only cross-contract call Settlement
makes in `_processBatch` for status reasons, and it's intentionally
non-reverting: the call is unwrapped (no try/catch) because Lifecycle is a
trusted ref and reverting would brick settlement. Anything that could
revert (bond return, etc.) is wrapped on the Lifecycle side.
