# DatumParameterGovernance

A separate conviction-vote governance instance dedicated to FP-stack
parameter changes — typically `setParams` calls on `DatumPublisherStake`,
`DatumPublisherGovernance`, `DatumNullifierRegistry` (when present), and
similar parameterised contracts.

## Why a separate governance contract

`DatumGovernanceV2` handles campaign-lifecycle decisions (activate /
terminate / demote). Mixing parameter changes into the same contract
would conflate two distinct quorum models:

- Campaign decisions are *per-campaign* — quorum is measured against a
  campaign-scoped vote pool.
- Parameter changes are *protocol-wide* — every voter should be able to
  participate, and the quorum threshold should reflect the systemic
  weight of the change.

Splitting them keeps each instance's quorum + slash settings independent.
It also means a busy campaign-vote period doesn't congest protocol-wide
parameter changes, and vice versa.

## The conviction table

Same step-function as the original DatumPublisherGovernance / V2:

```
weight: [1, 2, 3, 4, 6, 9, 14, 18, 21]
lockup: [0, 14400, 43200, 100800, 302400, 1296000, 2592000, 3888000, 5256000]
```

Note this contract still uses the *hardcoded step function* rather than
the governable quadratic curve. The alpha-4 governable-gating refactor
covered V2 / PubGov / AdvGov; ParameterGovernance was left on the step
table because retuning the parameter-vote curve is itself a parameter
change, and the recursive dependency made the governable upgrade fragile.
A future pass may align it.

## Proposal flow

```
1. propose(target, payload, description) payable
     - msg.value == proposeBond
     - payload = ABI-encoded call to a target's setParams() or equivalent
2. vote(id, aye, conviction) payable
     - locks DOT for the conviction's lockup
3. After endBlock: resolve(id)
     - Passed if ayeWeight > nayWeight && ayeWeight >= quorum
     - Rejected otherwise
4. After executeAfter: execute(id)
     - Only on Passed proposals
     - Calls target.call(payload)
     - Refunds proposeBond
5. Voters call withdrawVote(id) after lockup
```

## Authorization to govern a target

For ParameterGovernance to actually be able to retune `DatumPublisherStake.setParams`,
PublisherStake's `owner()` must be set to ParameterGovernance's address.
This is the standard governance handover: target.transferOwnership(governance).

In practice the targets are owned by the Timelock, and ParameterGovernance
is one of several proposers into the Timelock. A passed parameter
proposal here emits a call to `timelock.propose(target, data, salt)`,
which then goes through the 48-hour delay.

Some deployments may wire ParameterGovernance as the direct owner of
PublisherStake et al., bypassing the Timelock — the trade-off is faster
parameter response (no 48h delay) versus weaker safety net.

## Why "bond required" for propose

`proposeBond` filters spam. Unlike PublisherGovernance where the bond is
linked to fraud accusation cost, here the bond is purely a cost-of-
proposal floor. Refunded on execute (Passed), forfeited to treasury on
Rejected.

## Pull-payment

Same pattern as other governance contracts: `_safeSend` for outflows,
withdrawVote pulls voter locks back, proposeBond refunded through a
queue.
