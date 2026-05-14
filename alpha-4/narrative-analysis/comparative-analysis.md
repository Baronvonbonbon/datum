# DATUM vs the Ad-Tech Landscape

How the protocol's design choices compare to incumbent digital advertising
systems (Google AdSense, Meta Ads, Amazon Ads, The Trade Desk) and to
crypto-native ad protocols (Basic Attention Token, AdEx, Adshares,
Permission.io). The goal is to locate DATUM in design space, not to argue
it's strictly better — every choice has trade-offs.

## Dimensions of comparison

Six axes capture the meaningful differences:

1. **Who gets paid, in what proportion.** Publisher / user / advertiser /
   protocol split.
2. **Where the money lives.** Direct-payment, escrow, off-chain ledger,
   chargeback-able.
3. **Identity and tracking.** Cookies, device fingerprints, on-chain
   pseudonyms, zero-knowledge proofs.
4. **Trust model.** Whose books are authoritative; what stops the
   intermediary from rugging.
5. **Fraud resistance.** Click-farms, sybils, viewability fraud,
   credential stuffing.
6. **Governance and credibility.** Who can change the rules; how fast;
   under what oversight.

---

## Traditional ad tech

### Google AdSense + AdX

**Model.** AdSense pays publishers a share of advertiser bids (officially
68% for content, 51% for search). The publisher's share is computed from
auctioned CPMs; users pay nothing and earn nothing.

**Books.** Closed. Google reports impression counts, click counts, and
revenue to publishers through Google Ad Manager. Publishers must trust
those numbers. Advertisers see their spend reports but cannot independently
verify what users actually saw.

**Identity.** Until 2023, third-party cookies + GAID/IDFA. Post-deprecation,
Privacy Sandbox proposes Topics API (interest cohorts), Protected Audience
(on-device retargeting), Attribution Reporting (privacy-preserving
conversion). User is identified by browser fingerprint + first-party
cookie, but the dataset is centralised at Google.

**Trust.** Total. Every party trusts Google's measurement, billing,
fraud filtering, and policy enforcement. Disputes are appealed through
support tickets; legal action is the only escalation. Google can
unilaterally suspend a publisher (loss of all earned revenue, no
recourse) or block an advertiser (loss of campaign + bid history).

**Fraud resistance.** Sophisticated server-side filtering. Google's
opaque "invalid traffic detection" rejects ~10–20% of impression
volume. Publishers occasionally get hit by false-positive bans;
Google's own scale ensures fraud detection is industry-leading but
opaque.

**Governance.** Internal Google policy. No external input. Changes
announced via blog post; enforcement is unilateral.

**Where DATUM differs.** Every dimension. DATUM's publisher take is
governance-set per-publisher (30–80% bounded), the user gets 75% of the
remainder, on-chain books are authoritative, fraud resistance is
cryptographic + economic (slash) rather than statistical, and policy
changes go through Timelock + Council/OpenGov.

---

### Google Ads (the demand side)

**Model.** Advertisers bid CPC, CPM, or CPA into Google's auction. Spend
is debited from a prepaid balance or charged to a credit card.

**Books.** Google reports clicks, conversions, ROAS. Cross-checking
requires advertiser-side analytics (their own pixel) and accepting that
the two systems will disagree.

**Fraud incidence.** Click fraud is a known and persistent issue —
estimated 10–30% of ad spend depending on category and bot
sophistication. Google refunds aggressively to maintain advertiser
trust, but the refund is from Google's own discretion, not from a
publisher slashing pool.

**Where DATUM differs.** Advertisers' budgets are held in
`DatumBudgetLedger` (escrow); each deduction is on-chain. Publisher
fraud is bonded against `DatumPublisherStake` and slashable via
`DatumPublisherGovernance` — the recovery is from the publisher's
own capital, not from the protocol's discretion. Refunds aren't
needed because the deduction itself didn't happen if the claim was
fraudulent.

---

### Meta Ads (Facebook / Instagram)

**Model.** Advertisers pay Meta directly; publishers don't exist as a
distinct role on Meta's owned-and-operated properties — Meta is both
the publisher and the platform. Users (Meta account holders) get
nothing.

**Identity.** Meta's logged-in graph is the most powerful targeting
system in commercial advertising. Cross-app identity via Apple's ATT
opt-in restrictions has weakened post-2021 but Meta still owns the
core graph.

