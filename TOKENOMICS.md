# DATUM Token — Spec & Plan

**Status:** draft v0.2 (architecture frozen, sections being walked one-by-one)
**Date:** 2026-05-10
**Scope:** the DATUM ownership token, its utility, distribution, and integration with the existing DOT-denominated protocol.

---

## 0. Architecture decision (frozen)

**DATUM is a hybrid token: native Asset Hub asset (canonical) + auto-minting ERC-20 wrapper on Polkadot Hub (utility).**

### Layout

```
              ┌──────────────────────┐
              │  Asset Hub (Polkadot │
              │  parachain)          │
              │                      │
              │  DATUM (canonical)   │←── mint authority
              │  · native asset      │      = DatumSettlement
              │  · single source of  │      (during hybrid phase)
              │    truth for supply  │
              └──────────┬───────────┘
                         │
              precompile bridge / XCM
                         │
              ┌──────────▼───────────┐
              │  Polkadot Hub (EVM)  │
              │                      │
              │  WDATUM (wrapper)    │
              │  · 1:1 backed        │
              │  · auto-minted by    │
              │    DatumSettlement   │
              │    on every claim    │
              │  · used for all      │
              │    EVM utility:      │
              │    governance,       │
              │    staking,          │
              │    fee share,        │
              │    bonds, etc.       │
              └──────────────────────┘
```

### Mint flow (zero per-claim friction)

`DatumSettlement.settleClaim(...)` → in one tx:
1. Precompile call: mint canonical DATUM to the wrapper's reserve address.
2. Wrapper call: mint WDATUM to user / publisher / advertiser per the split.

Recipients hold WDATUM directly — no wrap step needed. Governance, staking, bonds all work immediately.

### Unwrap / re-wrap

- `wrapper.unwrap(amount, assetHubRecipient)` — burns WDATUM, releases canonical to the user's Asset Hub address. For sending cross-chain or holding long-term as canonical.
- `wrapper.wrap(amount)` — user transfers canonical to wrapper, mints WDATUM. For re-entering EVM utility.
- Both are zero-fee. No protocol take on wrap/unwrap.

### Invariants

- `wrapper.totalSupply() ≤ canonical.balanceOf(wrapper)` at all times. Equality when no canonical is held outside the wrapper.
- Wrapper has **no admin key**. Mint is gated to `DatumSettlement` only. Burn is user-initiated only. No rug-pull surface.
- Total supply (for governance, fee share, etc.) reads `canonical.totalSupply()` — single source of truth.

### Why hybrid (rationale)

- **Native canonical** secures the future parachain migration: the canonical asset moves cleanly via XCM to a future DATUM parachain with no claim contracts, no migration drama, no lost holders.
- **EVM wrapper** keeps governance + staking ergonomic: ERC-20 standard `transferFrom`/`approve`/`balanceOf` semantics, cheap reads (single SLOAD), standard checkpoint patterns for snapshot voting.
- **Auto-mint** removes per-claim friction: users never need to "wrap to use" — they receive WDATUM directly and unwrap only if they want to leave the EVM utility surface.

### Migration roadmap to native-only (post-parachain)

The hybrid is transitional. Three phases:

**Phase 1 (today): Hybrid.**
Settlement mints both sides atomically. WDATUM is the default user experience for governance/staking. Asset Hub canonical exists for cross-chain / parachain holders.

**Phase 2 (DATUM parachain launch):**
- Parachain ships with native pallets for staking, governance, fee share — replacing the EVM contracts.
- Canonical supply teleports from Asset Hub → DATUM parachain via XCM. Holders, balances, metadata carry over (standard Asset Hub asset migration).
- Mint authority for new issuance transfers from `DatumSettlement` (EVM) to the parachain's native issuance pallet. Settlement contract on Polkadot Hub stops minting.
- Wrapper enters **wind-down mode**: `wrap()` disabled (no new entrants); `unwrap()` still works (existing WDATUM holders can exit at their pace).
- Parachain native DATUM is fully utility-bearing on day one of phase 2.

**Phase 3 (wrapper sunset, ~12 months after phase 2):**
- After grace period, wrapper is deprecated. WDATUM holders who haven't unwrapped are notified well in advance.
- Parachain native is the only DATUM going forward.

**Critical guarantee:** at no point do new mints require an unwrap step to gain utility. During hybrid, mints are auto-wrapped. After parachain launch, mints are native on the parachain (which has native utility from day one).

### Friction cost of the hybrid

- **One extra contract** in the repo (the wrapper). ~150 LOC. Battle-tested pattern (WETH).
- **Two atomic ops per settlement mint** instead of one — adds ~30k gas to `_settleSingleClaim`. Acceptable; settlement is not the hot bottleneck.
- **Cross-chain users** who never want EVM utility can ignore WDATUM entirely — they hold canonical and never interact with the wrapper.
- **Wallet UX** has to surface WDATUM as the "default" balance, not canonical. Explorer integrations need to know both contracts.

These are all small. The migration upside (clean parachain path, no claim contracts, no lost holders) outweighs the per-tx overhead by orders of magnitude.

---

## 1. Core principles

These constrain every other decision in this document. Each is load-bearing — if a later section's design conflicts with one of these, the principle wins.

### 1.1 DOT preserved as the utility currency

Advertisers always pay budget in DOT. Publishers always earn DOT. Users always receive DOT for impressions. **No one needs to acquire DATUM to participate as an advertiser, publisher, or user.** DATUM is purely additive.

### 1.2 DATUM is an ownership token, not a payment token

DATUM captures the rights of *owning a piece of the protocol*:

- **Cashflow** — pro-rata share of protocol fees.
- **Parameter governance** — vote on protocol-wide tunables and ratify upgrades.
- **Trust collateral** — slashable bonds for roles where economic skin-in-the-game improves outcomes (council seats, fraud bonds, relay operators).
- **Coordination token** — credible commitment for actions that signal intent (proposing changes, taking on protocol roles).
- **Public-good funding** — substrate for community-treasury grants and ecosystem development, when treasury mechanisms are activated.

All five flow from the same underlying primitive (token holdings + lockups). DATUM does not replicate DOT's role as a medium of exchange.

### 1.3 Cypherpunk grassroots distribution

No ICO. No VC round. No public sale. No liquidity-mining programs ("stake X to earn Y"). No strategic partnership token grants. **Value comes from utility, not financial engineering.**

The only allocations are:
- A capped founders' premint with vesting (runway only — small enough to be irrelevant to long-term ownership).
- Settlement-driven emissions (real protocol usage = the only path to new tokens).

Retroactive distribution to historical users / publishers / advertisers is consistent with this principle (it rewards prior utility, not speculation) but is opt-in and decided per-case via governance.

### 1.4 Hard cap is non-governable

Total supply is fixed at genesis. **Governance cannot raise the cap. Ever.** Bitcoin-style immutability. This is the strongest credible commitment we can make about long-term scarcity, and it should not be subject to "but in this special case…" pressure later. If a future protocol needs more issuance capacity, it issues a different token.

Implementation: the cap is a `uint256 public constant` in the canonical asset's mint authority. No setter. No governance hook. Burned into the contract at deploy.

### 1.5 Anti-financialisation

DATUM's value should accrue from being useful, not from speculation engineered into the protocol. Concrete operational rules:

- **No yield-farming-style incentives** wrapped around DATUM (no LP rewards, no synthetic yield, no DATUM-earning-DATUM loops).
- **No protocol-issued derivatives** (no DATUM perps, no synthetic exposure tokens issued by the protocol).
- **DEX trading is fine** — Hydration, Acala, etc. are welcome. The protocol does not subsidise or impede secondary markets.
- **Skin-in-the-game for decisions, not trading.** Anywhere DATUM grants decision rights (governance, council, bonds), there is a meaningful lockup or stake. This makes decisions cost time/illiquidity without preventing free-market price discovery.
- **Speculation is a side effect, never a goal.** No protocol design choice should exist solely to drive token price.

### 1.6 Decentralisation over speed, with a sunset clause for admin

Where two designs are equivalent except one centralises authority, take the decentralised one. Accept slower iteration for credible neutrality.

**Every admin/owner function in the DATUM-token contracts has a documented sunset path tied to a participation threshold.** When circulating supply, governance participation, or council size crosses defined thresholds, the corresponding admin keys are removed or transferred to permissionless governance. Admin functions are scaffolding, not load-bearing. Sunset triggers are specified in §X (TBD when we get there) and are themselves non-governable once set.

### 1.7 Migration to parachain is non-optional

DATUM has a documented sunset path from EVM-wrapper to parachain-native (see §0). **No design choice in this spec should make that path harder.** If a later section's design (custodial wrapper extensions, EVM-only governance state, off-chain mint authority, etc.) blocks or complicates the canonical migration, the design is rejected. The hybrid is transitional; the parachain is the destination.

### 1.8 Migration policy: nothing critical is live

The protocol is in alpha. **No real economic value is currently locked in any contract that would be affected by a currency switch or migration.** This justifies the simplest possible migration approach throughout this spec: when a contract switches currency (DOT → WDATUM) or otherwise migrates, existing locked positions are force-released back to their owners and the contract starts fresh under new rules.

This policy applies to:
- `DatumParameterGovernance` currency switch (§2.3) — existing DOT votes force-withdrawn.
- `DatumPublisherGovernance` vote currency switch (§2.3) — existing DOT votes force-withdrawn.
- `DatumPublisherGovernance` propose-bond currency switch (§2.6) — existing DOT propose-bonds force-released, open proposals cancelled.
- Council bonding activation (§2.2) — voluntary opt-in grace period replaces forced bonding.
- Any other migration step introduced in later sections.

The policy expires once mainnet stabilises with real value at stake. Mainnet migrations will require honoring existing positions and may need dual-currency parallel paths. This document is for the pre-mainnet design.

---

## 2. Utility — what DATUM does

The eight roles below were selected from a longer brainstorm. Each section names the contract surface where it lands and what changes vs. today.

### 2.1 Protocol fee share — `DatumFeeShare`

**Role.** Cashflow utility. Replaces the current `pendingProtocolFee` admin-pull with a per-stake DOT distribution to WDATUM stakers.

**Stake / earn pair.**
- Stake currency: **WDATUM** (the EVM wrapper). Native canonical holders wrap before staking.
- Reward currency: **DOT** (protocol fees are DOT-denominated, settlement is DOT-denominated, stakers earn the real cashflow).
- This is intentionally **not** a self-referential loop (no stake-DATUM-earn-DATUM). Aligns with §1.5 anti-financialisation.

