# Gaps in the Checks and Balances

The 9-role matrix in [`process-flows/checks-and-balances.md`](./process-flows/checks-and-balances.md)
covers every named adversary pair. But "named pair has a check" isn't the
same as "the check is sufficient." This doc identifies structural gaps:
adversary patterns the matrix doesn't constrain adequately, asymmetries
in the design, and fundamental limits the protocol acknowledges but
can't fix in the current architecture.

Grouped by severity. Each gap names the failure mode, points at the
relevant contract, and (where applicable) suggests what closing it
would look like.

---

## High severity

### G-1. Relay has zero on-chain accountability

**Failure mode.** The relay submits every L1 batch but has no stake, no
slash, no on-chain identity that can be slashed. A dominant relay can:

- Censor specific users by silently dropping their claims.
- Front-run by delaying competitors' batches.
- Time submissions to extract MEV-like rents.

**Contract surface.** `DatumRelay.authorizedRelayers` is the only
gating, and the H-4 liveness fallback (empty list = anyone may submit)
deliberately weakens it. There is no `DatumRelayStake` contract.

**Why the matrix entry isn't enough.** "Publisher → Relay (14)" relies
on publishers rotating their relaySigner, but publishers will pick
relays for operational reasons (uptime, gas optimisation, integration
support), not user-protection reasons. If 2–3 relay operators end up
running 90% of throughput (a likely market structure), users have no
recourse. "User → Relay (3)" reduces to "switch publishers" — not a
real check.

**What closing it looks like.** Add a `DatumRelayStake` mirroring
PublisherStake's bonding curve. Slash on proven censorship — though
proof-of-censorship requires a witness mechanism (the relay claims
nothing was received; the user claims they sent it — adjudication is
hard without trusted intermediaries). At minimum, require relays to
register and be on a curator-managed allowlist with public reputation.

### G-2. Two-of-three guardian cabal has 14 days of damage power per cycle

**Failure mode.** A 2-of-3 guardian quorum can pause indefinitely by
re-engaging every 14 days. The 3rd honest guardian has *no unilateral
recovery path* — can't unpause (needs 2-of-3), can't rotate the set
(same).

**Contract surface.** `DatumPauseRegistry.pauseFast` (any single
guardian) + `MAX_PAUSE_BLOCKS = 201_600` auto-expiry. Auto-expiry caps
each freeze cycle to 14 days, but doesn't stop re-engagement.

**Why the matrix entry isn't enough.** "Guardian → Guardian (18)"
documents 2-of-3 rotation; doesn't address the 2-malicious case.

**What closing it looks like.** Add a slow asymmetric path: 1-of-3
with a 7-day delay can rotate the set if no 2-of-3 action has fired in
the interim. Weakens the strict 2-of-3 invariant, but provides escape
from the 2-malicious case. Alternative: widen to 5 guardians with
3-of-5, restoring true majority dynamics.

### G-3. No publisher-side dispute initiation

**Failure mode.** `DatumPublisherGovernance` lets advertisers file
fraud claims against publishers (conviction-vote + council-arbiter
paths). The reverse is asymmetric: publishers can be the target, but
can't file a defense or counter-claim. A wrongly-accused publisher
loses stake before any formal defense is heard.

**Contract surface.** `DatumPublisherGovernance.propose` (any caller
can propose against any publisher) + `proposeAdvertiserClaim`
(advertiser-filed, council-arbitrated). No equivalent `proposeDefense`
or `proposeCounterClaim` for publishers.

**Why the matrix entry isn't enough.** "Advertiser → Publisher (8)" is
the offensive path; there's no "Publisher → Advertiser (12, defense)"
beyond the grace period (which is a coordination window, not a
procedural right).

**What closing it looks like.** Add `proposeDefense(claimId,
evidenceHash)` callable by the target publisher, which extends the
grace period and lets the publisher submit on-chain rebuttal evidence
(IPFS CID). Doesn't change the vote math; gives publishers a formal
record.

### G-4. Reporter cabal has no fast eviction

**Failure mode.** The N-of-M threshold buys defense against a single
bad reporter. A coordinated cabal of `threshold` reporters can poison
stake roots indefinitely until the Timelock removes them. Timelock
removal requires the Timelock owner (Council or multisig) to act,
which is slow (48h delay + Council coordination).