**Trust model.** Meta is fully vertically integrated and fully closed.
Advertisers buy black-box performance; users have no economic stake.

**Where DATUM differs.** DATUM has no vertically-integrated publisher
side — the protocol explicitly decouples publishers (independent
operators) from the platform (DATUM contracts). Users earn from
attention, which is impossible in Meta's model.

The honest comparison: DATUM's design is fundamentally hostile to
Meta's. It treats user attention as a paid commodity rather than a
free input. Whether users prefer that framing is an empirical
question, not a design one.

---

### Amazon Ads / The Trade Desk / AppNexus

**Programmatic display.** DSPs (demand-side platforms) bid into SSPs
(supply-side platforms) via real-time auction (OpenRTB protocol).
Publishers get a share of clearing prices; users get nothing.

**Books.** Multiple parties measure the same impression and produce
different counts. The "discrepancy" between DSP-reported impressions
and SSP-reported impressions is a routine, unresolved part of the
business — typically 5–15%.

**Trust.** Each layer (DSP, SSP, ad server, publisher) takes a fee;
each layer holds books that are partially auditable to immediate
counterparties but not end-to-end. The IAB and TAG attempt
verification, but the system relies on trust between commercial
partners.

**Where DATUM differs.** A single on-chain ledger is authoritative
for every party. There is no discrepancy by construction — the
`ClaimSettled` event is what happened. Settlement is atomic with
deduction; there's no "impression served" vs "impression billed"
split.

DATUM has no DSP/SSP layer — the relay is a thin signing service, not
an auction participant. Whether this scales to programmatic complexity
(latency-sensitive real-time bidding, large auction inventories) is
unproven.

---

## Crypto-native ad tech

### Basic Attention Token (BAT) / Brave Browser

**Model.** Brave users opt in to see private ads served by Brave; users
earn BAT for viewing; publishers earn BAT when users tip or when
configured rev-share applies. Ad selection happens locally on-device —
Brave's servers never see what ads the user saw.

**Books.** Off-chain. Brave maintains a centralised ledger of BAT
balances; periodically pays out to publisher Uphold accounts. Public
verification is limited — users have to trust Brave's accounting.

**Identity.** Strong privacy: ad targeting happens on-device using
local browsing history. No server-side user profile. KYC required for
withdrawing BAT through Uphold.

**Trust.** Brave, the company, is the trusted intermediary. The BAT
token is on-chain (Ethereum), but the *accounting* of who-earned-what
is off-chain in Brave's system.

**Fraud resistance.** Server-side anomaly detection (similar to
Google's) plus device-fingerprinting. Brave has had public incidents
around sybil farming via emulated devices.

**Where DATUM compares.**

| Dimension | BAT | DATUM |
|---|---|---|
| User earns | Yes (BAT) | Yes (DOT + optional DATUM/ERC-20) |
| On-device privacy | Strong | Strong (extension-rendered, no server-side profile) |
| Accounting | Off-chain | On-chain |
| Verifiable fraud detection | No (server-side) | Yes (PoW, ZK, stake, slash) |
| Withdrawal gate | KYC (Uphold) | None (on-chain DOT) |
| Publisher onboarding | Self-serve, off-chain | On-chain registration with stake |
| Governance | Brave Software Inc. | Council → OpenGov |

DATUM's closest spiritual cousin. The key difference: BAT's accounting
sits in a private company's database; DATUM's sits in public state.
Users in BAT trust Brave Software; users in DATUM trust the protocol's
deployed contracts and reporter / guardian / council sets.

The trade-off: BAT's UX is smoother (no gas, no wallet management,
KYC-mediated fiat off-ramp). DATUM is harsher but verifiable.

---

### AdEx Network

**Model.** Hybrid on-chain / off-chain. Smart contracts hold campaign
escrow; off-chain "Validators" produce signed reports about impression
counts; advertisers and publishers can challenge.

**Identity.** Pseudonymous; no built-in user tracking.

**Trust.** N-of-M validators per channel. A campaign creates a payment
channel with two named validators; both must sign to release funds.
Disputes go to an on-chain arbitration contract.

**Fraud resistance.** Validator signatures + economic bonding. Lighter
than DATUM's cryptographic stack — no ZK, no PoW, no nullifiers.

