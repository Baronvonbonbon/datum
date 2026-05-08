# DATUM Alpha-4 Security Audit — Governance + Lifecycle

**Date:** 2026-05-08
**Auditor:** Internal manual review (Claude Code, inline)
**Build:** solc 0.8.24, evmVersion `cancun`, viaIR, optimizer 200 runs
**Branch:** `main` post-`8027927` (post hot-path fixes + L-2 + dual-sig toggle)

## Scope

Eight contracts on the governance + campaign-lifecycle surface, ~1,900 lines:

| Contract | Lines | Role |
|---|---:|---|
| DatumGovernanceV2 | 416 | Conviction-vote campaign governance + slash distribution (merged Helper + Slash) |
| DatumCouncil | 344 | Phase 1 N-of-M trusted council |
| DatumCampaignLifecycle | 238 | complete / terminate / expire / demote — re-audited post M-1 |
| DatumGovernanceRouter | 169 | Stable-address proxy across the governance ladder; merged AdminGovernance |
| DatumParameterGovernance | 256 | FP-15: conviction-vote DAO for protocol parameters |
| DatumPublisherGovernance | 277 | FP-3: conviction-vote fraud governance against publishers |
| DatumPauseRegistry | 122 | Global emergency pause; 2-of-3 guardian unpause |
| DatumTimelock | 94 | 48h admin delay |

## Out of Scope / Assumed

- Off-chain governance UX (web app vote pages) — assumed correct against on-chain expectations.
- The publisher / settlement / vault contracts — covered in the prior hot-path audit (`SECURITY-AUDIT-alpha4-hotpath-2026-05-08.md`).
- Solidity compiler / OZ library bugs.
- Mainnet on-chain governance design choices (e.g., quorum / slash BPS specifics) — these are configuration, not correctness.

## Executive Summary

No critical findings. Two governance-level **medium-severity** issues stand out:

1. **DatumGovernanceRouter exposes owner-only "admin*" shortcut functions in *every* phase**, not just Phase 0. Owner (Timelock) can bypass the active governor (Council, GovernanceV2) at any time — this undermines the governance ladder's whole point. Either gate the admin* functions on `phase == Admin` or document the design explicitly as an emergency-override channel.
2. **Slash + bond push patterns repeat the M-1 vulnerability**: `GovernanceV2.sweepSlashPool` pushes to `owner()`, `ParameterGovernance` pushes proposer/owner refunds in three spots. Each is DoS-able if the recipient contract reverts. Convert to pull pattern (same fix shape as M-1).

Plus several lower-severity items, including a permissionless spam vector in `PublisherGovernance.propose()`, untrappable treasury accumulation in `PublisherGovernance`, and a configuration corner where `slashBps = 10000` on `GovernanceV2` would permanently lock losing voters' DOT.

### Severity counts

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 6 |
| Low | 4 |
| Informational | 3 |

### Top 3 to address

1. **G-M1** — Phase-gate the `admin*` shortcut functions in `DatumGovernanceRouter`.
2. **G-M3** — Pull-pattern for `GovernanceV2.sweepSlashPool` and `ParameterGovernance` bond payouts.
3. **G-M5** — Bond + spam protection on `DatumPublisherGovernance.propose()`.

---

## Medium

### G-M1: Owner can bypass active governor in any phase via `admin*` shortcuts

**File:** `alpha-4/contracts/DatumGovernanceRouter.sol:142-155`

**Code:**
```solidity
// alpha-4/contracts/DatumGovernanceRouter.sol:142-155
/// @notice Owner-only campaign activation (Phase 0 shortcut).
function adminActivateCampaign(uint256 campaignId) external onlyOwner {
    campaigns.activateCampaign(campaignId);
}

/// @notice Owner-only campaign termination (Phase 0 shortcut).
function adminTerminateCampaign(uint256 campaignId) external nonReentrant onlyOwner {
    lifecycle.terminateCampaign(campaignId);
}

/// @notice Owner-only campaign demotion (Phase 0 shortcut).
function adminDemoteCampaign(uint256 campaignId) external nonReentrant onlyOwner {
    lifecycle.demoteCampaign(campaignId);
}
```

