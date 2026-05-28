# Settlement + Campaigns audit-gap hedges

Pre-audit punch list for the alpha-4 contract suite. Captures the
gap-closing work that would convert the EIP-170 carve-out architecture
from "probably passes" to "very likely passes" a top-tier external
audit (Trail of Bits / OpenZeppelin / equivalent).

**Context.** After Stage 6 (EIP-170 closeout via the Settlement
two-Logic split, commits `85b98ba` → `5a8b291`), `DatumSettlement` and
`DatumCampaigns` both fit under the 24,576 B cap. The architecture
trades on-chain gas + audit surface area for size compliance:

- `DatumSettlement` calls ~10 external satellite contracts per claim on
  the hot path, plus a chained DELEGATECALL through
  `DatumSettlementLogicA` → `DatumSettlementLogicB`.
- `DatumCampaigns` is simpler — single contract, 5 carve-outs, only
  `DatumTagSystem` reached per-claim.

The hedges below target the specific findings an adversarial auditor
would most plausibly write up as **medium** severity, in descending
order of return-per-effort. Times are rough — assume 1.5× for full
test + doc + review.

---

## Confidence baseline

| Contract | First-pass audit confidence (no hedges) | With minimum package | With full package |
|---|---|---|---|
| `DatumSettlement` | 60–70% | 80–85% | 85–90% |
| `DatumCampaigns`  | 75–80% | 85–90% | 90–95% |

Expected findings on `DatumSettlement` without hedges: 5–10 informational
+ 1–3 medium. With the minimum package below: 3–5 informational + 0–1
medium. None I'd expect to rise to high severity in either case.

---

## High-leverage (do these before audit)

### 1. Layout snapshot committed to repo, verified at deploy time

**Closes:** chained-DELEGATECALL drift — the biggest novel-architecture
risk. `test/settlement-layout.test.ts` already asserts
Settlement / LogicA / LogicB share an identical storage layout, but the
check runs only in CI. Nothing prevents deploying contracts compiled
from a divergent tree.

**Action.** Export the layout JSON to
`alpha-4/settlement-layout.snapshot.json`, commit it. Have the layout
test assert it matches the snapshot (not just that A/B/C match each
other). Add a `validateSettlementLayoutMatchesSnapshot()` call at the
top of `scripts/deploy.ts` so any layout drift fails before any
contract is deployed.

**Cost:** ~2 hours. **Audit value:** very high — converts an implicit
invariant into an explicit, version-controlled artifact.

### 2. Direct `msg.sender` preservation tests through the chain

**Closes:** chained-DELEGATECALL semantics. An auditor reading the
`_delegateProcessBatch` helper needs to convince themselves that
`msg.sender` is preserved as the original outer caller, not as
Settlement or LogicA. We can hand them tests that prove it.

**Action.** Add three tests using a mock satellite that records
`msg.sender` on its `validateClaim` call:

- `Settlement.settleClaims(...)` from EOA X → assert LogicB sees `msg.sender == X`
- `Settlement.settleClaims(...)` from `DatumRelay` → assert LogicB sees the relay
- `Settlement.processVerifiedBatch(...)` from `DatumDualSigSettlement` →
  assert LogicB sees DualSig

**Cost:** ~1 hour. **Audit value:** high — an auditor reads these and
the design intent is unambiguous.

### 3. `lockLogic()` lock-once entry on Settlement

**Closes:** captured-owner Logic-swap risk. `setLogic(addressA, addressB)`
is currently owner-rotatable (intentional during alpha/beta), but
nothing prevents an attacker who captures the deployer key from
swapping in malicious Logic contracts. The mitigation today is "owner
becomes the Timelock under OpenGov" — but auditors will flag the
window.

**Action.** Add `function lockLogic() external onlyOwner` plus
`if (_logicLocked) revert AlreadySet();` inside `setLogic`. Add
`bool internal _logicLocked` to the END of `DatumSettlementStorage`
(layout-invariant safe — append-only). Don't call `lockLogic` now;
document that production governance fires it after the Logic pair
stabilizes. Pattern matches existing `lockLanes` / `lockSlashers` /
`lockMintAuthority` clusters.

