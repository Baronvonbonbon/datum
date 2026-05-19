# DatumCouncilBlocklistCurator

The production implementation of `IDatumBlocklistCurator`, designed to be
plugged into `DatumPublishers.setBlocklistCurator(this)` so the Council
becomes the sole censorship authority.

## How it works

Two mutating functions, both gated to `onlyCouncil`:

- `block(addr, reasonHash)` — flags an address. `reasonHash` is an
  optional IPFS CID pointing at the rationale.
- `unblock(addr)` — removes the flag.

Plus a single view:

- `isBlocked(addr)` — returns the boolean state.

The council never directly calls these — they're targets of council
proposals. A blocking proposal goes through propose / vote / executionDelay
/ veto-window / execute. The same for unblocking.

## Why a curator pattern at all

`DatumPublishers` originally had `blocked[]` as a direct owner-controlled
mapping with a 48h unblock timelock. That worked for testnet but conflated
two concerns: (1) who has authority over the blocklist, and (2) what the
blocklist data structure looks like. The curator pattern splits them.

Now Publishers just asks "is X blocked?" and the curator answers. The
data, the authority, and the dispute resolution all live in the curator.
Pluggable means future deployments can swap in a DAO-driven curator, a
ZK-attested off-chain reputation curator, etc., without touching
Publishers.

## Lock-once council pointer

`setCouncil(newCouncil)` — owner-only. Used by the deployer to plug in the
real DatumCouncil contract.

`lockCouncil()` — owner-only, irreversible. Once called, the council
pointer is frozen permanently. After this, even the Timelock cannot
re-route censorship authority. The cypherpunk-credible commitment is
"the council is the sole censor, forever."

## Block reason

`blockReason[addr]` stores a `bytes32` per blocked address — typically the
IPFS CID of a justification document. Public read; off-chain UIs can show
"this publisher was blocked, here's why." This is the transparency floor;
the protocol doesn't enforce that reasons exist (the council can pass
`bytes32(0)`) but the field is available.

## Fail-open / fail-closed at the call site

This curator never reverts during normal operation. But a future curator
implementation could. `DatumPublishers.isBlocked` wraps the call in
try/catch and **fails open** (returns false). `DatumPublishers.isBlockedStrict`
(audit H-3) does not wrap and propagates reverts — used by Settlement at
AssuranceLevel ≥ 1 for fail-closed semantics.

## Why owner is even relevant pre-lock

During bootstrap, the deployer might want to:
1. Deploy curator with `council = address(0)`.
2. Deploy DatumCouncil.
3. `setCouncil(council)`.
4. Verify everything works.
5. `lockCouncil()`.

The owner role only exists to facilitate that. Lock-once is the
cypherpunk terminal state.

## Why not just put isBlocked in Council

Same reason Router exists: separating data from authority. If Council
itself implemented isBlocked, every dependent contract would have to point
at Council directly. Then swapping councils (Phase 1 v1 → v2) would
require re-wiring every dependent. With Curator in the middle, only the
Curator's `council` pointer needs updating.