**Impact:**
The Router's three `admin*` functions are gated on `onlyOwner` with **no phase check**. The comment says "Phase 0 shortcut", but they remain callable in Phase 1 (Council) and Phase 2 (OpenGov). Owner is the Timelock; whoever controls the Timelock can override on-chain governance at any time — activate / terminate / demote campaigns without the active governor's approval.

This nullifies the governance ladder's value: users believe a campaign decision was made by the council or by conviction voting, but the Timelock could have overridden it.

**Recommendation:**
Either (a) gate the `admin*` functions on `phase == GovernancePhase.Admin`:
```solidity
function adminActivateCampaign(uint256 campaignId) external onlyOwner {
    require(phase == GovernancePhase.Admin, "E19");
    campaigns.activateCampaign(campaignId);
}
```
or (b) document explicitly that Timelock retains a permanent emergency override and rename the functions (e.g. `emergencyActivateCampaign`) so the bypass is visible to anyone reading the code.

**Severity:** Medium. Operationally requires Timelock-controlled multisig collusion, but the governance-ladder narrative on the public docs is undermined as long as the bypass exists.

---

### G-M2: GovernanceV2 with `slashBps = 10000` permanently locks losing voters' DOT

**File:** `alpha-4/contracts/DatumGovernanceV2.sol:204-237`

**Code:**
```solidity
// alpha-4/contracts/DatumGovernanceV2.sol:218-226
if (resolved[campaignId]) {
    slash = _computeSlash(campaignId, v.direction, v.lockAmount);
    if (slash > 0) {
        slashCollected[campaignId] += slash;
    }
}

uint256 refund = v.lockAmount - slash;
require(refund > 0, "E58");
```

The constructor accepts `_slashBps` with no upper bound:
```solidity
// alpha-4/contracts/DatumGovernanceV2.sol:114-135
constructor(
    address _campaigns,
    uint256 _quorum,
    uint256 _slashBps,
    ...
) {
    ...
    slashBps = _slashBps;
    ...
}
```

**Impact:**
If `_slashBps` is set to `10000` (100%) at construction, `_computeSlash` returns `lockAmount` for losers, making `refund = 0` and tripping the `require(refund > 0, "E58")`. Losing voters can never call `withdraw()` — their DOT is permanently locked. Worse, since `slashBps > 10000` would underflow (`v.lockAmount - slash`) and revert, the contract has no on-chain guard.

Today the deployment configures `slashBps = 1000` (10%), so this is latent. But future governance / parameter updates have no constructor pass for `slashBps` to validate.

**Recommendation:**
Add `require(_slashBps < 10000, "E11")` to the constructor. If a 100% slash is ever desired, the withdraw path needs explicit handling (skip the `require` and emit a `VoteForfeited` event).

**Severity:** Medium. Configuration footgun with no on-chain bound.

---

### G-M3: Push payouts in slash sweep + parameter governance bonds — DoS pattern

**Files:**
- `alpha-4/contracts/DatumGovernanceV2.sol:353-365` (`sweepSlashPool`)
- `alpha-4/contracts/DatumParameterGovernance.sol:163-164` (resolve → owner)
- `alpha-4/contracts/DatumParameterGovernance.sol:191-192` (execute → proposer)
- `alpha-4/contracts/DatumParameterGovernance.sol:205-206` (cancel → owner)

**Code (sweepSlashPool):**
```solidity
// alpha-4/contracts/DatumGovernanceV2.sol:353-365
function sweepSlashPool(uint256 campaignId) external nonReentrant {
    require(slashFinalized[campaignId], "E54");
    require(block.number >= slashFinalizedBlock[campaignId] + SWEEP_DEADLINE_BLOCKS, "E24");

    uint256 pool = slashCollected[campaignId];
    uint256 remaining = pool - totalSlashClaimed[campaignId];
    require(remaining > 0, "E61");

    totalSlashClaimed[campaignId] += remaining;

    (bool ok,) = owner().call{value: remaining}("");
    require(ok, "E02");
}
```

