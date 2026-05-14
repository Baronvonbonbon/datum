# token/DatumMintAuthority

The single bridge contract between EVM-side protocol contracts and the
canonical DATUM asset on Asset Hub. Every DATUM mint flows through here.

## Why centralize mint authority

Three reasons:

1. **One enforcement point for the hard cap.** Total emissions are
   bounded at 95M DATUM (the 95% of the 100M HARD_CAP that isn't the
   founder premint). A single contract checks this on every mint,
   instead of every caller doing their own math.
2. **One bridge between EVM and Asset Hub.** The precompile interaction
   lives in exactly one place. If the parachain launches and DATUM
   migrates to its own native pallet, only this contract needs to
   change.
3. **One owner to graduate.** Mint authority transitions from founder
   multisig → Council via Timelock → eventual parachain pallet via the
   sunset path. Each phase is one `transferOwnership`.

## Three mint paths

```
mintForSettlement(user, userAmt, publisher, pubAmt, advertiser, advAmt)
  - called by DatumSettlement on every settled batch (if mint wired)
  - emits 3 separate WDATUM mints
  - enforces MINTABLE_CAP collectively

mintForBootstrap(user, amount)
  - called by DatumBootstrapPool when a new user qualifies
  - draws from a dedicated 1M reserve (subset of the 95M)
  - one-time-per-user (enforced upstream by BootstrapPool)

mintForVesting(recipient, amount)
  - called by DatumVesting on release
  - draws from a dedicated 5M reserve
  - linear schedule enforced upstream by Vesting
```

Each path is gated to a specific authorized caller. Settlement,
BootstrapPool, and Vesting addresses are set at deploy (constructor or
lock-once); a misconfigured caller will revert at the gate.

## How a mint actually works

```
1. caller invokes mintForX(recipient, amount)
2. authority checks msg.sender, checks recipient is non-zero
3. authority checks totalMinted + amount <= MINTABLE_CAP
4. authority calls precompile.mint(canonicalAssetId, wrapper, amount)
   → canonical DATUM appears in wrapper's balance
5. authority calls wrapper.mintTo(recipient, amount)
   → wrapper invariant check passes (canonical increased by amount)
   → recipient gets WDATUM
6. authority updates totalMinted
```

Atomicity: if either precompile or wrapper.mintTo reverts, the whole
mint reverts. There's no half-state where canonical is minted but
WDATUM isn't.

## Sunset path

`transferIssuer(newIssuer)` — owner-only. Used to hand the canonical
asset's issuer rights to a new authority (e.g. the parachain pallet
when it launches). After this, the precompile rejects further mint
calls from this contract — the parachain pallet is now the canonical
issuer.

This is the on-chain mechanism for the §5.5 sunset roadmap. The
protocol can fully migrate off this EVM-side bridge once the
parachain is live.

## Immutable wiring

- `precompile`, `wrapper`, `canonicalAssetId` — all immutable.
- `settlement`, `bootstrapPool`, `vesting` — lock-once owner setters.

Owner only controls (1) the wiring of the three mint callers before
their respective locks, and (2) `transferIssuer` for the sunset path.

## Why a hard cap

`MINTABLE_CAP = 95_000_000 * 10**10` (matches HARD_CAP - FOUNDER_PREMINT
per the TOKENOMICS spec). Without it, a bug in the rate-curve or a
compromise of one of the mint callers could mint unbounded DATUM, ending
the protocol's monetary credibility. The cap is enforced on every mint,
not just at deploy.

## Reserves within the cap

The 95M cap is partitioned:
- 1M reserved for `DatumBootstrapPool`.
- 5M reserved for `DatumVesting`.
- Remaining 89M available for settlement mints.

The authority tracks per-path counters and enforces both the per-path
sub-cap and the global 95M cap.
