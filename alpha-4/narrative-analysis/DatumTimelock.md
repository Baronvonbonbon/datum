# DatumTimelock

A standard 48-hour delay on owner-gated admin changes. Lets the community
inspect, dispute, or coordinate against proposed changes before they
land.

## Use case

In production, the Timelock is the `owner()` of every DATUM contract that
has owner-only setters. To change a setting (e.g. raise a quorum, swap
a curator, lock a feature):

1. Some authorised proposer calls `timelock.propose(target, data, salt)`.
2. Anyone can read the proposal on-chain and dispute.
3. After `TIMELOCK_DELAY = 172800 seconds` (48h), anyone calls
   `timelock.execute(target, data, salt)`.
4. Within `PROPOSAL_TIMEOUT = 604800 seconds` (7 days) post-delay,
   execution must occur, else the proposal expires (AUDIT-029).
5. Until execution, owner can `cancel(proposalId)`.

## Proposal identity

`proposalId = keccak256(target, data, salt)`. The salt allows the same
`(target, data)` pair to coexist as multiple proposals — necessary when
you legitimately want to redo a change after cancellation.

## Concurrency cap

`MAX_CONCURRENT = 10`. Prevents storage growth from spammed proposals.
A proposal lifecycle (propose → execute or cancel or expire) increments/
decrements `pendingCount`. The cap is on `pendingCount` at propose time.

## Authorization

`propose` is `onlyOwner`. So who is the owner of the Timelock itself?
Bootstrap: the deployer. Production: a multisig or — most cypherpunk
— the Timelock can be its own owner via a one-time `transferOwnership`
to its own address, making admin changes self-governing. (The current
deployment uses a multisig.)

`execute` is permissionless. Anyone can ratify a passed proposal.
`cancel` is `onlyOwner` — gives the owner an emergency abort.

## What it doesn't do

- It doesn't vote. Proposals pass automatically after the delay; no
  approval threshold. The Timelock is a *delay*, not a *vote*.
- It doesn't enforce that the target is a DATUM contract. The
  `target.call(data)` is generic. Anything ownable by the Timelock is
  governable through it.
- It doesn't snapshot calldata at proposal-time vs execute-time
  separately — `data` is stored at propose time and executed verbatim.

## Why 48 hours

Two business days is the conventional minimum for any change to a
production system. Long enough that the protocol's governance community
can react, short enough that legitimate operational changes don't drag.
The 7-day post-delay execution window means a proposal can sit pending
for at most 9 days total.

## Interaction with governance phases

In the protocol ladder:

- Phase 0 (Admin): Admin governance + Timelock + multisig. Most
  permissive; the deployer can route any change.
- Phase 1 (Council): Council proposes, executes through Timelock.
  Timelock owner becomes Council, so propose() is gated on a council
  proposal.
- Phase 2 (OpenGov): GovernanceV2 has the equivalent function built-in
  (conviction-weighted delay+execute). Timelock can be unowned at this
  point, used only as a fallback rescue path.

## ReentrancyGuard

`nonReentrant` on `execute()` since it makes an external call into
arbitrary contracts. Trust nothing.
