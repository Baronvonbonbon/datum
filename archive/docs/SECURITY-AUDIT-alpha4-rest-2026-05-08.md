# DATUM Alpha-4 Security Audit — Remaining Contracts

**Date:** 2026-05-08
**Auditor:** Internal manual review (Claude Code, inline)
**Build:** solc 0.8.24, evmVersion `cancun`, viaIR, optimizer 200 runs
**Branch:** `main` post-`368ce39` (all hot-path + governance fixes applied)

## Scope

Seven contracts not covered in the prior two audits, ~1,533 lines:

| Contract | Lines | Role |
|---|---:|---|
| DatumCampaigns | 580 | Campaign creation, metadata, status, tag registry, allowlist snapshots, community reports (merged TargetingRegistry / CampaignValidator / Reports) |
| DatumPublishers | 266 | Publisher registry, take rate, blocklist, allowlist, SDK version, profile |
| DatumZKVerifier | 214 | Groth16/BN254 verifier with 3 public inputs |
| DatumPublisherStake | 171 | FP-1+FP-4: bonding-curve stake + slash + unstake-delay |
| DatumAttestationVerifier | 146 | P1: mandatory publisher EIP-712 co-sign path |
| DatumClickRegistry | 125 | FP-6: impression→click session tracking for CPC |
| DatumOwnable | 31 | Shared Ownable2Step base (custom error codes, no renounce) |

## Out of Scope

- Off-chain claim builder, ZK trusted setup, governance UX. Same exclusions as the prior two audit passes.
- Hot-path contracts (Settlement / ClaimValidator / Relay / PaymentVault / BudgetLedger / TokenRewardVault / ChallengeBonds / CampaignLifecycle) — covered in `SECURITY-AUDIT-alpha4-hotpath-2026-05-08.md`.
- Governance contracts (GovernanceV2 / Council / Router / Timelock / ParameterGovernance / PublisherGovernance / PauseRegistry) — covered in `SECURITY-AUDIT-alpha4-governance-2026-05-08.md`.

## Executive Summary

No critical findings. One high-severity stake-evasion vector and three medium-severity items.

### Severity counts

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low | 2 |
| Informational | 3 |

### Top 3 to address

1. **R-H1** — `DatumPublisherStake.requestUnstake` moves stake out of the slashable balance before the unstake delay elapses. A publisher anticipating a fraud governance proposal can shield their stake by requesting unstake; `slash()` can no longer reach it.
2. **R-M1** — `DatumZKVerifier.setVerifyingKey` can be called multiple times by the owner. The VK should lock once-only or sit behind a timelock.
3. **R-M2** — `DatumAttestationVerifier.settleClaimsAttested` lacks the same-publisher (SM-1) loop that `DatumRelay` has. Open-campaign batches can mix publisher fields across claims.

---

## High

### R-H1: `requestUnstake` evades slash by moving stake into pendingUnstake

**File:** `alpha-4/contracts/DatumPublisherStake.sol:97-110, 137-147`

**Code (requestUnstake):**
```solidity
// alpha-4/contracts/DatumPublisherStake.sol:97-110
function requestUnstake(uint256 amount) external {
    require(amount > 0, "E11");
    require(_staked[msg.sender] >= amount, "E03");
    require(_pendingUnstake[msg.sender].amount == 0, "E68"); // already pending

    uint256 remaining = _staked[msg.sender] - amount;
    uint256 req = requiredStake(msg.sender);
    require(remaining >= req, "E69"); // would drop below required

    _staked[msg.sender] = remaining;
    uint256 avail = block.number + unstakeDelayBlocks;
    _pendingUnstake[msg.sender] = UnstakeRequest({ amount: amount, availableBlock: avail });
    emit UnstakeRequested(msg.sender, amount, avail);
}
```

**Code (slash):**
```solidity
// alpha-4/contracts/DatumPublisherStake.sol:137-147
function slash(address publisher, uint256 amount, address recipient) external nonReentrant {
    require(msg.sender == slashContract, "E18");
    require(recipient != address(0), "E00");
    uint256 available = _staked[publisher];          // <-- only the active stake
    if (amount > available) amount = available;
    if (amount == 0) return;
    _staked[publisher] = available - amount;
    (bool ok,) = recipient.call{value: amount}("");
    require(ok, "E02");
    emit Slashed(publisher, amount, recipient);
}
```

**Impact:**
`requestUnstake` decrements `_staked[msg.sender]` by `amount` *immediately*, parking the funds in `_pendingUnstake`. The 7-day delay (default `unstakeDelayBlocks = 100,800`) prevents the publisher from actually withdrawing right away — but `slash()` reads only `_staked[publisher]`, which is now smaller. The pending amount is **out of reach for slash** for the entire 7-day delay window.

