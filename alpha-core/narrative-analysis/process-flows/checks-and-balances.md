# Checks and Balances

The protocol distributes authority across eight roles. None of them
has unilateral power over any critical action. This document maps each
pair (Role X is bounded by Role Y) and names the contract + gate that
enforces it.

## Quick matrix

A row "X is bounded by Y" reads as: "Y can constrain X's actions."

| Bounded ↓ / By → | User | Publisher | Advertiser | Relay | Reporter | Guardian | Council | OpenGov | Timelock |
|---|---|---|---|---|---|---|---|---|---|
| **User** | self | ✓ (1) | ✓ (2) | ✓ (3) | ✓ (4) | ✓ (5) | ✓ (6) | – | – |
| **Publisher** | ✓ (7) | self | ✓ (8) | – | ✓ (4) | ✓ (5) | ✓ (9) | ✓ (10) | – |
| **Advertiser** | ✓ (11) | ✓ (12) | self | – | – | ✓ (5) | ✓ (9) | ✓ (13) | – |
| **Relay** | – | ✓ (14) | – | self | – | ✓ (5) | – | – | ✓ (15) |
| **Reporter** | – | – | – | – | ✓ (16) | – | – | – | ✓ (17) |
| **Guardian** | – | – | – | – | – | ✓ (18) | – | – | ✓ (19) |
| **Council** | – | – | – | – | – | ✓ (20) | self | – | ✓ (21) |
| **OpenGov** | ✓ (22) | – | – | – | – | ✓ (5) | – | self | ✓ (23) |
| **Timelock** | – | – | – | – | – | – | ✓ (24) | ✓ (24) | self |

Numbers reference the detailed entries below.

---

## Detailed constraints

### 1. Publisher → User

- **Refuse service.** Publisher allowlist (`Publishers._allowedAdvertisers`)
  excludes specific advertisers; user can't earn from blocked
  advertiser's campaigns on this publisher.
- **Claim integrity.** Publisher signs (or refuses to sign) the claim
  envelope. A publisher who won't cosign denies the user settlement
  at L1+ campaigns.
- **Take rate.** Publisher's `takeRateBps` (bounded 30%–80%) eats into
  the user's share. User can avoid by visiting other publishers.

### 2. Advertiser → User

- **AssuranceLevel.** Setting L2 (`DualSigned`) means the advertiser
  must cosign every batch. An advertiser who refuses to cosign denies
  user settlement.
- **Campaign policy.** Required tags, minStake, requiredCategory,
  userEventCapPerWindow, minUserSettledHistory all restrict which
  users can earn from the campaign.

### 3. Relay → User

- **Censorship potential.** Relay can drop a specific user's claims.
  User's recourse: switch relays (off-chain), or self-submit at L0,
  or push the publisher to switch relays.

### 4. Reporter → User / Publisher

- **Stake-root inclusion.** A dishonest reporter cabal can include
  phantom leaves (helping fake sybils) or exclude real leaves
  (locking real users out of Path A). Mitigation: N-of-M threshold,
  public verifiability, governance ejection of misbehaving reporters.

### 5. Guardian → Everyone

- **Pause categories.** Settlement, Campaign Creation, Governance,
  Token Mint. Any single guardian can pause; two-of-three to unpause.
- **Cap on damage:** `MAX_PAUSE_BLOCKS = 14 days` per category before
  auto-expiry. Caps a malicious freeze.
- **Cannot affect already-earned balances.** PaymentVault withdrawals
  are not pause-gated.

### 6. Council → User

- **Curator authority over user blocklist.** If a council proposal
  targets `curator.block(userAddr)`, the user gets blocklisted —
  Settlement at L1+ rejects claims to them. Notable: this is
  publisher/advertiser blocklist enforcement at Settlement, not user-side;
  users themselves aren't typically blocked, but a sufficiently
  abusive user address could be. The blocklist semantics target the
  protocol-facing identity.

### 7. User → Publisher

