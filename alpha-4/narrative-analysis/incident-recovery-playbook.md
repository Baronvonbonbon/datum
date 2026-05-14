# Incident Recovery Playbook

What to do if a critical bug is discovered in a deployed contract on
Paseo (or eventually Hub). Be honest about the architecture: **DATUM
contracts are NOT upgradeable in place.** No proxy pattern, no UUPS,
no Beacon. Each contract is deployed once at a fixed address and the
bytecode there is the bytecode forever.

This is intentional (cypherpunk: no operator backdoor that could be
abused or compromised) but it shapes every recovery option. The
playbook is "stop the bleeding, redirect traffic, drain funds back
to users."

## 0. First five minutes — pause first, think second

The single most important emergency primitive is `DatumPauseRegistry`.
It has four category bits, any of which can be engaged independently
by any guardian (1-of-3 to engage, 2-of-3 to lift).

```
CAT_SETTLEMENT        — stops settle*, drain, recordSettlement
CAT_CAMPAIGN_CREATION — stops createCampaign, setMetadata, set*Cap
CAT_GOVERNANCE        — stops vote/withdraw/evaluate
CAT_TOKEN_MINT        — stops DATUM emission on settle
```

A pause auto-expires after `MAX_PAUSE_BLOCKS = 201,600` (~14 days at
6s/block). Pausing burns ~50k gas; lifting requires a 2-of-3 proposal.

**Sequence:**
1. **Identify which category the bug affects.** Settlement bug → pause
   `CAT_SETTLEMENT`. Vote-manipulation bug → pause `CAT_GOVERNANCE`.
   In-flight campaign creation broken → pause `CAT_CAMPAIGN_CREATION`.
   When in doubt, pause `CAT_ALL` (engages all four).
2. **Pause from any guardian wallet.** No coordination required for
   engagement.
3. **Take a snapshot** of relevant on-chain state (event logs, key
   storage slots) before anything else moves.
4. **Then** start diagnosis.

Guardian wallets are configured at PauseRegistry deploy time
(`owner.address, advertiser.address, publisher.address` on testnet —
swap to a serious 3-of-N before mainnet).

## 1. Decide the recovery tier

Once paused, classify the bug. The right tier determines effort/risk.

| Tier | Bug shape | Fix cost |
|---|---|---|
| **T1** | Off-by-one in a parameter (e.g., rate limit too aggressive) | Setter call, minutes |
| **T2** | Wiring mistake (wrong contract pointed at) | Two-step ref swap on Campaigns, hours |
| **T3** | Logic bug in a non-lock-once-referenced contract (Settlement, ClaimValidator, Relay) | Deploy replacement, swap ref, migrate users, days |
| **T4** | Logic bug in a lock-once-referenced contract (Campaigns, Publishers, BudgetLedger) | Deploy entire fresh ladder, migrate users, weeks |
| **T5** | Logic bug in PauseRegistry (the emergency stop itself) | Hardest case; see §6 |

## 2. T1 — Parameter tweak

All governance-tunable parameters have owner setters. The owner is the
Timelock/Router; changes traverse the standard governance flow
(Phase 0 admin instant; Phase 1+ goes through Council/GovernanceV2
with delays).

Examples — these are NOT lock-once and can be re-tuned indefinitely:

- `Settlement.setRateLimits`, `setMaxBatchSize`, `setMinReputationScore`,
  `setUserShareBps`, `setMintRate`
- `Campaigns.setDefaultTakeRateBps`, `setMaxCampaignBudget`,
  `setMaxPublisherTags`, `setMaxCampaignTags`, `setMaxAllowedPublishers`,
  `setMinimumCpmFloor`
- `GovernanceV2.setQuorumWeighted`, `setSlashBps`, `setGraceParams`,
  `setConvictionCurve`, `setConvictionLockups`, `setCommitRevealPhases`
- `ActivationBonds.setMinBond`, `setTimelockBlocks`, `setPunishmentBps`,
  `setMuteMinBond`, `setMuteMaxBlocks`
- `ChallengeBonds.setMaxBondedPublishers`
- `Relay.setLivenessThreshold`, `setMaxBatchSize`, `setRelayerAuthorized`

A T1 fix on testnet: deployer calls the setter directly. On mainnet:
goes through Timelock → Router → target.

## 3. T2 — Wiring mistake (hot-swap a contract reference)