A publisher who notices a fraud governance proposal forming can:
1. Watch `DatumPublisherGovernance.ProposalCreated` events.
2. Call `requestUnstake(maxAvailable)` to move all but `requiredStake` into `pendingUnstake`. The on-chain `requiredStake` floor still applies (line 104), but with the bonding curve at 1 DOT base + ~10⁻⁷ DOT/impression, the bulk of a real publisher's stake is above the floor.
3. Wait for the proposal to resolve. Slash can only take from the residual amount in `_staked`.
4. After the fraud resolution, ride out the remainder of the unstake delay and pull the protected amount.

Worst case (fraud proposals resolve in days, not hours): a publisher with 100 DOT staked at a 1 DOT requiredStake can shield ~99 DOT from slash. The protocol's slash-deterrent collapses.

**Recommendation:**
Treat pendingUnstake as part of the slashable balance. Two clean options:

(a) **Single counter (preferred).** Replace `_staked` with `_staked = active + pending`, keep a separate `_pendingUnstake` flag for the withdrawability constraint. `slash()` then consumes from the combined balance, preferring pending first so a malicious unstake-then-slash sequence still hurts the publisher:
```solidity
uint256 totalSlashable = _staked[publisher] + _pendingUnstake[publisher].amount;
if (amount > totalSlashable) amount = totalSlashable;
// take from pending first, then from active
uint256 fromPending = Math.min(amount, _pendingUnstake[publisher].amount);
_pendingUnstake[publisher].amount -= fromPending;
uint256 fromActive = amount - fromPending;
if (fromActive > 0) _staked[publisher] -= fromActive;
```

(b) **Cancel-on-slash.** `slash()` first cancels any pendingUnstake (returns the amount to `_staked`) and then deducts from the combined active balance. Same effect, simpler accounting.

Either fix should also update `requestUnstake` so that an immediately-slashable amount can't be hidden via a no-op withdraw cycle.

**Severity:** High. Direct undermining of the fraud-prevention slash mechanism by the very actor it's meant to deter.

---

## Medium

### R-M1: ZKVerifier `setVerifyingKey` is overwritable

**File:** `alpha-4/contracts/DatumZKVerifier.sol:75-96`

**Code:**
```solidity
// alpha-4/contracts/DatumZKVerifier.sol:75-96
function setVerifyingKey(
    uint256[2] calldata alpha1,
    uint256[4] calldata beta2,
    uint256[4] calldata gamma2,
    uint256[4] calldata delta2,
    uint256[2] calldata IC0,
    uint256[2] calldata IC1,
    uint256[2] calldata IC2,
    uint256[2] calldata IC3
) external onlyOwner {
    _vk.alpha1 = alpha1;
    // ...
    vkSet = true;
    bytes32 vkHash = keccak256(abi.encode(alpha1, beta2, gamma2, delta2, IC0, IC1, IC2, IC3));
    emit VerifyingKeySet(vkHash); // AUDIT-018: include VK hash for auditability
}
```

**Impact:**
There is no `require(!vkSet)` check. The owner can overwrite the verifying key at any time. A new VK could accept arbitrary proofs (including all-zero proofs), turning the ZK gate into a no-op without any visible state change beyond an event.

The `VerifyingKeySet` event (AUDIT-018) provides off-chain auditability but cannot prevent the swap. The contract's NatSpec ("VK must be set by owner after running scripts/setup-zk.mjs") presumes a one-time configure pattern but the code doesn't enforce it.

**Recommendation:**
Either (a) make `setVerifyingKey` once-only:
```solidity
require(!vkSet, "E01");
```
or (b) gate it behind the Timelock (the deploy script already configures Timelock as owner of governance contracts). Option (a) is simpler and matches the "set once after trusted setup" intent; if the circuit needs replacement, deploy a new verifier and re-wire `ClaimValidator.setZKVerifier`.

**Severity:** Medium. Centralization risk; only exploitable by a compromised owner key, but the protective gate the contract advertises is only as strong as the owner's key.

---

### R-M2: AttestationVerifier doesn't enforce same-publisher across open-campaign claims

**File:** `alpha-4/contracts/DatumAttestationVerifier.sol:88-97`

**Code:**
```solidity
// alpha-4/contracts/DatumAttestationVerifier.sol:88-97
(, address cPublisher,) = campaigns.getCampaignForSettlement(ab.campaignId);
address expectedPublisher = cPublisher;
if (expectedPublisher == address(0)) {
    // Open campaign: verify against the actual serving publisher.
    // NOTE: claims[0].publisher is self-reported here. Defense-in-depth is
    // provided by DatumClaimValidator downstream, which checks publisher
    // registration in DatumPublishers before accepting settlement.
    expectedPublisher = ab.claims[0].publisher;
}
require(expectedPublisher != address(0), "E00");
```

