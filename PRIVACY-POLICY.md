# Datum Protocol — Privacy Policy & Data Use Policy

**Effective Date:** 2026-05-28
**Version:** 2.0 (alpha-5)
**Applies To:** Datum browser extension, Datum web app, Datum WordPress plugin, Datum publisher SDK, Datum publisher relay, Datum IPFS node, Pine RPC light client, and all on-chain protocol contracts (alpha-5, 59 production contracts).

---

## 1. Overview

Datum is a decentralized, privacy-first advertising protocol built on Polkadot Hub. Its core design principle is **local-first data handling**: sensitive personal information (browsing history, cryptographic secrets, wallet keys) never leaves your device unless you explicitly authorize a claim submission. Advertising interactions are proven cryptographically rather than tracked behaviorally.

This document describes:
- What data the protocol collects and where it is stored
- What data is transmitted off-device and to whom
- What data is permanently recorded on-chain
- What choices and self-sovereignty controls you have over your data
- Known privacy trade-offs inherent to the protocol design

**This policy covers the protocol's reference implementation.** Operators who deploy or fork this protocol (relay operators, publishers, advertisers, reporters, council members, guardians) may have their own privacy practices and should publish supplementary disclosures.

---

## 2. Definitions

| Term | Meaning |
|------|---------|
| **User** | A person who installs the Datum browser extension to earn from ad impressions |
| **Publisher** | A website operator who integrates the Datum SDK (or WordPress plugin) to display ads |
| **Advertiser** | An entity that creates and funds ad campaigns on the protocol |
| **Relay** | A server-side component that batches signed user claims and submits them on-chain. Three modes coexist (publisher-direct, dual-sig, bonded DatumRelay) |
| **Reporter** | An off-chain operator that submits Merkle roots, identity attestations, or stake-root commitments on-chain under bonded accountability |
| **Council** | An N-of-M trusted-member governance body active during Phase 1 (curated launch) |
| **Guardian** | One of three EOAs authorized to fast-pause categories of the protocol in emergencies |
| **On-chain** | Data permanently recorded on the Polkadot Hub blockchain (and, for some identity-bridge data, People Chain) |
| **Local storage** | Browser-local persistent storage (`chrome.storage.local`) on the user's own device |
| **Claim** | A cryptographically signed record of one or more ad impressions |
| **Click** | A cryptographically signed record of an ad click, tracked separately from impressions |
| **Nullifier** | A one-way hash that proves a claim has not been replayed, without revealing the user's identity |
| **User secret** | A 32-byte random value generated once per user, used exclusively for ZK nullifier derivation |
| **Interest profile** | A locally computed map of content-topic weights derived from browsing, never transmitted in raw form |
| **Interest commitment** | An on-chain Merkle commitment over interest-category leaves; the leaves themselves remain off-chain |
| **AssuranceLevel** | A per-campaign trust gradient (L0 open / L1 relay-mediated / L2 dual-sig / L3 ZK-only). Users may set a per-account floor |

---

## 3. Data Collected by the Browser Extension

### 3.1 Page Content (Classified Locally, Never Transmitted)

When the extension is active, the content script reads the following from each page you visit:

- Page URL and domain name
- Page title
- HTML `<meta>` description and keywords
- Browser language setting (`navigator.language`)
- User-agent device type (mobile / desktop / tablet)
- Detected ad-slot format(s) on the page (e.g. `format:leaderboard`)

This information is used **only on your device** to classify the page into content topics (e.g., `topic:crypto-web3`, `locale:en-US`, `platform:desktop`, `format:medium-rectangle`). The raw URL, title, and meta content are not stored beyond the immediate classification step. Only the resulting **tag strings** are retained, in local storage, for the interest profile (see §3.2).

**This data is never transmitted to any server, relay, or blockchain.**

### 3.2 Interest Profile (Local Only, User-Controlled)

The extension builds a locally computed interest profile:

- **What is stored:** A list of content-topic tags with timestamps, and derived per-topic weights (values 0.0–1.0 based on visit frequency with a 7-day exponential decay half-life).
- **Storage location:** `chrome.storage.local` on your own device, under key `interestProfile`.
- **Retention:** Rolling 30-day window; visits older than 30 days are pruned automatically.
- **Purpose:** Used exclusively to weight the local campaign auction — campaigns whose topic tags match your interests receive a higher probability of selection.
- **What it is NOT used for:** Profiling for third parties, sale of data, behavioral targeting by any external party.
- **Your control:** You can clear your interest profile at any time from the Settings tab in the extension popup. Uninstalling the extension deletes all local storage.

**The raw interest profile is never transmitted off your device.** A separate, optional Merkle-commitment-of-interest mechanism (§3.9) lets you publish only a *hash* of your category set on-chain if you choose to participate in ZK-targeted campaigns.

### 3.3 Cryptographic User Secret (Local Only, Sensitive)

Once, on first use of ZK-enabled campaigns, the extension generates a 32-byte random value called the **user secret**:

- **Stored:** In `chrome.storage.local` under key `zkUserSecret`, as a hex string.
- **Purpose:** Used as a private input to the impression ZK circuit (`nullifier = Poseidon(userSecret, campaignId, windowId)`) to generate replay-preventing nullifiers without revealing your identity. A second, independent secret is used by the identity ZK circuit (§3.10).
- **Never transmitted:** This value is never sent to any server, relay, or blockchain.
- **Security risk:** This value is currently stored in plaintext within Chrome's local storage. If an attacker gains physical or software access to your browser profile, they could extract this value and compute your future nullifiers. **Protect your device accordingly.**
- **Loss:** If you clear browser data or reinstall the extension, a new secret is generated and your ZK claim history becomes disconnected from the old one. There is no recovery mechanism for the secret itself (see §3.11 for fund recovery).

