# DatumRelayStake

G-1 first close: bond gate + slash hook for the relay role. Mirrors
`DatumPublisherStake` / `DatumAdvertiserStake` in shape but with a
**flat minimum stake** (no bonding curve) — a relay's adversarial
power is not a function of cumulative throughput, so curve growth
would penalize productive relays without economic benefit.

Two roles consume this contract:

1. **DatumRelay** reads `isAuthorized(addr)` to gate its authorized-
   relayer set (pattern (b) augment: pass if EITHER manually
   authorized via the existing allowlist OR adequately staked here).
2. **DatumRelayGovernance** calls `slash(...)` when a fraud proposal
   resolves upheld. The full slashed amount is forwarded to the
   recipient (governance); governance handles the challenger /
   treasury split off-side.

Companion: [`proposals/relay-accountability.md`](./proposals/relay-accountability.md)
covers the full design rationale, the pattern (a/b/c) integration
choice, and the upgrade-path scaffold for the future Settlement-mark
(Approach A) or on-chain commitment (Approach B) variants.

## Authorization model

`isAuthorized(relay) → bool` returns true iff:

```
relayMinStake > 0
  AND stakeOf(relay).amount >= relayMinStake
  AND stakeOf(relay).exitRequestedBlock == 0   // not in exit
```

`relayMinStake == 0` → the gate is disabled; this view returns false
unconditionally. That's the deploy posture (RELAY_MIN_STAKE = 0):
no staked relay is recognized; the manual `authorizedRelayers`
allowlist is the only authorization path. Governance arms the gate
by calling `setRelayMinStake(floor)` once the production relayer
set has stabilized.

## Bond + exit lifecycle

```
stake()    payable ──► registered; amount += msg.value
topUp()    payable ──► same; non-zero-balance precondition
requestExit() ─────► exitRequestedBlock = block.number; isAuthorized → false
cancelExit() ─────► exitRequestedBlock = 0; isAuthorized re-enabled
finalizeExit() ───► after exitDelay blocks: refund remaining stake, remove from list
```

Slash applies during the delay window — `requestExit` is NOT a slash
escape. Symmetric with `DatumPublisherStake`'s R-H1 fix.

## Slash hook

`slash(relay, amount, recipient, reasonCode) → slashed`:

- Gated to `msg.sender == governance` (revert E18).
- `amount` is the slash target; `recipient` receives the funds;
  `reasonCode` is for the event (1=censorship, 2=front-run, 3=MEV,
  4=collusion — matches RelayGovernance's reason codes).
- **Refund-floor cap.** Per-call slash is capped at
  `MAX_PUNISHMENT_BPS = 8000` of the relay's *current* balance. A
  relay always retains ≥ 20% on any single slash. Repeated slashes
  across multiple proposals can compound to drain the bond, but no
  single slash can be a 100% wipeout.
- Returns the *actual* slashed amount after the cap. RelayGovernance
  uses this return value to compute the challenger / treasury split.

`relayStake.slash` forwards via `_safeSend(recipient, slashed)` —
inherits PaseoSafeSender for the eth-rpc denomination workaround.

## Cypherpunk locks

| Function | Effect | Phase |
|---|---|---|
| `lockStakeGate()` | `relayMinStake` becomes immutable | OpenGov (`whenOpenGovPhase`) |
| `lockPlumbing()`  | `relayContractAddr` + `governance` freeze | OpenGov |

Both are one-way. Pre-OpenGov, calls revert `not-opengov` via the
`DatumUpgradable.whenOpenGovPhase` modifier. Post-OpenGov,
governance fires them to ratify the cypherpunk end-state per the
upgrade ladder.

## Parameter surface

| Param | Default | Bound |
|---|---|---|
| `relayMinStake` | 0 (gate disabled) | none |
| `exitDelay` | constructor | `≤ MAX_EXIT_DELAY` (1.2M blocks ≈ 84d) |
| `MAX_PUNISHMENT_BPS` | 8000 (constant) | — |
| `MAX_EXIT_DELAY` | 1,209,600 blocks (constant) | — |

`relayMinStake` is the only knob `lockStakeGate` freezes. `exitDelay`
remains tunable forever (subject to `whenNotFrozen`) — operationally
it should rarely change, but the bound is operational not invariant.

## Trust assumptions

- `governance` is the sole slasher. A captured governance contract
  could submit fraudulent slash calls; the refund-floor cap limits
  per-call damage to 80% of current stake, and OpenGov + Timelock
  govern any rotation of the governance pointer.
- A captured owner pre-`lockPlumbing` could rotate `governance` to
  a hostile contract. Mitigated by Timelock + Council veto window.
- A captured owner pre-`lockStakeGate` could lower `relayMinStake`
  to admit a captured relay below the production floor. Mitigated
  by the upgrade-ladder Timelock; post-OpenGov, `lockStakeGate`
  removes the surface entirely.

## Storage layout

Inherits `DatumUpgradable` (router + frozen + migrated + 50-slot
gap). Adds:

- `relayContractAddr`, `governance` (one slot each)
- `plumbingLocked`, `stakeGateLocked` (packed)
- `relayMinStake` (uint256)
- `exitDelay` (uint64)
- `_stake[address] → Stake` mapping
- `relayList[]` + `_relayIndex` for iteration
- `totalStaked` (uint256)

No pull-payment queue is needed — slash funds go directly to the
recipient (governance), and finalized exits go directly to the relay.

## Upgrade

Upgradable via DatumGovernanceRouter. State migration includes
`_stake[]` mapping (per-relay amounts + join/exit blocks),
`relayList[]`, `totalStaked`. The list iterability lets a `_migrate`
override paginate cleanly.