**Code (ParameterGovernance.resolve):**
```solidity
// alpha-4/contracts/DatumParameterGovernance.sol:159-165
} else {
    p.state = State.Rejected;
    // Slash bond to owner
    uint256 bond = p.bond;
    p.bond = 0;
    (bool ok,) = owner().call{value: bond}("");
    require(ok, "E02");
}
```

`ParameterGovernance.execute` (line 188-192) pushes the bond back to the proposer; `cancel` (line 203-206) pushes to owner. Same pattern.

**Impact:**
This is the same M-1 finding from the hot-path audit, repeated in the governance contracts. If the `owner()` (or proposer) is a contract whose `receive()` reverts, the entire `sweepSlashPool` / `resolve` / `execute` / `cancel` reverts. Funds permanently locked in the contract (sweep deadline already passed, no other path to retrieve).

Less catastrophic than the hot-path version because owner is operationally a Timelock with a `receive()`, but a future Timelock upgrade or guardian-controlled multisig with a strict fallback could brick these paths.

**Recommendation:**
Apply the same M-1 pull pattern: record `pendingPayout[recipient] += amount` and add `claimPayout()` / `claimPayoutTo()` functions. Same shape as `BudgetLedger.claimAdvertiserRefund` and `ChallengeBonds.claimBondReturn`.

**Severity:** Medium.

---

### G-M4: GovernanceV2 `firstNayBlock` is never reset — termination grace stale

**File:** `alpha-4/contracts/DatumGovernanceV2.sol:189-191, 270-275`

**Code (vote):**
```solidity
// alpha-4/contracts/DatumGovernanceV2.sol:189-191
nayWeighted[campaignId] += weight;
if (firstNayBlock[campaignId] == 0) {
    firstNayBlock[campaignId] = block.number;
}
```

**Code (evaluate):**
```solidity
// alpha-4/contracts/DatumGovernanceV2.sol:270-275
uint256 grace = baseGraceBlocks;
if (quorumWeighted > 0) {
    grace += total * gracePerQuorum / quorumWeighted;
}
if (grace > maxGraceBlocks) grace = maxGraceBlocks;
require(firstNayBlock[campaignId] > 0 && block.number >= firstNayBlock[campaignId] + grace, "E53");
```

**Impact:**
`firstNayBlock` is set on the very first nay vote ever and never cleared, even when every nay voter subsequently withdraws (`withdraw` at line 215 only updates `nayWeighted`). A scenario:

1. Block 1000: nay voter casts vote → `firstNayBlock = 1000`.
2. Block 1100: nay voter withdraws (now `nayWeighted = 0`).
3. Block 5000: a new nay voter casts a vote → `nayWeighted = nonzero`, but `firstNayBlock` still = 1000.
4. Block 5001: someone calls `evaluateCampaign` → grace check uses 1000 + grace; passes immediately.

The termination grace is supposed to give the campaign time to react after sustained nay support; the stale `firstNayBlock` lets a fresh nay vote terminate immediately.

The `lastSignificantVoteBlock` field (AUDIT-011) is the symmetric-grace fix for the **aye** path (line 263-264) but the nay path was not updated to match.

**Recommendation:**
Either reset `firstNayBlock` to 0 in `withdraw()` when `nayWeighted` drops to zero, or switch the nay grace check to use `lastSignificantVoteBlock` for symmetry with the aye path:
```solidity
require(
    lastSignificantVoteBlock[campaignId] == 0 ||
    block.number >= lastSignificantVoteBlock[campaignId] + grace,
    "E53"
);
```

**Severity:** Medium. Allows earlier-than-intended termination after a nay reset+revote cycle.

---

### G-M5: PublisherGovernance.propose() is permissionless with no bond — spam

**File:** `alpha-4/contracts/DatumPublisherGovernance.sol:122-139`

