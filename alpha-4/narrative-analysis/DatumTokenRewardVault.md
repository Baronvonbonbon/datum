# DatumTokenRewardVault

Pull-payment vault for ERC-20 token rewards alongside the DOT payout.
Some advertisers want to pay impressions partly in their own project
token (e.g. a DAO running a brand campaign that distributes governance
tokens to engaged users). This vault is the optional second payment leg.

## How it integrates

Per-campaign configuration (set in DatumCampaigns at creation):
- `rewardToken` (ERC-20 address; 0 = disabled)
- `rewardPerImpression` (token amount per event, type-0 only)

At settlement, after the DOT split, Settlement reads these and accrues
`agg.tokenReward = eventCount × rewardPerImpression` (view claims only —
clicks and actions don't get token rewards). At the end of the batch,
Settlement calls `creditReward(campaignId, token, user, amount)` here.

The call is wrapped in try/catch — a misconfigured or under-funded
reward leg cannot DoS DOT settlement. On failure, Settlement emits
`RewardCreditFailed` for monitors to flag.

## Two-balance accounting

```
userTokenBalance[token][user]       — pending pull-payments
campaignTokenBudget[token][campaignId]  — remaining advertiser deposit
```

Advertisers deposit the token at campaign creation (via direct
`transferFrom` from this contract pre-funded). The contract decrements
`campaignTokenBudget` as it credits users. When budget hits zero, future
`creditReward` calls revert and Settlement's catch branch handles it.

## Authorization

- `setSettlement` — owner-only, lock-once. Hot-swap would let an
  attacker credit arbitrary balances.
- `creditReward` — gated to Settlement.
- `depositCampaignTokens` — open to anyone (the advertiser, typically)
  who has approved the transfer. Funds the campaign's pot.
- `withdraw(token)` — user pulls their balance.

## Why isolate from DatumPaymentVault

DatumPaymentVault holds native DOT. Mixing ERC-20 accounting in there
would (a) complicate withdrawal semantics, (b) expose the DOT path to
SafeERC20-related re-entrancy patterns, (c) make the DOT path harder to
audit. Separating gives each vault one job.

## ReentrancyGuard + SafeERC20

`withdraw` is `nonReentrant`. Transfers use OpenZeppelin's SafeERC20 to
handle non-standard ERC-20s (USDT-style missing-return-bool, etc.).

## What it doesn't do

- It doesn't support native Asset Hub tokens. Only EVM-side ERC-20s. The
  Asset Hub side has its own precompile path; mixing them here would
  blow up the trust surface.
- It doesn't auto-refund unspent tokens on campaign end. The advertiser
  must explicitly `withdrawCampaignTokens(campaignId)` post-end. Design
  choice: the protocol's lifecycle paths are about DOT; ERC-20 cleanup
  is the advertiser's job.

## Why optional

`address(0) = disabled`. Many campaigns won't bother with token rewards
— they're complexity that only matters for token-issuing advertisers. By
keeping the wiring optional in Settlement and Campaigns, the protocol
imposes zero overhead on campaigns that don't want it.
