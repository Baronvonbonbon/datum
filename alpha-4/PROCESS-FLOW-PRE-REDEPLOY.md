# DATUM Alpha-4 — Pre-Redeploy Process Flow Analysis

**Scope:** contracts not yet on Paseo as of 2026-05-13. This includes the five `token/` contracts (`DatumWrapper`, `DatumMintAuthority`, `DatumFeeShare`, `DatumBootstrapPool`, `DatumVesting`), `DatumCouncilBlocklistCurator`, and the audit-pass deltas on the 21 currently-live contracts (most importantly `DatumSettlement.settleSignedClaims` and the AssuranceLevel gate).

**Notation:** `══►` is a human-originated transaction (wallet signs). `──►` is a machine/contract call. `┈┈►` is an off-chain signed message that later becomes on-chain calldata (the human/machine boundary).

---

## ACTOR 1 — End User (ad viewer / clicker)

### Intent
A user runs the browser extension, sees an ad, gets credit for it, and is paid in DOT plus optionally a campaign-specific ERC-20 reward. New in this redeploy: the user can demand a higher cryptographic-proof tier for their own settlements (opt-out of low-assurance batches), and can claim a one-time DAT token grant from the bootstrap pool.

### Process flow
```
USER WALLET                              EXTENSION (off-chain)              ON-CHAIN
─────────                                ─────────────────                  ────────
view page ══════════════════════════►  build claim {campaignId,publisher,
                                       user,nonce,impressions,claimHash}
                                       (Blake2 on PVM / keccak256 on EVM)
                                              │
                                              ├─ accumulate batch
                                              │
                                              ▼
                                       offscreen.js submits to relay
                                       OR signs EIP-712 ClaimBatch
                                              │                              ┌─► DatumSettlement.settleClaims  (relay path)
                                              ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┤
                                                                            └─► settleSignedClaims  (dual-sig path)

USER WALLET ══► DatumSettlement.setUserMinAssurance(level)   (NEW — user-side floor)
USER WALLET ══► DatumPaymentVault.withdraw()                  (pull-payment DOT credit)
USER WALLET ══► DatumTokenRewardVault.withdraw(token)         (pull-payment ERC-20)
USER WALLET ══► DatumBootstrapPool.claim(user)                (NEW — one-time DAT grant)
USER WALLET ══► DatumFeeShare.stake(amount)                   (NEW — stake DAT, earn DOT)
USER WALLET ══► DatumFeeShare.claim()                         (NEW — pull accumulated DOT fees)
USER WALLET ══► DatumWrapper.wrap / unwrap                    (NEW — bridge to Asset Hub DAT)
```