**Code:**
```solidity
// alpha-4/contracts/DatumPublisherGovernance.sol:122-139
function propose(address publisher, bytes32 evidenceHash) external whenNotPaused {
    require(publisher != address(0), "E00");
    require(evidenceHash != bytes32(0), "E00");

    uint256 proposalId = nextProposalId++;
    _proposals[proposalId] = Proposal({
        publisher: publisher,
        evidenceHash: evidenceHash,
        createdBlock: block.number,
        resolved: false,
        ayeWeighted: 0,
        nayWeighted: 0,
        firstNayBlock: 0
    });

    emit ProposalCreated(proposalId, publisher, evidenceHash);
}
```

**Impact:**
Anyone can spawn fraud proposals against any publisher without paying anything. Each proposal writes a `Proposal` struct to storage — at scale this is a free storage-bloat attack. It also creates social grief: spurious proposals against legitimate publishers degrade signal even if they never reach quorum.

`DatumParameterGovernance` already uses a `proposeBond` for spam protection — the same pattern should apply here.

**Recommendation:**
Add a `proposeBond` (configurable via owner / governance) that is forfeited if the proposal is dismissed (no quorum reached after voting period) and returned otherwise. Mirror the ParameterGovernance bond mechanic.

**Severity:** Medium. Storage-bloat + social-grief vector.

---

### G-M6: PublisherGovernance — slashed remainder accumulates with no withdraw

**File:** `alpha-4/contracts/DatumPublisherGovernance.sol:225-251, 276`

**Code:**
```solidity
// alpha-4/contracts/DatumPublisherGovernance.sol:230-251
if (fraudUpfield) {
    uint256 publisherStakeAmt = publisherStake.staked(p.publisher);
    slashAmount = (publisherStakeAmt * slashBps) / 10000;

    if (slashAmount > 0) {
        // Slash to this contract first, then distribute
        publisherStake.slash(p.publisher, slashAmount, address(this));

        // Forward bondBonusBps share to challenge bonds pool
        if (address(challengeBonds) != address(0) && bondBonusBps > 0) {
            uint256 bonusShare = (slashAmount * bondBonusBps) / 10000;
            if (bonusShare > 0 && bonusShare <= address(this).balance) {
                challengeBonds.addToPool{value: bonusShare}(p.publisher);
            }
        }
        // Remainder stays in this contract (protocol treasury)
    }
}
```

**Impact:**
On a fraud-upheld resolution, the slashed DOT is sent to this contract. `bondBonusBps` (currently 2000 = 20%) is forwarded to `ChallengeBonds`. The remaining 80% sits in `DatumPublisherGovernance` forever — there is **no `sweep`, `withdrawTreasury`, or owner-callable claim function**. The comment calls it the "protocol treasury" but no external system can actually retrieve it.

**Recommendation:**
Add `function sweepTreasury(address to) external onlyOwner` (preferably pull-pattern), or wire the remainder to flow through the GovernanceRouter / Timelock so it lands in a known treasury address.

**Severity:** Medium. Funds accumulate untrapped.

---

## Low

### G-L1: GovernanceV2 AUDIT-001 conviction floor is dead code

**File:** `alpha-4/contracts/DatumGovernanceV2.sol:170-172`

**Code:**
```solidity
// alpha-4/contracts/DatumGovernanceV2.sol:169-172
Vote storage v = _votes[campaignId][msg.sender];
// AUDIT-001: conviction floor — cannot downgrade conviction on an active vote
require(conviction >= v.conviction, "E74");
require(v.direction == 0, "E42");
```

**Impact:**
The `require(conviction >= v.conviction, "E74")` runs first. The next line forbids re-voting without prior withdraw. `withdraw()` resets `v.conviction = 0` (line 230). So whenever the floor check runs successfully (i.e., `v.direction == 0`), `v.conviction` is necessarily 0 → the check is `conviction >= 0`, always true. The AUDIT-001 fix is a no-op.

This isn't a bug per se (the protective intent is already satisfied by the direction-zero rule), but the comment is misleading and the dead check costs gas.

**Recommendation:** Remove the dead `require` and the AUDIT-001 comment, or document that direction-zero gating subsumes the floor.

**Severity:** Low (cosmetic + gas).

---

### G-L2: Council can shrink to 1-of-1 governance via `setThreshold(1)` + repeated `removeMember`