**Contract surface.** `DatumStakeRoot.removeReporter` is owner-only.
No permissionless challenge mechanism with on-chain dispute resolution.

**Why the matrix entry isn't enough.** "Timelock → Reporter (17)" is
the only recourse, and it's bottlenecked on Timelock's owner's speed.

**What closing it looks like.** Two options:

1. **Permissionless dispute.** Anyone can call `disputeRoot(epoch,
   evidenceCommitment)` paying a bond. If governance agrees within a
   window, the root is invalidated for that epoch. Stake-gated
   campaigns settle without the gate during the dispute window.
2. **Reporter staking.** Reporters post a bond, slashable by
   governance on upheld fraud. Lets the Timelock move fast (slash =
   on-chain enforcement, no eviction-then-replacement coordination).

---

## Medium severity

### G-5. Users can't collectively act

**Failure mode.** A user can self-block one publisher. 10,000 users
can each individually self-block, but they can't aggregate into a
single governance signal short of each posting DOT into a conviction
vote — which is biased toward DOT-holders.

**Contract surface.** No user-aggregation primitive exists.

**Why the matrix entry isn't enough.** "User → Publisher (7)" is a
per-user opt-out. Effective for the individual; invisible to other
users and to governance.

**What closing it looks like.** A `userVeto` primitive: if N% of
unique recent-claimants (e.g., users who settled at least one claim in
the last 90 days) opt in to blocklisting an address, the address is
auto-blocklisted at L1+. Computationally cheap if implemented as
per-user opt-ins to existing proposal IDs.

### G-6. No appeal for false-positive curator entries

**Failure mode.** Curator wrongly blocks an address. Only recourse:
another curator proposal (council route). No formal appeal, no
escrowed dispute, no time-bounded review.

**Contract surface.** `DatumCouncilBlocklistCurator.block / unblock`
are both council-gated. Symmetric in mechanism, asymmetric in
outcome (blocking is instant; unblocking is governance-paced).

**What closing it looks like.** `proposeUnblock(addr, evidence)`
callable by the affected address itself, with a bond. Auto-unblocks if
the council doesn't ratify the block within N blocks. Forces the
council to actively defend each block, not just enact it.

**2026-05-14 partial mitigation for the *tag*-curator analog of this
gap.** Tag-curator decisions used to have the same monopoly shape: a
tag the council refused to approve was unreachable network-wide. The
three-lane model (`DatumTagRegistry` + per-actor `publisherTagMode` /
`campaignTagMode`) gives anyone an exit: opt out of the Curated lane
into StakeGated (bond the tag yourself, contestable by Schelling jury,
not council) or Any (no on-chain check). G-6's address-blocklist
analog has no equivalent escape hatch yet — that would be the
cypherpunk follow-up.

### G-7. Asymmetric AssuranceLevel direction silently rejects

**Failure mode.** Users can demand a *higher* level than the campaign
offers (via `userMinAssurance`). Campaigns cannot demand a *lower*
level than the user wants. Fine in principle — but a campaign at L0
with a user at L3 silently rejects every claim with reason 26. Neither
side gets a clear "mismatch" signal.

**Contract surface.** `DatumSettlement._processBatch` reason 26 (L3
user-floor mismatch). Reason codes are off-chain-resolvable but no
in-protocol prompt steers the user / campaign to alignment.

**What closing it looks like.** Pre-flight view function:
`canSettle(user, campaignId) returns (bool, uint8 reason)`. SDKs can
call before generating proofs. Doesn't fix anything on-chain; reduces
wasted work.

### G-8. No emergency unstake for users

**Failure mode.** `DatumZKStake` has a hard 30-day lockup. If the
protocol is under active exploit, users can't pull DATUM early. The
lockup is essential for sybil defense, but the lack of *any* exception
path means a pause-driven crisis traps user capital.

**Contract surface.** `DatumZKStake.requestWithdrawal` always sets
`readyAt = block.number + LOCKUP_BLOCKS`. No conditional override.