**Impact:**
For open campaigns, the attestation signer is taken from `claims[0].publisher`. The path then forwards the entire batch to `Settlement.settleClaims` without first checking that **every** claim's publisher matches `claims[0].publisher`. This is exactly the gap I found in `Settlement.settleSignedClaims` and fixed as M-3 — the same fix is missing here.

Same impact as M-3: the signing publisher implicitly takes credit for claims attributed to other publishers in the same batch. `Settlement._processBatch` aggregates `agg.publisherPayment` to `claims[0].publisher`, so cross-publisher batches collapse all credit to the first publisher.

**Recommendation:**
Add the SM-1 loop, mirroring `DatumRelay`:
```solidity
if (cPublisher == address(0)) {
    expectedPublisher = ab.claims[0].publisher;
    for (uint256 i = 1; i < ab.claims.length; i++) {
        require(ab.claims[i].publisher == expectedPublisher, "E34");
    }
}
```

**Severity:** Medium. Same severity rationale as M-3 — no direct theft vector, but the authorization model the user signs against is incomplete.

---

### R-M3: AttestationVerifier `DOMAIN_SEPARATOR` immutable — chain-fork replay

**File:** `alpha-4/contracts/DatumAttestationVerifier.sol:35, 48-54`

**Code:**
```solidity
// alpha-4/contracts/DatumAttestationVerifier.sol:35, 48-54
bytes32 public immutable DOMAIN_SEPARATOR;

constructor(address _settlement, address _campaigns, address _pauseRegistry) {
    // ...
    DOMAIN_SEPARATOR = keccak256(abi.encode(
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        keccak256("DatumAttestationVerifier"),
        keccak256("1"),
        block.chainid,
        address(this)
    ));
}
```

**Impact:**
Same as L-1 in the hot-path audit (which I fixed for `DatumRelay`): the domain separator is baked at deploy time and never recomputed when `block.chainid` differs. On a chain-fork where the verifying contract is deployed at the same address, signatures from one fork can replay against the other.

**Recommendation:**
Inherit OZ `EIP712` (matches `DatumSettlement` and the post-fix `DatumRelay`) and replace the manual digest construction with `_hashTypedDataV4(structHash)`. Drop the `immutable DOMAIN_SEPARATOR`; expose a view function returning `_domainSeparatorV4()` for off-chain clients.

**Severity:** Medium. Standard EVM concern; rare in practice but the in-tree pattern at `DatumRelay` is the exemplar — `AttestationVerifier` should match.

---

## Low

### R-L1: `DatumPublishers` stakeGate trusts arbitrary stake-contract address

**File:** `alpha-4/contracts/DatumPublishers.sol:95-99, 104-107`

**Code:**
```solidity
// alpha-4/contracts/DatumPublishers.sol:95-99
function setStakeGate(address stakeContract, uint256 threshold) external onlyOwner {
    publisherStake = IDatumPublisherStake(stakeContract);
    stakeGate = threshold;
    emit StakeGateSet(stakeContract, threshold);
}
```

**Impact:**
`registerPublisher` consults `publisherStake.staked(msg.sender)` to decide whether a registrant bypasses the whitelist. Owner can swap `publisherStake` to a malicious contract that returns `type(uint256).max` for every caller — turning the bypass into "anyone with any wallet can register" without flipping `whitelistMode`. This is owner trust; today the deploy script wires it to the real `DatumPublisherStake`. But a compromised owner could exploit it with no on-chain trace beyond the (already-emitted) `StakeGateSet` event.

**Recommendation:** Either gate `setStakeGate` behind the Timelock (as governance ladder transitions do for `setGovernor`), or freeze it once set the first time. The existing event is good but isn't a control.

**Severity:** Low. Owner-trust vector; only material if owner key is compromised.

---

### R-L2: `DatumPublishers` queued take-rate update has no cancel path

**File:** `alpha-4/contracts/DatumPublishers.sol:126-141, 144-155`

After a publisher calls `updateTakeRate(newRate)`, the queued `pendingTakeRateBps` cannot be cancelled — the publisher must wait for the delay to elapse, call `applyTakeRateUpdate`, and only then queue a different rate. Operational nuisance; not a security issue. A `cancelPendingTakeRate()` function would round out the lifecycle cleanly.

**Severity:** Low (UX/operational).

---

## Informational

### R-I1: `DatumCampaigns.setMetadata` / `setCampaignRequiresDualSig` accept any status

**File:** `alpha-4/contracts/DatumCampaigns.sol:434-456`