**File:** `alpha-4/contracts/DatumCouncil.sol:256-302`

**Code:**
```solidity
// alpha-4/contracts/DatumCouncil.sol:256-274
function removeMember(address member) external onlyCouncil {
    require(isMember[member], "E01");
    require(memberCount > threshold, "E00");  // prevent locking council
    ...
}

// alpha-4/contracts/DatumCouncil.sol:281-284
function setThreshold(uint256 _threshold) external onlyCouncil {
    require(_threshold > 0 && _threshold <= memberCount, "E00");
    threshold = _threshold;
}
```

**Impact:**
Council members can collude to shrink the council via two proposals: first `setThreshold(1)`, then sequential `removeMember(...)` calls. After this sequence, a single member can propose, vote, and execute proposals unilaterally. The protocol's "trusted N-of-M council" property degrades to "trusted 1-of-1 dictatorship" with no on-chain prevention.

This is technically a governance design choice, but the contract should probably enforce a hard floor (e.g., `MIN_THRESHOLD = 3` or `MIN_MEMBERS = 3`) so the council cannot self-degrade past a safety floor.

**Recommendation:** Add `MIN_COUNCIL_SIZE` and `MIN_THRESHOLD` constants and gate `setThreshold` / `removeMember` on those floors.

**Severity:** Low (degradation requires deliberate council action, not exploitable by outsiders).

---

### G-L3: Council `setExecutionDelay` and `setVetoWindow` accept zero

**File:** `alpha-4/contracts/DatumCouncil.sol:291-297`

**Code:**
```solidity
// alpha-4/contracts/DatumCouncil.sol:291-297
function setExecutionDelay(uint256 blocks) external onlyCouncil {
    executionDelayBlocks = blocks;
}

function setVetoWindow(uint256 blocks) external onlyCouncil {
    vetoWindowBlocks = blocks;
}
```

**Impact:**
Council can vote to set both to 0, removing the cooldown buffer (proposals execute the moment threshold is hit) and disabling the guardian veto (window of zero means no veto possible). This is a deliberate weakening; should require an explicit minimum.

**Recommendation:** Add minimum constants (e.g., `MIN_EXECUTION_DELAY = 1`, `MIN_VETO_WINDOW = 1`) so the council can't accidentally zero these out without a hard-fork redeploy.

**Severity:** Low.

---

### G-L4: PublisherGovernance withdrawVote uses defensive underflow guard rather than revert

**File:** `alpha-4/contracts/DatumPublisherGovernance.sol:196-201`

**Code:**
```solidity
// alpha-4/contracts/DatumPublisherGovernance.sol:196-201
uint256 weight = v.lockAmount * _weight(v.conviction);
if (v.direction == 1) {
    if (p.ayeWeighted >= weight) p.ayeWeighted -= weight;
} else {
    if (p.nayWeighted >= weight) p.nayWeighted -= weight;
}
```

**Impact:**
The `if (p.ayeWeighted >= weight)` silently caps the deduction at zero on underflow rather than reverting. This shouldn't happen in normal flow (weight was added in `vote()`), so reaching the underflow branch indicates a bug — silently swallowing it makes the bug invisible. Solidity 0.8's checked arithmetic would catch it explicitly with a revert.

**Recommendation:** Drop the `if` guard and let Solidity revert on underflow:
```solidity
if (v.direction == 1) p.ayeWeighted -= weight;
else                   p.nayWeighted -= weight;
```

**Severity:** Low. Hides potential bugs rather than introducing one.

---

## Informational

### G-I1: Timelock `receive()` is unused — `execute` doesn't forward value

**File:** `alpha-4/contracts/DatumTimelock.sol:73, 93`

`Timelock.execute` calls `target.call(p.data)` with no `{value: ...}`. The `receive() external payable {}` function (line 93) accepts native deposits with no path to forward them. Either remove the receive (revert on stray transfers, matching the safer pattern in `DatumChallengeBonds`/`DatumTokenRewardVault`) or extend `Proposal` to carry a value field if the comment's intent is real.

