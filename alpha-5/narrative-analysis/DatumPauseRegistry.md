# DatumPauseRegistry

The protocol's global emergency brake. Every action contract calls into
this registry before doing anything that could move value or change
state. The model is intentionally asymmetric: any single guardian can
pause instantly; two-of-three is needed to unpause.

## CB6 categorical pauses

Four independent categories, each a bit in a bitfield:

```
CAT_SETTLEMENT        = 1
CAT_CAMPAIGN_CREATION = 2
CAT_GOVERNANCE        = 4
CAT_TOKEN_MINT        = 8
CAT_ALL               = 15
```

Each category has its own engagement block (`pausedAtBlockFor[cat]`),
its own solo expiry (`soloMaxPauseBlocks` ~24h default), and its own
extended expiry reachable via 2-of-3 proposal
(`categoryMaxPauseBlocks[cat]` ~3-14d depending on category). A
guardian who discovers a settlement bug can pause only CAT_SETTLEMENT,
leaving governance and campaign creation flowing.

## G-2 first close (2026-05-20): tighter damage bounds

Pre-close: any single guardian could pause for 14 days, and re-engage
at expiry indefinitely — the 14-day cap was unbounded in aggregate
(see `gaps-in-checks-and-balances.md` G-2). The close ships three
mechanisms:

1. **Per-category caps.** `categoryMaxPauseBlocks[cat]` differs per
   category (defaults: settlement 3d, campaign-creation 7d,
   governance 7d, token-mint 14d). Damage profiles vary; settlement
   pause stops user payouts (high cost), governance pause stops vote
   resolution (low cost in steady-state).
2. **Solo vs extended windows.** A single-guardian `pauseFast` engages
   the category for `soloMaxPauseBlocks` (~24h). Extending past that
   requires a 2-of-3 `proposeExtendPause(categories)` proposal
   (action 5), which bumps the effective end-block to
   `pausedAtBlockFor[cat] + categoryMaxPauseBlocks[cat]`. The solo
   window preserves emergency speed; sustained pause requires consensus.
3. **Per-(guardian, category) cooldown.** After a guardian's
   engagement on a category, that guardian cannot re-engage the same
   category until `lastEngagedBlock + soloMaxPauseBlocks +
   reengagementCooldownBlocks` (~7d default cooldown). Closes the
   "extend indefinitely by re-engaging at expiry" attack.

Owner-pause `pause()` bypasses the cooldown — it's the
bootstrap-emergency path, not a guardian's solo-pause role. Even when
the deployer happens to sit on the guardian set, the owner-pause
authority is the deploying party's emergency response, not a regular
guardian action.

Consensus unpause (action 2 or action 4) is an explicit dismissal: it
clears both the per-(guardian, category) cooldown clock for the
unpaused categories AND the `extendedUntilBlock[cat]` extension state,
so the next engagement starts fresh in the solo window.

### Parameter setters

- **`setSoloMaxPauseBlocks(b)`** — owner-only, bounded `1 ≤ b ≤ MAX_PAUSE_PARAM_CEILING`.
- **`setCategoryMaxPauseBlocks(cat, b)`** — owner-only, single bit,
  `soloMaxPauseBlocks ≤ b ≤ MAX_PAUSE_PARAM_CEILING`.
- **`setReengagementCooldownBlocks(b)`** — owner-only, `b ≤ MAX_PAUSE_PARAM_CEILING`.
  `b == 0` disables cooldown (testnet posture).
- **`lockPauseParams()`** — owner-only, `whenOpenGovPhase`, one-way.
  Freezes all three setters permanently.

### Damage bounds summary

| Attacker | Per-cycle damage on a single category | Notes |
|---|---|---|
| 1-of-3 (rogue guardian) | ≤ soloMaxPauseBlocks (~24h) | Then cooldown ~7d before they can re-pause |
| 2-of-3 cabal | ≤ categoryMaxPauseBlocks[cat] (3-14d) | Then cooldown applies to both colluding guardians; honest third can vote unpause |
| 3-of-3 (total compromise) | Unbounded | Out of scope of any mechanism short of Council/OpenGov override |

The 2-of-3 number is bounded per-cycle now, whereas pre-close it was
effectively unbounded.

Per-category accessor methods (`pausedSettlement()`,
`pausedCampaignCreation()`, `pausedGovernance()`, `pausedTokenMint()`)
do the bit-mask check. Contracts call the one relevant to them.

## Fast pause / slow unpause

- **Fast pause:** any single guardian, or the owner pre-`lockGuardianSet`,
  can flip pause bits with `pauseFast()` (CAT_ALL) or
  `pauseFastCategories(catMask)` (subset).
- **Slow unpause:** requires a 2-of-3 guardian proposal. Either action 2
  (unpause all categories) or action 4 (unpause specific categories).
- **Guardian rotation:** action 3, also 2-of-3.

The asymmetry: live exploits don't wait for quorum, but unpause should
not be a single-guardian action — a compromised guardian shouldn't be
able to undo a pause that another guardian rightly engaged.

## Auto-expiry

`MAX_PAUSE_BLOCKS = 201_600` blocks at 6s = ~14 days. After that window,
`paused()` returns false for that category even if the raw bit is still
set. Caps the worst-case-DoS damage: a malicious/captured guardian can
freeze the system but only for 14 days before needing to re-engage (which
costs gas each time and can be vetoed by rotation).

`expireStaleCategories()` (audit M-7) is a permissionless cleanup: it
clears raw bits for categories that have auto-expired, reconciling
internal state with effective state. Cosmetic — `paused()` already
returns the right answer either way.

## The Proposal struct

A single struct serves three actions:

- Action 2: Unpause-all.
- Action 3: Guardian rotation (`ng0, ng1, ng2` fields).
- Action 4: Categorical unpause (`categories` field).

`approvals` counter; `voted[addr]` mapping; `executed` flag (AUDIT-021:
proposals are flagged executed rather than deleted, preserving the audit
trail and preventing replay).

## Lock-guardian-set

`lockGuardianSet()` — irreversible owner action. After this, only sitting
guardians (via 2-of-3 self-rotation) can change the set. The owner
permanently loses authority over the safety committee. This is the
cypherpunk terminal state: protocol pauses cannot be controlled by the
deployer's keys anymore.

## What it doesn't pause

The PaymentVault withdraw path. Earned funds must always be claimable —
turning a global pause into a hostage scenario for user balances is a
worse outcome than the bug it's trying to contain.

Stake / unstake on the stake contracts: publishers and advertisers can
exit during emergencies. (Slash is gated on the governance pause via the
upstream governance contracts' own pause checks.)

## Why three guardians, not five

Three is the smallest number that supports "two of three" — the minimum
multisig topology that resists a single compromised guardian. Five would
be more resilient but harder to coordinate. The protocol designer chose
three with the option to widen later via governance.

## Bootstrap path

```
PauseRegistry deploys with g0, g1, g2 (deployer-chosen)
  → owner = deployer
  → guardianSetLocked = false
Deployer can pause() solo, can rotate via setGuardians()
After audit + community vetting:
  → owner calls lockGuardianSet()
  → forever after, only the three guardians (rotating among themselves) can
    change the set
```