Both setters require only `msg.sender == c.advertiser` and a non-zero campaign. They work even after Completed / Terminated / Expired status. For metadata this is reasonable (advertisers may want to update creative pointers post-campaign for archival linkage). For `requiresDualSig` it's also harmless — the flag has no effect once status > Active. Documenting the choice avoids surprise.

### R-I2: `DatumClickRegistry._sessionHash` uses `abi.encodePacked` on fixed-size fields

**File:** `alpha-4/contracts/DatumClickRegistry.sol:118-124`

The 3-field hash (address, uint256, bytes32) is unambiguous because every field is fixed-size. Same situation as the pre-L-2 `ClaimValidator` hash. If a future schema extension adds a field, switch to `abi.encode` to stay collision-resistant. Currently safe.

### R-I3: `DatumOwnable` is a clean Ownable2Step wrapper

**File:** `alpha-4/contracts/DatumOwnable.sol:1-31`

Custom error codes (E18 / E00), `renounceOwnership` blocked (`revert("E18")`), non-zero requirement on `transferOwnership`. Nothing to flag; included here for completeness.

---

## Areas Reviewed With No Findings

- **DatumPublisherStake stake/unstake mechanics** — separate from R-H1, the bonding curve, requiredStake cap (AUDIT-012), and unstake delay are correctly implemented.
- **DatumZKVerifier pairing math** — public-input truncation `% SCALAR_ORDER` is correct; precompile staticcall return-length checks are present; `pi_a` y-negation handles the 0 edge case; pairing input layout matches EIP-197 (24 × 32 = 768 bytes for 4 pairs).
- **DatumCampaigns role-gated state machine** — `setCampaignStatus` validates transitions via `_validTransition`; activate, togglePause, setMetadata, setRequiresDualSig all properly gated.
- **DatumCampaigns tag registry** — `enforceTagRegistry` toggle, `approveTags`/`removeApprovedTag` swap-and-pop, `hasAllTags` linear scan with MAX cap. Standard.
- **DatumCampaigns community reports** — per-(user,campaign) dedup mappings prevent spam; reason codes 1–5 enforced.
- **DatumPublishers blocklist + unblock timelock** — instant block (defensive), 48h-delayed unblock (`UNBLOCK_DELAY = 172800`), pending state cleared on block re-application.
- **DatumPublishers allowlist + SDK version + profile** — publisher self-service writes only.
- **DatumAttestationVerifier signature verification** — `v ∈ {27,28}`, canonical-s upper bound, `signer != address(0)` all checked. Same defensive pattern as `DatumRelay`.
- **DatumClickRegistry state machine** — `0 → 1 → 2` (recorded → claimed) prevents replay; `recordClick` rejects duplicates; `markClaimed` requires `_sessions[sh] == 1`.

---

## Recommendations (Priority Order)

### Must-fix before mainnet

1. **R-H1** — Stake-evasion is the only serious finding in this set. Fix in `DatumPublisherStake.slash` to consume from `_pendingUnstake` first (or simply combine).
2. **R-M1** — Lock `DatumZKVerifier.setVerifyingKey` once-only.
3. **R-M2** — Add the SM-1 same-publisher loop to `DatumAttestationVerifier`.

### Hardening

4. R-M3 — Migrate `DatumAttestationVerifier` to OZ `EIP712` (mirrors L-1 fix).
5. R-L1 — Timelock-gate `setStakeGate` (or one-shot it).
6. R-L2 — Add `cancelPendingTakeRate()` to `DatumPublishers`.

### After fixes

- Tests:
  - `DatumPublisherStake`: requestUnstake + slash sequence verifies pending is included in slashable balance.
  - `DatumZKVerifier`: second `setVerifyingKey` call reverts after the first.
  - `DatumAttestationVerifier`: open-campaign batch with mismatched publishers reverts E34.
- External audit before Kusama / mainnet.

---

## Audit Trail Summary (All Three Passes)

| Pass | Doc | Findings (C/H/M/L/I) | Status |
|---|---|---|---|
| Hot path | SECURITY-AUDIT-alpha4-hotpath-2026-05-08.md | 0 / 0 / 4 / 4 / 5 | All addressed (commit `9b15285`) |
| Governance | SECURITY-AUDIT-alpha4-governance-2026-05-08.md | 0 / 0 / 6 / 4 / 3 | All addressed (commit `368ce39`) |
| Remaining | SECURITY-AUDIT-alpha4-rest-2026-05-08.md | 0 / 1 / 3 / 2 / 3 | **Open — fix before mainnet** |

Total alpha-4 internal audit surface: **0 critical, 1 high, 13 medium, 10 low, 11 informational** across all 21 production contracts. With this third pass complete, the entire alpha-4 surface has been line-by-line reviewed.