Many `setX` setters are NOT lock-once. If the bug is "Campaigns is
pointing at the wrong Settlement contract" (e.g., a stale v8 ref slipped
through), you can swap.

### Special: the `setSettlementContract` / `setGovernanceContract` /
### `setLifecycleContract` two-step on `DatumCampaigns`

Once `bootstrapped` is true, these become **staging-only** — you call
`setSettlementContract(addr)` which records `pendingSettlementContract`,
and the **new** Settlement contract must then call
`acceptSettlementContract()` from its own address to commit.

This is the H-6 audit pattern: the incoming contract must consent to
receiving callbacks, so a stale or hostile target can't be wired in
without its own cooperation.

To swap:

1. Deploy fresh Settlement at address `S'`.
2. Wire `S'` internally first (`S'.configure(...)`, `S'.setClaimValidator(...)`, etc.).
3. `Campaigns.setSettlementContract(S')` from owner — stages pending.
4. From `S'`'s context, call `Campaigns.acceptSettlementContract()`.
5. Update everything else that points at the old Settlement: ClaimValidator,
   Lifecycle, ChallengeBonds (depending on where settlement is wired).

The two-step swap also exists for `governance` and `lifecycle` references.

### Other non-lock-once setters worth knowing

These can be set repeatedly by owner (no `already set` guard):

- `DatumSettlement.setClaimValidator` is **lock-once** (see below)
- `DatumSettlement.setAttestationVerifier` — NOT lock-once. Hot-swap.
- `DatumSettlement.setRateLimits` etc. — parameter only
- `DatumCampaigns.setLifecycleContract` (uses two-step staging post-bootstrap)
- `DatumCampaignLifecycle.setSettlementContract` — NOT lock-once
- `DatumCampaignLifecycle.setCampaigns` — NOT lock-once
- `DatumClickRegistry.setSettlement` / `setRelay` — NOT lock-once

## 4. T3 — Replace a non-lock-once contract

The non-fund-bearing service contracts can be replaced if all the
contracts that reference them have non-lock-once setters.

**Examples of replaceable contracts:**

- **`DatumClaimValidator`** — only Settlement holds the ref, and
  `Settlement.setClaimValidator` is **lock-once**. Wait — actually it
  IS lock-once. So ClaimValidator falls into T4 below for the
  Settlement→Validator edge.

Let me be more precise. Here's the dependency / replaceability matrix:

| Contract | Who holds the ref | Setter is lock-once? | Can replace? |
|---|---|---|---|
| `PauseRegistry` | almost everyone | **immutable** | **NO** — see §6 |
| `BudgetLedger` | Campaigns (lock-once), Settlement, Lifecycle | mostly lock-once | Hard (T4) |
| `PaymentVault` | Settlement (lock-once on PaymentVault.settlement) | yes | Hard (T4) |
| `Publishers` | Campaigns (lock-once) | yes | Hard (T4) |
| `Campaigns` | many (most lock-once) | many | Very hard (T4) |
| `Settlement` | Campaigns (staging), Lifecycle (settable), Relay (settable), ClickRegistry (settable), ClaimValidator (settable), ChallengeBonds (no — not stored) | mixed | Yes (T3) |
| `ClaimValidator` | Settlement (lock-once) | yes | **No** without redeploying Settlement |
| `Relay` | Settlement (settable via `configure`?) — actually configure is lock-once on first call | check | T3/T4 |
| `Lifecycle` | Campaigns (staging), GovernanceV2 (lock-once!), ChallengeBonds (lock-once) | lock-once in some places | T4 in practice |
| `GovernanceV2` | Router (settable via setGovernor), Lifecycle (settable via setGovernanceContract) | yes | T3 |
| `ActivationBonds` | Campaigns (lock-once!), GovernanceV2 (lock-once), ClaimValidator (settable) | **lock-once** | T4 |
| `ChallengeBonds` | Campaigns (lock-once) | yes | Hard (T4) |
| `TokenRewardVault` | Settlement (lock-once on `setTokenRewardVault`) | yes | No (T4) |
| `Council` | Router (settable) | settable | T3 |
| `Router` | many | hard-wired to GovernanceV2 (router IS the proxy) | very hard |

**Practical T3 recipe:**

1. Deploy fresh `Settlement'` at `S'`.
2. `S'.configure(ledger, vault, campaigns, relay)` — note `configure`
   is itself lock-once on first call, so the new Settlement gets a
   fresh wiring.
