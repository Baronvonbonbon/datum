# MVP slim deploy (`DATUM_MVP=1`)

A wiring posture, not a fork. `scripts/deploy.ts` with `DATUM_MVP=1` deploys and
wires only the **core settlement spine** and leaves every optional / governance /
token-plane / ZK module undeployed, with its references left at `address(0)`
(= "feature off", per `DatumSettlement.validateConfiguration`'s optional-refs
contract). Each deferred module activates later through its existing lock-once
setter — no redeploy of the spine.

```
DATUM_MVP=1 npx hardhat run scripts/deploy.ts --network <net>
```

Both settle paths ship: relay-signed (L1 / assurance tier 1) and dual-sig
permissionless co-sign (L2). `DatumClaimValidator` selects per-campaign.

## Core spine (18 contracts, always deployed in MVP)

`pauseRegistry`, `timelock`, `publishers`, `campaigns`, `campaignsMigrationLogic`,
`budgetLedger`, `paymentVault`, `campaignLifecycle`, `settlement`,
`settlementLogicA`, `settlementLogicB`, `claimValidator`, `attestationVerifier`,
`relay`, `dualSig`, `tokenRewardVault`, `nullifierRegistry`, `governanceRouter`.

- `nullifierRegistry` is inert for plaintext claims (a `bytes32(0)` nullifier
  skips the replay check) but is **required** by `validateConfiguration` with a
  non-zero window — so it stays wired even though ZK is deferred.
- `tokenRewardVault` is kept: it's the sidecar third-party-ERC20 reward path,
  independent of the DATUM mint plane.
- `governanceRouter` governor = deployer EOA (Phase 0 / Admin). Ownership is
  transferred to `timelock` as *pendingOwner* only (2-step; `acceptOwnership`
  is never called), so the deployer EOA stays the effective owner and can fire
  the deferred-module setters below.

## Deferred (left at `address(0)`, activate later)

ZK plane (`zkVerifier`, `stakeRoot`, `stakeRootV2`, `interestCommitments`,
`identityVerifier`), DATUM token plane (`emissionEngine`, `mintCoordinator`,
`relayStake`, `relayGovernance` + the `contracts/token/` stack), anti-abuse
extras (`powEngine`, `settlementRateLimiter`, `publisherReputation`,
`clickRegistry`), the governance ladder beyond the router (`governanceV2`,
`council`, `parameterGovernance`, `publisherGovernance`/`publisherStake`,
`advertiserGovernance`/`advertiserStake`, `challengeBonds`, `activationBonds`,
`blocklistCurator`, `tagCurator`), content/targeting (`campaignCreative`,
`reports`, `campaignAllowlist`, `tagSystem`), and the People Chain identity
rails (`peopleChainIdentity`, `peopleChainXcmBridge`, `peopleChainBondedReporter`).

## How the gating works (deploy.ts)

- `MVP_CORE_KEYS` set + `mvpDefer(key)`. `deployOrReuse` skips deferred keys and
  deletes any stale address so downstream `if (addresses.X)` guards see "off".
- `wireIfNeeded` short-circuits when either side of a wire is missing/zero — this
  auto-skips every optional cross-wire whose contract isn't deployed.
- Raw read-then-write blocks that touch a deferred contract are wrapped in
  `if (addresses.X)`; `transferOwnershipIfNeeded` / `lockPlumbingIfNeeded` skip
  missing targets; PHASE 3b (ParameterGovernance) is gated on its presence.
- PHASE 4 validation: deferred `check()` groups are gated by contract presence;
  the address-present loop + summary validate `MVP_CORE_KEYS` instead of the full
  roster; a `Settlement.validateConfiguration()` assert runs in both modes.

## Activating a deferred module later (no spine redeploy)

Deploy the module, then fire its lock-once setter from the owner (deployer EOA in
Admin phase, or via Timelock/governance once the ladder advances). Examples:

| Module | Activation call |
|---|---|
| PoW | `claimValidator.setPowEngine(p)`, `settlement.setPowEngine(p)` |
| Rate limiter | `settlement.setRateLimiter(r)` |
| Reputation | `settlement.setReputationContract(rep)` |
| Click registry (CPC) | `settlement.setClickRegistry(c)` |
| Publisher stake/gov | `settlement.setPublisherStake(s)` + bond wiring |
| ZK claim path | wire `zkVerifier` (`WIRE_ZK_PREDICATE=1`), `claimValidator.setStakeRoot*` / `setInterestCommitments` |
| Identity gate | `settlement.setIdentityRegistry(peopleChainIdentity)` |
| DATUM token rewards | deploy `contracts/token/` stack + `settlement.setMintCoordinator(mc)` |

Most of these are lock-once: one write, then frozen for the life of that
contract. Do **not** fire any `lock*()` / `lockPlumbing()` during MVP — they are
`whenOpenGovPhase`-gated (no-op pre-OpenGov) and are the production cypherpunk
commitment, not a launch step.

## Note: `lockBootstrap` phase gate (applies to full deploy too)

STAGE 4's `Campaigns.lockBootstrap()` is `whenOpenGovPhase`-gated (needs router
set AND `phase()==2`), so it can only succeed post-OpenGov. It is now phase-gated
in deploy.ts like `lockPlumbing` — on a fresh Admin-phase deploy (full or MVP) it
is a logged no-op; governance fires it later.