**Where DATUM compares.** AdEx's design is more like a payment-channel
protocol than DATUM's full settlement-state-machine. AdEx scales
better on throughput (channels can settle off-chain frequently) but
trusts the channel's two validators per campaign. DATUM is on-chain
per-batch (no channels) and uses cryptographic gates rather than
trusted validators per campaign.

Both protocols are answering "how do we bond advertisers and
publishers to a shared ledger?" — AdEx with payment channels, DATUM
with global on-chain state.

---

### Adshares

**Model.** A decentralised peer-to-peer ad exchange. Publishers and
advertisers transact directly via the protocol. ADS token is used for
both payment and as a "skin in the game" mechanism (publishers post
small refundable deposits).

**Identity.** Pseudonymous addresses.

**Fraud resistance.** Statistical (off-chain). Adshares does its own
view-fraud detection on the supply side.

**Where DATUM compares.** Adshares is a closer competitor than BAT
— both are pseudonymous, both have on-chain payment, both target the
display-ads market. Differences:

- Adshares is its own L1; DATUM runs on Polkadot Hub.
- Adshares' fraud detection is centralised at the protocol layer;
  DATUM's is in the contract.
- Adshares doesn't have a user-earning loop (users in Adshares are
  just impression recipients, not paid participants).

---

### Permission.io (formerly Ask)

**Model.** Users grant explicit permission to be marketed to and are
paid in ASK for each interaction. Advertisers pay in fiat or ASK.

**Identity.** KYC'd users; opt-in basis.

**Trust.** Permission.io operates the matching engine and holds
custody of ASK pre-distribution.

**Where DATUM compares.** Permission.io's model is "consent-and-pay";
DATUM's is "attention-and-pay". Permission.io has KYC; DATUM doesn't.
Permission.io is a centralised company with a token; DATUM is a smart
contract suite with a token.

Both share the user-earning premise. The difference is fundamentally
custody: Permission.io custodies user data and the ASK; DATUM doesn't
custody anything (every payment is in user-controlled DOT/WDATUM).

---

### Other notables

- **Audius (music streaming):** Pays creators in AUDIO for streams.
  Closer cousin is Spotify than ad tech, but worth flagging — same
  user-earns-from-attention pattern, applied to the publisher side
  instead of the advertiser side.
- **Lens Protocol / Farcaster (social):** Decentralised social with
  tipping and revenue-share primitives. Not strictly ad protocols, but
  the upstream content layer that ad protocols like DATUM could
  monetise.
- **Mask Network:** Browser extension overlaying decentralised features
  on Web2 social. Could host a DATUM client side-by-side; not
  competing.
- **Tract Network / Quintessential / Klaytn-based ad chains:** Smaller
  experiments mostly stalled. Worth knowing exist; not in active
  competition.

---

## Summary matrix

| Property | AdSense | Meta | BAT | AdEx | DATUM |
|---|---|---|---|---|---|
| User earns | – | – | ✓ BAT | – | ✓ DOT + DATUM + ERC-20 |
| Publisher take | 68% | n/a | ~70% | configurable | 30–80% bounded |
| Books on-chain | – | – | – | partial | ✓ full |
| Pseudonymous | – | – | – | ✓ | ✓ |
| Cryptographic fraud gates | – | – | – | sigs only | PoW + ZK + stake + slash |
| User-controlled key | – | – | partial | ✓ | ✓ |
| KYC required | for publisher payout | – | for off-ramp (Uphold) | – | – |
| Settlement latency | T+90 days | T+30+ | weekly via Uphold | per-channel | per-batch on-chain |
| Disputes | support ticket | n/a | support ticket | on-chain arbitration | conviction-vote governance |
| Governance | unilateral | unilateral | unilateral | core team + DAO | Timelock → Council → OpenGov |
| Withdrawal block | account suspension | n/a | Uphold KYC | none | none |

---

## Where DATUM is genuinely novel

Five design choices distinguish DATUM from every system above:

1. **User as a paid first-class participant** in a system that doesn't
   require KYC. BAT requires KYC at the off-ramp. Permission.io requires
   KYC up-front. DATUM is pseudonymous end-to-end.

2. **AssuranceLevel as a per-campaign cryptographic policy.** No other
   ad system lets an advertiser declare "I want dual-sig batches" at the
   protocol level. Traditional systems have "trust me" measurement; DATUM
   has cryptographic enforcement.

