# token/DatumVesting

Single-beneficiary linear vesting with cliff. Holds the right to mint
`TOTAL_ALLOCATION` DATUM (5M) to a single beneficiary on a fixed
schedule: zero before cliff, linear unlock between cliff and end, fully
vested at end.

## Constants

```
TOTAL_ALLOCATION = 5_000_000 * 10**10  (5M DATUM, 10 decimals)
CLIFF_DURATION   = 365 days
TOTAL_DURATION   = 4 * 365 days   (4 years total)
```

So: nothing in the first year, then linear unlock over the next three
years.

## The release math

```
if (now < startTime + CLIFF_DURATION):       vested = 0
else if (now >= endTime):                    vested = TOTAL_ALLOCATION
else:                                        vested = TOTAL_ALLOCATION × (now - startTime) / TOTAL_DURATION

claimable = vested - released
```

`release()` (anyone can call) mints `claimable` DATUM via
`mintAuthority.mintForVesting(beneficiary, claimable)`, updates
`released += claimable`.

## Beneficiary slow-down option

`extendVesting(newEndTime)` — beneficiary-only. They can EXTEND their
own end time (slow their unlock), never accelerate. Useful if the
beneficiary wants to commit to a longer alignment with the protocol
than the original schedule required.

`endTime` is the only mutable field. Everything else is `immutable`
from construction.

## No admin

The contract has no owner. No revoke, no clawback, no governance
override. The schedule is what was committed at deploy and stays that
way. Aligned with the protocol's credible-neutrality stance: a vesting
contract that can be unilaterally revoked isn't really a vesting
contract.

## Direct WDATUM delivery

The beneficiary receives WDATUM directly — no separate wrap step. The
flow:

```
release() called
  → mintAuthority.mintForVesting(beneficiary, claimable)
  → authority mints canonical DATUM to the wrapper
  → wrapper.mintTo(beneficiary, claimable)
  → beneficiary gets WDATUM
```

The atomicity matters: if the mintAuthority hits its cap or otherwise
reverts, the whole release reverts and `released` doesn't advance.

## Single beneficiary

The contract is per-beneficiary. The protocol's various vesting
allocations (team, advisors, investors if any) are each their own
deployed instance of this contract. This keeps state simple and
makes per-beneficiary parameters (cliff date, total amount) literally
immutable in deploy bytecode.

A future generalisation could template this with constructor args for
TOTAL_ALLOCATION et al.; currently those are constants because the
team vesting is the only declared use case.

## Why "release" instead of "claim"

Either works. The contract uses `release()` to signal "the next chunk
of the schedule unlocks now"; `claim` would suggest the beneficiary
has to opt-in to every unlock, but in fact `release()` is callable by
anyone (e.g. a bot keeping the beneficiary's claimed balance current).
The beneficiary doesn't pay gas for their own vesting.