- **Self-block.** `Settlement.setUserBlocksPublisher(pub, true)`
  rejects all batches claiming this publisher → user.
- **Self-pause.** `Settlement.setUserPaused(true)` rejects all
  incoming settlement, denying the publisher's take rate from this
  user.
- **userMinAssurance.** Forces the publisher to dual-sig or ZK-prove
  to settle for this user — friction the publisher must accept.

### 8. Advertiser → Publisher

- **Campaign assignment.** Advertiser chooses which publisher gets
  the campaign (closed campaigns).
- **AssuranceLevel.** L2 forces the publisher to operate the cosign
  flow correctly; misbehaving publishers can't satisfy.
- **Allowlist demand.** Advertiser can require allowlist-enabled
  publishers to add them.
- **Fraud proposals.** Advertiser proposes via PublisherGovernance
  (conviction vote) or PublisherGovernance's advertiser-claim arbiter
  (council route). Upheld → publisher slash.

### 9. Council → Publisher / Advertiser

- **Termination.** Council proposes `router.terminateCampaign(id)`;
  if approved + executed, the campaign is terminated with slash.
- **Blocklist.** Council-controlled curator can block the publisher's
  or advertiser's address. Settlement rejects at L1+.
- **Phase-1 default governor.** Until OpenGov is active, the Council
  is the default approver of campaign activation.

### 10. OpenGov → Publisher

- **Fraud-upheld slash.** `DatumPublisherGovernance` conviction vote
  → `PublisherStake.slash`. Up to `maxSlashBpsPerCall = 50%` per call.
- **Parameter changes.** ParameterGovernance can retune publisher
  stake bonding curve, minReputationScore, etc.

### 11. User → Advertiser

- **Self-block advertiser.** Symmetric to (7).
- **userMinAssurance ≥ 2** forces the advertiser to cosign.

### 12. Publisher → Advertiser

- **Refuse to serve.** Publisher allowlist excludes the advertiser
  from their inventory.
- **Take rate fixing.** Take rate is snapshot per-campaign; the
  publisher can't raise mid-campaign.
- **Advertiser fraud claim.** Publisher files via `PublisherGovernance.proposeAdvertiserClaim`
  (council arbiter path). Upheld → advertiser slash + bond redirected
  to publisher.

### 13. OpenGov → Advertiser

- **AdvertiserGovernance slash.** Conviction vote upheld → advertiser
  stake slashed (50% per-call cap).
- **Campaign termination via V2.** Upheld termination forces
  `slashBps` slash on the campaign's remaining budget.

### 14. Publisher → Relay

- **Hot-key rotation.** `Publishers.setRelaySigner(newAddr)`
  invalidates the relay's authority. The publisher can boot a relay
  unilaterally.
- **Cold-key authority.** Only the publisher's cold key (their EOA)
  can rotate the hot key.

### 15. Timelock → Relay

- **Authorized-relayer list.** Owner of DatumRelay (Timelock) can
  add/remove from `authorizedRelayers`. H-4 liveness fallback:
  empty list means anyone may submit.

### 16. Reporter → Reporter (mutual)

- **N-of-M threshold.** No single reporter can finalize a stake root;
  needs `threshold` approvals.
- **First-finalised-wins (M-1).** Once finalised for an epoch, no
  overwrite. Prevents oscillation by a late-arriving cabal.

### 17. Timelock → Reporter

- **Add / remove.** `DatumStakeRoot.addReporter / removeReporter`
  are owner-only.
- **Threshold tuning.** Owner-set; auto-clamped on reporter removal
  (L-4 audit fix).

### 18. Guardian → Guardian

- **2-of-3 unpause.** No single guardian can unpause unilaterally.
- **2-of-3 rotation.** Sitting guardians can rotate themselves
  without owner involvement (once `lockGuardianSet` is called).

### 19. Timelock → Guardian (pre-lock only)

