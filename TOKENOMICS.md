# DATUM Token — Spec & Plan

**Status:** draft v0.1 (design spec, no contracts yet)
**Date:** 2026-05-10
**Scope:** the DATUM ownership token, its utility, distribution, and integration with the existing DOT-denominated protocol.

---

## 1. Core principles

These constrain every other decision in this document.

1. **DOT is preserved as the protocol's utility currency.** Advertisers always pay budget in DOT. Publishers always earn DOT. Users always receive DOT for impressions. No one needs to acquire DATUM to participate as an advertiser, publisher, or user.
2. **DATUM is an ownership token.** It captures three things and only those three:
   - **Cashflow** — a pro-rata share of protocol fees.
   - **Parameter governance** — the right to vote on protocol-wide parameters and ratify upgrades.
   - **Trust collateral** — bonded stake for roles where skin-in-the-game improves outcomes (council, fraud bonds, relay operators).
3. **Cypherpunk grassroots ethos.** No ICO, no VC round, no public sale. Distribution is dominated by usage-driven minting. Founders get a small, vested allocation for runway, capped tightly.
4. **Hard supply cap with halving.** The token must be predictably scarce. Emissions are tied to settlement activity (real protocol use) with a difficulty-adjustment-style halving that bends the curve toward an asymptote.
5. **Decentralisation over speed.** Where two designs are equivalent except one centralises authority, take the decentralised one. We accept slower iteration for credible neutrality.

---

## 2. Utility — what DATUM does

The eight roles below were selected from a longer brainstorm. Each section names the contract surface where it lands and what changes vs. today.

### 2.1 Protocol fee allotment by stake (CASHFLOW)

**Source idea:** brainstorm #2.

**Mechanism.** Replace the current `pendingProtocolFee` → admin-pull model with a per-stake distribution.

- Today: `DatumPaymentVault` accrues `pendingProtocolFee`; an admin calls `withdrawProtocol(recipient)` to pull it.
- Proposed: introduce `DatumFeeShare`. Stakers deposit DATUM into the contract; settlement credits its protocol-fee share to the contract; stakers `claim()` proportional to (their stake × time staked) / (total stake × time staked).

**Implementation pattern.** SushiBar / MasterChef accumulator: maintain `accFeePerShare` updated on every credit, and `userDebt[address]` per staker. On stake/unstake, settle the user's accrued fee against the new share. Battle-tested; a few hundred lines of Solidity.

**Migration.** `DatumPaymentVault.withdrawProtocol` stays in place but the recipient becomes `DatumFeeShare`. After phase-in, governance can deprecate the manual withdraw path entirely.

**Invariants.**
- Unclaimed fees do not get diluted by new stakers (use the accumulator pattern, not naive division).
- Withdraw lockup of N blocks discourages flash-stake attacks where someone deposits, claims, and immediately exits.
- All fee inflows pause-respect the `DatumPauseRegistry`.

### 2.2 Council eligibility by DATUM bond (LONG-TERM COMMITMENT)

**Source idea:** brainstorm #3.

**Mechanism.** Council membership requires a slashable locked DATUM bond. Today, members are added via council self-governance with no economic gate.

- Add `bondAmount` storage to `DatumCouncil`. Default e.g. 100,000 DATUM.
- `addMember(address)` (already gated to onlyCouncil) additionally requires `datumToken.transferFrom(member, council, bondAmount)` succeeded — i.e. the member has bonded.
- `removeMember(address)` returns the bond minus any slashed amount.
- New `slashMember(address, uint256, string reason)` callable only by council self-governance, deducts from the bond.

**Effect.** Membership becomes economically credible: a captured / hostile member can be removed with their bond redirected to the treasury or a victim. Bond size becomes a governable parameter via `ParameterGovernance`.

**Open:** what counts as slashable? Specifically defining slashing conditions matters more than the bond amount.

### 2.3 Quadratic-weighted core parameter voting (PARAMETER GOVERNANCE)

**Source idea:** brainstorm #4, scoped to **core parameters only**.

**Mechanism.** `DatumParameterGovernance` switches its lock currency from DOT to DATUM, and additionally applies a sqrt dampener on per-account weight to reduce whale dominance.

- Vote effective weight = `floor(sqrt(lockedDatum)) × convictionMultiplier`.
- Conviction lockups + multipliers stay as-is.
- The conviction *currency* changes from DOT to DATUM. This is the governance-token coupling.