**Distribution math.** Standard MasterChef / SushiBar accumulator:

```
accDotPerShare       // running total of DOT distributed per WDATUM staked, ×1e12
userStake[a]         // a's currently staked WDATUM
userDebt[a]          // a's accumulator value at last settle
```

On `notifyFee(amount)`: `accDotPerShare += amount * 1e12 / totalStaked` (no-op if `totalStaked == 0`).

On stake / unstake / claim: settle a's pending = `userStake[a] * accDotPerShare / 1e12 - userDebt[a]`; pay it out; update `userDebt[a]` to current accumulator value. Same-block stakers accrue nothing because their debt is snapshot at deposit-time.

**Lockup.**
- **None.** Withdrawals are immediate. The accumulator pattern already prevents flash-stake attacks (a same-block staker has zero pending), and an explicit lockup adds friction without additional security.

**Fee delivery — periodic batch sweep.**
- Settlement does **not** call FeeShare on every claim (keeps the hot path gas flat).
- Fees accumulate in `DatumPaymentVault` as before, in a new `pendingFeeShare` slot.
- Anyone can call `feeShare.sweep()` to move accumulated fees: pulls from PaymentVault, calls `notifyFee(amount)`. Idempotent (no-op if nothing pending).
- A daily off-chain bot or a cheap scheduled call keeps fees flowing without anyone being a privileged sweeper.

**Minimum stake.**
- **Zero.** Any non-zero WDATUM balance can stake. The accumulator handles dust natively.

**Treasury skim at genesis.**
- **0%.** All swept fees route to stakers. Governance can later vote a non-zero treasury skim into the sweep path (e.g. 5% to community treasury / 95% to stakers), but it's not pre-baked.

**Compounding.**
- **No built-in.** Stakers receive raw DOT. No `claimAndSwap(routerAddr)` helper, no DEX integration in the contract. External tools (or the user manually) handle DOT → WDATUM if they want to compound. Keeps `DatumFeeShare` pure of DEX dependencies.

**Migration impact on existing contracts.**
- `DatumPaymentVault.withdrawProtocol(recipient)` stays as a fallback (in case FeeShare is ever paused or sunset), but the default recipient becomes `DatumFeeShare`. Governance can revoke the fallback once FeeShare is mature.
- New storage on PaymentVault: `pendingFeeShare` (uint256, accrues protocol fees pending sweep).
- New external entrypoint on PaymentVault: `drainPendingFeeShare(address feeShare)` — `onlyFeeShareOrGovernance`.

**Pause-respect.** All sweep + claim paths check `DatumPauseRegistry.paused()` and revert with `"P"` if paused.

**Audit surface.** ~250 LOC. Pattern is battle-tested (SushiBar, MasterChef, every yield-farming primitive). Main risks:
- Accumulator scale: `1e12` is sufficient for typical balances; with very small `totalStaked` and large fee inflows, rounding loss is non-zero but rounds toward the contract (not stakers — i.e. pro-protocol direction).
- Fee notifyFee called on `totalStaked == 0` must be a no-op or fees are silently lost. Spec requires the no-op path.

### 2.2 Council bonding — `DatumCouncil` collateral

**Role.** Long-term commitment. Council seats require a locked, slashable WDATUM bond. Today the council has no economic gate; this adds skin-in-the-game without changing the N-of-M voting model.

**Bond size.**
- Stored as `bondAmount` on `DatumCouncil`, **governance-tunable** via ParameterGovernance.
- Initial value at activation: deliberately low (e.g. 10,000 WDATUM) — circulating supply is small in early phase 1, and a bond that's prohibitive at that point excludes good candidates.
- Existing bonds are **grandfathered at the rate they posted at**. Raising `bondAmount` later does not retroactively top up existing seats; it only affects newly bonded seats. This prevents weaponising bond raises against current members.

**Slashable conditions — three only (kept narrow on purpose).**

| Trigger | Mechanism | Bond fate |
|---|---|---|
| **(b) Inactivity** — member fails to vote on N consecutive proposals | Automatic — anyone can call `markInactive(memberAddr)` after the threshold; contract verifies missed-vote count and slashes | → treasury |
| **(d) Manual governance** — explicit slash proposal cites the member, passes ParameterGovernance | `slashCouncilMember(addr, recipient, reason)` callable only by ParameterGovernance.execute | → treasury default; proposal can override to a named victim |
| **(e) Forced removal vote** — council removes a member via internal proposal | Bond redirects on the removal-execution path | → treasury |

Conditions explicitly **not** slashable (rejected to avoid weaponising the bond against good-faith disagreement):

- ~~Proposing something the guardian vetoed~~ — too easy to abuse against contrarians.
- ~~Voting on the wrong side of a later-reversed proposal~~ — punishes honest mistakes; chilling effect on participation.
- ~~Showing up but voting "incorrectly"~~ — there is no correct vote.

The principle: slash for **abandonment** and **provable misconduct**, not for **disagreement**.

**Inactivity threshold.**
- Stored as `inactivityThreshold` on `DatumCouncil`, governance-tunable.
- Default: missing 5 consecutive proposals OR no vote in 90 days (whichever fires first).

