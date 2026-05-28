# Datum Alpha-4 Economics — Break-Even Analysis by Role

All economic constants are identical between alpha-3 and alpha-4. The satellite merging changed code structure, not economics.

## Core Constants (on-chain)

| Parameter | Value | Source |
|---|---|---|
| Publisher take rate | 30–80% (per-publisher) | `DatumPublishers` MIN/MAX_TAKE_RATE_BPS |
| User share (of remainder) | 75% | `Settlement.USER_SHARE_BPS = 7500` |
| Protocol share (of remainder) | 25% | `remainder - userPayment` |
| Minimum CPM floor | 0.001 DOT / 1000 imps | `deploy.ts MIN_CPM_FLOOR` |
| Minimum campaign budget | 0.1 DOT (10^9 planck) | `Campaigns.MINIMUM_BUDGET_PLANCK` |
| Publisher base stake | 1 DOT | `deploy.ts PUBLISHER_STAKE_BASE` |
| Stake bonding curve | 1,000 planck / impression | `PUBLISHER_STAKE_PER_IMP` |
| Stake cap | 10,000 DOT | `maxRequiredStake = 10^14` |
| Campaign governance slash | 10% of losing vote | `SLASH_BPS = 1000` |
| Fraud governance slash | 50% of publisher stake | `PUB_GOV_SLASH_BPS = 5000` |
| Challenge bond bonus | 20% of fraud slash | `PUB_GOV_BOND_BONUS_BPS = 2000` |

## Revenue Split Formula

For a **view** claim (type 0, CPM-based):

```
totalPayment     = ratePlanck * eventCount / 1000
publisherPayment = totalPayment * takeRateBps / 10000
remainder        = totalPayment - publisherPayment
userPayment      = remainder * 75 / 100
protocolFee      = remainder - userPayment
```

For **click/action** claims (type 1/2, per-event):

```
totalPayment = ratePlanck * eventCount
```

Rest of the split is identical.

---

## Role 1: Publisher

### Revenue per 1,000 impressions

| Take Rate | CPM (DOT) | Publisher Gets | Remainder |
|---|---|---|---|
| 30% (min) | 0.001 | 0.0003 DOT | 0.0007 |
| 50% (default) | 0.001 | 0.0005 DOT | 0.0005 |
| 80% (max) | 0.001 | 0.0008 DOT | 0.0002 |
| 50% | 0.01 | 0.005 DOT | 0.005 |
| 50% | 0.10 | 0.05 DOT | 0.05 |
| 50% | 1.00 | 0.50 DOT | 0.50 |

### Costs

1. **Registration:** Gas only (~0 DOT on Paseo, negligible on mainnet)
2. **Staking:** `requiredStake = 1 DOT + cumulativeImpressions * 0.0000001 DOT`
3. **Unstake delay:** 7 days (100,800 blocks)

### Break-Even: Publisher Stake ROI

The stake is not consumed — it is locked and returned (minus slash risk). The real cost is the opportunity cost of locked capital.

At 50% take rate, minimum CPM (0.001 DOT):

| Cumulative Impressions | Required Stake | Revenue Earned | Stake ROI |
|---|---|---|---|
| 0 | 1.000 DOT | 0 | — |
| 10,000 | 1.001 DOT | 5.0 DOT | 500% |
| 100,000 | 1.01 DOT | 50 DOT | 4,950% |
| 1,000,000 | 1.1 DOT | 500 DOT | 45,354% |
| 10,000,000 | 2.0 DOT | 5,000 DOT | 250,000% |
| 100,000,000 | 11.0 DOT (capped at 10,000) | 50,000 DOT | capped |

**Publisher break-even: immediate.** The 1 DOT base stake starts earning revenue on the first impression. At minimum CPM with 50% take, the publisher earns back the base stake after 2,000,000 impressions (2M * 0.0005 / 1000 = 1.0 DOT). At realistic CPMs (0.01+ DOT), break-even is 200,000 impressions.

### Slash risk

