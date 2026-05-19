# DatumCouncil

Phase-1 governance: N-of-M trusted-member council. Any member can propose
an arbitrary set of `(target, calldata)` calls; a proposal passes when it
accumulates `threshold` YES votes; an `executionDelayBlocks` cooldown
follows; a `guardian` can veto within `vetoWindowBlocks` of creation.

This is the production governance for the period between "team multisig"
(Phase 0) and "full open conviction voting" (Phase 2). The Council is
selected at deploy and self-governs from there.

## Self-governance

Council membership, threshold, guardian, voting periods, execution delay,
and veto window are all managed via *council proposals targeting this
contract itself*. The functions are gated with `onlyCouncil` (which
resolves to `msg.sender == address(this)`), so the only way to change
parameters is to propose, vote, and execute through the normal flow.

Bootstrap exception: at deploy, the initial owner can call `addMember`
once each to seed the membership. After the first proposal executes, owner
authority drops to administrative-only (it can't change membership
unilaterally any longer).

## Floors

The G-L2 and G-L3 audit pins:

- `MIN_THRESHOLD = 2` — council can't degrade to 1-of-1 dictator.
- `MIN_COUNCIL_SIZE = 3` — minimum membership.
- `MIN_EXECUTION_DELAY = 1` and `MIN_VETO_WINDOW = 1` — non-zero cooldown
  and veto buffer required.

A self-proposal that violates any floor reverts on execution.

## Proposal lifecycle

```
1. propose(targets[], calldatas[], description) — member only
2. (voting period) — members call vote(id, support=true/false)
3. once approvals ≥ threshold → state = Succeeded
4. (execution delay) — anyone-may-veto window
5. (veto window for guardian) — guardian.veto(id) cancels
6. execute(id) — anyone may call after delay, before maxExecutionWindow
```

A proposal in `Succeeded` state but past `maxExecutionWindow` blocks
becomes Expired. The window-expiry prevents stale governance decisions
from being executed long after the politics have moved on.

## Guardian

A single guardian address has veto authority over proposals during the
veto window. The intent: the guardian is typically a separate multisig
(maybe even the deployer's team) that can stop a clearly-malicious
proposal even if the council voted for it. After the veto window expires,
the guardian has no recourse — execution proceeds.

The guardian itself is governance-set via a council proposal. The bootstrap
deployer wires an initial guardian; the council can replace.

## Usage with Router

```
router.setGovernor(GovernancePhase.Council, address(council))  // via Timelock
```

After that, every action that GovernanceV2 *would* take (activate, terminate,
demote a campaign) becomes a Council proposal whose targets are the Router.
E.g. `targets = [router]; calldatas = [activateCampaign(42)]`.

## ERC-20 rescue path

Council inherits a `rescueERC20(token, to, amount)` callable via council
proposal (`onlyCouncil`). Lets a future proposal sweep accidentally-sent
tokens out of the Council contract itself (mistransfers to the Council
address aren't impossible).

## Pause behavior

The Council itself isn't paused by the global PauseRegistry. The
rationale: pausing governance globally is a *guardian* call already (one
of the pause-registry categories is CAT_GOVERNANCE). A separate
council-level pause would be redundant.

## Why both Council and AdminGovernance

Phase 0 has `DatumAdminGovernance` — a team-multisig direct-approval
governor. Phase 1 graduates to Council. The migration is just a
`router.setGovernor` from AdminGovernance to Council. The protocol can sit
in Phase 1 indefinitely; "Phase 2 (OpenGov via GovernanceV2)" is the
end-state aspiration but not required.
