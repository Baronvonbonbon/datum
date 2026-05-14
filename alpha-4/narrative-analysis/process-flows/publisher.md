# Publisher

The operator of a site, app, or content surface that serves DATUM ads.
Stakes DOT, registers on-chain, integrates the SDK, signs batches, and
earns a configurable percentage of every settlement.

## On-chain footprint

A publisher has a real on-chain identity: their EOA is registered in
`DatumPublishers`. The publisher is identifiable by address forever
afterward, can be slashed, rated, blocked, allowlisted.

## End-to-end flow

### Onboarding

1. **Acquire DOT** for the stake requirement and gas.
2. **(Optional) Acquire DATUM** if a campaign category they want to
   serve has a publisher-level stake gate enabled. Most campaigns don't.
3. **Stake DOT in `DatumPublisherStake.stake()`** — must meet
   `requiredStake` (initially just `baseStakePlanck`, grows with
   cumulative impressions).
4. **Register in `DatumPublishers.registerPublisher(takeRateBps)`** —
   pre-checks include:
   - Not flagged by the blocklist curator (M-6 audit: fail-CLOSED on
     curator revert).
   - If `stakeGate > 0`, must have `publisherStake.staked(self) >=
     stakeGate`.
   - `takeRateBps` in `[3000, 8000]` (30%–80%).
5. **Set a relay signer** via `setRelaySigner(addr)`. The relay signer
   is the publisher's "hot key" — a separate EOA that the relay
   operator holds for signing batches. The publisher's cold key
   remains the only authority to rotate this.
6. **(Optional) Set profile metadata** via `setProfile(bytes32 hash)`
   — an IPFS CID pointing at the publisher's profile document.
7. **(Optional) Set tags** via `DatumCampaigns.setPublisherTags(bytes32[])`
   — the taxonomy tags this publisher serves. Tags must be approved
   either locally in Campaigns or by the `DatumTagCurator`.
8. **(Optional) Configure advertiser allowlist** via
   `DatumPublishers._allowedAdvertisers` + `allowlistEnabled = true`
   to restrict which advertisers can run campaigns on their inventory.
9. **(Optional) Self-declare AssuranceLevel** via `publisherMaxAssurance` —
   informational signal to SDKs and advertisers about the cosigning
   capability this publisher offers.
10. **Integrate the SDK** — the publisher's site embeds the DATUM SDK
    which renders ads and reports impressions to the relay.

### Steady state (per impression cycle)

The publisher is largely passive on-chain:
1. **SDK reports an impression to the relay** — off-chain.
2. **Relay constructs a batch and asks the publisher's hot key to
   sign** (PublisherAttestation EIP-712 typehash bound to claimsHash +
   deadline).
3. **Relay submits the batch** via `DatumSettlement.settleClaims`
   (with the publisher's relay signer as msg.sender) or
   `DatumRelay.settle` (passing the publisher sig as a parameter).
4. **Settlement runs validation, charges budget, credits balances.**
   - 50% (or whatever the publisher's take rate is) goes to
     `publisherBalance` in PaymentVault.
   - PublisherStake's `cumulativeImpressions` is incremented — the
     publisher's required stake floor moves up.
   - PublisherReputation counters (`repCampaignSettled`,
     `repTotalSettled`) update.

### Maintaining adequate stake

As `cumulativeImpressions` grows, `requiredStake` grows linearly. The
publisher must monitor and top up before serving big spikes:

```
required = base + cumulative × perImp (capped at maxRequiredStake)
```

If `_staked[publisher] < requiredStake`, **settlement starts rejecting
their claims with reason 15 (FP-1 stake gate)**. The publisher must
`stake()` more DOT to resume settlement. Their already-accrued
publisherBalance in PaymentVault remains withdrawable regardless.

### Earning withdrawals

`DatumPaymentVault.withdraw()` — pulls accumulated DOT. Pull-payment,
ReentrancyGuard, `_safeSend` so Paseo dust accumulates separately.

### Take-rate adjustment

`DatumPublishers.updateTakeRate(newRate)` — stages a change. After
`takeRateUpdateDelayBlocks` (~100 blocks on testnet), apply via
`applyTakeRateUpdate()`. The delay prevents mid-claim rate jumps. The
ultimate protection is the per-campaign snapshot: campaigns created
before the change keep the old rate forever.

### Rotation

- **Relay-signer rotation:** `setRelaySigner(newAddr)`. Invalidates
  any in-flight dual-sig cosigs that bound the prior signer in the
  envelope. The publisher's cold key (= their registered EOA) is the
  sole authority — a compromised hot key cannot self-perpetuate.
- **Profile rotation:** `setProfile(newHash)`.
- **Cold-key rotation:** not directly supported. Publishers wanting to
  rotate cold keys must re-register under the new address; the old
  registration is orphaned. (Future work may add a transfer flow.)

### Exit

1. **(Optional) Stop serving:** remove SDK from site, stop signing
   batches.
2. **`DatumPublisherStake.requestUnstake(amount)`** — drops `_staked`
   immediately; queues with `unstakeDelayBlocks` cooldown. Remaining
   stake after request must still meet `requiredStake` (E69).
3. **Wait the cooldown** (governance-set, typically ~7 days).
4. **`DatumPublisherStake.unstake()`** — pull DOT.
5. **(Optional) Final withdraw** from PaymentVault.

## Economic exposure

- **Capital at risk:** staked DOT in `DatumPublisherStake`. Slashable
  by `DatumPublisherGovernance` on fraud upheld — `slashBps` of stake
  per fraud proposal, capped at `maxSlashBpsPerCall = 50%` (H-2 audit
  fix). Multi-call slashes possible.
- **Earnings:** publisher take rate × every settlement.
- **Reputation:** `DatumPublisherReputation` tracks acceptance ratio.
  At `minReputationScore` enforced, can't settle below floor.

## Who polices the publisher

- **Advertisers:** can file fraud proposals (`DatumPublisherGovernance`)
  or council arbitration claims.
- **Users:** can self-block this publisher via `Settlement.setUserBlocksPublisher`,
  cutting them off from that user's settled events.
- **The blocklist curator (Council in production):** can flag the
  publisher's address; Settlement rejects at L1+.
- **Settlement-level gates:** stake adequacy, reputation score, rate
  limits, per-publisher window caps.
- **Anomaly detection:** `DatumSettlement.isAnomaly(publisher,
  campaignId)` flags rejection-rate outliers vs the publisher's
  baseline.