- Fraud upheld: lose 50% of staked amount
- At base stake (1 DOT): risk is 0.5 DOT
- At cap (10,000 DOT): risk is 5,000 DOT

---

## Role 2: User (Extension User / Ad Viewer)

### Revenue per 1,000 impressions

| Take Rate | CPM (DOT) | User Gets (75% of remainder) |
|---|---|---|
| 30% | 0.001 | 0.000525 DOT |
| 50% | 0.001 | 0.000375 DOT |
| 80% | 0.001 | 0.00015 DOT |
| 50% | 0.01 | 0.00375 DOT |
| 50% | 0.10 | 0.0375 DOT |
| 50% | 1.00 | 0.375 DOT |

### Costs

1. **No registration cost** — users are passive
2. **Gas for withdrawal** — one `withdrawUser()` call
3. **Optional:** ZK proof generation (client-side, no on-chain cost)

### Break-Even: User Withdrawal

The only cost is gas for `withdrawUser()`. On Paseo EVM, a simple call costs ~50,000 gas. At the Paseo gas price floor of 1 Twei (10^12 wei = 10^6 planck = 0.0001 DOT):

**Gas cost per withdrawal: ~0.005 DOT** (50K gas * 10^12 / 10^10)

At minimum CPM (0.001 DOT), 50% take rate, user earns 0.000375 DOT / 1000 imps:

| | CPM = 0.001 | CPM = 0.01 | CPM = 0.10 |
|---|---|---|---|
| Break-even impressions | **13,333** | **1,333** | **133** |

**User break-even at minimum CPM: ~13,000 impressions before first withdrawal is profitable.** At realistic CPMs (0.01+ DOT), this drops to ~1,300 impressions. Users should batch withdrawals.

### Daily earnings estimate

| Ads/day | CPM (DOT) | Take Rate | Daily User Earnings |
|---|---|---|---|
| 50 | 0.01 | 50% | 0.000188 DOT |
| 200 | 0.01 | 50% | 0.00075 DOT |
| 200 | 0.10 | 50% | 0.0075 DOT |
| 500 | 0.10 | 50% | 0.01875 DOT |
| 500 | 1.00 | 50% | 0.1875 DOT |

At DOT = $5: a user seeing 200 ads/day at 0.10 DOT CPM earns ~$0.0375/day = ~$13.69/year.

---

## Role 3: Protocol (Datum)

### Revenue per 1,000 impressions

| Take Rate | CPM (DOT) | Protocol Gets (25% of remainder) |
|---|---|---|
| 30% | 0.001 | 0.000175 DOT |
| 50% | 0.001 | 0.000125 DOT |
| 50% | 0.01 | 0.00125 DOT |
| 50% | 0.10 | 0.0125 DOT |
| 50% | 1.00 | 0.125 DOT |

### Additional Protocol Revenue Streams

1. **Governance slash (campaign):** 10% of losing voters' locked DOT
2. **Governance slash (publisher fraud):** 80% of the 50% publisher stake slash stays in PublisherGovernance as protocol treasury (the other 20% goes to ChallengeBonds pool)
3. **Dust sweep:** Rounding dust from completed campaigns to treasury
4. **Slash pool sweep:** Unclaimed governance slash after deadline to owner

### Break-Even: Protocol Infrastructure Costs

Protocol costs are:
- Contract deployment (one-time, ~2 DOT in gas on Paseo)
- Relay bot operation (server hosting, ~$5/month)
- Governance monitoring

At 50% take rate, 0.01 DOT CPM:

| Monthly Impressions | Protocol Monthly Revenue | Break-even? |
|---|---|---|
| 100,000 | 0.125 DOT (~$0.63 @ $5) | No |
| 1,000,000 | 1.25 DOT (~$6.25) | Marginal |
| 10,000,000 | 12.5 DOT (~$62.50) | Yes |
| 100,000,000 | 125 DOT (~$625) | Comfortable |

**Protocol break-even: ~1-2M impressions/month** at $5 DOT, 0.01 CPM (covers minimal hosting).

---

## Role 4: Advertiser

### Costs