### Technical
- **Claim formation is fully off-chain.** The on-chain interface point is one of three settlement entry points — `DatumRelay.settleClaimsFor` (network relay), `DatumSettlement.settleClaims` (publisher's own relay key, msg.sender == relaySigner), or `DatumSettlement.settleSignedClaims` (dual-sig). All three converge on the internal `_processBatch`, which respects the campaign's `AssuranceLevel` and the user's `userMinAssurance[user]` floor (audit pass 2, B5-fix at `DatumSettlement.sol:728`).
- **Per-user assurance floor** is the most user-visible new lever: a user with `userMinAssurance = 2` rejects every relay-path settlement on their account, regardless of campaign config — claims emit `ClaimRejected` with reason 24, settlement nets zero.
- **Bootstrap pool** (`DatumBootstrapPool.claim`) is per-address gated, owner-set amount, pull-only, no Sybil prevention beyond per-address dedup — the operator decides who's eligible by pre-allowlisting before calling `claim` on their behalf, or running it open and accepting Sybils as a launch-cost.

---

## ACTOR 2 — Publisher (site/app operator)

### Intent
A publisher runs the SDK on their property, registers on-chain, picks a take-rate and a relay-signer key, optionally stakes DAT as a quality bond, and either runs their own relay or lets the network relay submit claims for them. New in this redeploy: every settlement batch can also carry their EIP-712 signature for an advertiser to countersign (the dual-sig path) — this is the only way they can collect for `AssuranceLevel ≥ 2` campaigns.

### Process flow
```
PUBLISHER WALLET                          PUBLISHER BACKEND               ON-CHAIN
────────────────                          ──────────────────              ────────
══► DatumPublishers.registerPublisher(takeRateBps)
══► DatumPublishers.setRelaySigner(relayKey)
══► DatumPublishers.setProfile(metadataHash)
══► DatumPublishers.setPublisherMaxAssurance(level)        (caps which campaigns this pub can serve)
══► DatumPublisherStake.stake()  {payable PAS}            (FP-1: required-stake curve)

run SDK → receives user claims ┈┈┈┈┈┈►  aggregate → sign EIP-712
                                       (ClaimBatch w/ expectedRelaySigner)
                                              │
                                              ├──► forward to advertiser for cosig
                                              ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈►
                                              │                              │
                                              ▼ (if running own relay)       ▼ (returned cosigned batch)
                                       DatumSettlement.settleClaims     DatumSettlement.settleSignedClaims
                                       (msg.sender == relaySigner)      (advertiserConsented=true)

══► DatumPublishers.updateTakeRate(new)                    (2-step: timelocked applyTakeRateUpdate)
══► DatumPublisherStake.requestUnstake(amount) ──► (delay) ──► unstake()
```

### Technical
- **Two distinct on-chain authority surfaces** for a publisher: the publisher EOA itself (registration, takerate, stake) and `relaySigner` (a separate hot key bound via `DatumPublishers.setRelaySigner`). The EIP-712 typehash (`DatumSettlement.sol:260-262`) binds `expectedRelaySigner` so a post-sign rotation invalidates in-flight cosigs — this is the A1 fix.
- **Stake gate** (`DatumPublishers.setStakeGate`) makes `registerPublisher` revert if stake < threshold; existing publishers who fall below the threshold get rejected at `_processBatch` (Settlement reason code 15). The required-stake curve is `base + cumulativeImpressions × perImp`, capped at `maxRequiredStake`.
- **Publisher max-assurance** is a self-imposed cap: a publisher who has not enabled L2 cannot serve L2 campaigns — used so a publisher without dual-sig tooling doesn't appear as a candidate for advertisers who require it.

---

## ACTOR 3 — Advertiser

### Intent
An advertiser funds a campaign in DOT, optionally posts a challenge bond, sets per-campaign assurance and rate-limit policy, and either trusts the relay path or cosigns each settlement batch (their new role in the dual-sig path). New: they can demand `AssuranceLevel = 2` so settlements without their fresh signature are rejected.

### Process flow
```
ADVERTISER WALLET                         AD CONSOLE (off-chain)            ON-CHAIN
─────────────────                         ──────────────────────            ────────
══► DatumChallengeBonds.depositBond(...) {payable}        (FP-2 bond lock)
══► DatumCampaigns.createCampaign(...)  {payable budget + bulletin escrow}
        ├ requiredTags, categoryId
        ├ optional rewardToken / rewardPerImpression
        ├ optional bulletin creative storage
        ├ optional userCap (per-user-per-window event cap)
        └ challengeBond (now non-stranded post audit pass 3 fix)

══► DatumCampaigns.setCampaignAssuranceLevel(id, 2)        (NEW — force dual-sig)
══► DatumCampaigns.setCampaignRequiresDualSig(id, true)    (legacy boolean, AssuranceLevel supersedes)
══► DatumCampaigns.setCampaignUserCap(id, max, window)
══► DatumCampaigns.setCampaignMinHistory(id, blocks)       (audit pass 2: min publisher tenure)

receive batch from publisher ┈┈┈┈┈┈┈►  inspect claims, run fraud heuristics
                                       sign EIP-712 ClaimBatch (advertiserSig)
                                                  │
                                                  └ return to publisher OR submit directly
                                                  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈►
                                                                                  DatumSettlement.settleSignedClaims

══► DatumCampaigns.activateCampaign / togglePause / setCampaignStatus
══► DatumCampaigns.confirmBulletinRenewal / fundBulletinRenewalEscrow
══► DatumChallengeBonds.claim   (post clean-end / fraud-resolved-in-favor)
```

### Technical
- **Dual-sig is voluntary on the advertiser's part, mandatory by the protocol once `AssuranceLevel == 2`.** The advertiser's sig is recovered against `campaigns.getCampaignAdvertiser(campaignId)` — meaning if they delegate, they must transfer the campaign or sign with the EOA on file. There is no advertiser-side rotating key.
- **The stranded-bond fix** (audit pass 3): if `createCampaign` reverts after `ChallengeBonds.depositBond` succeeds, the bond is refunded inline. Prior code could leave a bond locked to a campaign that never existed.
- **The advertiser/publisher trust boundary** is the EIP-712 envelope: same struct, same domain, two sigs over identical bytes. Either party can refute by withholding — there is no on-chain dispute, only non-cooperation.

---

## ACTOR 4 — Relay Signer (publisher hot key OR network relay)

### Intent
Move signed batches from publisher-side aggregation into `settleClaims` without spending the publisher's cold-key signing budget per submission. The network relay (`DatumRelay`) extends this to a multi-tenant service: any authorized relayer EOA can submit batches on behalf of any publisher that signed them.

### Process flow
```
RELAY OPERATOR (off-chain)                                 ON-CHAIN
──────────────────────────                                 ────────
poll claim mempool / receive batch ┈┈┈┈┈┈┈┈┈┈┈┈┈►
verify publisher sig                                       DatumRelay.settleClaimsFor(batches[])
verify advertiser sig (if dual-sig campaign)                       │
                                                                   ├─► verifies envelope, deadlineBlock,
                                                                   │   liveness threshold
                                                                   └─► DatumSettlement.settleSignedClaims
                                                                          (advertiserConsented=true)
                                                                       OR settleClaims
                                                                          (Level 1: msg.sender == relayContract)
```

### Technical
- **Two distinct relay topologies share one settlement contract.** Publisher-self-relay is `msg.sender == publishers.relaySigner(claims[0].publisher)`, satisfying Level 1 by direct authority. Network relay is `msg.sender == relayContract`, where `DatumRelay` already validated the publisher cosig. The check is in `_processBatch` at `DatumSettlement.sol:747-748`.
- **`DatumRelay` is open-by-default but lockable**: `setRelayerAuthorized` + `lockRelayerOpen` (one-way) flips it from permissionless to a curated relayer set. The 2026-05-06 deploy is currently in open mode.
- **Liveness threshold** in `DatumRelay` rejects batches whose `deadlineBlock` is past or whose freshness exceeds the window — protects against replay of stale cosigned batches.

---

## ACTOR 5 — Governance Token Holder (DAT staker / voter)

### Intent
Hold DAT (the new ERC-20 issued by `DatumMintAuthority` and circulated via `DatumWrapper` ↔ Asset Hub), stake it for fee-share OR conviction-vote with it on campaign moderation and parameter changes. The same DAT supply backs three distinct utility surfaces: fee-share, conviction-weighted governance, and Asset Hub bridging.

### Process flow
```
HOLDER WALLET                                              ON-CHAIN
─────────────                                              ────────
══► DatumBootstrapPool.claim(user)                         (initial distribution, one-time)
══► DatumWrapper.wrap(amount)                              (Asset Hub DAT → wrapped ERC-20)
══► DatumWrapper.unwrap(amount, assetHubRecipient)         (round-trip out)

══► DatumFeeShare.stake(amount)                            (DAT in, snapshot accDotPerShare)
       │
       │ ←── DatumPaymentVault.sweepProtocolFee ──► DatumFeeShare.fund {payable}
       │        (settlement DOT fees auto-pushed to FeeShare)
       │
══► DatumFeeShare.claim()                                  (pull pending DOT)
══► DatumFeeShare.unstake(amount)

══► DatumGovernanceV2.vote(campaignId, aye, conviction)    {payable PAS for conviction lock}
       (Note: GovernanceV2 vote stake is PAS, NOT DAT — DAT is the
        fee-share token; conviction lock is the existing PAS-based system)
══► DatumParameterGovernance.propose / vote / execute
```

### Technical
- **`DatumFeeShare` is a single-token MasterChef pattern:** stake DAT, earn DOT. `accDotPerShare` is a per-share accumulator updated by `fund() payable` (called by `DatumPaymentVault` on each protocol-fee sweep) and `notifyFee` (`token/DatumFeeShare.sol:99`). `sweep()` is keeper-callable to fold orphaned dust if `totalStaked == 0` when fees arrive.
- **`DatumWrapper`** holds Asset Hub DAT 1:1 against ERC-20 supply. `mintTo` is restricted to `mintAuthority`; `wrap` requires a prior `precompile.transfer` of canonical DAT into the wrapper; `unwrap` burns and emits an event keyed on `assetHubRecipient` for off-chain bridge relayers to execute the Asset Hub side.
- **The DAT/PAS distinction matters for voting**: existing GovernanceV2 conviction-locks are paid in PAS (the L1 native asset on Paseo). The new DAT token does **not** participate in conviction voting in this redeploy — it is a fee-share and bridging asset only. Adding DAT-weighted governance is a separate future scope.

---

## ACTOR 6 — Council Member

### Intent
A small fixed-membership multisig that operates two distinct surfaces: (a) N-of-M proposals over arbitrary calldata against the GovernanceRouter / Campaigns (Phase 1 governance), and (b) **new in this redeploy**: a delegated address blocklist curator (`DatumCouncilBlocklistCurator`) and tag curator (`DatumTagCurator`) that decouple policy state from Council *membership* — when the Council rotates from v1 to v2, the blocklist and approved-tag dictionary survive intact.

### Process flow
```
COUNCIL MEMBER WALLETS (N-of-M)                            ON-CHAIN
───────────────────────────────                            ────────
member-1 ══► DatumCouncil.propose(target, calldata)
member-2..N ══► DatumCouncil.vote(proposalId)
            ───► (votingPeriod) ───► executionDelay ───► vetoWindow
member-X ══► DatumCouncil.execute(proposalId)              ──► target.call(data)
guardian ══► DatumCouncil.veto(proposalId)                 (during vetoWindow)

member-1 ══► DatumCouncil.proposeGrant(recipient, amount)
member-X ══► DatumCouncil.executeGrant(recipient, amount)  (caps: perProposalMax + monthlyMax)

NEW — Blocklist + Tag curators (still gated by full council propose/vote/execute):
Council (post-execute) ──► DatumCouncilBlocklistCurator.blockAddr(addr, reasonHash)
                              │
                              └──► DatumPublishers (via setBlocklistCurator wiring): isBlocked(addr) → true
Council (post-execute) ──► DatumCouncilBlocklistCurator.unblockAddr(addr)
Council (post-execute) ──► DatumTagCurator.approveTag / removeTag
owner ══► DatumCouncilBlocklistCurator.lockCouncil()       (one-way: freezes council ref)
owner ══► DatumTagCurator.lockCouncil()                    (one-way: freezes council ref)
```

### Technical
- **The curators are delegation shims, not fast lanes.** `DatumPublishers.setBlocklistCurator(curator)` points an external lookup at the blocklist curator; `DatumCampaigns.setTagCurator(curator)` does the same for tag approvals. `Publishers.isBlocked(addr)` ORs the curator's set with the internal 2-step blocklist; `Campaigns._isTagApproved(tag)` ORs the curator with the local approved-tag mapping.
- **`onlyCouncil` checks `msg.sender == council`** (the contract address, not membership), so every block/approval still flows through `DatumCouncil.propose → vote → executionDelay → vetoWindow → execute`. The curator's value is decoupling council *rotation* from policy *state* — when the Council rotates v1→v2, the blocklist and tag dictionary survive intact.
- **`lockCouncil()`** (on both curators) freezes the council pointer permanently, so even the Timelock owner can no longer reroute policy authority to a hostile contract.
- **Two separate emergency budgets:** grant proposals (DOT or ERC-20 via `setGrantToken`) operate against the Council's own balance; arbitrary-calldata proposals can hit any contract the GovernanceRouter has authority over.

---

## ACTOR 7 — Bulletin Renewer (anyone)

### Intent
Permissionless keeper-style actor who pays gas to renew a campaign's Bulletin Chain creative storage when it nears expiry, in exchange for a small reward. New surface in this redeploy from the Bulletin integration. Trust-graded: either the advertiser pre-approves specific addresses, or the campaign is open-renewal.

### Process flow
```
KEEPER                                                     ON-CHAIN
──────                                                     ────────
poll campaigns near bulletin expiry
══► DatumCampaigns.requestBulletinRenewal(campaignId)      (signal intent)
   off-chain: push new creative to Bulletin Chain
══► DatumCampaigns.confirmBulletinRenewal(...)             (advertiser OR approved renewer)
       │
       └── pays renewer reward from bulletinRenewalEscrow
           (refunded if advertiser self-renews)

advertiser ══► setApprovedBulletinRenewer(campaignId, renewer, true)
advertiser ══► setOpenBulletinRenewal(campaignId, true)    (anyone-can-renew mode)
```

### Technical
- **The escrow + trust gradient is what makes this work in adversarial conditions.** Without escrow, an open renewer could grief by re-uploading garbage. With escrow + per-campaign approved-renewer set + bounded reward (`setBulletinRenewerReward`), an advertiser can run open-mode for active campaigns and lock to known keepers for sensitive ones.
- **Expiry path:** if no renewal arrives, `markBulletinExpired(campaignId)` is callable by anyone to clear the bulletin reference — settlement continues but the creative reference goes stale.

---

## ACTOR 8 — Protocol Owner (deployer key)

### Intent
The deploy-time owner is responsible for the one-time wiring of every cross-contract reference. The audit pass 3 hardening converted most of these wiring slots to **lock-once** — the owner can write each once, and that's it. After deploy + lock, the owner role on most contracts is effectively dead.

### Process flow (deploy-time only)
```
OWNER (deployer)                                           ON-CHAIN
────────────────                                           ────────
══► DatumSettlement.configure(budgetLedger, paymentVault, lifecycle, relay)   ← lock-once
══► DatumSettlement.setClaimValidator(addr)                                    ← lock-once
══► DatumSettlement.setAttestationVerifier(addr)                               ← lock-once
══► DatumCampaigns.acceptSettlementContract / acceptGovernanceContract / ...   ← 2-step then locked
══► DatumCampaigns.lockBootstrap()
══► DatumMintAuthority.setWrapper / setSettlement / setBootstrapPool / setVesting
══► DatumMintAuthority.transferIssuerTo(newAuthority)        (transfers AssetHub issuer rights)
══► DatumPublishers.setBlocklistCurator(curator) ──► lockBlocklistCurator()
══► DatumGovernanceRouter.lockPlumbing()
══► DatumClickRegistry.setRelay / setSettlement ──► lockPlumbing()
══► DatumCampaignLifecycle.lockPlumbing()
══► DatumRelay.lockPlumbing()
══► DatumCouncilBlocklistCurator.setCouncil(council) ──► lockCouncil()
══► DatumFeeShare.setPaymentVault(vault)
```

### Technical
- **Lock-once vs. owner-mutable** is the core post-audit shape. Anything that, if hot-swapped, could re-route funds (validators, attestation verifier, payment vault, claim validator, bulletin plumbing) is lock-once. Anything that's a policy parameter (rate limits, take-rate caps, max budget, AssuranceLevel defaults) remains owner-mutable but is governance-routed.
- **`DatumMintAuthority.transferIssuerTo`** is the single most dangerous live owner call after deploy — it hands the Asset Hub DAT issuer role to a new contract. Audit pass 2 left this owner-mutable (not lock-once) specifically so a future governance handover can take it; that decision should be revisited before mainnet.

---

# Data Flow Diagram

```
                                       ┌─────────────────────────────────────────┐
                                       │            HUMAN / OFF-CHAIN            │
                                       └─────────────────────────────────────────┘
       USER             PUBLISHER             ADVERTISER          GOV HOLDER      COUNCIL
        │                  │                      │                   │             │
        │  view ad         │  aggregate           │  cosign batch     │ stake DAT   │ propose
        │                  │  + sign EIP-712      │  (EIP-712)        │             │
        │ ┌──────────────► │ ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈►│                   │             │
        │ │ claim          │                      │                   │             │
        │ │                │ ◄┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈ │  return cosig     │             │
        │ │                │                      │                   │             │
═══════════════════════════════════════════════════════════════════════════════════════════
        ▼                  ▼                      ▼                   ▼             ▼
                                       ┌─────────────────────────────────────────┐
                                       │              ON-CHAIN                    │
                                       └─────────────────────────────────────────┘

   ┌──────────────┐  relay path   ┌──────────────┐  dual-sig path   ┌──────────────────┐
   │ DatumRelay   │──────────────►│              │◄─────────────────│ settleSigned     │
   └──────────────┘               │              │                  │ Claims (direct)  │
                                  │              │                  └──────────────────┘
   ┌──────────────┐  attested     │ DatumSettle- │
   │AttestationVer│──────────────►│ ment         │
   └──────────────┘               │              │
                                  │  _processBatch│
                                  │  • Assurance │
                                  │    Level gate│
                                  │  • user min  │
                                  │    floor     │
                                  │  • rate-limit│
                                  │  • nullifier │
                                  └──────┬───────┘
                  ┌─────────────┬────────┼────────┬──────────────┬───────────────┐
                  ▼             ▼        ▼        ▼              ▼               ▼
          ┌─────────────┐ ┌──────────┐ ┌──────┐ ┌──────────────┐ ┌─────────────┐ ┌──────────────┐
          │ClaimValidator│ │BudgetLed │ │Camp- │ │PublisherStake│ │PaymentVault │ │TokenRewardVlt│
          │ (Blake2/k256)│ │ger       │ │aigns │ │(stake gate)  │ │ DOT credits │ │ ERC-20 cred. │
          └─────────────┘ └────┬─────┘ └──┬───┘ └──────────────┘ └──────┬──────┘ └──────────────┘
                               │          │                              │
                               │          ▼                              │
                               │   ┌──────────────┐                      │  protocol fee
                               │   │ZKVerifier    │                      │  sweep
                               │   │(L3 Assurance)│                      │
                               │   └──────────────┘                      ▼
                               │                                  ┌─────────────────┐
                               │                                  │ DatumFeeShare   │◄── HOLDERS
                               │                                  │ (DAT stakers    │    claim
                               │                                  │  earn DOT)      │
                               │                                  └─────────────────┘
                               │
                               │  campaign budget refund / completion
                               ▼
                       ┌──────────────────┐    ┌──────────────────┐
                       │CampaignLifecycle │◄───│ChallengeBonds    │
                       └──────────────────┘    └──────────────────┘

   ────────────────────────────────────────────────────────────────────────────────
                                GOVERNANCE PLANE
   ────────────────────────────────────────────────────────────────────────────────
            GOV HOLDER (PAS conviction)            COUNCIL                  OWNER
                  │                                   │                       │
                  ▼                                   ▼                       ▼
          ┌───────────────┐                  ┌────────────────┐       ┌────────────────┐
          │GovernanceV2   │                  │DatumCouncil    │       │GovernanceRouter│
          │ (campaign     │                  │ • N-of-M       │       │ (Phase 0 admin │
          │  moderation)  │                  │ • grant treas. │       │  ── locked)    │
          └───────┬───────┘                  └───────┬────────┘       └───────┬────────┘
                  │                                  │                        │
          ┌───────┴────────┐                ┌────────┴────────┐                │
          ▼                ▼                ▼                 ▼                ▼
   ┌────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   Campaigns
   │ParameterGov│  │PubGovernance │  │CouncilBlock- │  │Arbitrary     │   Lifecycle
   │(fees, caps)│  │(slash pubs)  │  │listCurator   │  │target.call() │   Publishers
   └────────────┘  └──────────────┘  │  (NEW)       │  └──────────────┘   PauseRegistry
                                     └──────┬───────┘
                                            │
                                            ▼
                                      ┌──────────────┐
                                      │DatumPublishers│
                                      │ isBlocked()   │
                                      └──────────────┘

   ────────────────────────────────────────────────────────────────────────────────
                            TOKEN PLANE (DAT — entirely new)
   ────────────────────────────────────────────────────────────────────────────────

       Asset Hub DAT ◄────precompile──────  DatumWrapper (ERC-20)
                                              ▲      │
                                  mintTo only │      │ wrap/unwrap (USER)
                                              │      │
                                       ┌──────┴──────▼──┐
                                       │MintAuthority   │  mintForSettlement (publisher loyalty)
                                       │  (sole issuer) │◄──── Settlement (future hook, not wired today)
                                       └──────┬─────────┘
                                              │
                       ┌──────────────────────┼───────────────────────┐
                       ▼                      ▼                       ▼
                ┌────────────┐         ┌─────────────┐         ┌────────────┐
                │BootstrapPool│         │ Vesting     │         │ (future    │
                │ one-time   │         │ founder/team│         │  emissions)│
                │ per-addr   │         │ linear      │         └────────────┘
                └────────────┘         └─────────────┘
                       │
                       ▼ DAT recipients
                  USER WALLET ──► stake into DatumFeeShare ──► earn DOT from settlement fees
```

---

## Trust & boundary summary

| Boundary | Human side | Machine side | Risk if broken |
|---|---|---|---|
| Claim → Settlement | User device signs nothing; publisher SDK aggregates | EIP-712 sig over `ClaimBatch` | Forged claims drain publisher's allocation |
| Publisher cosig | Publisher relay key (hot wallet) | `expectedRelaySigner` typehash binding | Key rotation invalidates in-flight cosigs (intended) |
| Advertiser cosig | Advertiser EOA | `getCampaignAdvertiser` lookup | No rotation possible — campaign transfer required |
| Council action | N-of-M wallet sigs | `propose/vote/execute` or `BlocklistCurator` direct | Curator path = faster but full council-trust |
| Wrapper ↔ Asset Hub | Off-chain bridge relayer watches `Unwrapped` events | `MintAuthority.mintTo` | Bridge halt = wrapped DAT trapped; canonical safe |
| Bootstrap claim | User claims their own grant | Per-address one-time | Sybil if operator runs open mode |
| Fee-share funding | Automatic from PaymentVault sweep | `accDotPerShare` accumulator | Orphan dust foldable via `sweep()` |

## What's load-bearing about the redeploy (vs. live 2026-05-06)

1. **`settleSignedClaims` is genuinely new on-chain authority surface.** A user can now lose funds to a forged advertiser sig only if both publisher and advertiser keys collude — the rest of the system was single-sig publisher trust.
2. **AssuranceLevel-2 campaigns cannot be served by the current 21-contract deploy** — the gate is in the new Settlement. Until redeployed, every campaign is effectively L0/L1.
3. **DAT token plane is entirely new** — no existing campaigns reference rewardToken=DAT, no fee-share is live. Bootstrap distribution must happen before FeeShare yields anything.
4. **CouncilBlocklistCurator is a faster lane** — without it, every block needs `DatumPublishers.blockAddress` from the owner, which means manual ops. Once wired + locked, the Council shoulders abuse response.
