# Process Flow Analysis — by Role

End-to-end action sequences for each role in the DATUM protocol, plus a
final matrix showing how each role is bounded by every other.

These docs assume you've read the per-contract narratives in
`../`. They're indexed there but the relevant ones are linked inline below.

## Roles

1. **[User](./user.md)** — installs the extension, sees ads, earns DOT
   (plus optional DATUM, plus optional ERC-20 rewards). The protocol's
   end-customer.
2. **[Publisher](./publisher.md)** — operator of a site or app
   serving DATUM ads. Stakes DOT, registers, integrates the SDK, signs
   batches, takes a configurable percentage of every settlement.
3. **[Advertiser](./advertiser.md)** — creates campaigns, funds them
   with DOT, sets policy (AssuranceLevel, tags, minStake, etc.),
   optionally posts a challenge bond.
4. **[Relay Operator](./relay-operator.md)** — runs the off-chain
   service that aggregates claims and submits batches. Could be the
   publisher themselves (publisher-relay path) or a third-party
   service.
5. **[Reporter](./reporter.md)** — off-chain operator committing
   stake-root Merkle commitments to `DatumStakeRoot`. The cryptographic
   anchor for Path A.
6. **[Guardian](./guardian.md)** — one of three addresses with
   fast-pause authority on `DatumPauseRegistry`. The protocol's
   emergency-response role.
7. **[Council Member](./council-member.md)** — Phase-1 governance
   member. Proposes, votes, and executes through `DatumCouncil`.
8. **[OpenGov Voter](./opengov-voter.md)** — anyone with DOT in
   Phase-2. Casts conviction-weighted votes in `DatumGovernanceV2`,
   `DatumPublisherGovernance`, `DatumAdvertiserGovernance`,
   `DatumParameterGovernance`.
9. **[Deployer / Timelock Operator](./deployer-timelock.md)** —
   bootstrap admin role; routes administrative changes through
   `DatumTimelock` post-Phase-0.

## The matrix

10. **[Checks and Balances](./checks-and-balances.md)** — pair-wise
    matrix: how role X is constrained by role Y, with the contracts and
    gates that enforce it.

## How to read these

Each per-role doc has the same structure:

- **What the role does** — plain-language summary.
- **On-chain entry points** — the contracts and functions they touch,
  in approximate first-to-last call order.
- **Lifecycle** — onboarding → steady-state → exit.
- **Economic exposure** — what they put on the line, what they earn,
  what they can lose.
- **Who polices them** — the roles and mechanisms that constrain them.

The checks-and-balances doc cross-cuts: for each pair (role × role),
which contract enforces the constraint and what happens on violation.