**What closing it looks like.** Allow `requestEmergencyWithdrawal` if
`pauseRegistry.pausedSettlement()` has been engaged for ≥ N blocks.
The conditional gate inherits the protocol's own crisis signal —
guardians pausing acts as the trigger.

### G-9. Slash funds compensate governance, not victims

**Failure mode.** When `DatumPublisherGovernance` upholds fraud,
slashed DOT splits between `DatumChallengeBonds`'s bonus pool
(advertisers with bonds) and the treasury. Users who were defrauded —
e.g., had settled claims wrongly attributed to them, exposing them to
reputation contamination — get nothing.

**Contract surface.** `DatumPublisherGovernance.resolve` distribution.

**Partial mitigation (2026-05-14).** With per-publisher bonds shipped
as part of the multi-publisher campaign work, the advertiser side of
G-9 is now finer-grained: an advertiser running a multi-publisher
campaign with bonds posted per publisher gets compensated only for
the *specific* publisher that was found fraudulent — not for any
publisher in the set. This better aligns the compensation with the
actual victim of each upheld fraud event. **User-side compensation
remains unaddressed.**

**Why the matrix entry isn't enough.** The slash *deters* fraud but
doesn't *remediate* affected users. Users are passive observers of the
slash even when they're the actual victims.

**What closing it looks like.** Per-user damage attribution requires
identifying the affected claimants from the upheld fraud's claim set —
non-trivial because the "fraud" verdict is on the publisher's
behavior, not per-claim. A pragmatic approximation: redirect a portion
of slash proceeds into a per-(publisher, campaign) user-claim pool
that users from that campaign-publisher pair can claim pro-rata.

### G-10. No rate limit on economic-parameter retunes

**Failure mode.** `setUserShareBps(5000)` instantly lowers user share
from 75% to 50%. Users have the 48h Timelock window of warning but no
transitional cushion: every settlement after the change uses the new
bps.

**Contract surface.** All economics setters
(`setUserShareBps`, `setDatumRewardSplit`, `setMintRate`, etc.) take
effect immediately on execute.

**What closing it looks like.** Two-step pattern mirroring publisher
take-rate updates: `pendingUserShareBps` + `effectiveBlock`. Users get
a predictable transition window beyond just the 48h Timelock delay.

---

## Low severity / asymmetry

### G-11. No publisher-vs-publisher reporting

Competing publishers have no on-chain channel to flag a rival running
click-farms or audience fraud. Has to route through an advertiser
noticing.

**Closing.** Open `propose` on PublisherGovernance to publishers
explicitly; currently any caller can propose (no role gate), but the
A6 "proposer ≠ target" rule blocks self-proposals — there's no
explicit publisher-vs-publisher path. Practical impact: low — most
publishers won't risk the bond.

### G-12. No whistleblower protection

A small actor reporting fraud via `propose` pays the bond and risks
losing it if quorum isn't reached. Discourages whistleblowing on niche
fraud where the community lacks eyes on evidence.

**Closing.** A bounty pool funded by treasury that pays out on upheld
proposals (in addition to bond refund) would tilt the math toward
small-fraud reporting. Currently treasury keeps the failed bonds and
doesn't redistribute.

### G-13. ZK Verifying Key has no rotation path

`setVerifyingKey` is lock-once (R-M1 audit). If the trusted-setup
ceremony is later discovered to be compromised, remediation requires
**deploying a fresh DatumZKVerifier and re-wiring
ClaimValidator.setZKVerifier**. The latter is also lock-once
(`plumbingLocked`). So a tainted VK forces a full ClaimValidator
redeploy, which means Settlement-redeploy-adjacent work.

**Closing.** Trade-off territory. The lock-once is a strong
cypherpunk credibility commitment; making it rotatable opens a major
rug surface. Most likely an accepted residual.

### G-14. No rate limit on mint per unit time

`MINTABLE_CAP = 95M` is total-supply protection but doesn't bound mint
*velocity*. A Settlement bug causing rapid mint accumulation would be
stopped only by `maxSettlementPerBlock` upstream — which is
governance-set and could be 0 (disabled by default).

**Closing.** Add `MAX_MINT_PER_BLOCK` constant in `DatumMintAuthority`
(e.g., 1000 DATUM/block ≈ 14M/day = ~7 days to drain the cap). Caps
worst-case bug impact at <1 week.

