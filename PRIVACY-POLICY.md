# Datum Protocol — Privacy Policy & Data Use Policy

**Effective Date:** 2026-04-22  
**Version:** 1.0  
**Applies To:** Datum browser extension, Datum web app, Datum relay infrastructure, Datum publisher SDK, and all on-chain protocol contracts.

---

## 1. Overview

Datum is a decentralized, privacy-first advertising protocol built on Polkadot. Its core design principle is **local-first data handling**: sensitive personal information (browsing history, cryptographic secrets, wallet keys) never leaves your device unless you explicitly authorize a claim submission. Advertising interactions are proven cryptographically rather than tracked behaviorally.

This document describes:
- What data the protocol collects and where it is stored
- What data is transmitted off-device and to whom
- What data is permanently recorded on-chain
- What choices you have over your data
- Known privacy trade-offs inherent to the protocol design

**This policy covers the protocol's reference implementation.** Operators who deploy or fork this protocol (relay operators, publishers, advertisers) may have their own privacy practices and should publish supplementary disclosures.

---

## 2. Definitions

| Term | Meaning |
|------|---------|
| **User** | A person who installs the Datum browser extension to earn from ad impressions |
| **Publisher** | A website operator who integrates the Datum SDK to display ads |
| **Advertiser** | An entity that creates ad campaigns on the protocol |
| **Relay** | A server-side component that batches signed user claims and submits them on-chain |
| **On-chain** | Data permanently recorded on the Polkadot / Asset Hub blockchain |
| **Local storage** | Browser-local persistent storage (`chrome.storage.local`) on the user's own device |
| **Claim** | A cryptographically signed record of one or more ad impressions |
| **Nullifier** | A one-way hash that proves a claim has not been replayed, without revealing the user's identity |
| **User secret** | A 32-byte random value generated once per user, used exclusively for ZK nullifier derivation |
| **Interest profile** | A locally computed map of content-topic weights derived from browsing, never transmitted |

---

## 3. Data Collected by the Browser Extension

### 3.1 Page Content (Classified Locally, Never Transmitted)

When the extension is active, the content script reads the following from each page you visit:

- Page URL and domain name
- Page title
- HTML `<meta>` description and keywords
- Browser language setting (`navigator.language`)
- User-agent device type (mobile / desktop / tablet)

This information is used **only on your device** to classify the page into content topics (e.g., `topic:crypto-web3`, `locale:en-US`, `platform:desktop`). The raw URL, title, and meta content are not stored beyond the immediate classification step. Only the resulting **tag strings** are retained, in local storage, for the interest profile (see §3.2).

**This data is never transmitted to any server, relay, or blockchain.**

### 3.2 Interest Profile (Local Only, User-Controlled)

The extension builds a locally computed interest profile:

- **What is stored:** A list of content-topic tags with timestamps, and derived per-topic weights (values 0.0–1.0 based on visit frequency with a 7-day exponential decay half-life).
- **Storage location:** `chrome.storage.local` on your own device, under key `interestProfile`.
- **Retention:** Rolling 30-day window; visits older than 30 days are pruned automatically.
- **Purpose:** Used exclusively to weight the local campaign auction — campaigns whose topic tags match your interests receive a higher probability of selection.
- **What it is NOT used for:** Profiling for third parties, sale of data, behavioral targeting by any external party.
- **Your control:** You can clear your interest profile at any time from the Settings tab in the extension popup. Uninstalling the extension deletes all local storage.

**This data is never transmitted off your device.**

### 3.3 Cryptographic User Secret (Local Only, Sensitive)

Once, on first use of ZK-enabled campaigns, the extension generates a 32-byte random value called the **user secret**:

- **Stored:** In `chrome.storage.local` under key `zkUserSecret`, as a hex string.
- **Purpose:** Used as a private input to the ZK circuit (`nullifier = Poseidon(userSecret, campaignId, windowId)`) to generate replay-preventing nullifiers without revealing your identity.
- **Never transmitted:** This value is never sent to any server, relay, or blockchain.
- **Security risk:** This value is currently stored in plaintext within Chrome's local storage. If an attacker gains physical or software access to your browser profile, they could extract this value and compute your future nullifiers. **Protect your device accordingly.**
- **Loss:** If you clear browser data or reinstall the extension, a new secret is generated and your ZK claim history becomes disconnected from the old one. There is no recovery mechanism.

### 3.4 Wallet Keys and Addresses (Local, Encrypted)

If you import or generate a wallet within the extension:

- **Private key:** Encrypted using AES-256-GCM with a key derived from your password (PBKDF2). The ciphertext is stored in `chrome.storage.local`. The plaintext key is never written to disk.
- **Auto-submit mode:** If you enable auto-submit, the extension encrypts your private key with a randomly generated session password held only in memory. On browser restart, the session password is lost and auto-submit is deauthorized — you must re-enable it with your password. This ensures the auto-submit key cannot be silently extracted from disk.
- **Wallet address:** Stored in plaintext in `chrome.storage.local` as `connectedAddress`. This is your public identifier used in claim construction and settlement.

**Private keys are never transmitted off your device.**

### 3.5 Impression Claims and Claim Queue (Local, Transmitted on Submit)

When an ad impression occurs, the extension constructs a **claim struct** and holds it locally in the claim queue:

```
{
  campaignId          (on-chain identifier)
  publisher address   (on-chain identifier)
  your wallet address (your on-chain identifier)
  impression count    (number of impressions)
  clearing CPM        (auction-determined price)
  nonce               (per-campaign counter)
  previousClaimHash   (chain integrity)
  claimHash           (Blake2-256 hash of the above)
  ZK proof            (Groth16 proof; only for ZK campaigns)
  nullifier           (Poseidon hash; does not contain your secret)
}
```

**Storage:** In `chrome.storage.local` under key `claimQueue`.  
**Retention:** Until submitted on-chain, at which point settled claims are removed.  
**Transmitted:** Yes — when you click "Submit Now" or auto-submit fires, this data is sent to the relay (see §4).

You can view the full contents of your claim queue in the extension popup at any time.

### 3.6 Per-Campaign Chain State (Local)

To preserve claim integrity, the extension stores per-campaign state:

- **Key:** `chainState:{walletAddress}:{campaignId}`
- **Contents:** Last nonce used, last claim hash
- **Purpose:** Ensures each new claim correctly links to the previous one (hash chain prevents insertion or deletion of individual claims)
- **Retention:** Until the campaign reaches a terminal state (completed, terminated, expired) at which point it is cleaned up

**This data is never transmitted off your device.**

### 3.7 Campaign Metadata Cache (Local)

The extension caches on-chain campaign data locally to reduce blockchain queries:

- **Contents:** Campaign IDs, publisher addresses, budgets, CPM bids, tag requirements, metadata IPFS hashes
- **TTL:** 5-minute cache for active campaigns; 1-hour TTL for metadata
- **Source:** Read from on-chain contracts; no user-generated content

### 3.8 Impression Deduplication (Local)

To prevent duplicate impression recording:

- **Key:** `impression:{campaignId}:{domain}`
- **Contents:** Timestamp of last impression for this campaign on this domain
- **Retention:** Persistent (cleared on extension reinstall)

---

## 4. Data Transmitted to the Relay

When you submit a batch of claims — either manually or via auto-submit — the following data is sent to the **relay server** over HTTPS:

### 4.1 What Is Sent

```
POST /relay/submit
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
          zkProof (if applicable), nullifier
        }
      ],
      deadline:   <block number>,
      signature:  <your EIP-712 signature over the batch>
    }
  ],
  powChallenge: <challenge ID from /relay/challenge>,
  powNonce:     <proof-of-work solution>
}
```

**This is the first point at which your wallet address leaves your device.**

### 4.2 What the Relay Does With This Data

1. **Validates** your EIP-712 signature (proves you authorized the batch)
2. **Verifies** the proof-of-work solution (anti-spam)
3. **Contacts the publisher's attestation endpoint** (see §5.2) — sends your wallet address, campaign ID, nonce range, and claim count to the publisher
4. **Submits the batch on-chain** via `DatumSettlement.settleClaimsFor()`
5. **Removes** your data from its queue upon successful on-chain confirmation

### 4.3 Relay Data Retention

- **In-transit queue:** The relay persists pending batches to a local file (`pending-queue.json`) to survive restarts. This file contains your wallet address and claim details. **Relay operators should secure this file with appropriate OS-level permissions.**
- **Error logs:** The relay keeps the last 50 error records in memory. These may contain wallet addresses associated with failed submissions.
- **Statistics:** Aggregate counters only (total claims, total payments). No per-user logs.
- **Epoch records:** After settlement, the relay may publish an epoch record containing settled claim hashes (not user addresses). See §4.4.

### 4.4 Epoch Logs (Claim Hash Merkle Tree)

After each settlement round, the relay optionally publishes:

- **Epoch ID**, settlement timestamp, block number, transaction hash
- **Merkle root** of settled claim hashes
- **List of settled claim hashes** (32-byte values only)

These are accessible via `/relay/epoch/:id`. Claim hashes do not contain or reveal your wallet address, user secret, or browsing activity. However, an observer who independently monitors on-chain `ClaimSettled` events (which do contain your address — see §6) could theoretically correlate epoch hashes with on-chain events.

### 4.5 Rate Limiting

The relay implements IP-based rate limiting (5 requests per minute for submissions). IP addresses are held in ephemeral memory-only buckets that expire every 5 minutes and are **not logged or persisted**.

---

## 5. Data Seen by Publishers

### 5.1 Publisher SDK (Minimal, No User Data)

The publisher SDK (`datum-sdk.js`) is a lightweight script embedded on publisher websites. It:

- Reads publisher configuration from its own `<script>` tag attributes (publisher address, relay URL, tags)
- Listens for challenge events from the Datum extension content script
- Responds with an HMAC signature (using the publisher's own key, not user data)
- **Receives no user data** — it never sees the user's wallet address, interest profile, or claim details

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
- Your browsing history or interest profile
- The content of individual pages you visited
- Your ZK user secret or nullifier pre-image
- Your private key

**Privacy implication:** Publishers can correlate wallet addresses with their campaign activity. This is an inherent trade-off of the attestation model. If you are concerned about a particular publisher learning your wallet address, you may choose not to submit claims for their campaigns.

---

## 6. Data Permanently Recorded On-Chain

The following data is **permanently and immutably recorded on the public Polkadot blockchain**. Anyone with access to a blockchain explorer can read this data.

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
)
```

**What this reveals:**
- Which campaigns your wallet address has earned from
- How much you earned per settlement (and thus per impression)
- Approximate timing (block number) of your impressions
- Nonce patterns that show how often you submit

This information is unavoidably public because blockchain payments require a public recipient address. There is no technical mechanism to hide the recipient of a payment on a transparent public chain.

### 6.2 Nullifier Registry

For ZK-enabled campaigns, a `submitNullifier` call records:

```
campaignId: <campaign identifier>   — PUBLIC
nullifier:  <32-byte hash>          — PUBLIC (not reversible)
```

The nullifier is a one-way cryptographic hash. Without your user secret, it cannot be linked to your identity or used to reconstruct your activity. It proves only that *someone* submitted an impression for *this campaign* in *this time window*.

### 6.3 Campaign Registry

Advertisers' campaigns are stored on-chain and publicly readable:

```
advertiser address   — PUBLIC
publisher address    — PUBLIC (for private/direct campaigns)
campaign budget      — PUBLIC
daily spend cap      — PUBLIC
CPM bid              — PUBLIC
campaign status      — PUBLIC
content tag hashes   — PUBLIC
metadata IPFS hash   — PUBLIC (links to full creative, images, text, landing page)
```

**What this means for advertisers:** All campaign parameters, budgets, and creative content (via IPFS) are permanently and publicly readable. Competitors can observe your bidding strategy and creative materials. This is by design — the protocol prioritizes transparency over advertiser confidentiality.

### 6.4 Publisher Registry

Publisher registrations are stored on-chain:

```
publisher address     — PUBLIC
take rate (bps)       — PUBLIC
blocked status        — PUBLIC
allowlist enabled     — PUBLIC
reputation score      — PUBLIC
stake amount          — PUBLIC
profile hash          — PUBLIC (links to IPFS profile metadata)
```

**Note on blocklist:** If a publisher address is blocked, that fact is publicly readable on-chain. This is a privacy trade-off inherent to the decentralized governance model.

### 6.5 Governance Records

Governance votes and proposals are stored on-chain:

```
proposal ID, campaign/publisher targeted   — PUBLIC
voter address                              — PUBLIC
vote direction (aye/nay)                   — PUBLIC
conviction weight and lock duration        — PUBLIC
```

### 6.6 Community Reports

If you use the extension to report a page or ad:

```
reporter address   — PUBLIC (if stored on-chain)
campaign ID        — PUBLIC
report reason      — PUBLIC
```

---

## 7. Data NOT Collected

The following data is **never collected** by the Datum protocol:

- **Full browsing history** — The extension classifies pages into topic tags but does not log a history of URLs visited
- **Search queries** — Not captured at any layer
- **Clicks or engagement duration** — Not tracked
- **Personal identity information** — No names, email addresses, phone numbers, or government IDs
- **Location data** — Not collected (locale tag is derived from browser language setting only)
- **Device fingerprint** — Not constructed or transmitted
- **Telemetry or analytics** — The protocol does not include any analytics SDK or crash reporting
- **Third-party tracking** — No pixels, beacons, or third-party scripts in the extension

---

## 8. Data Storage Summary

| Data Item | Storage Location | Transmitted To | On-Chain | User Control |
|-----------|-----------------|----------------|----------|--------------|
| Interest profile (topic weights) | Local only | Nobody | No | Clear in Settings |
| Page URLs / titles visited | Local (transient) | Nobody | No | Auto-cleared |
| User secret (ZK) | Local (plaintext) | Nobody | No | Clear browser data |
| Private key | Local (encrypted) | Nobody | No | Delete account |
| Wallet address | Local + Relay | Relay, Publisher, Chain | Yes (events) | None (public) |
| Claim queue | Local | Relay (on submit) | Via relay | View/clear in popup |
| Claim hashes | Local + Relay | Relay → Chain | Yes | None (public hashes) |
| Nullifiers | Local + Relay | Relay → Chain | Yes | None (public hashes) |
| Nonces | Local + Relay | Relay → Chain | Yes | None (public) |
| Earnings amounts | N/A | N/A | Yes (events) | None (public) |
| Campaign metadata | Local (cache) | Nobody | Via advertiser | None (public) |
| Publisher profile hash | N/A | N/A | Yes | Publisher's control |
| Governance votes | N/A | N/A | Yes | None (public) |

---

## 9. Your Rights and Choices

### 9.1 Access

You can view your locally stored data at any time:
- **Claim queue:** visible in the extension popup
- **Interest profile:** viewable in the Settings tab
- **Chain state and cached data:** accessible via the extension popup's developer view

On-chain data (settlement events, governance records) is publicly readable by anyone via the Polkadot blockchain explorer.

### 9.2 Correction and Deletion

**Local data:** You may clear your interest profile, claim queue, or all local data from the Settings tab, or by uninstalling the extension.

**On-chain data:** Settlement events, nullifier records, governance votes, and campaign registrations are **permanent and cannot be deleted**. This is a fundamental property of public blockchains. There is no "right to erasure" for data recorded on-chain.

### 9.3 Data Portability

The extension supports encrypted export of your claim queue and chain state. The export file is encrypted using a key derived from your wallet signature and can be imported into another device or browser profile.

### 9.4 Opt-Out

- **Passive impression recording:** You may pause or disable the extension at any time.
- **ZK campaigns:** If you do not wish to participate in campaigns that require a ZK proof, those campaigns will be excluded automatically if ZK proof generation fails.
- **Auto-submit:** Disabled by default; you opt in and can revoke at any time.
- **Campaign filters:** The extension provides a Filters tab where you can restrict which topics or specific campaigns you participate in.

---

## 10. Security Practices

### 10.1 Cryptographic Protections

- **Wallet private keys** are encrypted at rest using AES-256-GCM with PBKDF2 key derivation.
- **Auto-submit keys** use an ephemeral session password held only in memory (cleared on browser restart).
- **Claim exports** are encrypted with AES-256-GCM using a key derived from your wallet signature.
- **ZK proofs** (Groth16 / BN254) mathematically prove impression validity without revealing private witnesses.

### 10.2 Known Risks

**User secret stored in plaintext:** The ZK user secret is currently stored as a plaintext hex string in `chrome.storage.local`. While this data is inaccessible to other browser tabs and normal web pages, it could be exposed if:
- An attacker gains local file system access to your browser profile directory
- A malicious browser extension with `storage` permission accesses it
- Your device is compromised by malware

Mitigation: Keep your device secure, use OS-level full-disk encryption, and be cautious about which other extensions you install.

**On-chain address linkability:** Your wallet address appears in all `ClaimSettled` events. If your wallet address is publicly linked to your real identity (e.g., you have publicly doxxed it), your advertising activity becomes linkable to you. Consider using a dedicated wallet address for Datum participation.

**Publisher attestation reveals address:** The publisher of a campaign learns your wallet address when you submit a claim. See §5.2.

**Relay queue persistence:** The relay holds pending batches in a local file. A breach of the relay server could expose wallet addresses and claim details for batches that have not yet been submitted on-chain. Relay operators must secure their infrastructure accordingly.

---

## 11. Children's Privacy

The Datum protocol does not knowingly collect data from or target advertising to individuals under 13 years of age (or the applicable minimum age in your jurisdiction). The protocol has no mechanism to verify user age. Publishers integrating the Datum SDK are responsible for ensuring compliance with applicable children's privacy laws on their own platforms.

---

## 12. International Data Transfers

The relay server may be operated in any jurisdiction. Blockchain data is globally distributed. By using the Datum protocol, your wallet address and settlement records may be accessible to individuals and entities worldwide. The Polkadot blockchain operates across a globally distributed validator network with no single legal jurisdiction of control.

---

## 13. Third Parties

### 13.1 Blockchain Network

On-chain data is processed by the Polkadot validator network. Datum does not control the blockchain network and is not responsible for the privacy practices of blockchain node operators.

### 13.2 IPFS (Metadata Storage)

Campaign and publisher metadata hashes are resolved via IPFS (InterPlanetary File System). If the extension or web app fetches metadata from an IPFS gateway, the gateway operator may log your IP address and the requested content identifier (CID). The Datum web app supports configurable IPFS gateways; consider using a gateway that provides appropriate privacy protections.

### 13.3 RPC Providers

The extension and web app communicate with Polkadot via JSON-RPC endpoints. If you use a public RPC endpoint, the provider may log your IP address and query patterns. Consider using a private or self-hosted RPC node for enhanced privacy.

### 13.4 No Other Third Parties

The Datum protocol does not integrate with any advertising networks, data brokers, analytics platforms, or social media SDKs.

---

## 14. Governance and Protocol Changes

The Datum protocol is governed on-chain through `DatumParameterGovernance` and `DatumPublisherGovernance`. Changes to data handling practices that require smart contract changes are subject to on-chain governance. Changes to off-chain components (relay, extension, web app) are reflected in updated versions of this policy.

---

## 15. Relay Operator Obligations

Any party operating a Datum relay server is responsible for:

1. **Securing** the `pending-queue.json` file with OS-level permissions (0600 or equivalent)
2. **Not logging** user addresses beyond what is strictly necessary for claim processing
3. **Purging** processed batch data promptly after on-chain confirmation
4. **Publishing** a supplementary privacy notice disclosing any additional data collection or retention
5. **Complying** with applicable data protection laws in their jurisdiction regarding the processing of wallet addresses

---

## 16. Publisher Obligations

Any party integrating the Datum SDK and operating an attestation endpoint is responsible for:

1. **Disclosing** in their own privacy policy that wallet addresses of earning users are received via the attestation endpoint
2. **Not using** wallet addresses received via attestation for any purpose other than fraud detection and claim verification
3. **Not correlating** wallet addresses with off-chain user identities without explicit user consent
4. **Securing** their attestation endpoint to prevent unauthorized access

---

## 17. Contact and Updates

This policy may be updated as the protocol evolves. Material changes will be noted in the version history below.

For questions about this policy or to report a privacy concern, refer to the project repository:  
**https://github.com/[project-repo]**

---

## 18. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-04-22 | Initial privacy policy — covers alpha-3 protocol (26 contracts, extension v3, relay-bot, SDK) |

---

## Appendix A: Glossary of Cryptographic Terms

**Groth16:** A zero-knowledge proof system that allows one party to prove they performed a computation correctly without revealing private inputs. Used in Datum to prove impression validity without revealing the user's secret.

**Poseidon hash:** A cryptographic hash function designed for efficiency inside ZK circuits. Used to compute nullifiers: `nullifier = Poseidon(userSecret, campaignId, windowId)`.

**Blake2-256:** A cryptographic hash function used on PolkaVM (Polkadot's smart contract VM) to compute claim hashes.

**Nullifier:** A deterministic, one-way hash that identifies "this user submitted a claim for this campaign in this time window" without revealing which user. The same user+campaign+window always produces the same nullifier, allowing the registry to detect replays.

**EIP-712:** An Ethereum standard for structured, typed message signing. Used by users to authorize claim batch submissions.

**AES-256-GCM:** A symmetric encryption algorithm used to encrypt wallet private keys and claim exports at rest.

**PBKDF2:** A key derivation function that derives an encryption key from a user password, adding computational cost to brute-force attacks.

---

## Appendix B: On-Chain Data Longevity

All data recorded on the Polkadot blockchain is **permanent by design**. Even if the Datum protocol is discontinued, all historical settlement events, nullifier records, campaign registrations, and governance records will remain accessible on the blockchain indefinitely. There is no mechanism to redact or remove this data once recorded.

Users should treat their wallet addresses as long-term pseudonymous identifiers and understand that their full Datum interaction history is permanently associated with those addresses.