### 3.4 Wallet Keys and Addresses (Local, Encrypted)

If you import or generate a wallet within the extension:

- **Private key:** Encrypted using AES-256-GCM with a key derived from your password (PBKDF2). The ciphertext is stored in `chrome.storage.local`. The plaintext key is never written to disk.
- **Auto-submit mode:** If you enable auto-submit, the extension encrypts your private key with a randomly generated session password held only in memory. On browser restart, the session password is lost and auto-submit is deauthorized — you must re-enable it with your password. This ensures the auto-submit key cannot be silently extracted from disk.
- **Wallet address:** Stored in plaintext in `chrome.storage.local` as `connectedAddress`. This is your public identifier used in claim construction and settlement.
- **Multi-account:** The extension supports multiple encrypted wallets under a single password.

**Private keys are never transmitted off your device.**

### 3.5 Impression Claims and Claim Queue (Local, Transmitted on Submit)

When an ad impression occurs, the extension constructs a **claim struct** and holds it locally in the claim queue:

```
{
  campaignId          (on-chain identifier)
  publisher address   (on-chain identifier)
  your wallet address (your on-chain identifier)
  impression count    (number of impressions)
  clearing CPM        (Vickrey-auction-determined price)
  nonce               (per-campaign counter)
  previousClaimHash   (chain integrity)
  claimHash           (Blake2-256 hash of the above)
  PoW solution        (per-impression proof-of-work nonce; alpha-5)
  ZK proof            (Groth16 proof; only for ZK or L3 campaigns)
  nullifier           (Poseidon hash; does not contain your secret)
  expectedRelaySigner (advisory binding; dual-sig path only)
}
```

**Storage:** In `chrome.storage.local` under key `claimQueue`.
**Retention:** Until submitted on-chain, at which point settled claims are removed.
**Transmitted:** Yes — when you click "Submit Now" or auto-submit fires, this data is sent to the relay (see §4).

You can view the full contents of your claim queue in the extension popup at any time.

### 3.6 Click Records (Local, Transmitted via Publisher SDK)

When you click an ad rendered through the Datum SDK, the SDK dispatches a click report to the publisher's configured relay endpoint (`POST ${relay}/click`):

```
{
  publisher:  <publisher address>,
  campaignId: <campaign identifier>,
  slotId:     <slot identifier on the page>,
  href:       <destination URL>,
  ts:         <unix timestamp>,
  v:          <sdk version>
}
```

**Important:** This payload **does not include your wallet address.** The relay later batches click reports and submits them to `DatumClickRegistry` on-chain. Click attribution is per (publisher, campaignId) — it does not link clicks to individual users.

If you do not want clicks reported, disable clicks in the extension Settings tab or use the Filters tab to silence specific campaigns. Clicks are never reported if no relay URL is configured on the publisher's SDK script tag.

### 3.7 Per-Campaign Chain State (Local)

To preserve claim integrity, the extension stores per-campaign state:

- **Key:** `chainState:{walletAddress}:{campaignId}`
- **Contents:** Last nonce used, last claim hash, PoW difficulty state
- **Purpose:** Ensures each new claim correctly links to the previous one (hash chain prevents insertion or deletion of individual claims)
- **Retention:** Until the campaign reaches a terminal state (completed, terminated, expired, demoted) at which point it is cleaned up

**This data is never transmitted off your device.**

### 3.8 Campaign Metadata Cache (Local)

The extension caches on-chain campaign data locally to reduce blockchain queries:

- **Contents:** Campaign IDs, publisher addresses, budgets, CPM bids, tag requirements, metadata IPFS hashes, Bulletin Chain creative references, AssuranceLevel, dual-sig flag, ZK-required flag, side-reward token configuration
- **TTL:** 5-minute cache for active campaigns; 1-hour TTL for metadata; per-format creative images cached for the campaign lifetime
- **Source:** Read from on-chain contracts; no user-generated content

### 3.9 Interest Commitments (Optional, On-Chain Hash Only)

If you opt in to interest-targeted ZK campaigns, the extension may publish an **interest commitment** to the `DatumInterestCommitments` contract:

- **On-chain:** A 32-byte Merkle root over your interest-category leaves. The categories themselves are not revealed.
- **Local only:** The leaf list (the categories you actually fall into) and the leaf preimages stay in `chrome.storage.local`.
- **Purpose:** Lets advertisers run ZK-targeted campaigns where you can prove "I fall in this category" without revealing which other categories you fall into.
- **Opt-in:** This commitment is only created if you explicitly enable interest-targeted campaigns. It is a separate decision from claim submission.

### 3.10 ZK Identity Commitment (Optional, On-Chain Hash Only)

If you opt in to identity-gated campaigns (campaigns that require proof of unique personhood beyond Sybil-resistance):

- **Locally:** A second 32-byte identity secret is generated and stored under `zkIdentitySecret`, separate from the impression secret in §3.3.
- **On-chain:** A Poseidon hash commitment (single public input) is published to `DatumIdentityVerifier`. The pre-image is never revealed.
- **Purpose:** Allows campaigns at higher AssuranceLevel to verify you're a unique participant without learning your identity.
- **Trusted setup:** The identity circuit currently uses a single-party trusted setup (testnet only). Mainnet deployment requires a multi-party computation (MPC) ceremony.

### 3.11 Recovery Address (Optional, On-Chain Pointer)

If you set a recovery address on `DatumPaymentVault` (`setRecoveryAddress(addr)`):