**Scope.** Only `DatumParameterGovernance` (protocol-wide tunables) gets this treatment. **`DatumGovernanceV2` (per-campaign termination) keeps DOT staking.** Per-campaign voting is more like quality-control flagging, doesn't require ownership of the protocol, and shouldn't disenfranchise non-DATUM-holders.

**Compatibility.** PublisherGovernance (fraud against publishers, also a protocol-meta concern) probably should also switch to DATUM. Open question — see §5.

**Implementation friction.** Replace the `payable` `vote()` with `transferFrom` from a configured DATUM token; update `withdrawVote` / payout/slash flows correspondingly. ~150 LOC + test rewrite.

### 2.4 Publisher allowlist bypass via DATUM stake (TRUST COLLATERAL)

**Source idea:** brainstorm #5.

**Mechanism.** `DatumPublishers.stakeGate` already permits a publisher to bypass the whitelist by staking enough DOT. Add a parallel DATUM bypass — stake enough DATUM as an alternative.

- Add `datumStakeGate` (bps or flat) and `datumToken` reference to DatumPublishers.
- `registerPublisher` precondition becomes: `whitelistMode==false || approved[caller] || (publisherStake.staked(caller) >= dotStakeGate) || (datumToken.balanceOf(caller) >= datumStakeGate)`.
- The DOT path remains intact — DATUM is purely additive.

**Effect.** Publishers who own protocol equity are credibly committed; they can register without administrative approval. DOT-only publishers can still register via the existing path.

### 2.5 Minimal advertiser fee discount (CASHFLOW INCENTIVE)

**Source idea:** brainstorm #6, with explicit user constraint that this **must not over-burden settlement**.

**Mechanism.** Off the hot path: a precomputed `feeDiscountBps[advertiser]` slot, refreshed lazily.

- Hold-N-DATUM tiers map to a small bps discount (e.g. 50/100/150 bps off protocol take). Capped low to keep settlement gas flat.
- `feeDiscountBps[advertiser]` is read once during `_settleSingleClaim` — single SLOAD, no math overhead. The actual discount is computed at the tier boundary off-chain, written via a snapshot function callable by anyone (`refreshDiscount(address)`), and cached on-chain.
- Snapshot has a min interval (e.g. 14400 blocks ≈ 24h) to prevent griefing.

**Why lazy refresh.** Reading DATUM balance every settlement is expensive (SLOAD via precompile call). A cached value updated only when the holder requests it keeps the hot path one SLOAD. Holders are incentivised to refresh because it lowers their fees.

**Cap.** Total max discount ≤ 200 bps. Even with full take rate at 5% (500 bps), that's a 40% reduction at most, enforced at the contract level.

### 2.6 DATUM-denominated challenge bonds (FP-2 + FP-3)

**Source idea:** brainstorm #7.

**Mechanism.** `DatumChallengeBonds` (advertiser fraud bonds) and the propose-bond on `DatumPublisherGovernance` switch from DOT to DATUM.

- Bonding becomes a token transferFrom rather than a payable msg.value.
- Slashing redirects DATUM (not DOT) to challengers / bonus pool / treasury.
- Bond amounts are ParameterGovernance-tunable (already are; just change the unit).

**Effect.** A drive-by speculator with no token holdings can't grief the system with bond-spam. Bonds become a meaningful indicator of governance commitment, not just disposable DOT.

**Side effect.** ChallengeBonds bonus pool becomes a DATUM rewards pool — natural alignment with the staking story.

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
HARD_CAP = 100_000_000 DATUM   (100M)
```

Rationale: round number, simple math, large enough that per-settlement rewards don't dust to zero, small enough that whale concentration is visible.

### 3.2 Founders' premint (vested)

```
FOUNDER_ALLOCATION    = 5_000_000 DATUM   (5%)
VESTING_PERIOD        = 4 years
VESTING_CLIFF         = 12 months
DISTRIBUTION_TO       = team multisig (Gnosis Safe / hardware-backed council)
```

The full 5M is minted at genesis into a `DatumVesting` contract. Linear unlock starting 12 months after deploy, fully unlocked at 48 months. Standard pattern. Recipients can adjust their unlock schedule to be slower but never faster.

This is the only pre-allocation. **No private sale. No public sale. No KOL allocation.**

### 3.3 Settlement-driven emissions

The remaining `95M` mints into circulation via a per-settlement reward, with a halving difficulty adjustment.

**Per-settlement reward.**

```
INITIAL_REWARD          = 47.5 DATUM per settled claim
HALVING_INTERVAL        = 1_000_000 settlements
REWARD_AT_HALVING_n     = INITIAL_REWARD / 2^n
TOTAL_MINT_OVER_TIME    = HALVING_INTERVAL × INITIAL_REWARD × 2  (asymptote)
                        ≈ 95_000_000 DATUM