1. **Campaign budget:** Escrowed at creation (min 0.1 DOT)
2. **Challenge bond** (optional): Locked DOT, returned on clean campaign end
3. **Gas:** `createCampaign()` + governance votes if participating

### What they get

Every DOT of budget buys:

| CPM (DOT) | Impressions per DOT |
|---|---|
| 0.001 | 1,000,000 |
| 0.01 | 100,000 |
| 0.10 | 10,000 |
| 1.00 | 1,000 |

### Break-Even

Advertiser break-even is business-dependent (CPM vs conversion rate vs customer value). The minimum viable campaign:

- **Minimum budget:** 0.1 DOT
- **At minimum CPM (0.001):** buys 100,000 impressions
- **At 0.01 CPM:** buys 10,000 impressions
- **Daily cap** enforces pacing (must be <= budget)

### Refund paths

- **Governance termination:** Remaining budget returned to advertiser via `drainToAdvertiser()`
- **Campaign completion:** Budget fully spent (impressions delivered)
- **Challenge bond:** Returned on clean end; if fraud upheld, advertiser gets proportional share of slash bonus pool instead (bond is burned, bonus replaces it)

---

## Role 5: Governance Voter

### Revenue: Slash rewards from winning side

On campaign resolution, losing voters are slashed 10% of their locked DOT. This pool is distributed proportionally by conviction-weighted stake to winning voters.

| Your Vote | Lock Amount | Conviction | Weight | Lockup |
|---|---|---|---|---|
| Low commitment | 10 DOT | 0 | 10 | 0 days |
| Medium | 10 DOT | 3 | 40 | 7 days |
| High | 10 DOT | 6 | 140 | 180 days |
| Maximum | 10 DOT | 8 | 210 | 365 days |

### Example: 100 DOT losing side, 100 DOT winning side

- Slash pool = 100 * 10% = **10 DOT**
- If you contributed 50/100 of winning weight: **5 DOT reward**
- **ROI: 5%** on a 100 DOT vote (but requires conviction lockup)

### Break-Even: Governance Participation

Gas cost per vote: ~0.005 DOT. Slash reward must exceed gas:

| Losing Pool | Your Share of Winners | Your Reward | Break-even? |
|---|---|---|---|
| 10 DOT | 10% | 0.1 DOT | Yes (20x gas) |
| 1 DOT | 50% | 0.05 DOT | Yes (10x gas) |
| 0.1 DOT | 100% | 0.01 DOT | Yes (2x gas) |
| 0.01 DOT | 100% | 0.001 DOT | **No** (0.2x gas) |

**Voter break-even: Losing pool must be > ~0.05 DOT for participation to be gas-positive**, assuming you capture a reasonable share of the winning side.

---

## Alpha-3 vs Alpha-4 Comparison

| Parameter | Alpha-3 | Alpha-4 | Change |
|---|---|---|---|
| User share | 75% | 75% | None |
| Protocol share | 25% | 25% | None |
| Take rate range | 30-80% | 30-80% | None |
| Min CPM floor | 0.001 DOT | 0.001 DOT | None |
| Min budget | 0.1 DOT | 0.1 DOT | None |
| Base stake | 1 DOT | 1 DOT | None |
| Stake per impression | 1000 planck | 1000 planck | None |
| Stake cap | 10,000 DOT | 10,000 DOT | None |
| Campaign slash | 10% | 10% | None |
| Fraud slash | 50% | 50% | None |
| Bond bonus | 20% | 20% | None |
| Max batch size | **3 claims (PVM limit)** | **10 claims** | **+233%** |
| Gas per settlement | Higher (cross-contract) | Lower (inlined) | **~15-20% cheaper** |

The only economic difference is operational: alpha-4's satellite merging reduces gas per settlement (fewer cross-contract calls) and removes the 3-claim PVM batch ceiling. This means:

- Users can batch more claims per TX, fewer withdrawal TXs, lower amortized gas
- Publishers earn faster (more claims per block)
- Protocol collects fees faster

All split ratios, staking curves, governance parameters, and slash mechanics are identical.