**Cost:** ~30 min. **Audit value:** high — pattern matches an existing
lock-once cluster, the auditor checks one box.

### 4. Replace try/catch fail-closed with a non-reverting view contract

**Closes:** the single finding I'm most worried about. Currently
Settlement does:

```solidity
effectiveLevel = 2; // default to max enforced
try _campaigns.getCampaignAssuranceLevel(campaignId) returns (uint8 l) {
    effectiveLevel = l;
} catch {
    emit AssuranceLookupFailed(campaignId);
}
```

A malicious Campaigns upgrade could deliberately revert
`getCampaignAssuranceLevel` to force fail-closed rejections of
competitors. Today's mitigation is "Campaigns governance routes
through Timelock" — but the design relies on Campaigns being
well-behaved.

**Action.** Add `getCampaignAssuranceLevelSafe(uint256) returns (bool ok, uint8 level)`
to Campaigns (and analogous safe variants for the other
`getCampaign*` views Settlement reads). Replace Settlement's
try/catch blocks with calls to the safe variants, where:

- `(ok=true, level=N)` → use N
- `(ok=false, ...)` → known unknown (e.g. campaign deleted) — handle explicitly
- A genuine revert → still fail-closed, but now it can ONLY be a
  contract-level bug, not a getter-level grief vector

**Cost:** ~3 hours (Campaigns interface change, Settlement refactor,
test updates). **Audit value:** very high — directly closes the most
plausible medium finding.

### 5. Extract the `effectiveLevel` gradient into a pure helper

**Closes:** gradient-logic complexity. The fail-open/fail-closed
decision in `_processBatch` (M2-fix, H2-fix gradients) is correct but
dense — it's the kind of region where a reviewer can easily misread
intent.

**Action.** Pull the gradient into a pure internal function on
`DatumSettlementStorage`:

```solidity
function _effectiveAssuranceDecision(
    uint8 campaignLevel,
    uint8 userMinAssurance,
    bool advertiserConsented,
    bool fromRelay,
    bool fromPublisherRelay
) internal pure returns (bool accept, uint8 effLevel, uint8 reasonCode);
```

Then add an exhaustive table-driven test that iterates the cartesian
product of inputs (~64 cells) and asserts the expected output per
cell.

**Cost:** ~3 hours. **Audit value:** high — converts a dense control-flow
region into a small, exhaustively-tested pure function. An auditor can
verify the function in 5 minutes and trust the call site.

---

## Medium-leverage (do at least 2 of these)

### 6. Slither + Mythril pre-audit run

Run Slither's detectors on the alpha-4 contracts. Fix obvious findings.
Document false positives in `slither-baseline.json` so the audit firm
doesn't burn time on them. Mythril for the DELEGATECALL chain
specifically (the `assembly { revert(add(ret, 0x20), size) }` bubble
pattern is well-attested but worth a tool sweep).

**Cost:** ~6 hours including dispositioning false positives.
**Audit value:** medium — catches the cheap finds an auditor would
otherwise spend report time on, and signals "we've done the work."

### 7. Foundry fuzz tests on `_processBatch`

Hardhat alone doesn't do property-based fuzzing well. Add `forge test`
alongside Hardhat — the codebase compiles cleanly with both (stock
Solidity 0.8.24, no Hardhat-specific imports in the contracts). Target
~100 fuzz cases on payment math, gate combinations, batch sizes, and
the `_effectiveAssuranceDecision` helper from item #5.

**Cost:** ~1 day for setup + initial fuzz suite. **Audit value:**
medium — surfaces the kinds of edge-case findings (overflow on
multiplication, off-by-one in cap checks) that auditors love to find.

### 8. `docs/SETTLEMENT-ARCHITECTURE.md`

A 3-page document explaining:

- The storage base pattern (`DatumSettlementStorage` as single source
  of truth)
- The DELEGATECALL chain (Settlement → LogicA → LogicB on relay path;
  Settlement → LogicB on dual-sig path)