```

So on the n-th settlement window, the per-claim reward is `47.5 / 2^n`. Geometric sum to infinity converges to the 95M cap (matching the design).

The split per claim:

```
REWARD_USER_BPS         = 5000   (50%)
REWARD_PUBLISHER_BPS    = 4000   (40%)
REWARD_ADVERTISER_BPS   = 1000   (10%)
```

All three sides of a settled impression mint a small DATUM share. This:
- Bootstraps user holdings (most decentralised vector — every viewer earns a sliver).
- Rewards publisher participation (already aligned with their DOT earnings).
- Gives advertisers a reason to keep using the protocol (their spend earns governance rights).

### 3.4 Daily mint cap (circuit breaker)

```
DAILY_MINT_CAP = 50_000 DATUM / day
```

Why: settlements aren't smoothly distributed. A relay flood, batch settlement spike, or coordinated wash-loop could push 10x normal volume through in a day. The daily cap prevents emergency inflation from a temporary anomaly.

When the cap is hit, additional settlements *still settle DOT normally* — only the DATUM mint is paused for that day. Resumes at UTC midnight. The "unminted" DATUM is forfeited (not carried forward), which deliberately makes whale-spam unprofitable: spamming for tokens beyond the daily cap wastes DOT.

Cap is a ParameterGovernance-tunable (changeable through normal voting).

### 3.5 Halving milestones, not block intervals

Difficulty adjustment in DATUM is **milestone-based**, not time-based:

```
H_n triggers when totalSettlementsEver crosses n * HALVING_INTERVAL
```

This couples emissions to **real protocol use**, not wall-clock. If usage is low, halvings are slow (long high-reward bootstrap). If usage explodes, halvings come fast (early adopters get more, late entrants less). It's a direct settlement-driven Bitcoin-style schedule.

Counter-argument: this makes early bootstrap rewards huge if usage is slow. Mitigation: the daily cap still bounds upside. If real usage is low, you can't farm beyond ~50k/day no matter how cheap minting is.

### 3.6 Math sanity check

At launch, with assumed 100k settlements/day at saturation:

- Day-1 raw mint = 100,000 × 47.5 = 4,750,000 DATUM (wildly above cap)
- Day-1 actual mint = 50,000 (capped)
- Time to first halving at 100k/day = 10 days
- After halving: per-claim reward 23.75. To hit cap at 50k: needs ~2,105 settlements/day before reward × claims = 50k at 23.75 each. So as halvings progress, the cap stops binding.

This means in early days the cap dominates (good — slows the bootstrap). After a few halvings the per-settlement reward dominates (good — rewards real usage as it scales).

---

## 4. Allocation summary

```
HARD CAP:                100,000,000 DATUM
├── Founders' vesting:      5,000,000  (5%)  — 1y cliff, 4y linear
└── Settlement emissions:   95,000,000 (95%) — capped at 50k/day, halves every 1M settlements
                                               split 50% user / 40% publisher / 10% advertiser