3. `S'.setClaimValidator(validator)` — same validator, points at NEW
   Settlement only when validator's `setSettlement` is also updated.
4. Update referrers:
   - `Campaigns.setSettlementContract(S')` + `S'.acceptSettlementContract()`
   - `Lifecycle.setSettlementContract(S')`
   - `Relay.setSettlement(S')`
   - `ClickRegistry.setSettlement(S')`
   - `ClaimValidator.setSettlement(S')`
5. Unpause `CAT_SETTLEMENT`.
6. Users with pending balances in the OLD PaymentVault can still
   withdraw from old vault (pull-pattern, no expiry on `claim()`).
   New settlements go to new vault.

The hardest part of T3 isn't the swap — it's discovering all referrers
in time. Keep `check-wiring.ts` (already in `scripts/`) up to date.

## 5. T4 — Lock-once dead ends (deploy whole new ladder)

If the buggy contract has a lock-once reference that can't be hot-swapped,
the only options are:

a. **Migrate users to a new ladder.** Deploy entire fresh set. Users with
   funds in the old PaymentVault can still call `withdraw` from the old
   vault directly (pull-pattern survives). Active campaigns in old
   Campaigns can be terminated by governance → budget drains to advertiser
   (via Lifecycle.terminateCampaign → BudgetLedger drain). Bonds in old
   ChallengeBonds are claimable via `claimBondReturn` after returnBond
   fires. ActivationBonds bonds are claimable via `claim` after settle.
   **No funds get permanently stuck** as long as the bug doesn't prevent
   the relevant `withdraw`/`claim`/`returnBond` functions from running.

b. **Find a parameter that neutralises the bug.** Sometimes a lock-once
   reference contract has a tunable parameter that disables the broken
   feature. Example: if ActivationBonds has a bug only in the mute path,
   `setMuteMinBond(type(uint256).max)` makes mute economically impossible,
   sterilising the bug.

c. **Pause indefinitely.** Refresh the pause every 14 days via guardian
   2-of-3. Pauses are categorical, so other features keep running.
   Indefinite pause is essentially "we've decided to wind this contract
   down."

### The really hard lock-once edges

These are the ones to be especially careful with at deploy time:

- `Campaigns.setActivationBonds` — lock-once. If ActivationBonds ships
  with a bug, Campaigns will forever point at the broken contract. The
  only out is option (b) above or a fresh Campaigns deploy.
- `GovernanceV2.setActivationBonds` — same.
- `GovernanceV2.setLifecycle` — same.
- `Settlement.setClaimValidator` — same.
- `Settlement.setTokenRewardVault` — same.
- `PaymentVault.setSettlement` — same. **PaymentVault is fund-bearing**;
  if PaymentVault is buggy, the playbook is "pause settlement, let users
  withdraw from old vault, deploy new vault, route fresh settlements
  through new Settlement → new vault." Old vault keeps draining.

**Mitigation strategy:** maximize testnet bake time on anything
lock-once-referenced. Treat each lock-once setter as a one-shot vow.

## 6. T5 — PauseRegistry itself is buggy

This is the architectural worst case. `pauseRegistry` is **immutable**
on every consumer (Settlement, Campaigns, Publishers, Relay, etc.). If
PauseRegistry has a bug — say, `pause()` doesn't actually flip the
state, or the auto-expiry math is wrong — you cannot point any contract
at a new PauseRegistry.

Options if PauseRegistry breaks:

a. If the bug is in the *enforcement* path (e.g., `paused()` returns
   wrong value): you may be able to use **parameter setters** to
   simulate a pause. Set `Settlement.setRateLimits(1, 1)`, set quorum
   to MAX_UINT on GovernanceV2, etc. These are all reachable via
   owner/Timelock and don't depend on PauseRegistry.

