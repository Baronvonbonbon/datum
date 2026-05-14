# Council Member

Phase-1 governance: one of N members of `DatumCouncil`. Proposes,
votes, and executes governance actions through the standard N-of-M
council flow. In production, the Council is the protocol's primary
governor for the period between bootstrap and full OpenGov.

## On-chain footprint

Council membership lives in `DatumCouncil` as an address-set with a
configurable `threshold`. Floors: `MIN_COUNCIL_SIZE = 3`,
`MIN_THRESHOLD = 2`. Members are added/removed via council proposals
targeting the Council itself (`addMember(addr)` / `removeMember(addr)`
gated to `onlyCouncil` — i.e., `msg.sender == address(this)`).

## End-to-end flow

### Onboarding

1. **Be added at deploy** — the constructor takes an initial member
   set; the deployer chooses these.
2. **Be added via council proposal post-deploy** — any existing
   member proposes `addMember(newMember)`. After threshold approvals
   + execution delay, the new member is in.
3. The owner of the Council (typically Timelock) can NOT directly add
   members post-bootstrap. Self-governance only.

### Steady state — proposing

A council member who wants to enact something on-chain proposes:

```
council.propose(
    targets[],     // contract addresses to call
    calldatas[],   // ABI-encoded calls
    description    // string for off-chain context
) → returns proposalId
```

Typical proposal targets via the Router:
- `router.activateCampaign(id)` — activate a pending campaign.
- `router.terminateCampaign(id)` — terminate an active campaign for
  fraud or policy violation.
- `router.demoteCampaign(id)` — soft-kill without slash.

Direct-target proposals:
- `publishers.setBlocklistCurator(newCurator)` — only if Council is
  owner.
- `curator.block(addr, reasonHash)` — if the Council is the
  curator's authority.
- `pauseRegistry.proposeCategoryUnpause(catMask)` — only if a Council
  member is also a guardian (not typical).

### Voting

Each member calls `vote(proposalId, support)` where `support` is
boolean. The proposal's state transitions:

```
Pending → Voting → Succeeded (≥ threshold YES votes)
                 → Failed (voting period ends without threshold)
```

Once Succeeded, the proposal enters an `executionDelayBlocks` cooldown
(`MIN_EXECUTION_DELAY = 1` floor; production typically 1 day).

### Veto window

While in the cooldown, the **guardian address** (a separate, single
address — could be a guardian of the PauseRegistry, could be a
separate guardrail multisig) can `veto(proposalId)` within
`vetoWindowBlocks` (`MIN_VETO_WINDOW = 1` floor). The veto is final;
the proposal can't be re-executed.

After the veto window, the proposal is unblockable.

### Execution

```
council.execute(proposalId)
```

Anyone can execute a non-vetoed, non-expired, post-delay Succeeded
proposal. The Council uses a low-level `target.call(data)` for each
target/calldata pair. If any call reverts, the whole execution
reverts and the proposal can be retried (within
`maxExecutionWindow`).

After `maxExecutionWindow` blocks, the proposal expires. Stale
governance decisions don't haunt the protocol.

### Self-governance examples

Member rotation:
```
propose([address(this)], [removeMember.encode(oldAddr)], "rotate")
... vote, delay, veto window ...
execute → oldAddr is removed
```

Threshold change (subject to MIN_THRESHOLD floor):
```
propose([address(this)], [setThreshold.encode(3)], "increase quorum")
```

Guardian rotation (replaces the council's own veto guardian):
```
propose([address(this)], [setGuardian.encode(newGuardian)], "rotate veto")
```

### ERC-20 rescue

If tokens are accidentally sent to the Council contract, members can
propose `rescueERC20(token, to, amount)` to sweep them. Owner-gated
to `onlyCouncil`.

## Economic exposure

- **No direct on-chain stake.** Council membership is reputational +
  permissioned, not bonded.
- **Could add staking in a future upgrade.** Currently not wired.

## Who polices the council

- **Other council members:** removeMember proposals can boot a
  misbehaving member.
- **The veto guardian:** can stop any proposal in the cooldown
  window. Asymmetric: a single guardian can veto, but a single
  council member can only propose.
- **The Timelock:** owns the Router. Even if Council becomes
  malicious, advancing the protocol to Phase 2 (OpenGov via
  `router.setGovernor(OpenGov, address(govV2))`) is a Timelock
  action that can be community-pushed.
- **The PauseRegistry guardians:** can pause CAT_GOVERNANCE to halt
  Council proposal execution if needed.

## Trust assumptions placed on council members

- That at least `threshold` members will be online to vote.
- That they will follow the protocol's spirit (advertiser/publisher
  fairness, no unilateral censorship).
- That when there's a community consensus to graduate to Phase 2, the
  Council won't obstruct it.

The Council is a *trusted* committee. Phase 1 is explicitly the "we
trust the Council" stage; the cypherpunk progression is to graduate
to Phase 2 OpenGov where the Council role becomes ceremonial or is
retired entirely.
