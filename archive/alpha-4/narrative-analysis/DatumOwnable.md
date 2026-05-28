# DatumOwnable

The shared base contract for every owner-gated contract in the protocol.
31 lines. Wraps OpenZeppelin's `Ownable2Step` with two consistent
overrides:

1. **Error code `E18`** on unauthorized access. The protocol's compact
   require-string convention uses numeric codes (`E00`..`E94`); `E18`
   is "not owner". OZ's default revert string is "OwnableUnauthorizedAccount(...)"
   which is longer and inconsistent with the rest of the codebase.
2. **Non-zero newOwner** on `transferOwnership`. OZ allows transferring
   to zero address as a renunciation; we want renunciation to go
   through the explicit `renounceOwnership` path so it's never an
   accidental keystroke.

## Why Ownable2Step

Two-step transfers (propose + accept) prevent the most common ownership
disaster: transferring to an address the new owner can't sign from.
Step 1 (`transferOwnership`) stages the change; step 2 (`acceptOwnership`)
finalises only when the proposed owner calls it. If the wrong address
was staged, no harm — the current owner re-stages.

## The renunciation footgun

`renounceOwnership()` is inherited as-is from OZ. A single call sets
`owner = address(0)`. This is the cypherpunk terminal state: every
`onlyOwner` function reverts forever. The footgun warning in the
contract comment: "callers must verify each contract's lock state
before invoking" — meaning, if Settlement still has a swappable
reference that hasn't been lock-once-set, renouncing Settlement's
ownership would brick the ability to set it.

Standard practice is to renounce only AFTER every lock-once is locked
and every parameter is finalized.

## Used everywhere

Every contract that has any owner-only function inherits this. That's
basically every contract except the very few that are intentionally
ownerless (DatumWrapper, DatumVesting, DatumInterestCommitments,
DatumAttestationVerifier).

## Why not just use OZ directly

The error-code consistency matters for the off-chain stack — the
extension, relay, web app all map error codes to UI strings. Wrapping
OZ once in this shared base keeps the rest of the codebase clean: no
repeated `require(owner() == msg.sender, "E18")` boilerplate.
