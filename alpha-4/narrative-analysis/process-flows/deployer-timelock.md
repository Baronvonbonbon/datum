# Deployer / Timelock Operator

The bootstrap admin role and its post-bootstrap successor: the
Timelock. At deploy, a single EOA (or multisig) is the owner of every
contract. Over time that authority routes through `DatumTimelock` and
then is handed to phase-current governance.

## On-chain footprint

At deploy, the deployer EOA is `owner()` on every contract. Each
contract has its own owner; they're independent. The handover process
typically transfers each contract's ownership to a single Timelock,
then optionally transfers Timelock's owner to a multisig or to the
Council/OpenGov.

## End-to-end flow

### Bootstrap (deploy day)

```
1. Deploy DatumPauseRegistry(g0, g1, g2)
2. Deploy DatumOwnable-based contracts in dependency order:
   - DatumPublishers, DatumBudgetLedger, DatumPaymentVault,
     DatumChallengeBonds, DatumCampaigns, DatumCampaignLifecycle,
     DatumClaimValidator, DatumSettlement, DatumRelay,
     DatumAttestationVerifier, DatumClickRegistry, DatumPublisherStake,
     DatumPublisherGovernance, DatumAdvertiserStake,
     DatumAdvertiserGovernance, DatumTokenRewardVault,
     DatumGovernanceV2, DatumGovernanceRouter, DatumCouncil,
     DatumAdminGovernance, DatumCouncilBlocklistCurator,
     DatumTagCurator, DatumTimelock, DatumZKVerifier, DatumZKStake,
     DatumStakeRoot, DatumInterestCommitments, DatumParameterGovernance,
     plus token/* contracts.
3. Wire all the lock-once cross-refs:
   - Settlement.setClaimValidator, .setPublishers, .setCampaigns,
     .setPublisherStake, .setAdvertiserStake, .setTokenRewardVault,
     .setClickRegistry, .setNullifierWindowBlocks, .setMintAuthority
   - Campaigns.setBudgetLedger, .setLifecycleContract, .setGovernanceContract,
     .setChallengeBonds, .setTagCurator, .setAdvertiserStake
   - Lifecycle.setBudgetLedger, .setGovernanceContract,
     .setSettlementContract, .setChallengeBonds
   - PaymentVault.setSettlement
   - BudgetLedger.setCampaigns, .setSettlement, .setLifecycle
   - ChallengeBonds.setCampaigns, .setLifecycle, .setGovernance
   - PublisherStake.setSettlement, .setSlashContract
   - AdvertiserStake.setSettlement, .setSlashContract
   - PublisherGovernance.setPublisherStake, .setChallengeBonds
   - ZKVerifier.setVerifyingKey  (after running setup-zk.mjs)
   - ClaimValidator.setZKVerifier, .setStakeRoot, .setInterestCommitments
   - StakeRoot.addReporter (× N), .setThreshold
   - Publishers.setBlocklistCurator
   - Campaigns.setTagCurator
   - GovernanceRouter.setGovernor(Admin, adminGov)
   - Set Campaigns.governanceContract = router
   - Set Lifecycle.governanceContract = router
   - MintAuthority.set settlement / bootstrap pool / vesting
4. Sanity check: validateConfiguration() on Settlement, etc.
5. Seed test campaigns (optional; for testnet runbooks).
```

### Lock-once tightening

Once wiring is verified, lock the structural references. Each
contract that has a `lockPlumbing()` or similar should be called:

- `ClaimValidator.lockPlumbing()`
- `Lifecycle.lockPlumbing()`
- `ClickRegistry.lockPlumbing()`
- `Publishers.lockBlocklistCurator()` (after curator is real)
- `Campaigns.lockPolicy()` (after policy defaults are set)
- `Campaigns.lockTagCurator()`
- `PauseRegistry.lockGuardianSet()` (after guardian set is real)
- `Settlement` setters auto-lock on first non-zero write — no
  separate lockPlumbing.

### Handover

```
6. transferOwnership(timelock) on every owner-gated contract
7. timelock.transferOwnership(councilOrMultisig)
8. router.setGovernor(Council, councilAddress) ← via timelock
9. Optionally: council.transferOwnership(timelock) so council
   self-administers via the standard 48h delay
```

After this point, the deployer EOA has no authority over anything.

### Steady state (Timelock operator)

Once the Timelock owns everything, all admin changes route through
it:

```
1. timelock.propose(target, data, salt) ← only callable by timelock's owner
2. (48h delay)
3. anyone.execute(timelock.proposalId)
```

Example: changing the protocol's userShareBps:
```
data = settlement.interface.encodeFunctionData("setUserShareBps", [7000])
timelock.propose(settlementAddr, data, randomSalt)
... wait 48h ...
timelock.execute(...)
```

A council-driven change is the same shape, but Council is the
Timelock's owner so the Council proposes to itself, then executes a
Timelock.propose, etc.

### Renunciation (cypherpunk terminal)

After every lock is set and Phase 2 OpenGov is running:

```
timelock.transferOwnership(address(timelock))  → timelock is self-owned
// or
timelock.renounceOwnership() → no owner; timelock can't propose new changes
```

The protocol then has *no admin path at all*. Every change must go
through Phase 2 OpenGov (which has its own action surface via
`router.setGovernor` and direct calls to the various governance
contracts).

This is the cypherpunk terminal state. Most protocols don't reach it;
the option exists.

## Economic exposure

- **None directly.** The Timelock holds no protocol funds. (It might
  custody Council slash treasuries, but only as an admin-controlled
  destination, not as a beneficiary.)

## Who polices the deployer / Timelock

- **The 48-hour delay** — community can see proposed changes and
  organize against them.
- **The community's ability to fork.** If the Timelock executes
  community-hostile actions, the social contract permits a fork.
- **Once `lockGuardianSet` / `lockPolicy` / etc. are called**, the
  Timelock loses authority over those specific surfaces forever.

## Trust assumptions

- **Pre-Phase-2:** the Timelock owner (deployer multisig, then
  Council) is trusted to act in good faith. The 48h delay is the only
  on-chain protection.
- **Post-Phase-2:** the Timelock either still operates with
  conservative changes via OpenGov-elected operators, or is renounced
  entirely. The protocol's contracts are then immutable except via
  Phase-2 governance.
