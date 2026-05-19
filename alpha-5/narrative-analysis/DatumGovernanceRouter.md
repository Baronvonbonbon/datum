# DatumGovernanceRouter

A stable-address proxy between the action contracts (`DatumCampaigns`,
`DatumCampaignLifecycle`) and whichever governance contract is currently
in charge. Lets the protocol progress through governance phases
(Admin → Council → OpenGov) without re-wiring every action target.

## The problem this solves

`DatumCampaigns.governanceContract` is set once and trusted thereafter.
If the protocol upgrades from `DatumAdminGovernance` (Phase 0) to
`DatumCouncil` (Phase 1) to `DatumGovernanceV2` (Phase 2), Campaigns'
governance pointer needs to update — but Campaigns is critical
infrastructure and you really don't want to hot-swap its references.

Router fixes this: both Campaigns and Lifecycle point at the Router once
and never change. Phase transitions only need `router.setGovernor(phase,
newGovernor)` — a single owner call (timelocked).

## Phases

```
enum GovernancePhase { Admin, Council, OpenGov }
```

The phase enum exists for off-chain observability (UI, governance dashboards)
more than for on-chain enforcement. The actual gate is `msg.sender == governor`.

## How calls flow

```
GovernanceV2 wants to activate campaign id 42
   → calls router.activateCampaign(42)
   → Router checks msg.sender == governor (== GovernanceV2)
   → Router calls campaigns.activateCampaign(42)
   → Campaigns checks msg.sender == governanceContract (== Router) ✓
```

Router implements the `IDatumCampaignsMinimal` and `IDatumCampaignLifecycle`
interfaces enough that GovernanceV2 can call into it as if it were the
real contract.

## Owner = Timelock

In production, Router's `owner` is the Timelock. To advance the phase, you:

1. `timelock.propose(target = router, data = setGovernor(NewPhase, NewGovernor), salt)`
2. Wait 48 hours.
3. `timelock.execute(...)`
4. From the next block, the new governor is in charge.

The 48-hour delay gives the community time to inspect, dispute, or unwind
a phase transition before it lands.

## Forwarded functions

- `activateCampaign(id)` → `campaigns.activateCampaign`
- `terminateCampaign(id)` → `lifecycle.terminateCampaign`
- `demoteCampaign(id)` → `lifecycle.demoteCampaign`
- Plus IDatumCampaignsMinimal view forwarders for GovernanceV2's
  status-read needs.

## Why a separate contract instead of just owner-of-Campaigns

You could imagine making the governance contract directly `owner` of
Campaigns. Two reasons not to:

1. **Owner is also the admin for many other settings**. Putting governance
   in the owner slot conflates two roles (admin and governor). Router
   separates them: owner = Timelock for admin, governor = phase-current
   governance for lifecycle decisions.
2. **Phase transitions need to be auditable.** Router emits explicit
   `GovernorSet` events; tracing "who was in charge at block N" is one
   indexed event lookup.

## Lock-once on `campaigns` and `lifecycle`

The two forwarding targets are set once (in constructor or via owner) and
frozen. The Router doesn't itself need swap surface; the abstraction is
between Router and governance, not Router and the action targets.

## Pause behavior

None directly. The pause check happens at the receiving end (Campaigns or
Lifecycle reads the relevant pause category).

## Stage 1 extension: contract registry

The router was extended (upgrade-ladder Stage 1, 2026-05-18) into a
**global contract registry**. Every upgradable contract (~36 of 57)
registers a `bytes32 name → address` mapping here. Consumers
(other contracts, web app, extension) look up the live address by
name instead of holding a fixed reference.

```solidity
mapping(bytes32 => address) public currentAddrOf;   // name → live addr
mapping(bytes32 => address[]) public addressHistory;
mapping(bytes32 => uint256) public versionOf;       // monotone
```

The names are `bytes32` keys like `keccak256("DatumSettlement")`.
The deploy script pre-populates them all at Stage 5.

### `upgradeContract(name, newAddr)`

Governance-only. The on-chain upgrade primitive:

```
upgradeContract(name, v2Addr)
  ├ require(versionOf[name] + 1 == v2.version())
  ├ require(v1.frozen()) — predecessor must be paused
  ├ v2.migrate(v1) — copy state via per-contract _migrate
  ├ currentAddrOf[name] := v2Addr
  ├ addressHistory[name].push(v2Addr)
  └ versionOf[name]++
```

Off-chain consumers see a single `ContractUpgraded(name, v2,
version)` event and refresh their cached address. Other contracts
that hold cached references get re-wired via their respective
setters.

## Phase floor monotonicity

`raisePhaseFloor()` — owner-only, idempotent. Records the highest
phase the system has ever reached:

```
After Phase 0 → 1: raisePhaseFloor() locks setGovernor against
  proposals that would regress to Phase 0.
After Phase 1 → 2: raisePhaseFloor() again locks against regression
  to Phase 1.
```

The floor is a one-way ratchet. `setGovernor(newPhase, ...)` reverts
if `newPhase < phaseFloor`. Closes PRE-REDEPLOY M4 (governance
de-decentralization risk).

There's a deliberate escape hatch: `setGovernor(currentPhase, newGovernor)`
is allowed — rotating WITHIN a phase to a fresh contract is fine.
Just no regression backward.

## `whenOpenGovPhase` for the router's own locks

The router exposes `lockPlumbing()` that freezes the
`(campaigns, lifecycle)` forwarding targets permanently. Because
the router IS the phase source, it can't use the
`whenOpenGovPhase` modifier from `DatumUpgradable` — that would be
circular. Instead, the router uses a local
`require(phase == GovernancePhase.OpenGov, "not-opengov")` check.

## Admin-phase shortcuts

The router carries `adminActivateCampaign(id)`,
`adminTerminateCampaign(id)`, `adminDemoteCampaign(id)` for Phase 0
operational convenience. Each is gated on `onlyAdminPhase` —
they're inert once the governor is the Council or OpenGov contract.
Audit G-M1 fix closed the original surface where these were
owner-callable forever.
