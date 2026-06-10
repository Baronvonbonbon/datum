# DatumBondedIdentityReporter

Permissionless bonded multi-reporter set for People Chain identity
attestations. Mirrors `DatumStakeRootV2`'s design at a different
trust surface: anyone with ≥ `reporterMinStake` PAS can join,
submit attestations (with bond), approve to fast-finalize, or
challenge (with bond).

Companion: [`bonded-reporter-identity.md`](./bonded-reporter-identity.md).

**Status: deployed but not wired.** Per `deploy-runbook-paseo.md` §11,
this contract is deployable on Paseo today but not yet wired as a
writer on `DatumPeopleChainIdentity`. The cache currently uses the
`oracleReporter` path (Diana) plus the `xcmDispatcher` path (the
XCM bridge). Wiring this contract is a runtime decision via
governance — either add a `bondedReporter` writer slot to the cache
(additive) or repurpose the `xcmDispatcher` slot.

## Why a third path

`DatumPeopleChainIdentity` already has two writer paths:

- **`oracleReporter`** — a single trusted EOA (Diana on Paseo)
- **`xcmDispatcher`** — the trustless future-state via the XCM bridge

This contract offers a middle ground: **multi-reporter consensus
WITHOUT requiring People Chain → Hub trustless bridging**. Multiple
parties stake; each can submit; the others approve or challenge.
Useful during the long lead time before pallet-revive's
synchronous XCM-Query precompile ships.

## Attestation lifecycle

```
proposer ──submitAttestation(user, level, validity, bond)──► attestation Pending
                                                              │
                approvers ──approveAttestation──► fast-finalize
                                                              │
                challenger ──challengeAttestation(bond)──► Contested
                                                              │
                                                  resolve (owner v1; registrar-sig v2)
                                                              │
                                                              ▼
            any caller ──finalize──► cache.submitAttestation
```

Each attestation is keyed by `keccak256(proposer, user, nonce)` so
the same proposer can have many in-flight attestations for the same
user. Status: `None`, `Pending`, `Approved`, `Contested`,
`Resolved`, `Finalized`.

## Resolution paths

- **v1 (current):** Owner-arbitrated. Challenge resolution is
  governance-driven (Option γ in the design doc). Acceptable for
  the early-stage trust model.
- **v2 (future, registrar-sig):** People Chain registrar
  signatures verified on Hub. Requires anchoring the registrar set
  on-chain — design Section 3a of `bonded-reporter-identity.md`.

## Stake + slash

Mirror of `DatumStakeRootV2` model:

- `reporterStake[address]` — amount, joinedAt, exitProposedBlock.
- `totalReporterStake` — sum of active stake.
- `proposerBond` per attestation, slashed if challenge upheld.
- `challengerBond`, refunded + bonus on challenge upheld; slashed
  on challenge failed.
- `slashApproverBps` (≤ 5000) caps approver slash on attestations
  found fraudulent.

Same exit flow: `proposeReporterExit()` zeros voting weight,
delays for `reporterExitDelay`, then `exit()`. Slash applies during
the delay; exit-propose isn't a slash escape.

## Bounds + ceilings

| Param | Ceiling |
|---|---|
| `approvalThresholdBps` | 9900 (99%) |
| `challengeWindow` | 1.2M blocks (~84d) |
| `reporterExitDelay` | 1.2M blocks (~84d) |
| `slashedToChallengerBps` | 10000 (100%) |
| `slashApproverBps` | 5000 (50%) |
| Validity bounds | [600, 1.44M] blocks |

## Cache integration

When `finalize` fires, the contract calls
`cache.submitAttestation(user, level, validityBlocks)` on the
identity cache. This requires the cache to authorize this contract
as a writer. Options:

- **(a) additive:** Add a `bondedReporter` slot to the cache.
- **(b) substitution:** Repurpose `xcmDispatcher` to point here,
  and have the XCM bridge submit through this contract.

The runbook recommends (a). Either way, the cache write requires
governance to wire this contract as one of the authorized writers.

## Lock-once

- **`setCache(addr)`** — owner-only, lock-once via `cacheLocked`.
- **Various bps + bond + delay setters** — owner-only,
  `whenNotFrozen`, bounded.

## Trust assumptions

- Stake floor `reporterMinStake` is the Sybil bound.
- Challenge bond is the false-positive bound — challengers lose
  the bond on failed challenges.
- v1 challenge resolution is owner-arbitrated. Until v2 ships,
  the owner is the trust root for resolution.
- A captured reporter cabal could collude to push fraudulent
  attestations, but each costs `proposerBond`; the challenge
  window gives time for honest reporters or external parties to
  challenge.

## Upgrade

Upgradable via DatumGovernanceRouter. State migration is non-trivial
(reporter list, stake, pending attestations, challenge state). v2
might replace this contract entirely once registrar-sig verification
is feasible.