b. If the bug is in the *guardian* path (engaging pause doesn't work):
   deploy fresh contracts that point at a fresh PauseRegistry. T4
   migration applies.

c. If PauseRegistry has the equivalent of an unbounded mint authority:
   you have a true emergency. The protocol is compromised. Coordinate
   with users to withdraw via pull-pattern and abandon the deployment.

**Conclusion:** treat PauseRegistry as the highest-trust contract.
It's the simplest one (~250 LOC, no funds, well-tested) but its
breakage is the most expensive.

## 7. Fund-safety guarantees during recovery

What's true regardless of which tier you're in:

- **`DatumPaymentVault`** holds user balances. Withdrawal is permissionless
  (`withdraw()`, `withdrawTo()`). As long as `withdraw` itself isn't broken,
  users can always pull their funds — even from a frozen old deployment.
- **`DatumChallengeBonds`** has `claimBondReturn(To)` for queued returns
  and `claimBonusForPublisher(To)` for bonus claims. Pull-pattern.
- **`DatumActivationBonds`** has `claim()` / `claimTo()`. Pull-pattern.
- **`DatumBudgetLedger`** drains budgets via Lifecycle on campaign end.
  If Lifecycle is buggy too, budget can be stranded — but only governance
  can fail to end a campaign, and `evaluateCampaign` is permissionless
  by anyone (gas-payer).
- **`DatumTokenRewardVault`** has `withdraw(token)` for user-pull of
  ERC-20 rewards. Pull-pattern.
- **`DatumGovernanceV2`** voter stakes are released via `withdraw(cid)`
  after lockup expires. Slash pool is claimable via `claimSlashReward`.

**What can get stuck:**

- Funds locked in a contract whose `withdraw`-equivalent is the buggy
  function itself. (E.g., bug in ActivationBonds.claim().)
- Bonds locked in a campaign whose Lifecycle cannot terminate.
- Funds in a contract that depends on a buggy upstream's view function.

Defense: every fund-bearing contract has a pull-pattern claim that's
independent of state from other contracts. Verify this holds end-to-end
during testnet bake.

## 8. Owner-emergency-drain — what doesn't exist

Per cypherpunk design, NO contract has an owner `drain()` function that
seizes bonds or balances. This is a deliberate trust property — operator
can't rugpull. It also means: **if a fund-bearing contract has a bug
that locks funds, the owner cannot drain those funds and refund users
off-chain.** Recovery is purely on-chain through the pull-pattern claims
of the user's choosing.

Exceptions:

- `GovernanceV2.claimOwnerSweep` — sweeps **unclaimed** slash pool after
  365-day deadline. Time-bounded, not arbitrary.
- `Council.executeGrant` — Council can vote to grant funds **from
  Council's own balance** to a recipient. Capped per-proposal +
  monthly. Not a drain.
- `Settlement.sweepDust` — not a fund movement, hygiene only.

This is a feature, not a bug. But it means recovery effort lives in
governance + protocol redesign, not in operator action.

## 9. Communication during incident

(Not a contract concern but flows from the above.)

- Pause first; communicate after. The pause is the time-stop that
  buys analysis time.
- Publish a clear incident report including: which contract, which
  category paused, what state is safe vs at-risk, what user action
  (if any) is needed.
- If T4 migration is needed, give a clear deprecation timeline. Old
  contracts keep running for pull-pattern withdrawals; new contracts
  serve new flows.

## 10. Pre-deploy hygiene that reduces incident probability

These are not recovery steps but they're the leverage points that
make recovery less likely to be needed in the first place:

- **Maximise testnet bake time** before any contract receives a
  lock-once reference from another.
- **Lock-once setters should be the LAST step** of deploy.ts, not
  the first. Currently many lock-onces fire mid-deploy, which means
  a deploy failure halfway through can leave irrecoverable wiring.
- **Don't lock plumbing** (`ClaimValidator.lockPlumbing()`,
  `Campaigns.bootstrapped`) until you've done at least one full
  end-to-end smoke test on the live chain.
- **Run `check-wiring.ts`** before considering a deploy complete.
- **Snapshot deployed-addresses.json** to a backup before any new
  deploy run.

## TL;DR

1. **Pause first** via the relevant `PauseRegistry` category.
2. **Diagnose**, classify T1–T5.
3. **T1/T2**: parameter setter or two-step ref swap. Minutes to hours.
4. **T3**: deploy replacement of the buggy contract, swap refs in all
   referrers, unpause. Days.
5. **T4**: lock-once dead end — migrate users to a fresh ladder OR
   neutralize via parameters OR indefinite pause. Weeks.
6. **T5**: PauseRegistry bug — fall back to parameter-based effective
   pause, then fresh ladder. Worst case.
7. Funds remain user-claimable via pull-pattern across all migrations.
   No operator drain function exists, by design.
