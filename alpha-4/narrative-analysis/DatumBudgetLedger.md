# DatumBudgetLedger

The escrow that holds advertiser DOT until it's earned. Every active campaign
has one Budget struct per action type (view / click / remote-action); each
holds the remaining balance, a daily cap, the per-day spent counter, and the
day index that counter was last reset on. Settlement charges against these
budgets; Lifecycle drains them on completion/termination.

## Who can write

- **`DatumCampaigns`** calls `initBudget(id, actionType, amount, dailyCap)`
  exactly once per pot when a campaign is created. It is payable; the DOT
  forwarded becomes the pot's `remaining`.
- **`DatumSettlement`** calls `deductAndTransfer(id, actionType, amount,
  paymentVault)`. The contract decrements `remaining`, enforces `dailyCap`,
  forwards DOT to `paymentVault`, and returns `exhausted = true` when the
  pot hits zero so Settlement can mark the campaign Completed.
- **`DatumCampaignLifecycle`** calls `drainToAdvertiser(id)` (full refund on
  Completed/Expired) or `drainFraction(id, bps, governance)` (partial refund
  + slash split on Terminated).

## The daily cap mechanic

`dailyCap` enforces a per-UTC-day ceiling on how fast a campaign can spend.
The day index is `block.timestamp / 86400`. When `lastSpendDay` advances,
`dailySpent` resets to zero. The cap matters most for view-pot CPM
campaigns where a fraud spike could otherwise drain a day's budget in a
single block.

## Refund accounting

`drainToAdvertiser` doesn't push DOT to the advertiser EOA — that would let
a contract-advertiser with a reverting fallback DoS the lifecycle flow.
Instead it credits `pendingAdvertiserRefund[advertiser]`; the advertiser
pulls via `claimRefund`. M-1 audit fix.

`drainFraction(id, slashBps, governance)` splits the remaining balance:
`slashBps` → governance contract, the rest → advertiser pull queue. Used
when GovernanceV2 terminates a campaign for fraud.

## Pause behavior

`initBudget`, `deductAndTransfer`, and the drain functions check
`pauseRegistry.pausedSettlement()` (NOT the all-categories `paused()` —
governance can still drain a terminated budget during a settlement pause).

## The `_send` invariant

All DOT outflows from this contract go through a single private `_send(to,
amount)` that wraps `PaseoSafeSender._safeSend`. This is the only callsite
that moves native value off the contract; auditors get one place to verify.

## Notable fields

- `_budgets[id][actionType]` — the canonical Budget struct.
- `pendingAdvertiserRefund[addr]` — pull-payment queue for refunds.
- `lastSettlementBlock[id]` — last block a deduction happened on this
  campaign. Drives the `inactivityTimeoutBlocks` expiry path in Lifecycle.
- `treasury` (immutable) — fixed at deploy. Dust-recipient for rounding
  remainders that can't be returned cleanly. SL-1 audit pin.

## Why it's its own contract

Separation of concerns: Campaigns is "the policy bundle", Settlement is "the
state-machine that pays out", Lifecycle is "the state-machine that resolves",
and Ledger is "the value escrow." Moving budget custody here removed
~3KB from Campaigns' bytecode and made the value path independently
testable. The Settlement, Lifecycle, and Campaigns references on this
contract are all lock-once.