3. **Path A ZK stake + interest commitment.** Privacy-preserving
   targeting that doesn't leak the user's interest set, only what they
   prove. No incumbent has this. (Brave's targeting is private but
   *all* on-device; DATUM's is *cryptographically* private — the
   campaign learns only the proven category.)

4. **Slashing as fraud remediation.** When fraud is upheld, the bad
   actor's stake is destroyed. Traditional systems issue refunds from
   the platform's discretion; DATUM destroys capital. The economics
   are different: a slashed publisher loses real money the moment a
   governance proposal resolves.

5. **Leaky-bucket PoW per impression.** No other ad system imposes
   computational work per impression. The intent: bots that amortise
   across many impressions face quadratic difficulty growth, making
   high-velocity fake-impression farming economically unviable.

---

## Where DATUM trades off

Honest about the costs:

1. **UX is worse.** Wallet management, gas, transaction signing.
   AdSense and BAT both have smoother user experiences. DATUM users
   need at least basic crypto literacy.

2. **Latency is higher.** Per-batch on-chain settlement adds
   per-impression overhead that channel-based or off-chain systems
   don't have. Programmatic auctions at AdX scale (millions of bids
   per second) wouldn't fit DATUM's current throughput.

3. **Throughput is bounded by L1.** Polkadot Hub block times,
   per-block circuit breakers, and per-batch claim caps limit how many
   impressions can settle per second. Mature ad tech moves orders of
   magnitude more impressions.

4. **Inventory matters less than measurement.** Google wins because
   they have audience and inventory; DATUM bets on advertisers
   preferring verifiable inventory over scale. Empirically untested.

5. **The protocol is young.** AdSense has 20 years of fraud-detection
   tuning. DATUM has 2026 audit reports. Many fraud vectors will
   emerge in production that haven't yet.

6. **Reporter centralization.** Path A's stake-root depends on a small
   reporter set. Brave at least has the honesty of saying "we run it";
   DATUM tries to N-of-M it but the reporters are still trusted
   parties. (Documented in the audit residual-trust section.)

7. **No global hidden inventory.** DATUM has no equivalent of "all of
   YouTube" or "all of Facebook" as a single inventory pool. Each
   publisher is its own site, which means audience reach scales by how
   many publishers join — slow growth compared to incumbent
   walled-garden inventory.

---

## Strategic positioning

DATUM is best understood as **"verifiable ad infrastructure for the
publisher long tail."** Three positioning points:

1. **Publishers who can't afford Google's revenue share** (or who
   resent it). 50% to publisher + 12.5% to protocol is a worse-than-
   AdSense split when you remove the user (37.5%), but if the user
   share grows reader loyalty, the publisher-side net may be better.

2. **Advertisers who want verifiable spend.** Brands that have been
   burned by click-fraud or by walled-garden measurement
   discrepancies. DATUM offers cryptographic proof — the spend went
   where it says.

3. **Users who prefer being paid to being surveilled.** A niche today;
   potentially mainstream if Privacy Sandbox / similar trends continue
   to fragment cross-site tracking and users start expecting compensation
   for attention.

The honest read: DATUM isn't a direct AdSense replacement. It's a
*different shape* of ad market — pseudonymous, verifiable, user-pay.
Whether the market that wants that shape is large enough to support
the protocol's economic flywheel (mint, fee-share, governance) is the
open question.

---

## What the comparison surfaces about DATUM's design

Reading the comparison back into the protocol:

- The four-tier AssuranceLevel ladder maps cleanly to "different
  advertiser trust requirements." L0 is BAT-like. L1 is AdEx-like. L2
  is more conservative than any incumbent. L3 (user-floor ZK) doesn't
  exist anywhere else.

- The user blocklist + self-pause + userMinAssurance reflects a
  consumer-sovereignty stance no incumbent has. AdSense users can't
  refuse to be tracked by specific publishers; DATUM users can refuse
  to settle for them.

- The lock-once / cypherpunk-terminal-state design is a hedge against
  the incumbent failure mode (Google's policy enforcement becoming
  arbitrary). DATUM bets that immutable rules + governance-tunable
  parameters is more credible than discretionary moderation.

- The bonding-curve stake on publishers and advertisers is a hedge
  against the persistent ad-tech failure mode (fraud). DATUM bets that
  cryptographic verification + capital slashing is better deterrence
  than statistical detection + commercial trust.

Each hedge has a cost. The protocol's central wager is that the costs
are worth the credibility.
