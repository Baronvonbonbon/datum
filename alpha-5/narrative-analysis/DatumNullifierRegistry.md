# DatumNullifierRegistry

FP-5 ZK-replay-prevention registry. ZK claims commit to a nullifier
computed off-chain as `Poseidon(userSecret, campaignId, windowId)`,
where `windowId = block.number / nullifierWindowBlocks`. This contract
tracks observed nullifiers and rejects collisions. Carved back out of
DatumSettlement for EIP-170; the inline alpha-3 version is restored
here as a separate, independently-upgradable module.

## Hot-path interface

Settlement's `_processBatch` calls `tryConsume(campaignId, nullifier)`
per claim (view claims only, where `nullifier != bytes32(0)`):

- Gated to `msg.sender == settlement` (`OnlySettlement`).
- `nullifier == bytes32(0)` returns `true` — matches the caller's
  "no nullifier" path. This skip is intentional: non-ZK campaigns
  set the nullifier to zero, and the registry must let them through.
- Already-used `(campaignId, nullifier)` returns `false` (Settlement
  rejects the claim with reason 19 and sets `gapFound`).
- Otherwise marks `(campaignId, nullifier)` as used, emits
  `NullifierSubmitted`, returns `true`.

The atomic check-and-set semantics replaced the previous inline
split (check + register were two separate lines of `_processBatch`).
Observable behavior is identical because the logic between the
old check and old register couldn't fail — the CEI chain-state
writes (`lastClaimHash`, `lastNonce`) don't revert.

## Window size is lock-once

`setNullifierWindowBlocks(windowBlocks)` reverts with `WindowFrozen`
after the first non-zero value is set. Reason:

- **Increasing the window** would invalidate in-flight ZK proofs.
  Off-chain clients derived `windowId` from the old size; new
  proofs targeting the new size would conflict with no obvious
  off-chain coordination signal.
- **Decreasing the window** would let a previously-burned nullifier
  re-map to a fresh windowId and re-settle. Old proofs would
  retroactively become valid under a new windowId interpretation —
  the exact replay vector the registry is designed to prevent.

If a window-size change is ever genuinely needed, the right path is
a per-contract upgrade via DatumGovernanceRouter that resets all
nullifier state (i.e., a different deployed instance).

## Governance surface

- **`setNullifierWindowBlocks(windowBlocks)`** — owner-only,
  `whenNotFrozen`, lock-once after first non-zero value.
- **`setSettlement(addr)`** — owner-only; locked by `lockPlumbing`.
- **`lockPlumbing()`** — owner-only, `whenOpenGovPhase`. Permanent.

## Trust assumptions

- The nullifier preimage is bound to `userSecret` (which the user
  alone holds), `campaignId` (specific to the campaign settling), and
  `windowId` (specific to a chunk of blocks). A user can prove they
  haven't already used their nullifier for this campaign+window
  without revealing the secret.
- The contract has no view of the ZK proof itself — that's
  DatumZKVerifier's job. The registry trusts that any nullifier
  passed in arrived alongside a verified ZK proof.
- A captured Settlement upgrade could call `tryConsume` with arbitrary
  nullifiers, but that's bounded — the worst case is "Settlement burns
  random nullifier slots", which doesn't let anyone steal funds.

## Storage

`mapping(uint256 campaignId => mapping(bytes32 nullifier => bool used))`
is the only state. The `campaignId` outer key means nullifiers are
namespaced per campaign — a user's nullifier for campaign A is
unrelated to their nullifier for campaign B (same `userSecret` +
`windowId`, different `campaignId` gives a different Poseidon output).
