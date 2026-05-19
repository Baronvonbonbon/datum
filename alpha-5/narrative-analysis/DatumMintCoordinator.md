# DatumMintCoordinator

Per-batch DATUM emission orchestrator. The ~36 lines of mint logic
that used to live inline in `DatumSettlement._processBatch` carved
out to its own contract for EIP-170. Settlement now calls
`coordinate(user, publisher, advertiser, dotPaid)` once per batch
after the per-claim loop, and the coordinator owns:

- the MintAuthority pointer (lock-once)
- the optional Path-H EmissionEngine pointer (lock-once)
- the legacy flat-rate fallback (`mintRatePerDot`)
- the dust gate (`dustMintThreshold`)
- the user / publisher / advertiser DATUM split bps (default 55/40/5
  per TOKENOMICS §3.3)

Companion doc: [`task-datum-emission-path-h.md`](./task-datum-emission-path-h.md)
covers the path-H rate-adaptation design that the EmissionEngine
implements.

## Why a coordinator rather than direct calls?

Settlement no longer needs to know about the emission curve, the
dust gate, or the split bps. All of that policy lives here, where
it can be tuned, locked, or replaced independently. Settlement
calls `coordinate` and the rest is opaque to it.

## Hot-path flow

`coordinate(user, publisher, advertiser, dotPaid)`:

1. Gated to `msg.sender == settlement`. Non-Settlement callers revert
   `OnlySettlement`.
2. No-op on `mintAuthority == address(0)` (mint flow disabled) or
   `dotPaid == 0`.
3. **Compute total mint.** If `emissionEngine != address(0)`,
   delegates to `IEmissionEngine(emissionEngine).computeAndClipMint(dotPaid)`,
   wrapped in try/catch (engine misconfig → fail-soft → totalMint = 0).
   Otherwise uses the flat-rate fallback `dotPaid * mintRatePerDot / 1e10`.
4. **Dust gate.** Returns early without minting if `totalMint <
   dustMintThreshold` (default 0.01 DATUM = 1e8 base units).
5. **Split.** `userMint = totalMint * userBps / 10000`;
   `publisherMint` same; `advertiserMint = totalMint - userMint -
   publisherMint` absorbs rounding dust so the sum stays exact.
6. **Mint.** `IMintAuthority(mintAuthority).mintForSettlement(...)` in
   try/catch — if the authority rejects (cap hit, paused, etc.) the
   coordinator emits `DatumMintFailed` for observability and
   Settlement does NOT revert (mint is non-critical to DOT settlement).

## Soft-fail design

Three layers of soft-fail:

- `mintAuthority == 0` → silent no-op (mint disabled).
- EmissionEngine try/catch → totalMint = 0 → dust gate skips → no mint.
- MintAuthority try/catch → `DatumMintFailed` event, no revert.

The settlement DOT flow must NEVER be DoS'd by the DATUM mint path.
DATUM is a downstream reward; DOT is the primary value. The L-4
audit principle applied here.

## Governance surface

- **`setMintAuthority(addr)`** — owner-only, lock-once
  (`AlreadySet` on second call). Must be set before any mint will fire.
- **`setEmissionEngine(addr)`** — owner-only, lock-once. Optional;
  zero-address keeps the legacy flat-rate fallback.
- **`setMintRate(newRate)`** — owner-only, `whenNotFrozen`. Bounded
  by `MAX_MINT_RATE` (100 DATUM/DOT). Bootstrap: 19 DATUM/DOT.
- **`setDustMintThreshold(newThreshold)`** — owner-only,
  `whenNotFrozen`. Capped at 1 DATUM.
- **`setDatumRewardSplit(userBps, publisherBps, advertiserBps)`** —
  owner-only, `whenNotFrozen`. Sum must equal 10000.
- **`setSettlement(addr)`** — owner-only, locked by `lockPlumbing`.
- **`lockPlumbing()`** — owner-only, `whenOpenGovPhase`. Permanent.

The two distinct lock semantics:
- **`lockPlumbing()`** locks ONLY the Settlement pointer (the hot-path
  authorization).
- **`AlreadySet` on `setMintAuthority` / `setEmissionEngine`** locks
  the emission targets one-shot at first assignment.

## Upgrade

Coordinator is upgradable via DatumGovernanceRouter. State to migrate
is small (per-actor split bps, mint rate, dust threshold) — easily
hand-copied in a `_migrate` override.

The mint authority target itself is irrevocable post-`acceptIssuerRole`
on `DatumMintAuthority` — replacing the authority requires re-deploying
the coordinator, which is acceptable since the coordinator carries no
fund custody.