```

No treasury allocation. The community treasury, if needed, is funded by:
- Slashed DATUM from challenge bonds + governance bonds (FP-2 + FP-3 forfeits).
- Slashed DATUM from removed council members.
- Optional: governance-voted redirect of a fraction of per-settlement mint.

---

## 5. Token contract

### 5.1 Where it lives

**Polkadot Hub (alongside the existing alpha-4 EVM contracts).** ERC-20, single-domain. Reasoning:

- All the integration points (governance, settlement-time minting, fee share, challenge bonds) are EVM-side.
- A native Asset Hub asset would require precompile reads on every governance vote and challenge bond — adds gas + complexity.
- Bridge to Asset Hub later if the cross-chain story becomes important.

### 5.2 Minting authority

- `DatumToken` is `Ownable2Step`, owner = `DatumSettlement` (only contract that mints from settlement).
- Genesis mint to `DatumVesting` happens at deploy time, then `transferOwnership(settlement)`.
- A separate `DatumGovernanceMint` role can be added later for governance-voted treasury issuance, but **not in v0.1**. Hard supply cap is non-negotiable in v0.1.

### 5.3 Storage layout sketch

```solidity
contract DatumToken is ERC20, DatumOwnable {
  uint256 public constant HARD_CAP = 100_000_000e18;
  uint256 public constant HALVING_INTERVAL = 1_000_000;
  uint256 public constant INITIAL_REWARD = 47.5e18;       // halved each milestone

  uint256 public dailyMintCap = 50_000e18;
  uint256 public mintedToday;
  uint256 public mintDayStartedAt;     // unix seconds, midnight-aligned

  uint256 public totalSettlementsEver;
  uint256 public currentRewardPerSettlement = INITIAL_REWARD;

  function mintForSettlement(address user, address publisher, address advertiser) external onlySettlement;
}
```

Settlement contract calls `mintForSettlement(user, publisher, advertiser)` exactly once per settled claim. Token contract does the daily-cap check, splits the reward, mints to all three. Halving fires when `totalSettlementsEver % HALVING_INTERVAL == 0`.

---

## 6. Open follow-up: DATUM-gated relays (#10, expanded)

**Problem.** The current relay model is open: any address can run a relay, sign attestation responses, and submit batches. There's no economic gate against a malicious relay. The `relaySigner` rotation cooldown helps, but doesn't actually require relays to commit anything.

**Proposal.** A relay must lock DATUM as a slashable bond before any of its batches will be accepted by `DatumSettlement`.

**Sketch:**

- New `DatumRelayStake` contract. Relays call `stake(amount)` to deposit; mapping `relayBond[address] → uint256`.
- `DatumSettlement` reads `relayBond[batch.publisher.relaySigner] >= MIN_RELAY_STAKE` during batch validation. Insufficient → reject.
- Slashing conditions:
  - Settlement rejection rate > X bps over a window (auto-slash via reputation contract).
  - Council vote on a fraud finding (manual).
- Slashed DATUM goes to the treasury or to publishers whose users were affected.

**Tension with grassroots ethos.** Requiring stake to run a relay raises the floor for who can operate relays. Mitigations:
- Stake threshold should be small enough that any committed publisher could afford it (e.g. earned-DATUM from running the relay over a few weeks could cover it).
- A small "earnings-backed" path: a relay could pledge future earnings to back the bond, with a smart-contract escrow taking a percentage of settlements until the bond is met. This keeps the gate without requiring upfront capital.

**Open questions:**
- Does the bond scale with throughput? (e.g. larger relays bond more)
- What's the slashing mechanism for soft failures vs hard fraud?
- Do we keep an "open relay" path with no DATUM bond but reduced settlement caps?

This deserves a separate spec doc once the core token is shipped. Tracked as a follow-up.

---

## 7. Open follow-up: emissions deep-dive (#8, expanded)

**The user wants to dig deeper here.** Specific design questions:

1. **Reward split tuning.** 50/40/10 (user/publisher/advertiser) is an opening guess. Should publishers actually get more given they bear more cost? Should advertisers get less because they're already getting traffic? Survey real-world incentive math.
2. **Anti-Sybil.** A user can mint DATUM by viewing impressions on their own publisher site. The ZK nullifier prevents *replay* of the same impression but doesn't prevent a single attacker from running both ends. How do we distinguish farmers from real users?
   - Option A: per-user daily mint cap, separate from the global cap.
   - Option B: tie DATUM mint to engagement quality score (users with high engagement get more).
   - Option C: route a portion to a treasury that's redistributed via real human KYC (compromises ethos).
3. **Halving milestones — settlements vs unique users.** Halving by settlement count rewards farms. Halving by *unique-user-settlements* (using nullifier identity) is more attack-resistant but slower-converging.
4. **Daily cap dynamics.** Should the cap auto-adjust based on settlement volume to keep emissions roughly constant? Or stay fixed? Fixed is simpler; dynamic is more economically smooth.
5. **Treasury redirect.** Should a fixed % of every per-settlement mint go to a community treasury (auto-funded)? E.g. 5% to treasury, 95% split among the three sides. Automatically funds public goods without explicit fundraises.

---

## 8. Migration plan

DATUM is launched **after** alpha-4 is mature. The order:

1. **alpha-4 v2 deploy** (current direction, no DATUM).
2. **DatumToken contract** deployed first, owner = DatumSettlement, premint goes to DatumVesting.
3. **DatumFeeShare** contract deployed; redirect protocol fees from PaymentVault.
4. **DatumChallengeBonds → DATUM**: governance proposal to migrate bonds; existing DOT bonds wind down.
5. **DatumParameterGovernance vote currency switch**: governance proposal to change lock currency. Existing locked DOT votes continue under old rules until withdrawn.
6. **Council bond requirement**: governance proposal to add bond requirement to existing council members; grandfather initial members or slash-then-replace.
7. **Publisher stake gate (DATUM path)**: parallel addition, doesn't break existing DOT path.
8. **Relay staking** (post-DATUM, separate spec).

Each step is a normal governance proposal (ParameterGovernance or Council). Token doesn't need a hard fork; it's additive infrastructure.

---

## 9. Decisions made (from this conversation)

- ✅ **DOT preserved** for all primary functions (campaigns, publishers, settlement payments, GovernanceV2 per-campaign votes).
- ✅ **DATUM utility** = ownership, cashflow share, parameter governance, trust collateral.
- ✅ **#2 fee share** included — replace `pendingProtocolFee` with stake-based distribution.
- ✅ **#3 council bonding** included — long-term commitment via slashable DATUM stake.
- ✅ **#4 quadratic vote weight** included, scoped to **core parameters only** (ParameterGovernance, possibly PublisherGovernance — see §10).
- ✅ **#5 publisher allowlist DATUM bypass** included as parallel path.
- ✅ **#6 advertiser fee discount** included with strict gas-cost ceiling — single SLOAD on the hot path, lazy off-chain refresh.
- ✅ **#7 challenge bonds in DATUM** included.
- 🔁 **#8 emissions** — direction approved (5% premint, micro-mint per settlement, daily cap, halving via settlement milestones, hard cap). Deep design open in §7.
- ❌ **#9 supermajority veto override** deferred to OpenGov phase, not for runway.
- 🔁 **#10 relay staking** — direction approved, deeper spec in §6.
- ✅ **Cypherpunk grassroots distribution.** No ICO. 5% premint cap. Vesting with cliff.

---

## 10. Follow-up questions to revisit

These came up while writing this doc and need explicit answers before contracts are touched:

1. **PublisherGovernance vote currency**: switch to DATUM (matches ParameterGovernance) or stay on DOT (matches GovernanceV2)? It's "protocol meta" (about a publisher's standing) but not "protocol-wide tunables". Lean DATUM, but worth confirming.
2. **Fee discount tier curve**: linear, step-function, or exponential? What balances vs underbuilt user base?
3. **Daily mint cap initial value**: 50,000 is a guess. What's the design target — hit cap on day 1? On day 30? Never (cap is purely a circuit breaker)?
4. **Halving criterion**: settlements vs unique-settlement-users (Sybil-resistance tradeoff).
5. **Treasury auto-funding %**: 0% (current spec — only slashing funds the treasury) vs 5% per-settlement skim.
6. **Founder allocation % and vesting curve**: 5% / 4y / 1y cliff is the current proposal. Tighten or loosen?
7. **DatumFeeShare withdrawal lockup**: how many blocks? Need to balance flash-stake protection vs UX.
8. **Council bond size**: 100k DATUM is a placeholder. What's actually committing-but-not-prohibitive at expected token price?
9. **Relay staking model**: bond-from-capital vs bond-from-future-earnings. Hybrid?
10. **What slashes a council member's bond?** Need a precise list of conditions before deploying.
11. **Should advertisers really get DATUM mint share?** They're paying DOT for service. Argument for yes: keeps them aligned with protocol success. Argument for no: keeps emissions more decentralised toward users/publishers.
12. **Quadratic dampener**: sqrt is the standard but fairly aggressive. Cube-root, or piecewise (linear up to N, sqrt above)?
13. **Per-user daily mint cap**: yes/no/how. Affects Sybil-farming math.
14. **DATUM-token name/ticker**: confirm "DATUM" is the symbol, or do we want a distinct ticker (e.g. "DTUM", "DATA")?
15. **License + verifier identity**: token contract should be auditable + verified on the explorer from day 1.

---

## 11. What this doc is NOT

- It is not a contract. No code is committed yet.
- It is not final. Every parameter (cap, premint %, halving interval, daily cap) is subject to change before genesis.
- It is not a launch plan. Distribution mechanics, marketing, and exchange listings (if any) are out of scope here.
- It is not a regulatory analysis. We deliberately don't speak to whether DATUM is a security in any jurisdiction. That conversation requires legal counsel before mainnet.

---

*End of v0.1 spec. Iterate before any contract code touches the repo.*
