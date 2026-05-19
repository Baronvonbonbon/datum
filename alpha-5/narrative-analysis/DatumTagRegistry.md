# DatumTagRegistry

**The StakeGated lane** of the three-lane tag-policy model. Permissionless
tag registration, symmetric challenge bonds, Schelling-point juror
arbitration, expiry-with-bounty. Pairs with `DatumTagCurator` (Curated
lane) and the no-op `Any` lane to give each actor a free choice of
tag-policy posture.

## Why this exists

The cypherpunk objection to a council-only tag registry is that it
recreates platform moderation: a small group decides which concepts can
be advertised against. The 2026-05-14 redesign added two parallel lanes
so the curator becomes one option in a market rather than the only path:

- **Any (mode 0)** — any non-zero `bytes32` works. No on-chain check.
  Spam-resistance is a UX concern, not a protocol one.
- **StakeGated (mode 1)** — anyone can register a tag by bonding WDATUM;
  bonds are slashable via challenge; idle tags expire. This contract
  implements that lane.
- **Curated (mode 2)** — `DatumTagCurator` council-approved list, with
  legacy `approveTag` fallback on `DatumCampaigns`.

The StakeGated lane is the cypherpunk middle ground: still
permissionless, but economically gated so namespace squatting has a
cost.

## Mechanics

### Registration

```solidity
function registerTag(bytes32 tag, uint256 amount) external;
```

Caller approves WDATUM to the registry, then calls `registerTag` with
`amount >= minTagBond`. Tag enters the `Bonded` state, `lastUsedBlock`
is set to `block.number`. Re-registering an `Expired` tag is allowed
(the prior owner forfeited it via expiry).

### Usage tracking

`DatumCampaigns` calls `recordUsage(tag)` opportunistically when a
publisher sets the tag (StakeGated mode only). Updates `lastUsedBlock`.
Silent no-op for non-Bonded tags so a publisher tag-update doesn't fail
on a tag that's mid-dispute.

### Expiry (the cypherpunk cleanup pattern)

After `expiryBlocks` of inactivity (default ~30 days), **anyone** can
call:

```solidity
function expireTag(bytes32 tag) external;
```

The caller receives **100% of the bond** as a garbage-collection bounty.
This is deliberate: it treats the bond as namespace rent that lapses
when the tag isn't being used, and pays the keeper economics for
cleanup. It also implements the user-prompted "squatting popular terms
becomes market price discovery" mechanic — whoever values a term most
either uses it (which keeps the timer fresh) or pays a continually-
rising bond to hold it idle, because anyone can claim the bond once
they let it lapse.

### Challenge (symmetric bonds)

```solidity
function challengeTag(bytes32 tag) external returns (uint256 disputeId);
```

Challenger must approve WDATUM equal to the tag's current bond and
call `challengeTag`. **Symmetric**: no free challenges, no free
defenses. The contract picks `jurySize` jurors from the registered
juror pool via blockhash-seeded Fisher-Yates. Tag enters `Disputed`
state for the duration.

### Commit-reveal jury

Each selected juror calls:

```solidity
function commitVote(uint256 disputeId, bytes32 commitHash) external;
// commitHash = keccak256(abi.encode(disputeId, jurorAddress, vote, salt))
```

Within `commitWindow` blocks. Then within the subsequent `revealWindow`
blocks:

```solidity
function revealVote(uint256 disputeId, Vote vote, bytes32 salt) external;
```

Anyone can then call `resolveDispute(disputeId)` after the reveal
window closes.

### Resolution math