### G-I2: GovernanceV2 50/50 ties go to nay (`>=` vs `>`)

**File:** `alpha-4/contracts/DatumGovernanceV2.sol:252-253`

```solidity
bool ayeWins = ayeWeighted[campaignId] * 10000 > total * 5000;
bool nayWins = nayWeighted[campaignId] * 10000 >= total * 5000
            && nayWeighted[campaignId] >= terminationQuorum;
```

A perfect 50/50 split satisfies `nayWins` (>=) but not `ayeWins` (>). Termination wins the tie. This is a conservative tie-breaker (favours the no-action path), likely intentional, but worth surfacing in user-facing governance docs.

### G-I3: PublisherGovernance "fraudUpfield" typo

**File:** `alpha-4/contracts/DatumPublisherGovernance.sol:227, 230, 250`

`fraudUpfield` should be `fraudUpheld`. Cosmetic; appears in the local var name + event.

---

## Areas Reviewed With No Findings

- **Timelock proposal lifecycle** — propose / execute / cancel correctly idempotent; AUDIT-029 7-day expiry in place; MAX_CONCURRENT cap prevents storage bloat; CEI ordering correct.
- **PauseRegistry 2-of-3 guardian flow** — guardian dedup at construction, proposal nonce monotonic, state-change re-check in `approve` (defends against owner pause racing), AUDIT-021 `executed` flag in place of mapping delete.
- **Council reentrancy + permissioning** — `execute` correctly sets `executed = true` before the loop; self-call into `propose()` blocked by `onlyMember` (`isMember[address(this)] == false`); recursive `execute` blocked by `nonReentrant`.
- **GovernanceV2 slash pool accounting** — `slashClaimed` mapping prevents double-claim; `winningWeight` snapshotted at finalization (SM-5); `sweepSlashPool` deadline correctly anchored on `slashFinalizedBlock`.
- **GovernanceRouter passthrough wiring** — `IDatumCampaignsMinimal` passthrough is a clean stub allowing `GovernanceV2.campaigns = router` per the Phase 2 design.
- **ParameterGovernance whitelist + selector check** (AUDIT-004) — execute correctly reads the leading 4 bytes of payload and gates against `permittedSelectors[target][sel]`.
- **CampaignLifecycle re-audit** — drainToAdvertiser already pull-pattern (M-1 fix in place); status-change-then-drain CEI ordering preserved; auto-complete from Settlement remains DoS-safe post-M-1.

---

## Recommendations (Priority Order)

### Address before mainnet

1. **G-M1** — phase-gate the Router `admin*` shortcuts, or rename to `emergency*` and document.
2. **G-M3** — pull-pattern slash sweep + ParameterGovernance bond payouts.
3. **G-M5** — add a propose bond to `PublisherGovernance` to prevent storage spam.
4. **G-M6** — add a treasury withdrawal path on `PublisherGovernance` so the slashed remainder isn't stranded.
5. **G-M2** — bound `slashBps < 10000` in the `GovernanceV2` constructor.
6. **G-M4** — fix the stale `firstNayBlock` grace check (use `lastSignificantVoteBlock` for symmetry).

### Hardening (next release)

7. G-L1 — drop the dead AUDIT-001 conviction floor.
8. G-L2 — add `MIN_COUNCIL_SIZE` / `MIN_THRESHOLD` floors on Council.
9. G-L3 — add minimums for `executionDelayBlocks` / `vetoWindowBlocks`.
10. G-L4 — drop the defensive underflow guards in `PublisherGovernance.withdrawVote`.
11. G-I1 — tighten `Timelock.receive()`.
12. G-I3 — fix the `fraudUpfield` typo.

### After fixes

- Add explicit tests:
  - Phase-1 / Phase-2 ladder: Council/GovernanceV2 set as governor → owner attempts `adminActivateCampaign` → expect revert (after G-M1 fix).
  - GovernanceV2 with `slashBps = 10000` constructor arg → expect revert (after G-M2 fix).
  - PublisherGovernance: spammed proposals before/after bond requirement.
- External audit before Kusama / mainnet.