- `msg.sender` preservation through the chain
- The layout invariant + how it's enforced (test + deploy-time check)
- The upgrade story (`setLogic` rotates the pair atomically;
  `lockLogic` freezes once production-ready)

Auditors orient in 15 min instead of reverse-engineering it.

**Cost:** ~3 hours. **Audit value:** medium-high — efficiency
multiplier on the auditor's time, which translates to deeper coverage
of the actual logic instead of architecture exploration.

### 9. `// SAFETY:` annotations on every try/catch in `_processBatch`

Each try/catch in the inner pipeline makes a security-critical
decision (fail-open vs fail-closed) keyed to the assurance gradient.
Add a `// SAFETY: <one-line rationale>` comment above each one, naming
the gradient rule (M2-fix, H2-fix, etc.) and the consequence of the
opposite choice.

**Cost:** ~1 hour. **Audit value:** medium — removes "why" questions
the auditor would otherwise ask in the report.

---

## Low-leverage (skip unless audit budget allows)

### 10. Public testnet bug bounty

Publish addresses, announce a 30-day bounty (~$5k–$50k pool). Surface
bugs from external eyes before the paid audit window. **Cost:**
significant calendar time + bounty pool. **Audit value:** low-medium —
auditors will still find what they find regardless; this hedges the
*severity* tail more than the count.

### 11. Formal verification of payment math

Certora or similar, targeting the `(totalPayment × cTakeRate) /
BPS_DENOMINATOR` and `userShareBps` computations. **Cost:** weeks +
dollars. **Audit value:** medium for the verified properties, but
probably overkill for an alpha-4 audit.

### 12. Second independent reviewer for the layout/DELEGATECALL slice

Hire a second smaller firm or individual to specifically re-review the
carve-out architecture (not the full contract suite). **Cost:**
$5k–$15k. **Audit value:** medium-high on the novel-architecture risk
specifically, but expensive for the slice it covers.

---

## Recommended packages

### Minimum recommended (~6.5 hours of work)

Items **#1 + #2 + #3 + #4**. Revises confidence from 60–70% → 80–85% on
Settlement; closes the highest-likelihood medium finding (#4) and the
captured-owner finding (#3). Layout enforcement (#1) and `msg.sender`
tests (#2) give the auditor concrete artifacts for the novel
architecture.

### Full recommended (~13.5 hours of work)

Minimum package + **#5 + #8 + #9**. Brings confidence to ~85–90%. The
gradient extraction (#5) and architecture doc (#8) are the items most
likely to convert "5 informational findings" into "2 informational
findings" — both are auditor-time amplifiers more than vulnerability
fixes.

### Defense-in-depth (additional ~1.5 days)

Add **#6 + #7**. Slither/Mythril sweep + Foundry fuzz suite. This is
the package I'd recommend if there's any budget to do it — the cost is
moderate and the residual risk after these is mostly "things genuinely
novel auditors would find" rather than "things tools or fuzz would
have caught."

---

## What this list does NOT cover

These are real but out of scope here:

- **DatumCampaigns audit hedges** beyond what's implied by item #4
  (the safe-view variants). Campaigns is structurally simpler; the
  primary audit risks are the lock-once-after-Active patterns and the
  long `createCampaign` function — both well-tested.
- **Pre-mainnet remerge** — see
  `~/memory/project_eip170_remerge_plan.md` (in user auto-memory).
  The remerge story is about gas recovery once mainnet is real, not
  audit-pass; the carve-outs are correct as-shipped.
- **Upgrade ladder** audit — `STATUS.md` items 8 + the cypherpunk
  roadmap. Separate concern.

---

## File references

- `alpha-4/SETTLEMENT-EIP170-PLANNING.md` — the planning doc for the
  Logic split itself
- `alpha-4/MAINNET-DEFERRED-ITEMS.md` — the broader pre-mainnet punch
  list
- `alpha-4/contracts/DatumSettlementStorage.sol` — single source of
  truth for storage layout
- `alpha-4/test/settlement-layout.test.ts` — current layout invariant
  test (the snapshot in item #1 augments this)
- `STATUS.md` — current line items 10–14 (the path to mainnet beyond
  EIP-170)