- **On-chain:** Your wallet address is bound to your chosen cold-wallet recovery address. The mapping is publicly readable.
- **Purpose:** Lets you (or anyone) call `emergencyWithdraw(yourAccount)` after a time delay (~24h default; bounded `[6h, 30d]`); ALL vault balances are sent to the registered recovery address.
- **Anti-attack:** Overwriting `setRecoveryAddress` resets the delay timer, giving the legitimate user time to call `cancelRecoveryAddress` if a hot key is compromised.
- **One-shot:** Recovery state clears after use; you may set a new recovery address afterward.

### 3.12 User Self-Sovereignty State (Local + On-Chain)

The extension exposes per-account controls that map to on-chain `DatumSettlement` mappings:

- `userPaused` — pauses all settlement involving your address
- `userBlocksPublisher[addr]` / `userBlocksAdvertiser[addr]` — rejects claims involving named counterparties
- `userMinAssurance` — your per-account AssuranceLevel floor (L0–L3); claims below this level are auto-rejected

These values are publicly readable on-chain. They override any local preference and apply globally to your address.

### 3.13 Impression Deduplication (Local)

To prevent duplicate impression recording:

- **Key:** `impression:{campaignId}:{domain}`
- **Contents:** Timestamp of last impression for this campaign on this domain
- **Retention:** Persistent (cleared on extension reinstall)

---

## 4. Data Transmitted to the Relay

There are **three relay paths** in alpha-5; which one is used depends on the publisher's SDK configuration (`data-relay-mode` attribute):

| Mode | Mechanism | Who runs it |
|------|-----------|-------------|
| `publisher` | Publisher hosts their own relay or uses their `relaySigner` hot key direct to `DatumSettlement` | The publisher |
| `dualsig` | Permissionless: publisher + advertiser EIP-712 cosigs submitted to `DatumDualSigSettlement` | Either party, or a delegated dispatcher |
| `datumrelay` | Bonded third-party relay via `DatumRelay.settleClaimsFor`; relay must satisfy stake or allowlist | Independent relay operators with on-chain stake |

In all three paths the data shape submitted by the extension is the same; only the on-chain entry point and authorization model differ.

### 4.1 What Is Sent

```
POST <relay-endpoint>
{
  batches: [
    {
      user:          <your wallet address — plaintext>,
      campaignId:    <campaign identifier>,
      claims: [
        {
          campaignId, publisher, impressionCount,
          clearingCpmPlanck, nonce,
          previousClaimHash, claimHash,
          powSolution, zkProof (if applicable), nullifier
        }
      ],
      deadline:                       <block number>,
      expectedRelaySigner:            <advisory; dual-sig only>,
      expectedAdvertiserRelaySigner:  <advisory; dual-sig only>,
      userSig:        <your EIP-712 signature over the batch>,
      publisherSig:   <optional / dual-sig only>,
      advertiserSig:  <dual-sig only>
    }
  ],
  powChallenge: <challenge ID>,
  powNonce:     <proof-of-work solution>
}
```

**This is the first point at which your wallet address leaves your device.**

### 4.2 What the Relay Does With This Data

1. **Validates** your EIP-712 signature(s) on the `ClaimBatch(user, campaignId, claimsHash, deadline, expectedRelaySigner, expectedAdvertiserRelaySigner)` envelope
2. **Verifies** the proof-of-work solution (`DatumPowEngine` anti-spam)
3. **Contacts the publisher's attestation endpoint** (see §5.2) — sends your wallet address, campaign ID, nonce range, and claim count to the publisher
4. **Submits the batch on-chain** via the appropriate Settlement entry point
5. **Removes** your data from its queue upon successful on-chain confirmation

### 4.3 Relay Data Retention

- **In-transit queue:** The relay persists pending batches to a local file (`pending-queue.json`) to survive restarts. This file contains your wallet address and claim details. **Relay operators must secure this file with appropriate OS-level permissions.**
- **Error logs:** The relay keeps the last 50 error records in memory. These may contain wallet addresses associated with failed submissions.
- **Statistics:** Aggregate counters only (total claims, total payments). No per-user logs.
- **Epoch records:** After settlement, the relay may publish an epoch record containing settled claim hashes (not user addresses). See §4.4.
- **Click queue:** Click reports (§3.6) are batched in a separate queue without user addresses.

### 4.4 Epoch Logs (Claim Hash Merkle Tree)

After each settlement round, the relay optionally publishes:

- **Epoch ID**, settlement timestamp, block number, transaction hash
- **Merkle root** of settled claim hashes
- **List of settled claim hashes** (32-byte values only)

These are accessible via `/relay/epoch/:id`. Claim hashes do not contain or reveal your wallet address, user secret, or browsing activity. However, an observer who independently monitors on-chain `ClaimSettled` events (which do contain your address — see §6) could theoretically correlate epoch hashes with on-chain events.

### 4.5 Rate Limiting

The relay implements IP-based rate limiting (5 requests per minute for submissions). IP addresses are held in ephemeral memory-only buckets that expire every 5 minutes and are **not logged or persisted**.

### 4.6 Relay Accountability

In `datumrelay` mode the relay operator is required to either:

1. Hold a flat-minimum bond in `DatumRelayStake` (publicly readable on-chain stake balance); **or**
2. Appear on a Council-curated `authorizedRelayers` allowlist.

Bonded relays are slashable via conviction vote (`DatumRelayGovernance`) on four reason codes: censorship, front-running, MEV extraction, collusion. The relay operator's stake address and slash history are publicly readable on-chain.

---

## 5. Data Seen by Publishers

### 5.1 Publisher SDK (Minimal, No User Data)

The publisher SDK (`datum-sdk.js`) is a lightweight script embedded on publisher websites. It:

- Reads publisher configuration from its own `<script>` tag attributes (publisher address, relay URL, tags, excluded tags, relay mode)
- Listens for challenge events from the Datum extension content script
- Responds with an HMAC signature (using the publisher's own key, not user data)
- Optionally fetches Bulletin Chain creative material from `${relay}/bulletin/<cid>` for the rendering slot
- Optionally forwards click events to `${relay}/click` (see §3.6)
- Exposes read-only counters on `window.DATUM.metrics` for publisher-side observability
- **Receives no user wallet address, interest profile, or claim details**
- **Sets no cookies, no localStorage, no fingerprint signals**
- **Sends no telemetry to any third-party domain**

### 5.2 Publisher Attestation Endpoint

When a user submits a claim batch through a publisher's relay, the relay contacts the publisher's **attestation endpoint** (`/.well-known/datum-attest`) with:

```json
{
  "campaignId": <campaign ID>,
  "user":       "<your wallet address>",
  "firstNonce": <first nonce in batch>,
  "lastNonce":  <last nonce in batch>,
  "claimCount": <number of claims>
}
```

**The publisher therefore learns:**
- That a specific wallet address earned impressions from their campaign
- The nonce range and count of impressions

**The publisher does NOT learn:**
- Your browsing history or interest profile (raw or commitment pre-image)
- The content of individual pages you visited
- Your ZK user secret, identity secret, or nullifier pre-image
- Your private key
- Your recovery address

**Privacy implication:** Publishers can correlate wallet addresses with their campaign activity. This is an inherent trade-off of the attestation model. In the `dualsig` path the advertiser also learns your address (and signs to acknowledge it). If you are concerned about a particular publisher or advertiser learning your wallet address, you may decline by setting `userBlocksPublisher` / `userBlocksAdvertiser` (§3.12) or by simply not engaging.

### 5.3 WordPress Plugin (Equivalent to SDK)

The `datum-publisher` WordPress plugin is a thin wrapper around the SDK — it embeds the same `datum-sdk.js`, exposes the same shortcode/block/widget placement, and inherits all the SDK's privacy properties (zero cookies, zero third-party tracking, no PII collection). The plugin stores only publisher configuration (publisher address, tags, slot formats) in WordPress's standard options table.

---

## 6. Data Permanently Recorded On-Chain

The following data is **permanently and immutably recorded on the public Polkadot Hub blockchain** (and where noted, People Chain). Anyone with access to a blockchain explorer can read this data.

### 6.1 Settlement Events

Every successfully settled claim batch emits a `ClaimSettled` event:

```
ClaimSettled(
  campaignId:       <campaign identifier>       — PUBLIC
  user:             <your wallet address>        — PUBLIC
  nonce:            <claim nonce>                — PUBLIC
  publisherPayment: <amount in planck>           — PUBLIC
  userPayment:      <amount in planck>           — PUBLIC
  protocolFee:      <amount in planck>           — PUBLIC
  assuranceLevel:   <L0/L1/L2/L3>                — PUBLIC
)
```

**What this reveals:**
- Which campaigns your wallet address has earned from
- How much you earned per settlement (and thus per impression)
- Approximate timing (block number) of your impressions
- Nonce patterns that show how often you submit
- The AssuranceLevel at which the claim was settled

This information is unavoidably public because blockchain payments require a public recipient address. There is no technical mechanism to hide the recipient of a payment on a transparent public chain.

### 6.2 Click Registry

`DatumClickRegistry.recordClick` events publicly record:

```
campaignId:    <campaign identifier>   — PUBLIC
publisher:     <publisher address>     — PUBLIC
clickCount:    <aggregate per window>  — PUBLIC
windowId:      <time window>           — PUBLIC
```

**Click events do not record user addresses.** Click attribution is per (publisher, campaignId, window).

### 6.3 Nullifier Registry

For ZK-enabled campaigns, a `submitNullifier` call records:

```
campaignId: <campaign identifier>   — PUBLIC
nullifier:  <32-byte hash>          — PUBLIC (not reversible)
```

The nullifier is a one-way cryptographic hash. Without your user secret, it cannot be linked to your identity or used to reconstruct your activity. It proves only that *someone* submitted an impression for *this campaign* in *this time window*.

### 6.4 Interest Commitments (If Used)

If you opt into interest-targeted ZK campaigns (§3.9):

```
user:          <your wallet address>   — PUBLIC
interestRoot:  <32-byte Merkle root>   — PUBLIC (categories not revealed)
```

The categories you fall into are not revealed; only proofs of category membership are checked at claim time.

### 6.5 ZK Identity Commitment (If Used)

If you opt into identity-gated campaigns (§3.10):

```
user:                 <your wallet address>   — PUBLIC
identityCommitment:   <32-byte Poseidon hash> — PUBLIC (pre-image hidden)
```

### 6.6 People Chain Identity Bridge (If Used)

If you opt into the People Chain identity bridge for higher-assurance campaigns:

- **On Polkadot Hub:** `DatumPeopleChainIdentity` records the verification status of your account (verified / pending / rejected) and an XCM request ID. The People Chain `pallet-identity` judgment level may be reflected.
- **On People Chain:** The standard `pallet-identity` data you submit (display name, optional fields such as email, twitter, etc.) is stored on People Chain itself. This is **separate from Datum** and governed by Polkadot's identity-pallet posture, not by this policy.
- **Reporter mode (current Paseo testnet posture):** The bridge currently operates in oracle mode — a designated reporter EOA forwards People Chain judgments to the Datum bridge contract. The reporter sees the same data anyone reading People Chain sees.

If you do not interact with the People Chain bridge, none of this data is created.

### 6.7 Campaign Registry

Advertisers' campaigns are stored on-chain and publicly readable:

```
advertiser address       — PUBLIC
publisher allowlist      — PUBLIC (multi-publisher campaigns)
campaign budget          — PUBLIC
daily spend cap          — PUBLIC
CPM bid                  — PUBLIC
campaign status          — PUBLIC
required tag hashes      — PUBLIC
AssuranceLevel           — PUBLIC
metadata IPFS hash       — PUBLIC (links to full creative, images, text, landing page)
Bulletin Chain reference — PUBLIC (alternative creative storage)
ERC-20 side-reward       — PUBLIC (token + per-impression amount)
challenge bond           — PUBLIC
activation bond          — PUBLIC
```

**What this means for advertisers:** All campaign parameters, budgets, creative content (via IPFS or Bulletin Chain), and side-reward configuration are permanently and publicly readable. Competitors can observe your bidding strategy and creative materials. This is by design — the protocol prioritizes transparency over advertiser confidentiality.

### 6.8 Publisher Registry

Publisher registrations are stored on-chain:

```
publisher address     — PUBLIC
take rate (bps)       — PUBLIC
blocked status        — PUBLIC
allowlist enabled     — PUBLIC
reputation score      — PUBLIC
stake amount          — PUBLIC
profile hash          — PUBLIC (links to IPFS profile metadata)
tags                  — PUBLIC (publisher's declared tag set)
relaySigner address   — PUBLIC (publisher's relay hot key)
```

**Note on blocklist:** If a publisher address is blocked (via `DatumCouncilBlocklistCurator`), that fact is publicly readable on-chain. A bonded appeal mechanism (`fileBlocklistAppeal`) is available to contest blocks.

### 6.9 Advertiser Stake and Stake Roots

```
advertiser stake balance — PUBLIC (DatumAdvertiserStake)
publisher stake balance  — PUBLIC (DatumPublisherStake)
relay stake balance      — PUBLIC (DatumRelayStake)
ZK stake balance         — PUBLIC (DatumZKStake; per-user lockup)
stake-root Merkle roots  — PUBLIC (DatumStakeRoot / DatumStakeRootV2)
```

### 6.10 Governance Records

Governance votes and proposals are stored on-chain:

```
proposal ID, target                         — PUBLIC
voter address                               — PUBLIC
vote direction (aye/nay)                    — PUBLIC
conviction weight and lock duration         — PUBLIC
commit-reveal commitment (optimistic votes) — PUBLIC
council member roster                       — PUBLIC
```

Conviction-vote PAS lockups (1d / 3d / 7d / 21d / 90d / 180d / 270d / 365d) tie your wallet address to a lockup balance and timeline.

### 6.11 Community Reports

If you use the extension to report a page or ad:

```
reporter address   — PUBLIC (if stored on-chain)
campaign ID        — PUBLIC
report reason      — PUBLIC (one of 5 codes)
```

### 6.12 Recovery Address Mapping (If Used)

If you set a recovery address (§3.11):

```
account            — PUBLIC
recoveryAddress    — PUBLIC
unlockBlock        — PUBLIC
```

### 6.13 User Self-Sovereignty Mappings

If you set any of the user self-sovereignty controls (§3.12):

```
userPaused[account]                            — PUBLIC
userBlocksPublisher[account][publisherAddr]    — PUBLIC
userBlocksAdvertiser[account][advertiserAddr]  — PUBLIC
userMinAssurance[account]                      — PUBLIC
```

Setting these values is itself a public action that requires an on-chain transaction from your wallet.

---

## 7. DATUM Token Plane Data

The protocol mints a sidecar ERC-20 token (`DATUM`) on the EVM side, with a WDATUM wrapper (`DatumWrapper`) bridging to canonical Asset Hub DATUM. The token plane has its own public-data surface:

### 7.1 Mint Events

```
DatumMintAuthority.Mint(to, amount, reason)   — PUBLIC
```

Per-claim emissions, bootstrap grants, and vesting releases are all minted via `DatumMintAuthority` and emit public events tied to recipient addresses.

### 7.2 Bootstrap Grants

`DatumBootstrapPool` issues a one-time WDATUM grant to new users on first claim. The grant event records:

```
recipient address     — PUBLIC
grant amount          — PUBLIC
campaignId (trigger)  — PUBLIC
```

### 7.3 Fee-Share Staking

If you stake WDATUM in `DatumFeeShare` to earn DOT fee share:

```
staker address    — PUBLIC
stake amount      — PUBLIC
accDotPerShare    — PUBLIC (per-stake accumulator)
withdrawal events — PUBLIC
```

### 7.4 Vesting

If you are a beneficiary of `DatumVesting`:

```
beneficiary       — PUBLIC
total amount      — PUBLIC
cliff timestamp   — PUBLIC
release schedule  — PUBLIC
```

---

## 8. Data NOT Collected

The following data is **never collected** by the Datum protocol:

- **Full browsing history** — The extension classifies pages into topic tags but does not log a history of URLs visited
- **Search queries** — Not captured at any layer
- **Engagement duration** — Not tracked (only impression count and click events)
- **Personal identity information** — No names, email addresses, phone numbers, or government IDs (unless you voluntarily submit identity data to People Chain `pallet-identity`, which is outside Datum's scope)
- **Location data** — Not collected (locale tag is derived from browser language setting only)
- **Device fingerprint** — Not constructed or transmitted
- **Telemetry or analytics from production builds** — The protocol does not include any analytics SDK or crash reporting. `window.DATUM.metrics` exposes counters to the publisher's own page console but does not phone home.
- **Third-party tracking** — No pixels, beacons, or third-party scripts in the extension, SDK, or WordPress plugin
- **Cookies** — None set by the SDK, extension, or plugin in any browser context

---

## 9. Data Storage Summary

| Data Item | Storage Location | Transmitted To | On-Chain | User Control |
|-----------|-----------------|----------------|----------|--------------|
| Interest profile (topic weights) | Local only | Nobody | No | Clear in Settings |
| Interest commitment Merkle leaves | Local only | Nobody | No (only root) | Opt-in |
| Page URLs / titles visited | Local (transient) | Nobody | No | Auto-cleared |
| Impression user secret (ZK) | Local (plaintext) | Nobody | No | Clear browser data |
| Identity user secret (ZK) | Local (plaintext) | Nobody | No | Clear browser data |
| Private key | Local (encrypted) | Nobody | No | Delete account |
| Wallet address | Local + Relay | Relay, Publisher, (Advertiser in dual-sig) | Yes (events) | None (public); but settable blocklist |
| Claim queue | Local | Relay (on submit) | Via relay | View/clear in popup |
| Claim hashes | Local + Relay | Relay → Chain | Yes | None (public hashes) |
| Click reports | Local (briefly) | Publisher relay | Yes (no user addr) | Disable in Settings |
| Nullifiers | Local + Relay | Relay → Chain | Yes | None (public hashes) |
| Interest commitment root | N/A | N/A | Yes (opt-in) | Clear by replacement |
| Identity commitment | N/A | N/A | Yes (opt-in) | Single-shot |
| Recovery address | N/A | N/A | Yes (opt-in) | Cancel before delay |
| User self-sovereignty mappings | N/A | N/A | Yes | Set/clear via wallet |
| Nonces | Local + Relay | Relay → Chain | Yes | None (public) |
| Earnings amounts | N/A | N/A | Yes (events) | None (public) |
| Token mint / staking events | N/A | N/A | Yes | None (public) |
| Campaign metadata | Local (cache) | Nobody | Via advertiser | None (public) |
| Publisher profile hash | N/A | N/A | Yes | Publisher's control |
| Governance votes | N/A | N/A | Yes | None (public) |

---

## 10. Your Rights and Choices

### 10.1 Access

You can view your locally stored data at any time:
- **Claim queue:** visible in the extension popup
- **Interest profile:** viewable in the Settings tab
- **Chain state, cached data, secrets:** accessible via the extension popup's developer view

On-chain data (settlement events, governance records, identity commitments) is publicly readable by anyone via the Polkadot Hub blockchain explorer.

### 10.2 Correction and Deletion

**Local data:** You may clear your interest profile, claim queue, or all local data from the Settings tab, or by uninstalling the extension.

**On-chain data:** Settlement events, nullifier records, governance votes, campaign registrations, token mint events, identity commitments, and similar records are **permanent and cannot be deleted**. This is a fundamental property of public blockchains. There is no "right to erasure" for data recorded on-chain.

You may *augment* your on-chain state — e.g., publishing a new interest commitment overwrites the previous one in the contract's "current" slot, but the historical commitment remains in the chain's event log.

### 10.3 Data Portability

The extension supports encrypted export of your claim queue and chain state. The export file is encrypted using a key derived from your wallet signature and can be imported into another device or browser profile.

### 10.4 Opt-Out and Self-Sovereignty Controls

- **Passive impression recording:** You may pause or disable the extension at any time.
- **`userPaused` (on-chain):** Pauses all settlement involving your address protocol-wide.
- **`userBlocksPublisher` / `userBlocksAdvertiser` (on-chain):** Refuses settlement with specific counterparties.
- **`userMinAssurance` (on-chain):** Refuses claims below your declared trust floor (L0–L3).
- **ZK campaigns:** If you do not wish to participate in campaigns that require a ZK proof, those campaigns will be excluded automatically if ZK proof generation fails or is disabled.
- **Identity-gated campaigns:** Opt-out by simply not creating an identity commitment.
- **Interest-targeted campaigns:** Opt-out by not creating an interest commitment.
- **Click reporting:** Disable in the extension Settings.
- **Auto-submit:** Disabled by default; you opt in and can revoke at any time.
- **Campaign filters:** The extension provides a Filters tab where you can restrict which topics or specific campaigns you participate in.
- **Recovery address:** Set via the extension Settings; cancellation is available at any time before the delay expires.

### 10.5 Blocklist Appeals

If your address is added to the `DatumCouncilBlocklistCurator` blocklist (e.g., flagged for fraud), you may file a bonded appeal: post the configured `appealBond` and submit evidence. Council reviews and resolves on-chain. If upheld, the appeal bond is refunded and your address is unblocked. If dismissed, the bond is forfeit to the protocol treasury.

---

## 11. Security Practices

### 11.1 Cryptographic Protections

- **Wallet private keys** are encrypted at rest using AES-256-GCM with PBKDF2 key derivation.
- **Auto-submit keys** use an ephemeral session password held only in memory (cleared on browser restart).
- **Claim exports** are encrypted with AES-256-GCM using a key derived from your wallet signature.
- **ZK proofs** (Groth16 / BN254) mathematically prove impression and identity validity without revealing private witnesses.
- **Poseidon nullifiers** prevent claim replay without linkability across campaigns.

### 11.2 Known Risks

**User secrets stored in plaintext:** Both the impression ZK secret and identity ZK secret are currently stored as plaintext hex strings in `chrome.storage.local`. While this data is inaccessible to other browser tabs and normal web pages, it could be exposed if:
- An attacker gains local file system access to your browser profile directory
- A malicious browser extension with `storage` permission accesses it
- Your device is compromised by malware

Mitigation: Keep your device secure, use OS-level full-disk encryption, and be cautious about which other extensions you install.

**On-chain address linkability:** Your wallet address appears in all `ClaimSettled` events. If your wallet address is publicly linked to your real identity (e.g., you have publicly doxxed it, or you have submitted People Chain `pallet-identity` data), your advertising activity becomes linkable to you. Consider using a dedicated wallet address for Datum participation.

**Publisher attestation reveals address:** The publisher of a campaign learns your wallet address when you submit a claim. The advertiser additionally learns it in the dual-sig path. See §5.2.

**Relay queue persistence:** The relay holds pending batches in a local file. A breach of the relay server could expose wallet addresses and claim details for batches that have not yet been submitted on-chain. Relay operators must secure their infrastructure accordingly.

**Single-party ZK trusted setups:** The impression circuit (`DatumZKVerifier`) and identity circuit (`DatumIdentityVerifier`) currently use single-party trusted setup ceremonies. This is acceptable for testnet but **mainnet requires multi-party computation (MPC) ceremonies** before deployment. Soundness of the proofs depends on the ceremony's integrity.

**Censorship by relays:** Even bonded relays can selectively refuse submissions. The `DatumRelayGovernance` censorship reason code provides post-hoc accountability but not real-time prevention. If censored, you may submit via a different relay or self-submit on-chain.

---

## 12. Children's Privacy

The Datum protocol does not knowingly collect data from or target advertising to individuals under 13 years of age (or the applicable minimum age in your jurisdiction). The protocol has no mechanism to verify user age. Publishers integrating the Datum SDK are responsible for ensuring compliance with applicable children's privacy laws on their own platforms.

---

## 13. International Data Transfers

The relay server may be operated in any jurisdiction. Blockchain data is globally distributed. By using the Datum protocol, your wallet address and settlement records may be accessible to individuals and entities worldwide. The Polkadot Hub and People Chain operate across a globally distributed validator network with no single legal jurisdiction of control.

---

## 14. Third Parties

### 14.1 Blockchain Network

On-chain data is processed by the Polkadot Hub validator network. Identity data, where used, is processed by the People Chain validator network. Datum does not control either network and is not responsible for the privacy practices of node operators.

### 14.2 IPFS (Metadata + Creative Storage)

Campaign and publisher metadata hashes are resolved via IPFS (InterPlanetary File System). If the extension or web app fetches metadata from an IPFS gateway, the gateway operator may log your IP address and the requested content identifier (CID). The Datum web app supports configurable IPFS gateways.

The Datum project operates an optional self-hosted IPFS node (`ipfs-node/`) and authenticated upload proxy fronted by Cloudflare Tunnel at `ipfs.datum.javcon.io`. The proxy logs upload requests in standard server access logs (timestamp, IP, request line); read requests are served by the IPFS gateway under the same Cloudflare tunnel. Cloudflare's standard logging applies to all traffic through this tunnel. Operators of forked deployments may use any IPFS gateway of their choice.

### 14.3 Bulletin Chain (Creative Storage Phase A)

Advertisers may optionally store campaign creative material on Polkadot's Bulletin Chain instead of (or in addition to) IPFS. When the SDK fetches Bulletin-stored creative via `${relay}/bulletin/<cid>`, the relay operator and the Bulletin Chain network see the CID being requested. The CID itself does not contain user identifiers.

### 14.4 RPC Providers

The extension and web app communicate with Polkadot Hub via JSON-RPC endpoints. If you use a public RPC endpoint, the provider may log your IP address and query patterns.

**Pine RPC light client (`pine/`)** is an optional smoldot-based EIP-1193 provider that translates Ethereum JSON-RPC into Substrate calls via a peer-to-peer light client, eliminating the centralized RPC proxy dependency for supported methods. Pine RPC does not log queries — it processes them locally in the browser/process and fetches proofs from the Polkadot peer network. Some methods (subscriptions, debug/trace) are not supported and may fall back to a centralized RPC.

### 14.5 No Other Third Parties

The Datum protocol does not integrate with any advertising networks, data brokers, analytics platforms, or social media SDKs.

---

## 15. Governance, Reporters, and Protocol Changes

The Datum protocol is governed on-chain through a phase ladder: Admin (Phase 0, deployer EOA) → Council (Phase 1, N-of-M) → OpenGov (Phase 2, conviction voting via `DatumGovernanceV2` and `DatumParameterGovernance`). Sensitive changes (treasury sweeps, parameter retunes, blocklist mutations, contract upgrades) are gated by a 48-hour `DatumTimelock` and per-key retune cooldowns (`ParameterRetuneGuard`).

Several roles have data access beyond an ordinary user:

- **Council members** see proposal details and may resolve appeals, fraud claims, and curator actions on-chain. Their addresses are public.
- **Guardians (3)** can fast-pause categories of the protocol. Their addresses are public.
- **Reporters** (StakeRoot V1/V2, identity bridge) submit data to the protocol on a bonded basis. Their submissions are public and slashable on fraud.
- **Curators** (`DatumTagCurator`, `DatumCouncilBlocklistCurator`) make on-chain blocklist and tag decisions on Council's behalf.

Changes to data handling practices that require smart contract changes are subject to on-chain governance. Changes to off-chain components (relay, extension, web app, WordPress plugin, IPFS node, Pine RPC) are reflected in updated versions of this policy.

---

## 16. Relay Operator Obligations

Any party operating a Datum relay server is responsible for:

1. **Securing** the `pending-queue.json` file with OS-level permissions (0600 or equivalent)
2. **Not logging** user addresses beyond what is strictly necessary for claim processing
3. **Purging** processed batch data promptly after on-chain confirmation
4. **Publishing** a supplementary privacy notice disclosing any additional data collection or retention
5. **Complying** with applicable data protection laws in their jurisdiction regarding the processing of wallet addresses
6. **In bonded mode (`datumrelay`):** complying with the `DatumRelayStake` accountability regime and accepting governance-driven slashing for censorship, front-running, MEV extraction, or collusion

---

## 17. Publisher Obligations

Any party integrating the Datum SDK, WordPress plugin, or operating an attestation endpoint is responsible for:

1. **Disclosing** in their own privacy policy that wallet addresses of earning users are received via the attestation endpoint
2. **Not using** wallet addresses received via attestation for any purpose other than fraud detection and claim verification
3. **Not correlating** wallet addresses with off-chain user identities without explicit user consent
4. **Securing** their attestation endpoint to prevent unauthorized access
5. **Disclosing** if they operate click-tracking infrastructure beyond the click registry path described in §3.6

---

## 18. Advertiser Obligations

Advertisers participating in dual-sig settlement campaigns are responsible for:

1. **Disclosing** that they receive earning users' wallet addresses as part of the dual-sig cosignature process
2. **Not using** those wallet addresses for off-chain re-identification or correlation
3. **Honoring** the AssuranceLevel they declared at campaign creation

Advertisers in non-dual-sig modes do not receive user wallet addresses directly (only aggregate settlement events on-chain are visible to them, as to anyone).

---

## 19. Contact and Updates

This policy may be updated as the protocol evolves. Material changes will be noted in the version history below.

For questions about this policy or to report a privacy concern, refer to the project repository or the project's public web presence at https://datum.javcon.io.

---

## 20. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-04-22 | Initial privacy policy — covers alpha-3 protocol (26 contracts, extension v3, relay-bot, SDK) |
| 2.0 | 2026-05-28 | Alpha-5 (59 production contracts). Added: People Chain identity bridge, ZK identity verifier, interest commitments, click registry, DATUM token plane (mint authority / WDATUM wrapper / bootstrap pool / fee share / vesting), dual-sig settlement path and `DatumDualSigSettlement`, three relay modes (publisher / dualsig / datumrelay), bonded relay accountability (`DatumRelayStake` + `DatumRelayGovernance`), AssuranceLevel L0–L3 gradient with `userMinAssurance`, user self-sovereignty controls (`userPaused` / `userBlocksPublisher` / `userBlocksAdvertiser`), time-locked recovery address on `DatumPaymentVault`, advertiser stake + governance, blocklist appeals, Bulletin Chain creative storage, WordPress plugin, self-hosted IPFS node + upload proxy, Pine RPC smoldot light client, governance phase ladder (Admin → Council → OpenGov) with retune cooldowns, bonded identity reporter, stake-root V1/V2 fraud-proof system. |

---

## Appendix A: Glossary of Cryptographic Terms

**Groth16:** A zero-knowledge proof system that allows one party to prove they performed a computation correctly without revealing private inputs. Used in Datum to prove impression validity (`DatumZKVerifier`, 7 public inputs) and identity uniqueness (`DatumIdentityVerifier`, single public input).

**Poseidon hash:** A cryptographic hash function designed for efficiency inside ZK circuits. Used to compute nullifiers (`nullifier = Poseidon(userSecret, campaignId, windowId)`) and identity commitments.

**Blake2-256:** A cryptographic hash function used by `DatumSettlement` to compute claim hashes (via the pallet-revive system precompile on Polkadot Hub).

**Nullifier:** A deterministic, one-way hash that identifies "this user submitted a claim for this campaign in this time window" without revealing which user. The same user+campaign+window always produces the same nullifier, allowing the registry to detect replays.

**EIP-712:** An Ethereum standard for structured, typed message signing. Used by users (and, in dual-sig mode, publishers and advertisers) to authorize claim batch submissions.

**AES-256-GCM:** A symmetric encryption algorithm used to encrypt wallet private keys and claim exports at rest.

**PBKDF2:** A key derivation function that derives an encryption key from a user password, adding computational cost to brute-force attacks.

**Merkle commitment:** A 32-byte root hash that commits to a set of values; allows proving membership in the set without revealing the set. Used for interest commitments and stake roots.

**XCM:** Cross-Consensus Messaging — Polkadot's messaging protocol used to bridge identity judgments from People Chain to the Datum identity bridge contract on Polkadot Hub.

**MPC ceremony:** Multi-Party Computation ceremony — a setup ritual where multiple independent parties contribute randomness to a ZK proving key; required for production-grade ZK soundness.

---

## Appendix B: On-Chain Data Longevity

All data recorded on the Polkadot Hub blockchain is **permanent by design**. Even if the Datum protocol is discontinued, all historical settlement events, click events, nullifier records, interest commitments, identity commitments, campaign registrations, governance records, and token mint events will remain accessible on the blockchain indefinitely. There is no mechanism to redact or remove this data once recorded.

Users should treat their wallet addresses as long-term pseudonymous identifiers and understand that their full Datum interaction history is permanently associated with those addresses. If you also submit personally identifying data to People Chain `pallet-identity`, that data is similarly permanent and may be linked to your Datum activity by anyone who reads both chains.

---

## Appendix C: Surfaces & Components Inventory

| Surface | Path | What it sees |
|---------|------|--------------|
| Browser extension (alpha-5 v0.5.x) | `alpha-5/extension/` | Everything in §3 |
| Web app | `web/` | On-chain reads + wallet sign requests; no server-side tracking |
| Publisher SDK | `sdk/datum-sdk.js` | Publisher config + click events; no user PII |
| WordPress plugin | `wordpress-plugin/datum-publisher/` | Wraps the SDK; publisher config in WP options |
| Publisher relay | `relay-bot/` (gitignored) | Submitted batches, attestation calls (§4) |
| IPFS node + proxy | `ipfs-node/` | Uploaded creative metadata + standard access logs |
| Pine RPC light client | `pine/` | Local JSON-RPC translation; no centralized query log |
| Smart contracts | `alpha-5/contracts/` (59 production) | All on-chain data in §6 + §7 |
| Demo page | `docs/index.html` | Reference page using the SDK |
