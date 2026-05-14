# token/DatumBootstrapPool

One-time-per-address WDATUM dispenser. Bootstraps initial circulating
supply by giving each new user a small grant on their first qualifying
engagement with the protocol's house ad campaign.

## The economic role

A new user joining the protocol has zero DATUM and therefore can't:
- stake to participate in the ZK gate at Path A campaigns
- vote in governance
- transact in WDATUM-denominated markets

But they earn DOT (the main reward) immediately on settled impressions.
DATUM accrues from the mint-on-settlement flow at the standard 19
DATUM/DOT rate, but that's a long slow accumulation.

The bootstrap pool front-loads a small grant — typically enough DATUM to
let a new user immediately interact with a Path A campaign or vote
once. The grant is bounded (1M total reserve, distributed one-per-user)
and self-limiting: when the pool depletes, the dispenser silently stops
paying, and the house-ad campaign reverts to its non-paying fallback
role.

## How qualification works

The pool dispenses on `mintForBootstrap(user, amount)`, called by
`DatumSettlement` when a claim against the *reserved house-ad campaign*
settles. The house-ad campaign is identified at deploy
(`houseAdCampaignId`); any claim against any other campaign is ignored.

`hasReceived[user]` mapping enforces one-per-address. A user who already
took their grant gets nothing on subsequent house-ad claims (but still
earns the normal DOT settlement).

The pool reads `campaigns.getCampaignAssuranceLevel` and may require a
minimum level — preventing trivially-faked house-ad claims at L0 from
draining the pool.

## Immutable wiring

```
BOOTSTRAP_RESERVE = 1_000_000 * 10**10  (1M DATUM)
settlement       (immutable)
mintAuthority    (immutable)
houseAdCampaignId (immutable)
```

All set at construction. No top-up function exists. Once the reserve is
fully distributed (`mintedSoFar == BOOTSTRAP_RESERVE`), the pool is
done forever.

## Why "house ad"

The protocol runs a single reserved campaign (campaignId = 1 in
production) that serves as the onboarding ad. It typically points to a
welcome page or documentation. The pool dispenser is gated to this
campaign specifically so that the bootstrap mints can't be gamed by
spinning up arbitrary campaigns.

## Owner role

Inherits DatumOwnable but the owner has limited authority:
- Set the minimum required AssuranceLevel.
- Tune the per-user grant amount (within reasonable bounds).
- Nothing that increases total dispensable amount.

The 1M reserve is hard-coded in the constant. No way to extend.

## Why one-time-per-user

If bootstrap grants were per-claim, sybils would farm them. By making
them one-shot per address, the cost of N grants is N sybil setups —
which the Path A stake gate is supposed to make expensive. The two
mechanisms reinforce each other.

## Sunset

When the pool depletes (`mintedSoFar == BOOTSTRAP_RESERVE`), the
contract effectively self-deactivates. The mint authority returns the
"cap exceeded" error and Settlement's try/catch silently handles it.
The contract storage remains (`hasReceived` mapping is still readable)
but no new mints happen.

## Trust assumptions

The pool trusts:
- `settlement` to only call on legitimate house-ad claims.
- `mintAuthority` to actually mint when called.
- The house-ad campaign's own integrity (advertiser, publisher, etc.) —
  if the house ad is configured wrongly, the dispenser may pay out
  to fake users. That's a Campaigns-side concern.

In practice, the house ad is configured by the founder team via the
governance ladder; if they're compromised, much worse things go wrong
than the bootstrap pool draining.