- **KeepTag wins:** tag survives. Owner receives `bondAmount - juryReward`
  (challenger's forfeited bond minus jury cut). Owner's bond stays
  escrowed against the tag.
- **ExpireTag wins:** tag destroyed (state → `Expired`, owner cleared).
  Challenger receives `2*bondAmount - juryReward`.
- **Tie / no reveals:** refund challenger; owner's bond stays escrowed;
  no jury reward; the slashed pool from non-revealers is **stranded in
  the contract** as a soft penalty against total juror inattention. Not
  recoverable by governance — that's deliberate.
- Majority revealers split `juryReward + slashed pool` proportionally,
  credited as juror stake (auto-compounded).
- Non-revealers and minority revealers each lose up to
  `jurorSlashBps` of their snapshotted juror stake (bounded by their
  remaining stake — partial-unstaking can't be a DoS vector against
  challenges).

### Juror pool

Anyone can `stakeAsJuror(amount)` with `amount >= jurorMinStake`. Joined
jurors are eligible for random selection. They can `unstakeJuror`
their **unlocked** stake at any time (locked = sum of worst-case slash
exposure across active disputes the juror is committed to). Partial
unstake below `jurorMinStake` is rejected — to leave the pool, withdraw
fully.

## Governance — indefinite evolution, hard floors

All parameters are owner-tunable indefinitely. There is **no policy
lock** on the registry itself — the user's explicit requirement was
that tag economics must remain adaptable as the network grows.

Tunable: `minTagBond`, `jurorMinStake`, `commitWindow`, `revealWindow`,
`jurySize` (must be odd, 3–21), `juryRewardBps` (≤ 30%),
`jurorSlashBps` (≤ 50%), `expiryBlocks` (~24h–~1y).

What stops a hostile owner from setting `minTagBond = type(uint256).max`
and pricing out the lane? Hard floors in the contract:

```solidity
MIN_TAG_BOND_FLOOR    = 1e18   // 1 WDATUM
MAX_TAG_BOND_CEILING  = 1_000_000e18
MIN_JUROR_STAKE_FLOOR = 1e18
MIN_COMMIT_WINDOW     = 600    // ~1 h
MAX_COMMIT_WINDOW     = 100800 // ~1 week
MIN_REVEAL_WINDOW     = 600
MAX_REVEAL_WINDOW     = 100800
MIN_EXPIRY_BLOCKS     = 14400  // ~24 h
MAX_EXPIRY_BLOCKS     = 5_256_000 // ~365 d
MIN_JURY_SIZE         = 3
MAX_JURY_SIZE         = 21
MAX_JURY_REWARD_BPS   = 3000
MAX_JUROR_SLASH_BPS   = 5000
```

These are contract-level constants. The lane stays usable forever
regardless of governance composition. That guarantee is what makes the
StakeGated lane a credible permissionless option rather than a lever
governance can disable in practice.

## Lock-once references

Two pointers can be frozen:

- `setCampaignsContract(c)` + `lockCampaigns()` — only the wired
  Campaigns contract is allowed to call `recordUsage`. Locked once so
  a hostile owner can't redirect usage-recording authority to a contract
  that lies about activity (which would prevent rightful expiries).
- On the Campaigns side: `setTagRegistry(addr)` followed by `lockLanes()`
  (in `DatumCampaigns`) pins the registry pointer permanently.

## Randomness limitations

Juror selection seeds from `blockhash(block.number - 1) ^ disputeId ^ tag
^ challenger`. **Not miner-resistant.** Adequate for low-stakes tag
squabbles where the cost-to-attack (proposer reorg + bond posting) far
exceeds the value-of-tag for the foreseeable future. A VRF (or
Drand-style external beacon) replacement is the natural upgrade path
once high-value tag disputes become economically interesting. Deferred
until then.

## Why WDATUM (not DOT)

The registry is a **protocol-policy mechanism**, not a settlement path.
Pricing it in DATUM (via the wrapped ERC-20) ties tag economics to the
project's own token rather than the host chain's gas asset. This keeps
DOT focused on settlement and impressions, and gives DATUM holders an
intrinsic protocol-policy role (jurying, registering, challenging).

## Error codes

T-codes are exclusive to this contract:

| Code | Meaning                                      |
|------|----------------------------------------------|
| T01  | locked / already locked                      |
| T02  | unset reference (e.g., campaignsContract)    |
| T03  | gov param out of allowed range               |
| T04  | bond amount below `minTagBond`               |
| T05  | tag is already live or disputed              |
| T06  | unauthorized `recordUsage` caller            |
| T07  | tag not eligible for expiry (wrong state)    |
| T08  | tag still fresh (lastUsed within window)     |
| T09  | tag not in Bonded state — can't challenge    |
| T10  | self-challenge forbidden                     |
| T11  | juror pool smaller than `jurySize`           |
| T12  | stake below `jurorMinStake`                  |
| T13  | unstake amount exceeds free (unlocked) stake |
| T14  | partial unstake below min not allowed        |
| T15  | not currently in pool                        |
| T16  | unknown dispute id                           |
| T17  | not on this jury                             |
| T18  | commit window over                           |
| T19  | already committed                            |
| T20a-h | reveal/resolve precondition failures      |

## Open questions / future work

- **Reveal-only attendance.** A juror who commits but never reveals is
  treated as the worst case (slash). Some Schelling designs reward
  reveals separately from majority alignment. The current design folds
  both into one slash bucket; revisit if reveal rates are low in
  practice.
- **Counter-bond escalation.** Tags worth more than `minTagBond` should
  arguably pay disputes against themselves with larger bonds. Currently
  the challenger matches whatever bond the tag *currently* has. A
  defender could deliberately under-bond a popular tag to make challenges
  cheap. Mitigation: tier `minTagBond` by tag age or by a "popular tag"
  flag set by the curator. Deferred.
- **Jury reuse / sybil.** Same juror may be selected to multiple
  concurrent disputes. We lock per-dispute slash exposure independently,
  so this is sound, but extremely-large stakers may dominate selection.
  Consider weighting selection by `1/stake^α` for some α to flatten the
  distribution. Deferred.
