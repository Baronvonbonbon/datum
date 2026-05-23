# Alpha-5 v5 Verification Snapshot

Captured 2026-05-23, post v5 redeploy (deployedAt
`2026-05-23T12:23:32.462Z`).

This document is the immutable record of "what was live on Paseo at the
v5 milestone" — used as the diff base for any future change.

## Network

- Chain: Paseo Hub (chainId `420420417`)
- RPC: `https://eth-rpc-testnet.polkadot.io/`
- Explorer: `https://blockscout-testnet.polkadot.io`
- Deployer: `0x94CC36412EE0c099BfE7D61a35092e40342F62D7`

## Phase A contracts

```
DatumCampaigns @ 0x3a7AB32f47f789A59c0dd659fd2DB08E4662E149
  version()                 = 2
  minimumCpmFloor           = 10000000 planck    (= 0.001 DOT/1000 imps)
  pendingTimeoutBlocks      = 100800             (= ~7 days)
  minimumCpmFloorLocked     = false
  owner()                   = 0x94CC36412EE0c099BfE7D61a35092e40342F62D7

DatumCampaignLifecycle @ 0x99A876954Bf4294e59938f5A031e41D508e372b4
  version()                       = 2
  inactivityTimeoutBlocks         = 432000        (= ~30 days)
  inactivityTimeoutBlocksLocked   = false
  owner()                         = 0x94CC36412EE0c099BfE7D61a35092e40342F62D7
```

## Phase B contracts

```
DatumActivationBonds         @ 0xeb3ffFD9eaAF7E7fb56BB166ce5f300143c0c59A
  version()                   = 2  ✓
  parameterGovernance()       = 0xE28851Fd4CFD71A16Be7AAb80e953f53bB6b3102  ✓

DatumGovernanceV2            @ 0x7974823244F2c46b8b952F6F84B8AcA811353ecB
  version()                   = 2  ✓
  parameterGovernance()       = 0xE28851Fd4CFD71A16Be7AAb80e953f53bB6b3102  ✓

DatumMintCoordinator         @ 0xAb66b639F61C10746BC4C876Fc9d6a2Df1759aF2
  version()                   = 2  ✓
  parameterGovernance()       = 0xE28851Fd4CFD71A16Be7AAb80e953f53bB6b3102  ✓
```

(`DatumAdvertiserStake` and `DatumAdvertiserGovernance` are v1 — Phase B
modifiers are present, no version bump since they're new deploys.)

## ParameterGovernance state

```
ParameterGovernance @ 0xE28851Fd4CFD71A16Be7AAb80e953f53bB6b3102
  owner          = 0xE28851Fd4CFD71A16Be7AAb80e953f53bB6b3102   (self-owned)
  pendingOwner   = 0x0000000000000000000000000000000000000000
  whitelistLocked= false  (lock-once deferred until OpenGov Phase 2)
```

**13 whitelisted targets** + **33 routable selectors** — see deploy log
`/tmp/deploy-v5.log` for the full enumeration. The Phase A + Phase B
parameter sweep covered 10 of these via the up/down/restore exercise
(`scripts/exercise-governable-params.ts` against Paseo). All 10 passed.

## Drift check

Run on any future date to verify no on-chain drift from this snapshot:

```sh
cd alpha-5
npx hardhat run scripts/check-phase-a.ts  --network polkadotTestnet
npx hardhat run scripts/check-phase-b.ts  --network polkadotTestnet
npx hardhat run scripts/check-pg-state.ts --network polkadotTestnet
```

Drift = any setter value, address, lock-flag, or whitelist entry that
differs from this snapshot AND is not in a published change-log entry.
Either we changed it (intentional, document) or someone else did
(investigation required).

## Pre-mainnet items deferred

Items in this snapshot that are NOT mainnet-ready and have follow-up
work tracked elsewhere:

- `whitelistLocked = false` on PG — deferred until OpenGov phase, per
  `alpha-4/PRE-MAINNET-CHECKLIST.md` §Permission lock-downs.
- `minimumCpmFloorLocked = false`, `inactivityTimeoutBlocksLocked = false`
  — same reason.
- `owner = deployer` on most contracts — pendingOwner staged to Timelock
  but `acceptOwnership()` not yet called by Timelock.
- All migration machinery (`_migrate()` overrides, router `msg.sender`
  wedge) — per `alpha-4/PRE-MAINNET-CHECKLIST.md` §U1-U7.
- `DatumTagRegistry` and `DatumZKStake` — deferred to token-plane deploy,
  per `alpha-5/DEPLOY-COVERAGE.md`.
