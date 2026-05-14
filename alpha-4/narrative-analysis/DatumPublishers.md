# DatumPublishers

The publisher registry. Anyone who serves DATUM ads registers here. The
contract carries:

- Per-publisher take rate (bounded `[MIN_TAKE_RATE_BPS = 30%,
  MAX_TAKE_RATE_BPS = 80%]`, default 50%).
- Per-publisher advertiser allowlist.
- Per-publisher hot key (the `relaySigner` that submits batches for L1 settles).
- Per-publisher profile metadata hash.
- Per-publisher self-declared AssuranceLevel (informational; the protocol
  enforces level on the campaign, not the publisher).
- Publisher tags (taxonomy, set via Campaigns).
- Pluggable blocklist via the `IDatumBlocklistCurator` curator.
- Optional stake gate (publisher must stake DATUM via DatumPublisherStake to
  register).

## Registration

`registerPublisher(takeRateBps)` is the entrypoint. Constraints:

- Must not be blocked by the curator (audit M-6: fail-CLOSED on curator
  revert — a broken curator delays registration rather than whitelisting
  everyone for the duration of the outage).
- If `stakeGate` is set, the caller's `publisherStake.staked` must meet
  `stakeGate`.
- `takeRateBps` must be in the `[3000, 8000]` band.
- Caller must not already be registered.

Once registered, `setRelaySigner(addr)` delegates the hot key (the address
that may submit batches via the Relay/Settlement paths). The cold key
remains the publisher's EOA; only the cold key can rotate the hot key.

## Take-rate updates

`updateTakeRate(newRate)` stages a new rate. After
`takeRateUpdateDelayBlocks` (an immutable set at deploy, typically ~100
blocks for testnet, longer for mainnet), `applyTakeRateUpdate()` activates
it. The delay prevents publishers from raising rates mid-claim — but the
real protection is the per-campaign **take-rate snapshot** in Campaigns:
once a campaign is created, its rate is fixed at that moment, regardless
of later publisher changes.

## Blocklist

The classic blocklist (`blocked[]` mapping) was removed in alpha-4. The
sole source of truth is now the curator contract pointed at by
`blocklistCurator` — typically `DatumCouncilBlocklistCurator` in
production. Two getters:

- `isBlocked(addr)` — fail-OPEN on curator revert (liveness over policy).
- `isBlockedStrict(addr)` — propagates curator revert (audit H-3). Used by
  Settlement at AssuranceLevel ≥ 1 to make the fail-closed gate actually
  reachable.

The curator pointer is settable until `lockBlocklistCurator()` is called.
After locking, the curator address is permanent — meaning the only way to
unblock someone is via the curator's own governance flow.

## Per-publisher advertiser allowlist

Each publisher can opt into a private advertiser allowlist
(`allowlistEnabled` + `_allowedAdvertisers` mapping). When enabled, only
advertisers in the allowlist may run campaigns on this publisher. Open
campaigns (`publisher == 0`) cannot be served by allowlist-enabled
publishers — BM-7 audit rule, enforced in ClaimValidator Check 3.

## Stake gate

Optional `stakeGate` threshold (DATUM staked in `DatumPublisherStake`). If
non-zero, a would-be publisher must have ≥ `stakeGate` staked before
`registerPublisher` is callable. `lockStakeGate()` freezes both the
`publisherStake` ref and the threshold permanently, so a hostile owner
can't swap to a permissive stake reader.

## Pause behavior

`whenNotPaused` reads `pausedCampaignCreation()` — registration and tag
changes are campaign-creation-domain operations. Settlement-domain pauses
don't block them.

## What this contract doesn't do

- It doesn't compute the take rate at settle time — Campaigns snapshot does.
- It doesn't track per-publisher reputation — Settlement does (merged from
  the old DatumPublisherReputation).
- It doesn't enforce per-publisher rate limits — Settlement does (merged
  from DatumSettlementRateLimiter).
- It doesn't govern itself. Owner is the Timelock; censorship authority is
  the curator. This contract is plumbing, not policy.
