# token/DatumWrapper (WDATUM)

The EVM-side ERC-20 handle for canonical DATUM. Sits at 1:1 reserve via
the Asset Hub precompile and issues WDATUM (ERC-20) to recipients. Every
EVM-side governance, staking, and protocol utility reads WDATUM
balances; the canonical DATUM on Asset Hub is just the reserve.

## Why this contract exists

DATUM lives on Asset Hub as a substrate-native asset. EVM contracts
can't directly hold or transfer it — they need an EVM-ERC20 surface.
Wrapping is the standard pattern: the wrapper custodies the canonical
asset and mints/burns a 1:1 ERC-20 representation. Burnable, ownerless,
no upgradeability — this contract is intentionally rigid.

## No admin

- No owner. The contract doesn't even inherit Ownable.
- `mintAuthority` is `immutable`, set in constructor.
- `precompile` and `canonicalAssetId` are `immutable`.
- `decimals()` returns 10 (matches the canonical asset, not the
  EVM-standard 18) — non-standard but avoids scaling math at the
  wrap/unwrap boundary.

## Mint flow

Only `mintAuthority` may call `mintTo(recipient, amount)`:

```
mintAuthority.mintForSettlement(user, ...)
  ↓ (precompile mint of canonical DATUM to wrapper's address)
  ↓ wrapper.mintTo(user, amount)
  ↓ _mint(user, amount)
  ↓ _checkInvariant() — totalSupply must match canonical balance
```

The invariant check ensures the wrapper can never issue more WDATUM
than the canonical it holds. If something went wrong upstream (mint
authority didn't actually deposit canonical), the WDATUM mint reverts.

## Wrap (user-initiated, H1-secured)

Users can also wrap canonical DATUM they hold directly. Two-step
protocol (H1 audit pattern):

1. **`requestWrap(amount)`** — declares intent. Increments
   `pendingWrap[user]` and `totalCommittedCanonical`. Reserves
   canonical against future calls.
2. User transfers `amount` canonical DATUM to this wrapper via the
   precompile (off-chain step from their own context).
3. **`wrap()`** — consumes the user's pending commitment, verifies the
   wrapper's canonical balance increased by at least the committed
   amount, mints WDATUM.

Why two steps: without the commitment, a frontrunner could deposit
canonical to the wrapper just before a victim's deposit, then call
`wrap()` first and capture the victim's deposit as their own WDATUM.
The commitment reserves the canonical slack to the user who declared
intent first.

## Unwrap

`unwrap(recipient, amount)` — burns WDATUM and sends canonical DATUM
back to a substrate-native `bytes32` address on Asset Hub. On devnet
where the precompile is mocked, a shim path is used (gated by
`devnetUnwrapShimEnabled = true`). In production (`= false`), unwrap
reverts with "xcm-required" — production deploys must replace this
contract with an XCM-aware variant before unwrap is enabled. L3 audit
fix: belt-and-suspenders against accidentally shipping the mock shim
path to mainnet.

## Invariant

`_checkInvariant()`: `totalSupply() <= precompile.balanceOf(canonicalAssetId, this)`.
The wrapper can never issue more WDATUM than canonical it holds. Checked
after every mint.

## Trust assumptions

The wrapper trusts:
- `mintAuthority` (immutable) to mint canonical before calling mintTo.
- `precompile` (immutable) to honestly report balances.

Trust is one-way and gated to immutable references. No governance can
hot-swap either; the only escape hatch is the per-deployment
construction of a new wrapper.