### G-15. Council membership has internal-only friction

A council voting to add a new member faces only the Council's own
threshold + execution delay + veto window. `MIN_COUNCIL_SIZE = 3` and
`MIN_THRESHOLD = 2` are floors but a captured majority can pack the
Council quickly within those.

**Closing.** Require a Timelock-mediated waiting period for
membership changes, on top of the Council's own threshold. Members
get added only after both Council vote AND Timelock 48h have passed.

### G-16. No protocol-level relay reputation

Settlement tracks publisher reputation
(`DatumSettlement.repCampaignSettled / repCampaignRejected`). There's
no equivalent for relays. A relay that drops user batches looks
identical on-chain to one that doesn't — dropped claims are off-chain
and invisible.

**Closing.** Add `relaySubmitted[relayAddr]` and
`relaySuccess[relayAddr]` counters in Settlement, updated per batch.
Lets the off-chain community rank relays. Doesn't catch silent drops
(those leave no on-chain trace) but catches everything submitted.

---

## Fundamental, acknowledged, unfixable in current design

These are the protocol's *known* residuals, not gaps in the matrix.
Listed here so they aren't conflated with the addressable gaps above.

### F-1. Attention isn't provable

Cryptography proves *capability* (you have stake, you have the
required interest leaf, you produced a valid claim hash, you did the
PoW). It doesn't prove *fact* (a human's eyeballs saw the ad render
on a screen). No on-chain gate can. This is the structural limit of
every ad system, traditional or crypto.

### F-2. Reporter trust is residual

Even with N-of-M threshold, a `threshold`-or-more cabal can collude
on stake-root poisoning. The protocol's stance: public verifiability
lets the community detect; rotation evicts. Both are reactive.

### F-3. Off-chain key custody

Hot keys (publisher relaySigner, advertiser relaySigner) live
off-chain. The protocol can't prevent compromise; it can only
invalidate their cosigs via cold-key rotation. Hot-key compromise
detection is off-chain.

### F-4. ZK trusted setup

The current setup is single-party (`scripts/setup-zk.mjs`). Mainnet
requires a multi-party computation (MPC) ceremony. The VK is
lock-once, so a compromised setup is hard to remediate (see G-13).

---

## Recommendations if tightening

In priority order:

1. **G-1 / Relay accountability.** Largest residual trust surface,
   most addressable. Real `DatumRelayStake` with bonding curve. Probably
   2–3 weeks of engineering + audit.
2. **G-9 / User-side compensation.** Smaller change in scope, large
   change in user-protection posture. Per-(publisher, campaign) damage
   pool with pro-rata user claims.
3. **G-3 / Publisher defense path.** Procedurally cleaner; defends
   against malicious fraud proposals targeting honest publishers.
4. **G-10 / Parameter retune transition.** Two-step pattern on
   economic parameters. Low effort; high user-protection value.
5. **G-2 / Single-honest-guardian recovery.** Trade-off territory —
   weakens 2-of-3 — but worth considering vs widening the guardian set.
6. **G-15 / Council membership friction.** Add Timelock co-gate on
   member additions.

None of these are required for the alpha-4 build to ship. All are
worth tracking against the mainnet roadmap. The fundamentals (F-1
through F-4) are architectural limits; mitigating them requires
different protocol designs, not patches to this one.

---

## What this analysis does NOT cover

- **Specific exploit chains** combining gaps. The gaps are listed
  individually; an attacker might combine G-1 (relay control) with
  G-4 (reporter cabal) to silently fabricate sybil farms. Multi-step
  exploit modeling is its own document.
- **MEV / front-running.** Mostly a Polkadot Hub / sequencer concern
  rather than a protocol-design concern. Worth its own analysis
  against the Polkadot Hub mempool model.
- **Cross-contract reentrancy.** Out of scope — audit-class concerns
  rather than role-design concerns. Settlement uses CEI + nonReentrant
  consistently.
- **Off-chain failure modes.** Relay-DB consistency, SDK key
  management, extension storage attacks. Real concerns; orthogonal
  to the role matrix.