**Slash recipient.**
- **Default: protocol treasury.** Funds the public-good role from §1.2.
- **Optional victim override** for case (d) only — the slash proposal can specify a recipient address other than the treasury (e.g. compensating a publisher harmed by the member's misconduct).
- **Never burned.** DATUM is utility-bearing; burning would convert utility into a deflationary signal, which conflicts with §1.5.
- **Never redistributed to remaining council members.** Creates a perverse incentive to slash colleagues.

**Voluntary exit — 30-day cool-down.**
- Member calls `resign()` → status flips to "exiting", bond locked but not returned.
- 30-day window during which slashing proposals can still hit the bond (closes the "exit before being slashed" escape hatch).
- After 30 days with no slash: bond fully released to the resigning member.
- Cool-down length is governance-tunable, defaults to 30 days. Does not retro-apply to already-resigned members.

**Phase-in for existing members.**
At the proposal that activates bond requirements:
1. Grace period (e.g. 60 days) where existing members can voluntarily post bond to keep their seat.
2. After grace: members who haven't bonded are auto-removed via a sweep call (`pruneUnbonded()` callable by anyone).
3. Their seats become vacant; standard council process backfills.

This avoids both "two-class council forever" and "overnight forced resignation."

**Storage additions to `DatumCouncil`.**

```solidity
mapping(address => uint256)  public memberBond;             // posted bond per member
mapping(address => uint256)  public memberMissedVotes;      // running count, reset on each vote
mapping(address => uint256)  public memberLastVoteBlock;    // last vote timestamp / block
mapping(address => uint256)  public exitingAt;              // 0 unless resigning
uint256 public bondAmount;                                  // current required bond
uint256 public inactivityThreshold;
uint256 public exitCooldownBlocks;
```

**Audit surface.** Small (~150 LOC additional on the existing council contract). Main risk vectors:
- Bond return on resignation must be re-entrancy safe (use the pull pattern: `pendingBondReturn[member]` → user-claimed).
- `markInactive` must verify the inactivity claim from on-chain state alone (no oracle).
- Grace-period sweep `pruneUnbonded()` must not be DOS-able by adding fake members.

### 2.3 Quadratic-weighted protocol governance

**Role.** Parameter governance. Switches the vote-lock currency from DOT to WDATUM on protocol-meta governance contracts. Applies a quadratic dampener to compress whale dominance without disenfranchising small holders.

**Scope — which contracts switch.**

| Contract | Vote currency | Reason |
|---|---|---|
| `DatumGovernanceV2` (per-campaign termination) | **DOT** (unchanged) | Quality-control flagging on individual campaigns; should be open to any DOT holder with skin-in-the-game, not gated on protocol ownership |
| `DatumParameterGovernance` (protocol tunables) | **WDATUM** (switch) | Protocol-wide policy decisions; ownership stake required |
| `DatumPublisherGovernance` (publisher fraud) | **WDATUM** (switch) | Fraud verdicts change protocol policy (slash stake, redirect bonus pools), more meta than per-campaign judgement. Symmetric with the WDATUM-denominated challenge bonds in §2.6 |

**Vote weight formula.** Piecewise dampener with linear floor + sqrt above:

```
function weight(amount, conviction):
    if amount <= DAMPENER_THRESHOLD:
        dampened = amount                                  # small holders: full weight
    else:
        dampened = DAMPENER_THRESHOLD + sqrt(amount - DAMPENER_THRESHOLD)
    return convictionMultiplier(conviction) * dampened     # outer multiplication
```

- `DAMPENER_THRESHOLD` is governance-tunable. Default: **100 WDATUM**.
- Below the threshold: holders feel their full vote (no "1 token = 1 weight" psychological disincentive for small voters).
- Above the threshold: each marginal WDATUM contributes √n weight. 10,000 WDATUM ≈ 199 weight; 1,000,000 WDATUM ≈ 1,099 weight. Whales aren't excluded, just flattened.
- Conviction multiplier applies **outside** the dampener — long-lockers get their commitment fully rewarded on top of the dampened capital. This avoids double-punishing whales who also commit to long lockups.

Conviction table itself is unchanged (multipliers 1, 2, 3, 4, 6, 9, 14, 18, 21 across 0-8 levels).

**Quorum unit.** Switches from a fixed DOT amount to a percentage of circulating WDATUM-equivalent supply:

```
quorum = canonical.totalSupply() * quorumBps / 10000
```

- Default: **1%** of circulating (`quorumBps = 100`).
- Governance-tunable. Auto-scales with token issuance — quorum doesn't become irrelevant as supply grows or impossibly high during early phases.
- Note: uses `canonical.totalSupply()` (Asset Hub native asset) as the source of truth, not `wrapper.totalSupply()`. This counts both wrapped and unwrapped DATUM in the denominator. Voters must still lock **WDATUM** specifically, but the quorum reflects the full ownership base.

**Proposer bond vs vote — kept separate.** Posting the propose-bond does NOT auto-cast an aye vote. A proposer can surface a question and remain neutral or even vote nay on their own proposal. Aligned with the spirit of separating "I want this debated" from "I support this outcome."

**Migration: existing DOT-locked votes at switch.**

Force-withdraw on activation. Rationale: nothing critical is currently live in ParameterGovernance or PublisherGovernance, and dual-currency support during a transition adds complexity without value.

- At the proposal that activates the currency switch:
  - All currently-locked DOT votes auto-unlock back to voters (regardless of remaining conviction lockup).
  - All open proposals reset their vote tallies to zero.
  - From that block onward, new votes require WDATUM `transferFrom`.
- Stakers who want to continue voting re-cast in WDATUM.

This is a one-time clean-cut. Simpler than dual-currency parallel paths; acceptable because no real value or live decisions are at stake.

**Implementation surface.**

- New constructor arg / setter: `wdatumToken` (the wrapper address).
- `vote()` changes from `payable` (DOT) to `transferFrom(wdatum, voter, this, amount)`.
- `withdrawVote()` returns WDATUM instead of DOT.
- Slashing redirects WDATUM (to treasury) instead of DOT.
- ~200 LOC changed across PG and PublisherGov + corresponding test rewrites.

**Storage additions.**

```solidity
address public wdatumToken;            // EVM wrapper address
uint256 public dampenerThreshold;      // default 100e18
uint256 public quorumBps;              // default 100 = 1%
```

**Open: WDATUM availability.** The vote currency switch requires WDATUM to exist before the migration proposal is filed. The phase ordering in §8 enforces this: token contract deploys first, settlement mints begin populating supply, FeeShare turns on, then governance switches. Voters acquire WDATUM via settlement participation or DEX before the switch lands.

### 2.4 Publisher allowlist DATUM bypass — `DatumPublishers` extension

**Role.** Trust collateral. Adds a DATUM-staked path to bypass the whitelist mode in `DatumPublishers`, parallel to the existing DOT-staked path. Publishers can register without administrative approval by committing either DOT or WDATUM.

**Stake source — DatumFeeShare, not balance.**

The bypass reads `DatumFeeShare.stakedBy(publisher)`, **not** `wdatum.balanceOf(publisher)`. Reasons:

- Pure-balance gating allows a whale to register many publisher addresses by shuttling the same tokens between wallets at each `registerPublisher` call.
- Stake-based gating combines two utilities (fee-share earnings + registration bypass) into one commitment, consistent with §1.5 "skin-in-the-game for decisions."
- Movement requires unstake → wait nothing (no lockup per §2.1) → restake. Round-trip overhead discourages address-shuttling without preventing legitimate use.

**Gate logic — pure-parallel OR.**

Updated `registerPublisher` precondition:

```solidity
require(
  !whitelistMode
  || approved[msg.sender]
  || publisherStake.staked(msg.sender) >= dotStakeGate
  || feeShare.stakedBy(msg.sender) >= datumStakeGate,
  "E79"
);
```

No combined / weighted formula. A publisher satisfies the gate via the DOT path or the DATUM path, never a normalisation across both. Keeps the contract reasonable about and avoids any cross-currency oracle.

**Threshold size — governance-tunable, starts low.**

- Stored as `datumStakeGate` on `DatumPublishers`. Default at activation: **1,000 WDATUM** (an order of magnitude below council bond — registration is a less powerful role than a council seat).
- Tunable via ParameterGovernance.
- Existing registered publishers are **unaffected**: they registered under prior rules and remain valid.

**Grandfathering on later unstake.**

If a publisher registers via DATUM stake bypass and later withdraws their stake from FeeShare:

- **They remain a registered publisher.** Registration is a one-time admission gate, not an ongoing requirement.
- Their *ongoing publisher activity* is separately governed by reputation (already), DOT stake adequacy on `DatumPublisherStake` (already), and fraud governance (already). DATUM stake bypass is solely an entry point.
- This avoids breaking active publishers when they need to move funds, without weakening the protections that matter (reputation, DOT stake, fraud).

**Same scope as DOT gate.**

The DATUM bypass only matters when `whitelistMode == true`. With whitelist mode off (the default in mature operation), neither gate is checked — registration is open. No new gating modes are introduced; this is purely an expansion of paths within the existing whitelist scope.

**Storage additions.**

```solidity
address public feeShare;            // for stakedBy() reads
uint256 public datumStakeGate;      // default 1000e18 WDATUM
```

`feeShare` is set via the existing `setStakeGate(...)` pattern (or a parallel `setDatumStakeGate(...)` setter, owner-gated, governance-tunable).

**Effects on §1.7 migration.** Once parachain native staking pallets exist, the bypass reads `parachainStaking.bondedBy(publisher)` instead of `feeShare.stakedBy(publisher)`. The contract setter swaps the source pointer; no behavioural change for publishers.

### 2.5 Advertiser fee discount — `DatumSettlement` extension

**Role.** Cashflow incentive for advertisers who hold protocol equity. Reduces the protocol take on their settlements by a small bps amount, drawn from a stake-tiered table. Designed to add **at most one SLOAD** to the settlement hot path.

**Tier curve — step function, 4 tiers.**

```
stakedBy(advertiser) in WDATUM      →    discount (bps off protocol take)
< 1,000                                  0     (no discount)
1,000   – 9,999                          25    (0.25%)
10,000  – 99,999                         75    (0.75%)
100,000 – 999,999                        150   (1.50%)
≥ 1,000,000                              200   (2.00% — absolute cap)
```

Step function chosen over linear/log because:
- Differences feel meaningful at each tier (50-75 bps jumps).
- Tier edges are publicly known — no surprise to advertisers.
- Capped at 200 bps absolute (governance-tunable upper bound, but never exceeds protocol take).

Tier thresholds and bps values are governance-tunable via ParameterGovernance.

**Stake source — reuse DatumFeeShare.**

The discount reads `DatumFeeShare.stakedBy(advertiser)`, the same source as §2.4's publisher bypass. A single act of staking unlocks multiple utilities (fee earnings + publisher registration + advertiser discount). This is intentional — DATUM is ownership, ownership confers all the rights from one commitment.

An entity that's both a publisher and advertiser earns all three benefits from a single stake. No double-dip prevention; this is a feature, not a bug, of role-fungible commitment.

**Hot path on `_settleSingleClaim` — single SLOAD, no math.**

```solidity
// In settlement, when computing the protocol fee:
uint16 discountBps = advertiserDiscountBps[advertiser];           // SLOAD #1 (cache)
if (discountBps > 0 && block.number <= discountExpiry[advertiser]) {  // SLOAD #2 (expiry)
    take -= (take * discountBps) / 10000;
}
```

Two SLOADs (the two slots can be packed if `discountExpiry` fits in a uint64 alongside the uint16). No external calls, no math beyond a single multiplication.

**Lazy refresh — anyone can call.**

`refreshAdvertiserDiscount(address advertiser)` external, no auth:
- Reads `DatumFeeShare.stakedBy(advertiser)`.
- Looks up the tier from the on-chain table.
- Writes `advertiserDiscountBps[advertiser] = newBps` and `discountExpiry[advertiser] = block.number + MAX_DISCOUNT_AGE`.
- Min interval: **14,400 blocks (~24h)** between refreshes per advertiser. Prevents griefing spam.

Anyone can refresh anyone else's discount. The advertiser is incentivised to refresh themselves when they want a discount; competitors are incentivised to refresh when they want a competitor's stale discount cleared. Self-policing.

**Stale-discount auto-expiry.**

The discount entry has an upper-bound age:

```
MAX_DISCOUNT_AGE = 432,000 blocks (~30 days)
```

After this, `discountExpiry[advertiser]` falls behind `block.number`, and the hot-path check returns 0 even if the cached `discountBps` is non-zero. Forces a re-refresh every 30 days minimum.

Without this, an advertiser could stake → refresh → unstake → keep the discount forever. The 30-day cap closes that loophole without requiring third-party policing.

**Coverage — all actionTypes.**

The discount applies uniformly to CPM (impressions), CPC (clicks), and CPA (actions). Asymmetric application would add settlement-loop branching for marginal benefit; uniform is simpler and economically equivalent (an advertiser saves the same total bps regardless of which actionType drives their volume).

**Storage additions to `DatumSettlement`.**

```solidity
mapping(address => uint16)  public advertiserDiscountBps;
mapping(address => uint64)  public discountExpiry;        // packs with above
mapping(address => uint64)  public lastRefreshBlock;
address public feeShare;                                  // for stakedBy() reads

// Tier table (governance-tunable):
uint256[4] public discountTierThresholds;   // [1000, 10000, 100000, 1000000] * 1e18
uint16[4]  public discountTierBps;          // [25, 75, 150, 200]
uint256 public maxDiscountAge;              // default 432_000 blocks (~30d)
uint256 public minRefreshInterval;          // default 14_400 blocks (~24h)
```

**Total gas overhead on hot path.** 2 SLOADs + 1 conditional + 1 multiplication. Cold first-call, warm thereafter. Compared to the previous take calculation: ~200 gas additional per settled claim. Negligible at protocol-scale throughput.

**Open: handling top-tier advertisers' refresh frequency.** A whale at 1M+ WDATUM benefits from a 200 bps discount. They'll refresh at the start of every 30-day window. Nothing about this is exploitative, but worth noting as expected behaviour. Bot operators can offer "refresh-as-a-service" gas refunding if it becomes a UX issue (out of protocol scope).

### 2.6 Bonds — selective WDATUM switch

**Role.** Trust collateral + coordination. Replaces DOT with WDATUM in *governance-related* bonds only. **Bonds tied to primary protocol functions (campaign creation, publisher operation) stay DOT** to preserve §1.1.

**Three bond surfaces — three different currency decisions.**

| Bond surface | Today | Decision | Rationale |
|---|---|---|---|
| `DatumChallengeBonds` — bond at campaign creation | DOT | **Stays DOT** | Campaign creation is a primary advertiser function (§1.1). Forcing WDATUM here would violate "no one needs DATUM to participate as advertiser" |
| `DatumPublisherGovernance` propose-bond | DOT | **Switch to WDATUM** | Filing a fraud proposal is a governance action, not a primary function. Symmetric with §2.3 (votes are WDATUM) — same currency required to propose and to vote |
| `DatumPublisherStake` — publisher operational stake | DOT | **Stays DOT** | Operating as a publisher is a primary function (§1.1). Stake size grows with cumulative impressions — this is an economic commitment to publisher operations, not a governance signal |

**Publisher's bonus pool — single-pool DOT.**

On fraud upheld, the slashed publisher stake (DOT) routes to the publisher's bonus pool in `DatumChallengeBonds` — same as today. Pool stays DOT-denominated.

The newly WDATUM-denominated propose-bond, when slashed (rejected proposal), routes to the **protocol treasury** rather than to the publisher's bonus pool. This avoids dual-currency accounting on the bonus pool: pool stays clean DOT, slashed WDATUM gov-bonds fund the public-good role of the treasury (§1.2).

```
                    UPHELD FRAUD                          REJECTED PROPOSAL
                          │                                       │
        ┌─────────────────┴─────────────────┐                    │
        ▼                                   ▼                    ▼
  Publisher stake                   Propose-bond              Propose-bond
  (DOT) slashed                     (WDATUM) released         (WDATUM) slashed
        │                                   │                    │
        ▼                                   ▼                    ▼
  ChallengeBonds                    Returned + bonus       Protocol treasury
  bonus pool (DOT)                  to proposer
        │
        ▼
  Claimable by advertisers
  who bonded against this
  publisher (DOT)
```

This is cleaner than two-pool model, doesn't require an oracle/DEX, and routes value where it's most useful (treasury for upgrades + public goods).

**Bond size — governance-tunable.**

The propose-bond amount on `DatumPublisherGovernance` becomes a WDATUM value, governance-tunable. Default at activation: e.g. **100 WDATUM** (low enough to not block sincere proposals, high enough to discourage spam).

Bond size is parameter-governable via ParameterGovernance (which itself is WDATUM-locked per §2.3).

**Migration on switch — force-withdraw existing DOT bonds.**

Identical pattern to §2.3:
- At the activation proposal: existing DOT-bonded proposals are auto-cancelled, bonds returned to proposers, all state reset.
- From that block onward: `propose()` requires `wdatum.transferFrom(proposer, this, bondAmount)`.

Nothing critical is live in PublisherGovernance — force-withdraw is the simplest path and avoids dual-currency code branches.

**Implementation surface.**

- `DatumPublisherGovernance.propose()` — change from `payable` (msg.value == bond) to `transferFrom(wdatum, msg.sender, this, bondAmount)`.
- `DatumPublisherGovernance.resolve()` — on Rejected, transfer the bond out to the treasury via WDATUM instead of slashing via DOT path. On Upheld, queue WDATUM refund + bonus to the proposer.
- `DatumPublisherGovernance.claimBondReturn` flows already exist; just swap units.
- No changes to `DatumChallengeBonds` (stays DOT).
- No changes to `DatumPublisherStake` (stays DOT).

**Storage additions.**

```solidity
// In DatumPublisherGovernance:
address public wdatumToken;
address public protocolTreasury;     // for slashed-bond destination
// bondAmount changes meaning from DOT planck to WDATUM (1e18 units)
```

**Why not also switch ChallengeBonds.** Worth being explicit: the temptation to "make all bonds DATUM" was strong, but it would mean every advertiser launching a campaign needs to acquire DATUM first. That's a friction wall against the protocol's actual users. The principle (§1.1) wins over symmetry.

### 2.7 Lifecycle-aligned emissions (DISTRIBUTION) — *needs deeper design, see §3*

This is the primary distribution mechanism. Covered in detail in the Supply & Emissions section.

### 2.8 DATUM-gated relays (TRUST COLLATERAL) — *needs deeper design, see §6*

Open follow-up. Sketched in §6 because the design space is large enough to warrant its own section.

### 2.9 Out of scope for v0.1

- **Per-campaign DOT staking → DATUM** (brainstorm #1) — kept on DOT. Per-campaign votes are quality control, not ownership.
- **Veto override by token supermajority** (brainstorm #9) — deferred to OpenGov phase. Council guardian is the alpha mechanism; supermajority override is a v2 layering.

---

## 3. Supply & emissions

### 3.1 Hard cap

```
HARD_CAP = 100_000_000 × 10^18 DATUM        (100M, 18 decimals)
```

**Non-governable** per §1.4 — declared as `uint256 public constant` in the canonical asset's mint authority. No setter, no governance hook, no escape valve.

Sits between Bitcoin (21M) and Ethereum (~120M, uncapped). Large enough that per-settlement rewards don't dust to zero in the long tail; small enough that whale concentration is visible and 1% holdings feel meaningful.

### 3.2 Founders' premint (vested)

```
FOUNDER_ALLOCATION    = 5_000_000 DATUM   (5% of HARD_CAP)
VESTING_PERIOD        = 48 months (4 years)
VESTING_CLIFF         = 12 months
VESTING_CURVE         = linear after cliff
RATE_FLEXIBILITY      = slowable only (never accelerable)
DISTRIBUTION_TO       = team multisig (Gnosis Safe / hardware-backed)
```

The full 5M is minted at genesis into a `DatumVesting` contract. No tokens unlock until month 12; from months 12–48 the unlock accrues linearly (≈ 138,889 DATUM/month after cliff).

**Slowable-only.** A recipient can call `extendVesting(newEndDate)` on their allocation to slow their own unlock (signal long-term alignment). They cannot accelerate. Slowing is one-way per allocation entry — once extended, the new schedule is binding.

This is the only pre-allocation. **No private sale. No public sale. No KOL allocation. No partnership grants.** Subsequent supply comes exclusively from settlement-driven emissions (§3.3).

**Sizing rationale.** 5% sits well below industry norms (15-25% team/insiders) and signals founders-as-runway-not-payday. At 100M cap, 5M = a meaningful but bounded founder position. Compared to: Bitcoin (0% premine), Maker (~30% founders), Compound (~22% team), Uniswap (~22% team+investors).

### 3.3 Settlement-driven emissions — Path F: time-based halvings + per-epoch budgets

The 95M emittable supply mints into circulation under a **time-halving** schedule with **per-epoch supply budgets** and **carry-forward** of any unminted budget.

This combines Bitcoin's predictable halving cadence with an activity-driven safety net that ensures the full 95M reaches circulation regardless of when activity arrives.

**Core mechanism.**

```
HALVING_PERIOD       = 7 years (calendar time, extend-only via governance)
INITIAL_RATE         = 19 DATUM per DOT settled (locked at deploy)
EPOCH_BUDGETS        = [47.5M, 23.75M, 11.875M, 5.94M, 2.97M, 1.48M, 0.74M, ...]
                       (geometric halving sequence; sum ≈ 95M; locked at deploy)
CARRY_FORWARD        = unused budget rolls into next epoch
```

At the start of epoch `n` (calendar 7n years after launch):
- Per-DOT rate halves: `currentRate = INITIAL_RATE / 2^n` = 19, 9.5, 4.75, …
- Epoch budget refreshes: `currentEpochBudget = scheduledBudget(n) + carryFromPriorEpoch`

**Per-settlement logic.**

For each settled claim:

```
mint = payoutDOT × currentRate     // total DATUM for this claim

// Gate checks (silent skip on failure, DOT still settles):
if !meetsQualityThreshold(claim) → skip mint                    // §3.7(b)
if mint < dustThreshold          → skip mint                    // sub-dust
if mint > remainingEpochBudget   → cap to remainingEpochBudget
if mint > remainingDailyCap      → cap to remainingDailyCap

// Apply 7-day per-address ramp (§3.7c):
mint = mint × rampFactor(recipient) / 10000

// Split across recipients (§3.5):
userMint        = mint × 5500 / 10000
publisherMint   = mint × 4000 / 10000
advertiserMint  = mint - userMint - publisherMint

// Per-recipient daily cap (§3.7a):
each recipient mint capped at perAddressDailyCap, excess forfeit

// Update accumulators:
remainingEpochBudget   -= actually_minted
remainingDailyCap      -= actually_minted
totalMinted            += actually_minted
```

**Epoch rollover.**

```solidity
function rollEpoch() external {
    require(block.timestamp >= epochStartTime + HALVING_PERIOD, "too early");
    uint256 carry = currentEpochBudget;            // whatever's unused rolls forward
    epochNumber++;
    epochStartTime = block.timestamp;
    currentRate     = currentRate / 2;
    currentEpochBudget = scheduledBudget(epochNumber) + carry;
}
```

Permissionless — anyone can call once the epoch boundary passes. The first call after the boundary triggers the halving and budget refresh.

**Split per claim — 55 / 40 / 5.**

```
REWARD_USER_BPS         = 5500   (55%)
REWARD_PUBLISHER_BPS    = 4000   (40%)
REWARD_ADVERTISER_BPS   =  500   (5%)
```

Rationale:
- **User-weighted (55%).** Users provide attention — the scarce resource the protocol monetises. Distribution skews toward the side providing the most decentralised input.
- **Publisher (40%).** Operating the surface area is the second-largest contribution.
- **Advertiser (5%).** Small but non-zero. Aligns advertisers with protocol governance and feeds the §2.5 fee-discount loop (advertiser DOT spend → DATUM accumulation → discount tier). Capped low to avoid governance concentration among high-volume advertisers.

### 3.4 Daily mint cap (spike protection)

```
DAILY_MINT_CAP = 500_000 DATUM / day  (governance-tunable, both directions)
```

The daily cap is **spike protection only**, not a constant constraint. At INITIAL_RATE = 19 and the 500k cap, the cap binds only at >26,300 DOT/day daily volume — well above expected sustained usage.

When the cap is hit:
- Additional settlements still settle DOT normally.
- DATUM mint is paused for the remainder of the UTC day.
- Unminted DATUM beyond the daily cap is **forfeited**, NOT carried to the next day (the carry-forward in §3.3 is on epoch budgets, not daily caps).
- The day rolls at UTC midnight.

This distinction matters: epoch-budget carry-forward ensures the **full 95M reaches circulation** over time. Daily cap forfeit ensures **spike protection is real** — you can't bank up "missed mints" from a quiet week and dump them on a spike day.

### 3.5 Halving criterion — time-based, governance-asymmetric

Halvings fire on **wall-clock time** at every `HALVING_PERIOD` (default 7 years).

**Asymmetric governance.** Per §1.6 (admin sunset clause) and the long-term-growth principle, governance can adjust `HALVING_PERIOD` but **only in the direction that lengthens emissions**:

```solidity
function setHalvingPeriod(uint256 newPeriod) external onlyGovernance {
    require(newPeriod >= HALVING_PERIOD, "halving period can only extend");
    HALVING_PERIOD = newPeriod;
}
```

The function reverts on any attempt to shorten. Governance can choose to slow halvings (extending the emission tail), never accelerate them. This codifies the §1.4 principle (predictable scarcity) at the contract level.

Other parameters that are similarly extend-only:
- `MIN_RATE` (floor on currentRate after deep tail) — can only raise.
- `currentEpochBudget` — can only top up via carry-forward (no governance reduction).

Parameters that are unrestricted-governance-tunable:
- `DAILY_CAP` (spike protection — bidirectional tuning is fine).
- `PER_ADDRESS_DAILY_CAP` (Sybil knob).
- `DUST_THRESHOLD` (gas optimisation knob).
- `TREASURY_SKIM_BPS` (0% at genesis, ≤ 10% if activated).

Parameters that are **never** governance-tunable:
- `HARD_CAP` (§1.4).
- `INITIAL_RATE` (locked at deploy).
- `EPOCH_BUDGETS` (locked at deploy).
- `FOUNDER_ALLOCATION` (locked at deploy).

### 3.6 Math sanity check

**Scenario A — target volume: 1,000 DOT/day average for 50 years.**

- Epoch 0 (years 0-7): rate 19, daily mint at target volume = 19,000 DATUM/day.
- 7 years at 19,000/day = 48.5M raw, but bounded by budget 47.5M.
- Budget exhausts at ~6.85 years into epoch 0. Mints stop for the remaining ~6 weeks.
- Year 7: epoch rolls. New rate = 9.5. Budget = 23.75M + ~0 carry = 23.75M.
- Same shape across epochs. Each epoch's budget exhausts shortly before the calendar boundary.
- **Total emitted by year 50: ~94M** (99% of 95M target). ✓

**Scenario B — low volume: 100 DOT/day average.**

- Epoch 0: rate 19, daily mint = 1,900 DATUM. 7 years = 4.85M. Budget = 47.5M.
- 42.65M carries forward to epoch 1.
- Epoch 1: rate 9.5, budget = 23.75M + 42.65M = 66.4M. 7y at 9.5 × 100 = 2.43M emitted. 64M carries.
- Carry-forward grows faster than emissions can burn it under low volume.
- **By year 50: ~10-15M emitted. Remaining accumulates in the tail forever** — but the 95M target is preserved; governance can lengthen halvings (extend-only) to let later epochs stretch and emit more.

**Scenario C — high volume: 10,000 DOT/day average.**

- Epoch 0: rate 19, raw daily = 190,000 DATUM/day (well under 500k cap).
- Budget 47.5M exhausts at 47.5M / 190k ≈ 250 days (~8 months) into epoch 0.
- Mints pause for remaining ~6.3 years of epoch 0.
- Epoch 1: rate 9.5, budget 23.75M. Exhausts in ~8 months again. Quiet for 6.3 years.
- Same shape across epochs.
- **Total emitted by year 50: ~94M.** ✓
- **No "crumbs later" problem.** Emission is bounded *per epoch*, not just by hard cap.

**Scenario D — bursty / spike: 100,000 DOT/day for a single day in epoch 0.**

- Raw daily mint = 100k × 19 = 1.9M DATUM/day. Hits daily cap 500k.
- 500k minted that day; 1.4M forfeit (no daily carry-forward).
- Cumulative epoch budget: minimal impact (500k of 47.5M = 1%).
- **Spike protection works without distorting long-term emission.** ✓

**Sensitivity flag.** If actual average volume is much lower than 1,000 DOT/day for prolonged periods, the carry-forward tail extends well beyond year 50. Total emission still converges to 95M (it just takes longer). Governance can extend the halving period to make later epochs longer, giving more time for emissions to flow at higher rates. The 95M cap is always honored; the 50-year *target* is a goal, not a guarantee.

### 3.7 Sybil resistance

The user-side 55% mint is the primary attack surface. ZK nullifiers prevent claim *replay* but not one attacker generating many distinct claims via controlled addresses + publisher sites. Two stacked defences:

**(a) Per-user daily mint cap.**

```
PER_USER_DAILY_MINT_CAP = 500 DATUM / day per recipient address (governance-tunable)
```

Each unique recipient address (user, publisher, or advertiser) can receive up to 500 DATUM in mints per UTC day across all settlements they participate in. Excess is forfeit (matches the global cap pattern).

- Resets at UTC midnight.
- Applies independently to all three recipient roles. A user, a publisher, and an advertiser are each capped at 500 separately. An address that's both publisher and user (single-wallet operation) is capped at 500 total across both roles to prevent role-stacking exploitation.
- Tracking storage: `mapping(address => uint256) public mintedToday` + `mapping(address => uint256) public mintDayStart` (UTC midnight timestamp).

**Sizing rationale.** At INITIAL_RATE = 475 DATUM/DOT and 55% user share, a user hits the 500 cap after settling ~1.92 DOT worth of their user-side share. Roughly equivalent to a moderate-to-heavy day of genuine usage; trivially exceeded by farms running spam impressions. Cap stops binding after ~4 halvings as the per-DOT rate falls.

**Sybil cost analysis.** To collect more than 500 DATUM/day, an attacker needs a second user address — which requires:
- Setting up a separate wallet (cheap).
- Generating impressions that pass §3.7(b) quality gating from that wallet (less cheap).
- Settling DOT to that wallet's address (the publisher-side payouts go to one address, so cross-address farming requires either multiple publisher addresses too or routing DOT externally).

Net: the cap forces farmers to maintain N addresses for N × 500 DATUM/day. Each address costs setup + ongoing quality-pass effort. Drives the Sybil-marginal-cost above zero.

**(b) Engagement-quality gating.**

The extension already computes a per-impression `qualityScore` based on dwell time, viewability, scroll depth, and other engagement signals. Settlement currently uses this score to filter low-quality claims.

For DATUM minting, **only claims that exceed the quality threshold mint DATUM**. Sub-threshold claims still settle DOT normally (preserving the existing economic model) but skip the DATUM mint.

- Threshold: same threshold currently used in `meetsQualityThreshold()` (already in `qualityScore.ts`).
- Implementation: `_settleSingleClaim` checks `meetsQualityThreshold(claim.qualityScore)` before invoking `mintForSettlement(...)`.
- Defence-in-depth: a sophisticated attacker can fake the quality score client-side, but combined with (a) the cap, even faked-quality farms hit the per-address ceiling quickly.

**(c) Address ramp-up — mild (7 days).**

Each recipient address has a first-seen block stamp, set on its first DATUM mint. For the first 7 days after first-seen, the address's mint share is scaled down:

```
RAMP_DURATION_BLOCKS  = 100_800   (~7 days at 6s/block)
RAMP_START_BPS        = 3_000     (30% on the first mint)
RAMP_END_BPS          = 10_000    (100% at day 7+)

rampFactor(addr) = if firstSeen[addr] == 0:
                       RAMP_START_BPS    // counts as day 0
                   else:
                       elapsed = block.number - firstSeen[addr]
                       if elapsed >= RAMP_DURATION_BLOCKS:
                           RAMP_END_BPS
                       else:
                           RAMP_START_BPS + (RAMP_END_BPS - RAMP_START_BPS) * elapsed / RAMP_DURATION_BLOCKS

effectiveMint(addr, raw) = raw × rampFactor(addr) / 10_000
```

On first mint to an address, `firstSeen[addr] = block.number` is set permanently — addresses don't "re-age" if dormant and reactivated. Returning users get full rate.

**What this defeats.**

- **One-shot address spawning.** A farm can't cycle through fresh addresses and capture full rate from day 1. Each new address eats a 7-day low-rate ramp.
- **Pre-spawning doesn't help.** `firstSeen` is recorded on **first mint**, not first existence. An idle pre-spawned address has no clock running; it starts at 30% the moment it earns its first mint.

**What this doesn't defeat.**

- A patient farmer who plants 100 addresses today and lets them earn at low rate for a week eventually gets full rate. Mild (c) raises activation energy, doesn't permanently lock farms out. Combined with quality gating + per-address cap, it's defence-in-depth, not a hard wall.

**Friction on honest users.**

- A genuine new user earns 30% of normal mint on their first day, ramping to 100% over a week. One-time cost for the lifetime of the address.
- DOT settlement is **unaffected**. Sub-ramp claims still earn full DOT — only the DATUM mint is scaled.
- The §2.5 fee discount and §2.4 publisher bypass are **unaffected** — those read `feeShare.stakedBy()`, not address age.

**Composition — all three defences must pass.**

```
canMintFull(claim, recipient) = 
       meetsQualityThreshold(claim.qualityScore)         // (b)
    && addressMintedToday[recipient] < perAddressCap     // (a) — per-address cap
    && rampFactor(recipient) → scales mint, never blocks  // (c) — ramp scales not gates

effectiveMint = baseMint × rampFactor[recipient] / 10000

if (sub-quality) → skip mint entirely
if (would exceed per-address cap) → mint only up to cap, excess forfeit
if (would exceed global cap) → mint only up to cap, excess forfeit
```

Quality is binary (pass/skip); cap and ramp scale the mint without blocking it.

**Storage additions.**

```solidity
mapping(address => uint256) public firstSeen;            // block of first mint to addr
mapping(address => uint256) public addressMintedToday;
mapping(address => uint256) public addressMintDayStart;
uint256 public rampDurationBlocks;                       // default 100_800
uint16  public rampStartBps;                             // default 3000
```

**Future work — not in v0.1.** Stake-required-to-earn (option (d) from the design notes) and identity-anchored mints via the future People Chain integration. These layer on top of (a)+(b)+(c) when they become available; they don't replace them.

### 3.8 Treasury auto-skim

**0% at genesis.** No fraction of per-settlement mints routes to a community treasury initially.

**Treasury funding sources at genesis:**
- Slashed council bonds (§2.2).
- Slashed propose-bonds on `DatumPublisherGovernance` (§2.6).
- Slashed propose-bonds on `DatumParameterGovernance` (existing mechanism).
- Voluntary donations (no protocol mechanism, just direct transfers to the treasury address).

**Future activation.** Governance can vote in a non-zero auto-skim at any time via ParameterGovernance. Proposed mechanism: a `treasuryBps` parameter on the settlement-mint path. If set non-zero (e.g. 500 bps = 5%), the per-settlement mint splits as:

```
treasuryMint     = (totalMint × treasuryBps) / 10000
remainingMint    = totalMint - treasuryMint
userMint         = (remainingMint × 5500) / 10000
publisherMint    = (remainingMint × 4000) / 10000
advertiserMint   = remainingMint - userMint - publisherMint
```

Treasury skim is governance-tunable upward but **capped at 1000 bps (10%)** at the contract level — even unanimous governance cannot redirect more than 10% to the treasury, protecting the user/publisher/advertiser bootstrap.

**Why 0% to start.** Genesis emissions are the maximally-decentralised distribution moment. Pre-baking a treasury skim sets a precedent that "some fraction goes to a committee." Better to let governance activate it explicitly when public-good funding becomes a priority, with a real proposal and real vote.

### 3.9 Storage + invariants summary

Mint authority contract storage (the EVM-side controller; calls Asset Hub precompile to mint canonical, then WDATUM wrapper):

```solidity
// ── Constants (locked at deploy, never settable) ──────────────────────
uint256 public constant HARD_CAP                = 100_000_000 × 10**18;
uint256 public constant FOUNDER_PREMINT         =   5_000_000 × 10**18;
uint256 public constant INITIAL_RATE            =          19 × 10**18;   // DATUM per DOT
uint256 public constant TREASURY_SKIM_BPS_MAX   = 1000;                   // 10%
uint256 public immutable LAUNCH_TIME;                                     // unix seconds

// EPOCH_BUDGETS computed in a pure function from INITIAL_BUDGET and epochNumber:
//   scheduledBudget(n) = INITIAL_BUDGET / 2^n   (geometric halving)
// INITIAL_BUDGET = 47_500_000 × 10**18
uint256 public constant INITIAL_BUDGET          = 47_500_000 × 10**18;

// ── Extend-only governance state ──────────────────────────────────────
uint256 public halvingPeriod             = 7 years;                      // can only extend
uint256 public minRate                   = 0.001 × 10**18;               // can only raise

// ── Bidirectional governance state ────────────────────────────────────
uint256 public dailyMintCap              = 500_000 × 10**18;
uint256 public perAddressDailyMintCap    = 100 × 10**18;
uint256 public dustMintThreshold         = 0.01 × 10**18;
uint16  public treasuryBps               = 0;                            // ≤ TREASURY_SKIM_BPS_MAX
uint16  public rewardUserBps             = 5500;
uint16  public rewardPublisherBps        = 4000;
uint16  public rewardAdvertiserBps       = 500;
uint16  public rampStartBps              = 3000;
uint256 public rampDurationBlocks        = 100_800;                      // ~7 days

// ── Running state ─────────────────────────────────────────────────────
uint256 public currentRate;                                              // halves at epoch boundary
uint256 public epochNumber;                                              // 0 at launch
uint256 public epochStartTime;                                           // unix seconds
uint256 public currentEpochBudget;                                       // = scheduled(n) + carry
uint256 public totalMinted;                                              // ≤ HARD_CAP always

uint256 public mintedToday;                                              // global daily counter
uint256 public mintDayStart;                                             // UTC midnight timestamp

mapping(address => uint256) public addressMintedToday;
mapping(address => uint256) public addressMintDayStart;
mapping(address => uint256) public firstSeen;                            // for ramp-up
```

**Invariants enforced at the contract level:**

- `totalMinted + FOUNDER_PREMINT ≤ HARD_CAP` always. Mint silently no-ops if it would exceed.
- `rewardUserBps + rewardPublisherBps + rewardAdvertiserBps == 10000 - treasuryBps`. Enforced by setter.
- `treasuryBps ≤ TREASURY_SKIM_BPS_MAX` (10%). Enforced by setter.
- `setHalvingPeriod(newPeriod)` reverts if `newPeriod < halvingPeriod` (extend-only).
- `setMinRate(newMin)` reverts if `newMin < minRate` (raise-only).
- Daily cap rollover is UTC-midnight based.
- Sub-dust mints skip entirely; epoch budget and daily cap **still decrement** by 0 (no state change for skipped mints).
- Epoch budget overflow into the next epoch is unbounded (carry-forward has no ceiling other than the global hard cap).
- `currentRate` floors at `minRate`; mints below `minRate` are dust-skipped.

---

## 4. Allocation summary

```
HARD CAP:                  100,000,000 DATUM   (non-governable)
│
├── Founders' vesting:        5,000,000  (5%)   ─┐
│   • 48-month vest                              │ pre-allocated
│   • 12-month cliff                             │ at genesis
│   • slowable-only                              │
│   • team multisig                              ┘
│
└── Settlement emissions:    95,000,000 (95%)  ─┐
    │                                            │
    ├── per-settlement formula:                  │
    │   mint = payoutDOT × currentRate           │
    │   currentRate halves at each epoch         │ minted over time
    │   epoch = 7 calendar years (extend-only)   │ via real protocol use
    │   INITIAL_RATE = 19 DATUM/DOT              │
    │                                            │
    ├── per-epoch budget caps:                   │
    │   E0=47.5M / E1=23.75M / E2=11.875M / ...  │
    │   unused budget carries to next epoch      │
    │   total emission converges to 95M          │
    │                                            │
    ├── split (after optional treasury skim):    │
    │   55% user / 40% publisher / 5% advertiser │
    │                                            │
    ├── caps:                                    │
    │   daily   ≤  500,000 DATUM / day  (spike)  │
    │   per addr ≤    100 DATUM / day            │
    │                                            │
    ├── gates:                                   │
    │   • quality score must exceed threshold    │
    │   • sub-dust mints skipped (< 0.01 DATUM)  │
    │                                            │
    └── ramp:                                    │
        • new addresses start at 30%             │
        • linear to 100% over 7 days             │
        • set on first mint; permanent ─────────┘

NO treasury allocation at genesis.
Target emission horizon: ~50 years at sustained moderate volume.
Halving period is extend-only via governance (slow allowed, accelerate denied).
```

### Treasury funding (at genesis)

The community treasury is **not pre-allocated**. It accrues from:
- Slashed council bonds (§2.2).
- Slashed propose-bonds on PublisherGovernance + ParameterGovernance.
- Voluntary donations.
- **Future:** governance-voted auto-skim from per-settlement mints, capped at 1000 bps (10%) at the contract level.

### Distribution profile

At launch:
- **Founders' position: 0** (12-month cliff). Founders cannot sell, vote, or earn fee share for the first year.
- **All circulating supply** comes from settlement mints — every DATUM in circulation in year 1 was earned by a user, publisher, or advertiser using the protocol.

After year 1, founders begin linear unlock (≈ 138,889 DATUM/month). By month 48, full founder allocation released.

**Bootstrap concentration risk.** Settlement-driven distribution favours early heavy users. The Sybil controls (§3.7) cap per-address daily intake at 500 DATUM, but a single party running many addresses + many publisher sites could still capture an outsized fraction in early months. Recognised limitation; the alternative (centralised distribution) was rejected as worse. Quality gating + governance-tunable caps provide knobs to tighten if abuse becomes visible.

---

## 5. Token contract

### 5.1 Token metadata (canonical + wrapper, both 10 decimals)

Both the canonical Asset Hub asset and the EVM-side WDATUM wrapper use **10 decimals**, matching Polkadot's substrate default (DOT planck-denomination).

| Property | Canonical (Asset Hub) | Wrapper (Polkadot Hub EVM) |
|---|---|---|
| Name | `DATUM` | `Wrapped DATUM` |
| Symbol | `DATUM` | `WDATUM` |
| Decimals | **10** | **10** |
| Metadata | Asset Hub native metadata field | ERC-20 constructor |

**Why 10 decimals, not 18.** Substrate-native default (matches DOT planck) means:
- 1:1 wrapping is trivial — no scaling math at the wrap/unwrap boundary.
- All on-chain math is in planck-equivalent units; aligned with Settlement's existing DOT-denominated state (also planck).
- 100M DATUM = 10^18 plancks (one slot, no overflow concerns).
- Trade-off: many ERC-20 tooling assumes 18 decimals. WDATUM at 10 is unusual but technically valid; wallets and DEXes that read the `decimals()` field will display correctly. Aggregators that hardcode 18 will misrender — minor, well-known integration risk for non-standard decimals.

### 5.2 Mint-authority architecture (`DatumMintAuthority`)

Dedicated authority contract on Polkadot Hub (EVM). Separates the bridge logic from settlement and from the wrapper. This is the single point of contact for canonical-asset mint operations, which makes the phase-2 parachain migration a one-contract pointer swap.

```
                  ┌─────────────────────────┐
                  │  Asset Hub              │
                  │  DATUM (canonical)      │
                  │  issuer = MintAuthority │
                  └────────────▲────────────┘
                               │
                       precompile bridge
                               │
   ┌────────────┐    ┌─────────┴─────────┐    ┌────────────┐
   │ Settlement │───►│ DatumMintAuthority│───►│  WDATUM    │
   │ (EVM)      │    │ (EVM)             │    │  Wrapper   │
   └────────────┘    │  · holds asset    │    │  (EVM)     │
                     │    issuer rights  │    └─────▲──────┘
                     │  · only entrypoint│          │
                     │    for canonical  │     also calls
                     │    mint           │       wrapper
                     │  · gates by caller│       to mint
                     │    address        │       WDATUM
                     │  · paramaterised  │     1:1
                     │    sunset trigger │
                     └───────────────────┘
```

**Operations on `DatumMintAuthority`:**

```solidity
contract DatumMintAuthority {
    address public settlement;           // only address allowed to mintForSettlement
    address public vesting;              // only address allowed to mintForVesting
    address public wrapper;              // the WDATUM wrapper

    /// Called by Settlement on every settled claim
    /// Atomically: mints canonical to wrapper's reserve + WDATUM to recipients
    function mintForSettlement(
        address user, uint256 userAmt,
        address publisher, uint256 publisherAmt,
        address advertiser, uint256 advertiserAmt
    ) external onlySettlement {
        uint256 total = userAmt + publisherAmt + advertiserAmt;
        require(totalMinted + total <= HARD_CAP, "cap");
        totalMinted += total;
        _mintCanonicalTo(wrapper, total);                // precompile call
        IDatumWrapper(wrapper).mintTo(user, userAmt);
        IDatumWrapper(wrapper).mintTo(publisher, publisherAmt);
        IDatumWrapper(wrapper).mintTo(advertiser, advertiserAmt);
    }

    /// Called by DatumVesting on unlock to mint a founder's share as WDATUM directly
    function mintForVesting(address recipient, uint256 amount) external onlyVesting {
        _mintCanonicalTo(wrapper, amount);
        IDatumWrapper(wrapper).mintTo(recipient, amount);
    }

    /// Sunset: transfer Asset Hub issuer rights to a new authority
    /// (e.g. the parachain pallet at phase 2). Governance-gated.
    function transferIssuerTo(address newAuthority) external onlyGovernance {
        _xcmOrPrecompileTransferIssuer(newAuthority);
        emit IssuerTransferred(newAuthority);
    }
}
```

**Why this architecture is parachain-migration-friendly:**

- Settlement only knows about `DatumMintAuthority`. It doesn't care where the canonical asset lives.
- When the parachain launches: governance proposal calls `DatumMintAuthority.transferIssuerTo(parachainPallet)`. The asset's issuer-on-Asset-Hub moves to the new authority. Settlement is then reconfigured to point at a new mint authority (or stops minting altogether, depending on phase).
- The wrapper is unaffected by the issuer transfer — it still holds canonical-asset reserves; unwrap still works. Only new mints are gated by who controls the issuer.
- One contract is the sole bridge surface. Easier to audit; easier to swap.

### 5.3 WDATUM wrapper (`DatumWrapper`)

ERC-20 with **no admin key**. Mints solely by `DatumMintAuthority`; burns solely by user-initiated unwrap.

```solidity
contract DatumWrapper is ERC20 {
    address public immutable mintAuthority;
    uint256 public immutable canonicalAssetId;     // Asset Hub asset ID

    constructor(address _mintAuthority, uint256 _assetId) ERC20("Wrapped DATUM", "WDATUM") {
        mintAuthority = _mintAuthority;
        canonicalAssetId = _assetId;
    }

    function decimals() public pure override returns (uint8) { return 10; }

    /// Mint WDATUM to a recipient. Only the mint authority can call.
    /// The authority is expected to have minted matching canonical to this contract first.
    function mintTo(address recipient, uint256 amount) external {
        require(msg.sender == mintAuthority, "E18");
        _mint(recipient, amount);
        _checkInvariant();
    }

    /// User-initiated wrap: caller transfers canonical to wrapper, mints WDATUM.
    /// Caller must have approved the Asset Hub precompile to spend canonical on their behalf.
    function wrap(uint256 amount) external {
        _pullCanonicalFrom(msg.sender, amount);     // precompile call
        _mint(msg.sender, amount);
        _checkInvariant();
    }

    /// User-initiated unwrap: burns WDATUM, releases canonical to caller (or specified Asset Hub recipient).
    function unwrap(uint256 amount, bytes32 assetHubRecipient) external {
        _burn(msg.sender, amount);
        _pushCanonicalTo(assetHubRecipient, amount);   // precompile call
        _checkInvariant();
    }

    /// Invariant: WDATUM supply must always be ≤ canonical held by this contract.
    function _checkInvariant() internal view {
        require(totalSupply() <= _canonicalBalanceOf(address(this)), "broken peg");
    }
}
```

**Properties.**
- No admin key, no upgradeability. Wrapper is immutable after deploy.
- 1:1 backed at all times; the invariant assertion catches any drift.
- Wrap/unwrap zero-fee (per §0).
- Unwrap to an Asset Hub recipient takes a 32-byte AccountId destination (substrate-native address format).

### 5.4 Vesting (`DatumVesting`)

Single-pool, linear-with-cliff. Premint goes here at genesis.

```solidity
contract DatumVesting {
    uint256 public constant TOTAL_ALLOCATION = 5_000_000 × 10**10;     // 5M DATUM, 10 decimals
    uint256 public constant CLIFF_DURATION   = 365 days;
    uint256 public constant TOTAL_DURATION   = 4 × 365 days;

    address public immutable beneficiary;          // single pool, single recipient
    uint256 public immutable startTime;
    uint256 public endTime;                        // extendable but not shortenable
    address public mintAuthority;
    uint256 public released;

    /// Anyone can call to release vested tokens to the beneficiary.
    /// Founder unlocks deliver WDATUM directly (cleanest UX — no separate wrap step needed).
    function release() external {
        uint256 vested = vestedAmount();
        uint256 toRelease = vested - released;
        require(toRelease > 0, "nothing to release");
        released = vested;
        IDatumMintAuthority(mintAuthority).mintForVesting(beneficiary, toRelease);
    }

    function vestedAmount() public view returns (uint256) {
        if (block.timestamp < startTime + CLIFF_DURATION) return 0;
        if (block.timestamp >= endTime) return TOTAL_ALLOCATION;
        uint256 elapsed = block.timestamp - startTime;
        uint256 duration = endTime - startTime;
        return (TOTAL_ALLOCATION * elapsed) / duration;
    }

    /// Slowable-only: the beneficiary may extend their own end date, never accelerate.
    function extendVesting(uint256 newEndTime) external {
        require(msg.sender == beneficiary, "E18");
        require(newEndTime > endTime, "can only extend");
        endTime = newEndTime;
    }
}
```

**Design choices.**
- **Single beneficiary, single pool.** No sub-allocations.
- **No revoke.** If the beneficiary stops being involved, vesting continues per the original schedule. No accelerated forfeit, no clawback. Simpler, more credibly neutral.
- **`release()` is permissionless.** Anyone can trigger the unlock for the beneficiary's address; saves the beneficiary from having to call it themselves on the regular.
- **WDATUM direct delivery.** `release()` calls `DatumMintAuthority.mintForVesting(beneficiary, amount)`, which mints canonical to the wrapper + WDATUM to the beneficiary in one atomic operation. Founder receives WDATUM in their wallet; can unwrap to canonical for Asset Hub if they want.
- **`extendVesting(newEndTime)`** is the slowable-only knob (§3.2).

### 5.5 Sunset triggers — governance vote per stage

Per §1.6 (admin sunset clause), every privileged role transitions out via governance. Each phase transition requires a specific governance proposal with token-holder turnout to ratify.

**Phases that require governance approval to advance:**

| Stage | Trigger | Authority required |
|---|---|---|
| **A0 → A1**: Settlement-mint authority transfers from deployer multisig to `DatumMintAuthority` contract | Initial deployment | Founder action (one-time) |
| **A1 → A2**: `DatumMintAuthority` admin transfers from founder multisig to the Council | Council activated | Council vote |
| **A2 → A3**: Asset issuer right transfers from `DatumMintAuthority` to the DATUM parachain pallet | Parachain ready | ParameterGovernance proposal + token-holder vote; quorum per §2.3 (1% of canonical supply) |
| **A3 → A4**: WDATUM wrapper enters wind-down (`wrap()` disabled, `unwrap()` still works) | Parachain mature | ParameterGovernance proposal |
| **A4 → A5**: WDATUM wrapper deprecated | 12+ months after wind-down | ParameterGovernance proposal |

No phase advances automatically. Each requires an active proposal, quorum, and ratification by token-weighted vote. The `DatumMintAuthority.transferIssuerTo(...)` function is gated to `onlyGovernance`, which means a successful ParameterGovernance proposal calling it via `execute()`.

This codifies §1.6 — admin roles are scaffolding, sunsetable only via explicit governance action, never by automatic clock.

### 5.6 Implementation surface

- `DatumMintAuthority` (~200 LOC) — bridge logic, mint gates, sunset transfer.
- `DatumWrapper` (~120 LOC) — ERC-20 + wrap/unwrap + invariant check.
- `DatumVesting` (~80 LOC) — linear-with-cliff, single beneficiary, extend-only.
- Asset Hub setup script — register canonical DATUM asset, set decimals=10, set metadata, transfer issuer to `DatumMintAuthority`.
- Integration changes:
  - `DatumSettlement._settleSingleClaim` — calls `DatumMintAuthority.mintForSettlement(...)` after fee + payment math; gated by §3 budget/cap/ramp/quality logic.
  - `DatumFeeShare` — reads WDATUM balances via standard `IERC20`.
  - `DatumPublishers` (allowlist bypass) — reads `feeShare.stakedBy()` (no change to this surface).
  - Other §2 utilities — read WDATUM via standard ERC-20 interfaces.

Total new surface: ~400 LOC of new contract code + integration changes to ~3 existing contracts. Manageable audit scope.

---

## 6. Relay staking — forward-looking sketch

**Status:** direction approved, deferred to a follow-up spec doc. The current alpha-4 relay model stays in place for v0.2 of the token spec; staking is a v0.3+ enhancement.

**Problem.** The relay model in alpha-4 is open: any address can run a relay, sign attestation responses, and submit batches. The `relaySigner` rotation cooldown helps, but doesn't require relays to commit anything economically. Bad-actor relays can spam settlement, sign for compromised publishers, or fail silently — the only cost is reputation (already tracked).

**Proposed mechanism.** A relay must stake WDATUM into a `DatumRelayStake` contract; `DatumSettlement` reads `relayStake[batch.publisher.relaySigner]` during batch validation and rejects under-staked relays.

```solidity
contract DatumRelayStake {
    mapping(address => uint256) public stakedBy;        // relay → WDATUM staked
    uint256 public minStake;                            // governance-tunable
    uint256 public unstakeDelay;                        // blocks

    function stake(uint256 amount) external;            // transferFrom WDATUM
    function requestUnstake(uint256 amount) external;
    function claimUnstake() external;
    function slash(address relay, uint256 amount, address recipient) external onlySlasher;
}
```

**Slashing conditions (proposed, to be tuned in v0.3 spec):**
- Auto-slash: settlement rejection rate > X bps over a rolling window (read from `DatumPublisherReputation`).
- Manual slash: council vote on a documented fraud finding.
- Slashed WDATUM → protocol treasury.

**Grassroots compatibility.** Staking requirement raises the floor for relay operators. Mitigations to maintain accessibility:
- **Low stake threshold.** Sized so a publisher running a relay can cover it within a few weeks of earned DATUM. Not a capital wall.
- **Earnings-backed path.** A relay can pledge future settlement earnings to back the bond via an escrow that takes a fraction of each settlement until the threshold is met. Permits zero-capital relay operation; gates only by commitment.
- **Open-relay fallback.** Optionally, unstaked relays remain functional but face reduced settlement caps (e.g. half the per-block ceiling). Maintains permissionless participation; tilts the economics toward staked operators without locking out small ones.

**Open questions for the v0.3 spec:**
- Bond scales with throughput, or flat?
- Slashing tier system (soft failures vs hard fraud)?
- Does the bond reset on relay-signer rotation? (If so, attackers could rotate to dodge slashing.)
- Cross-relay reputation: should slashing a relay also slash its operator's other relay signers?

This section will be expanded into a full spec doc before any relay-staking contract is deployed.

---

## 7. Emissions deep-dive — RESOLVED

The v0.1 follow-up questions on emissions have all been resolved by Path F (§3.3-§3.6). For reference:

| v0.1 question | Resolved as |
|---|---|
| Reward split tuning | **55 / 40 / 5** (user / publisher / advertiser), §3.3 |
| Anti-Sybil | Three-layer defence: per-address cap (§3.7a) + quality gate (§3.7b) + 7-day ramp (§3.7c) |
| Halving criterion: count vs unique users | Replaced by **time-based halvings** (§3.5); Sybil resistance handled at mint level, not halving level |
| Daily cap dynamics | Fixed `DAILY_CAP = 500k DATUM/day` as spike protection, governance-tunable. Carry-forward is on **epoch budgets** (§3.3), not daily caps |
| Treasury auto-skim | **0% at genesis**, ≤ 10% if activated by governance (§3.8) |

The §3 mechanism (Path F: time-based halvings + per-epoch budgets + carry-forward) supersedes all v0.1 emission-design open questions. Section retained for traceability.

---

## 8. Migration plan

DATUM rolls out after alpha-4 stabilises and the protocol has demonstrated real settlement activity. The order:

1. **alpha-4 v2 stabilisation** (current direction; no DATUM yet). Includes the active parameter-governance + Timelock catalog work.
2. **Asset Hub setup.** Register the canonical DATUM asset (name `DATUM`, symbol `DATUM`, decimals 10). Issuer assigned to the founder multisig initially.
3. **Token contracts deployed on Polkadot Hub:**
   - `DatumWrapper` (WDATUM) — no admin key.
   - `DatumMintAuthority` — issuer rights transferred to it after deploy.
   - `DatumVesting` — 5M premint goes here; founder begins 12-month cliff.
4. **`DatumFeeShare` deployed.** Stake currency = WDATUM, reward currency = DOT. `DatumPaymentVault.withdrawProtocol` recipient pointed at FeeShare. Existing fee accrual continues seamlessly under new accounting.
5. **`DatumPublisherGovernance` propose-bond currency switch** to WDATUM (§2.6). Force-withdraw existing DOT bonds per §1.8.
6. **`DatumParameterGovernance` + `DatumPublisherGovernance` vote currency switch** to WDATUM with quadratic dampener (§2.3). Force-withdraw existing DOT votes per §1.8.
7. **`DatumPublishers.datumStakeGate`** activated as parallel path (§2.4). Existing DOT path unchanged.
8. **Advertiser fee discount activated** (§2.5). Snapshot caching turns on, settlement starts reading the cache.
9. **Council bonding activated** (§2.2). 60-day grace period for existing members to opt in.
10. **Relay staking** — separate v0.3 spec; not blocked on (1)-(9).

Each step is a normal governance proposal (ParameterGovernance or Council); each carries normal voting + quorum requirements. No hard fork required; the token is purely additive infrastructure.

**Phase advancement past v0.2:**
- Phase 1 → 2 (parachain launch) when DATUM parachain is ready: ParameterGovernance proposal calls `DatumMintAuthority.transferIssuerTo(parachainPallet)`. Wrapper enters wind-down.
- Phase 2 → 3 (wrapper sunset) after ≥ 12 months of wind-down: explicit ParameterGovernance proposal deprecates the wrapper.

---

## 9. Decisions captured (v0.2)

### Architecture (§0)
- ✅ **Hybrid token**: canonical Asset Hub asset + WDATUM ERC-20 wrapper on Polkadot Hub.
- ✅ **Auto-mint** at settlement: users receive WDATUM directly, no per-claim wrap step.
- ✅ **Three-phase migration**: hybrid → parachain native → wrapper sunset. Each phase requires governance vote.

### Core principles (§1)
- ✅ DOT preserved for all primary functions.
- ✅ DATUM = ownership token (cashflow + governance + collateral + coordination + public-good funding).
- ✅ Cypherpunk grassroots — no ICO, no VC, no LM, no partnership grants.
- ✅ Hard cap non-governable.
- ✅ Anti-financialisation; DEX trading welcome, skin-in-the-game required for decisions.
- ✅ Admin functions have explicit sunset triggers.
- ✅ Parachain migration is non-optional.
- ✅ Nothing-critical-is-live migration policy (pre-mainnet only).

### Utility (§2)
- ✅ **§2.1 FeeShare** — stake WDATUM, earn DOT. Immediate withdrawals. Periodic permissionless sweep. Zero floor. 0% treasury skim at genesis. No DEX integration.
- ✅ **§2.2 Council bonding** — governance-tunable WDATUM bond, three slashable conditions (inactivity / manual vote / forced removal), treasury default recipient, 30-day cool-down, voluntary opt-in phase-in.
- ✅ **§2.3 Quadratic voting** — ParameterGovernance + PublisherGovernance switch to WDATUM. Piecewise dampener (linear up to 100, sqrt above). Outer conviction multiplier. Quorum = 1% of canonical supply. Proposer bond stays separate from vote.
- ✅ **§2.4 Publisher allowlist DATUM bypass** — parallel-OR path; reads `feeShare.stakedBy`; governance-tunable threshold (1k WDATUM default); grandfathered on later unstake; same whitelist-mode scope.
- ✅ **§2.5 Advertiser fee discount** — step function 0/25/75/150/200 bps at tiers 0/1k/10k/100k/1M WDATUM staked. Reuses FeeShare. Lazy refresh, 24h min interval / 30d max age, anyone can call. Absolute 200 bps cap. All actionTypes.
- ✅ **§2.6 Bonds** — selective switch: PublisherGovernance propose-bond → WDATUM (to treasury on slash). ChallengeBonds + PublisherStake stay DOT (primary-function bonds).
- ✅ **§2.8 Relay staking** — direction approved, deferred to v0.3 spec.

### Supply & emissions (§3)
- ✅ Hard cap **100M DATUM** (non-governable).
- ✅ Founders' premint **5M (5%)**, 4y/1y cliff, slowable-only, single beneficiary.
- ✅ **Path F**: time-based halvings, every 7 calendar years, **extend-only** via governance.
- ✅ Initial rate **19 DATUM/DOT**, halves at each epoch boundary.
- ✅ Per-epoch supply budgets `[47.5M, 23.75M, ...]` with **carry-forward** ensuring 95M total emission.
- ✅ Split: **55% user / 40% publisher / 5% advertiser**.
- ✅ Daily cap **500k DATUM/day** as spike protection (governance-tunable).
- ✅ Per-address daily cap **100 DATUM/day**, dust threshold **0.01 DATUM**.
- ✅ Sybil resistance: per-address cap + quality gate + 7-day ramp (30% → 100%).
- ✅ Treasury auto-skim **0% at genesis**, ≤ 10% if activated by governance.

### Token contract (§5)
- ✅ Both canonical and WDATUM use **10 decimals** (substrate-native, 1:1 wrapping).
- ✅ Asset Hub issuer = `DatumMintAuthority` contract on Polkadot Hub.
- ✅ Metadata via Asset Hub native field.
- ✅ **Dedicated `DatumMintAuthority`** — single bridge contract, parachain-migration-friendly.
- ✅ Precompile bridge for canonical mint operations.
- ✅ Vesting delivers WDATUM directly at unlock.
- ✅ Sunset triggers: each phase advance requires explicit governance proposal + token-holder vote.

### Out of scope for v0.2
- ❌ Per-campaign DOT staking → DATUM (GovernanceV2 stays DOT — quality control, not ownership).
- ❌ Supermajority veto override (deferred to post-OpenGov phase).
- ❌ Liquidity mining programs.
- ❌ Stake-required-to-earn DATUM (§3.7d, deferred).
- ❌ Identity-anchored minting via People Chain (deferred until that chain is integrated).

---

## 10. Open questions (still to resolve)

These remain unanswered after v0.2. Most are concrete parameter values whose defaults are reasonable starting points but should be reviewed before deploy.

1. **Council bond initial size at activation.** Spec says "low" (~10k WDATUM); needs a final number once circulating supply is observable.
2. **Slashing conditions for relay staking** — full design in v0.3 spec.
3. **Per-tier WDATUM thresholds for advertiser fee discount** — current values 1k/10k/100k/1M are placeholders.
4. **Founder allocation distribution** — single multisig (current spec) is fine for one founder; revisit if scope expands.
5. **MIN_RATE floor on adaptive rate** — currently 0.001 DATUM/DOT; impacts late-tail emissions.
6. **License + verifier identity** for the token contract — auditable + verified on the explorer from day 1.
7. **WDATUM at 10 decimals** — confirm major Polkadot ecosystem wallets / DEX aggregators handle this correctly. Asset Hub native asset is fine; the wrapper is the integration risk.
8. **Asset Hub asset ID assignment** — claim a specific asset ID at genesis (not first-come).
9. **Cross-chain XCM channel setup** — for the canonical asset to be usable on other parachains (Acala, Hydration), XCM channels need to be opened. Coordinate with parachain teams pre-launch.
10. **Token contract upgrade pathway** — explicit. Are these contracts mutable post-deploy? Stance: `DatumWrapper` immutable; `DatumMintAuthority` admin-tunable for the sunset path only (no logic upgrades); `DatumVesting` immutable.
11. **Emergency pause** — does the token need a global pause switch? If so, who can trigger? Council? Per §1.6 sunset clause, any pause authority needs an explicit removal trigger.
12. **Genesis claim window** — at what block does settlement-driven minting actually start? Day 1 of token deploy, or after a "warmup" period? Affects bootstrapping.

---

## 11. What this doc is NOT

- It is **not** a contract. No code is committed yet — only design.
- It is **not** final. Every parameter is subject to revision before genesis.
- It is **not** a launch plan. Distribution mechanics, marketing, listings — all out of scope.
- It is **not** a regulatory analysis. The doc deliberately doesn't address whether DATUM is a security in any jurisdiction. That requires legal counsel before mainnet.
- It is **not** a public commitment to issue DATUM. The token can be cancelled or modified before deploy.

---

*End of v0.2 spec. Architecture and major parameters locked. Concrete numbers are subject to final review before any contract code touches the repo.*
