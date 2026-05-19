# DatumSettlementRateLimiter

BM-5 per-publisher window-based rate limiter. Caps view events a
single publisher can settle per window so a compromised publisher
can't drain a campaign in a single block. View events only —
clicks and actions are per-event rate-limited at the application
layer, not here. Carved back out of DatumSettlement (alpha-3
satellite restored for EIP-170).

## Hot-path interface

`tryConsume(publisher, events)`:

- Gated to `msg.sender == settlement` (`OnlySettlement`).
- `rlWindowBlocks == 0` short-circuits to `true` (limiter disabled).
- `events == 0` short-circuits to `true`.
- Computes `windowId = block.number / rlWindowBlocks`.
- Reads current accumulator `publisherWindowEvents[publisher][windowId]`.
- Returns `false` if `current + events > rlMaxEventsPerWindow`
  (rejects the entire claim — Settlement sets `gapFound` and rejects
  with reason 14).
- Otherwise writes back the incremented counter and returns `true`.

Atomic check-and-increment. Settlement no longer has to read-then-
write the counter inline — the limiter owns the bookkeeping.

## Window size is lock-once

`setRateLimits(windowBlocks, maxEventsPerWindow)`:

- Bounded: `windowBlocks >= MIN_RL_WINDOW_SIZE` (10).
- `maxEventsPerWindow > 0`.
- Reverts `WindowFrozen` if `windowBlocks` is being changed (the
  `maxEventsPerWindow` cap remains tunable).

The window size is lock-once for the same reason as
DatumNullifierRegistry: changing it mid-flight would either DoS
in-flight publisher windows or, if the new size divides the old,
re-open already-used windows for double-use.

`maxEventsPerWindow` IS tunable forever (subject to `whenNotFrozen`).
Operationally that's the right knob: the window size sets the
period semantics; the cap sets the policy.

## Governance surface

- **`setRateLimits(windowBlocks, maxEventsPerWindow)`** — owner-only,
  `whenNotFrozen`. Window size lock-once after first non-zero value;
  cap is freely tunable.
- **`setSettlement(addr)`** — owner-only; locked by `lockPlumbing`.
- **`lockPlumbing()`** — owner-only, `whenOpenGovPhase`. Permanent.

## Views

`currentWindowUsage(publisher) → (windowId, events, limit)` is consumed
by relay-bot dashboards to detect publishers approaching the cap.
Returns `(0, 0, 0)` when the limiter is disabled.

## Trust assumptions

- Settlement is the sole writer.
- A captured Settlement could submit fake `tryConsume` calls that
  burn budget for a publisher; the worst case is "publisher hits
  cap and gets temporarily limited". Recovery is automatic at the
  next window boundary.
- A captured governance setting `rlMaxEventsPerWindow = 1` would
  effectively DoS every publisher. Mitigated by the upgrade-ladder
  Timelock + bicameral veto on parameter changes once OpenGov is live.

## Why per-publisher, not per-campaign

A campaign with a single (compromised) publisher could be drained
in one tx. Per-publisher capping forces an adversary to control N
publishers to drain N× faster. Combined with `DatumPublisherStake`'s
bonding curve (cost-to-onboard grows with cumulative impressions),
the multi-publisher attack has a real economic floor.