- Owner of PauseRegistry (Timelock in production) can `setGuardians`.
- After `lockGuardianSet`: cannot. Permanently delegated.

### 20. Guardian → Council

- **Pause CAT_GOVERNANCE.** Halts Council proposal execution. A
  guardian set in disagreement with a Council action can force a
  pause while community organizes a response.

### 21. Timelock → Council

- **Self-governance default.** Council is self-governing (members
  manage themselves via proposals). But:
- **Phase advance via Router.** Timelock can `router.setGovernor`
  to move past Council to OpenGov, retiring Council's authority.

### 22. OpenGov → User

- **Parameter retune.** OpenGov can change `userShareBps` (bounded
  `[5000, 9000]`), `minReputationScore`, `MAX_USER_EVENTS`,
  per-window caps. All affect what users can earn.

### 23. Timelock → OpenGov

- **Curve retune.** Owner of GovernanceV2 (Timelock) can change
  `convictionA/B`, lockup schedules, quorum, slashBps. Per-proposal
  snapshot (M-2) means in-flight proposals are unaffected; but new
  proposals use the new curve.

### 24. Council / OpenGov → Timelock

- **Self-perpetuation.** In Phase 1, the Council typically owns the
  Timelock. In Phase 2, OpenGov can propose `timelock.transferOwnership`
  to retire it.

---

## Critical invariants the protocol relies on

These are properties no single role can violate:

1. **No double-spend of nullifiers.** `Settlement._nullifierUsed`
   prevents per-window-per-campaign replay. Nullifier window size is
   lock-once (A8 audit).

2. **No retroactive AssuranceLevel raising.** Advertiser can raise
   only at Pending; once Active, raises lock. Lowering always
   allowed. Protects users from frozen earnings.

3. **No retroactive conviction reweighting.** M-2 snapshot per
   proposal in V2 / PubGov / AdvGov.

4. **No stake-root overwrite.** M-1: first-finalised-wins per epoch.

5. **No infinite mint.** `DatumMintAuthority.MINTABLE_CAP = 95M
   DATUM`. Settlement, BootstrapPool, Vesting all draw from the same
   cap.

6. **No mid-flight stake rug.** Lock-once on slashContract, slasher
   set + `lockSlashers()`, and `setSlashRecipient` requires non-zero
   (H-1).

7. **No silent fail-open at high assurance.** Settlement uses
   `isBlockedStrict` at L1+ (H-3); curator revert → batch reject.

8. **No orphan slashed funds.** H-1: slash requires recipient.

9. **No slash drainage in one call.** H-2: `maxSlashBpsPerCall = 50%`
   on all three stake contracts.

10. **No DoS by pause.** PaymentVault withdrawals not pause-gated;
    14-day auto-expiry caps pause duration.

11. **No retroactive parameter retune of stake gates.** M-4: clamp
    pub4 at proof consumption time, so a governance cap tightening
    protects users from previously-set high values.

12. **No reactive interest-set swap.** M-8: `minInterestAgeBlocks`
    on the InterestCommitments age before usable in proofs.

---

## Where the protocol still trusts

Despite the matrix, three trust assumptions remain residual:

1. **Reporters.** N-of-M threshold buys defense in depth, but a cabal
   of `threshold` reporters can poison stake roots. Mitigation:
   public verifiability, reporter rotation.

2. **ZK trusted setup.** The Groth16 VK is set once. The current
   single-party ceremony is acceptable for testnet; mainnet needs an
   MPC ceremony. VK is lock-once (R-M1).

3. **Guardian set composition.** Three guardians, each capable of
   solo pause. A coordinated three-guardian malicious pause forces
   the protocol into a 14-day freeze. The auto-expiry caps damage but
   doesn't prevent it.

These are tracked as known residual trust in the per-contract docs;
the alpha-4 design accepts them in exchange for the simpler
N-of-M / Groth16 / single-committee structure. Future upgrades
(MPC, reporter staking, larger guardian sets) can tighten them.
