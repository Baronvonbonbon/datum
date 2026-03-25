# DATUM Browser Extension (Alpha-2)

Privacy-preserving ad network on Polkadot Hub. Users earn DOT for relevant ad impressions recorded locally in their browser.

**Status:** Alpha-2 build complete. 13-contract support, Blake2-256 claim hashing, mandatory publisher attestation (P1), EIP-1193 provider bridge. 165/165 Jest tests, 0 webpack errors.

## Requirements

- Node 18+
- Chrome / Chromium (Manifest V3)
- Embedded wallet (no external wallet extension needed — keys encrypted at rest with AES-256-GCM)

## Build

```bash
npm install
npm run build
```

Output is written to `dist/`. The build uses webpack 5 with full inlining (no code splitting):

| File | Role |
|------|------|
| `dist/popup.js` | React popup UI (3 tabs) |
| `dist/background.js` | MV3 service worker (polling, claim queue, auction, engagement, auto-submit) |
| `dist/content.js` | Content script (page classification, ad slot injection, engagement tracking) |
| `dist/provider.js` | EIP-1193 provider bridge (`window.datum`) injected at document_start |

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` directory (not the repo root)

## Configure

Open the extension popup -> **Settings** tab:

| Setting | Value |
|---------|-------|
| Network | Local (dev) / Paseo / Westend / Kusama / Polkadot Hub |
| RPC URL | e.g. `http://localhost:8545` for local devchain |
| Contract Addresses | 13 addresses — auto-loaded from `deployed-addresses.json` or paste from deploy script output |
| Publisher Address | Leave blank to use connected wallet address |
| Auto-submit | Enable to have claims submitted automatically on a timer |

### Ad Preferences (Settings tab)

- **Max ads per hour** — rate limit (1-30, default 12)
- **Minimum bid CPM** — floor CPM in DOT
- **Silenced categories** — collapsible 26-category hierarchy with subcategories
- **Blocked campaigns** — per-campaign block list

## Tabs

| Tab | Component | Function |
|-----|-----------|----------|
| Claims | ClaimQueue | Pending claims, submit via AttestationVerifier, sign for publisher relay, earnings estimate, attestation badges, export/import (P6) |
| Earnings | UserPanel | User balance (DOT), withdraw from PaymentVault, engagement stats (dwell, viewable, viewability rate), per-campaign breakdown |
| Settings | Settings | Network, RPC, 13 contract addresses, IPFS gateway, Pinata API key, auto-submit, ad preferences, interest profile, wallet management |

Advanced flows (Campaigns, Publisher, Advertiser, Governance) are in the [web app](../../web/).

## Provider Bridge (window.datum)

The extension injects an EIP-1193-compatible provider into all pages so the DATUM web app can request wallet operations without exposing private keys:

```typescript
// Web app usage (walletProvider.ts):
const provider = new ethers.BrowserProvider(window.datum);
const signer = await provider.getSigner();
```

Supported methods:

| EIP-1193 Method | Extension Handler |
|-----------------|-------------------|
| `eth_requestAccounts` / `eth_accounts` | Returns connected wallet address |
| `eth_chainId` | Returns chain ID from configured RPC |
| `eth_signTypedData_v4` | Wallet signs EIP-712 typed data |
| `personal_sign` | Wallet signs arbitrary message |
| All other RPC methods | Proxied to extension's configured RPC endpoint |

Communication flow: Page -> `window.datum.request()` -> CustomEvent -> content script -> `chrome.runtime.sendMessage` -> background -> response -> content script -> CustomEvent -> page.

Concurrent requests use per-request IDs to prevent race conditions.

## Local Devchain

```bash
# Start substrate devchain (Docker required)
cd ../
docker compose up -d

# Deploy 13 contracts with full wiring
npx hardhat run scripts/deploy.ts --network substrate

# Fund your wallet
TARGET=0xYourAddress npx hardhat run scripts/fund-wallet.ts --network substrate

# Set up a test campaign (registers publisher, creates + activates campaign)
npx hardhat run scripts/setup-test-campaign.ts --network substrate
```

Deploy script writes `deployed-addresses.json` — the extension auto-loads addresses on reload.

## Claim Export/Import (P6)

Export and import claim state between browsers/devices:

1. **Export:** Claims tab -> "Export Claims" -> signs with wallet -> downloads encrypted `.dat` file
2. **Import:** Claims tab -> "Import Claims" -> select `.dat` file -> decrypts with wallet signature -> merges with existing state

- Encryption: AES-256-GCM with HKDF key derived from wallet signature of fixed message
- Import validates: address match, on-chain nonce check, deduplication
- Merge strategy: keeps higher nonce, appends only new claims

## Architecture

```
background/
  index.ts              — Service worker entry, alarm setup, message routing
  auction.ts            — Vickrey second-price auction (P19)
  behaviorChain.ts      — Per-(user, campaign) engagement hash chain (Blake2-256)
  behaviorCommit.ts     — Behavior commitment bytes32 (Blake2-256)
  campaignMatcher.ts    — Legacy fallback selector
  campaignPoller.ts     — Polls contracts every 5 min, caches all statuses
  claimBuilder.ts       — Builds hash-chain claims with Blake2-256 + auction CPM + quality weighting
  claimQueue.ts         — Persists pending claims, provides batches
  interestProfile.ts    — Exponential-decay category weights
  publisherAttestation.ts — Publisher co-sig requests (POST /.well-known/datum-attest)
  userPreferences.ts    — Block/silence/rate-limit/minCPM
  zkProofStub.ts        — Dummy ZK proof generator

content/
  index.ts              — Page classification, auction selection, engagement tracking
  provider.ts           — EIP-1193 provider bridge (window.datum) + content script relay
  taxonomy.ts           — 26-category multi-signal classifier
  adSlot.ts             — Shadow DOM ad injection + auction badge
  engagement.ts         — IntersectionObserver engagement capture

popup/
  App.tsx               — 3-tab shell (Claims, Earnings, Settings)
  ClaimQueue.tsx        — Claims + submit via AttestationVerifier + relay POST + export/import
  Settings.tsx          — Full configuration + ad preferences + 13 contract addresses
  UserPanel.tsx         — Earnings + engagement stats + PaymentVault withdrawal
  WalletSetup.tsx       — Embedded wallet setup (AES-256-GCM + PBKDF2)

shared/
  abis/                 — 13 contract ABIs (includes DatumAttestationVerifier)
  claimExport.ts        — P6 encrypted export/import
  contracts.ts          — Contract factories (13 contracts)
  messages.ts           — Chrome message type definitions
  networks.ts           — Network configs (local, Paseo, Westend, Kusama, Polkadot Hub)
  types.ts              — TypeScript types, 26 categories, ContractAddresses (13 fields)
  walletManager.ts      — Multi-account wallet (AES-256-GCM + PBKDF2, 310k iterations)
  dot.ts                — parseDOT / formatDOT helpers
  qualityScore.ts       — Pure quality scoring (computed in trusted background context)
  errorCodes.ts         — Human-readable error code map (E00-E64, P, reason codes)
```

## 13 Contract System

| Contract | Purpose |
|----------|---------|
| DatumPauseRegistry | Global emergency pause |
| DatumTimelock | 48h admin delay (owns Campaigns + Settlement) |
| DatumPublishers | Publisher registry + take rates + S12 blocklist/allowlists |
| DatumCampaigns | Campaign creation, metadata, status management |
| DatumBudgetLedger | Campaign escrow + daily caps + settlement tracking |
| DatumPaymentVault | Pull-payment vault (publisher/user/protocol balances) |
| DatumCampaignLifecycle | Complete/terminate/expire + P20 inactivity timeout |
| DatumAttestationVerifier | P1 mandatory publisher co-signature for all campaigns |
| DatumGovernanceV2 | Conviction voting (9 levels, 0-8), escalating lockups |
| DatumGovernanceSlash | Symmetric slash on losing voters + sweep |
| DatumSettlement | Blake2-256 hash-chain validation + 3-way payment split |
| DatumRelay | EIP-712 gasless settlement + publisher co-sig |
| DatumZKVerifier | Stub ZK verifier (real Groth16 post-alpha) |

## Key Changes from Alpha Extension

- **3 tabs** (Claims, Earnings, Settings) — down from 7. Advanced flows moved to web app.
- **Blake2-256 claim hashing** — `@noble/hashes/blake2.js` replaces keccak256. Matches Settlement on PolkaVM.
- **P1 attestation path** — Claims submitted via `AttestationVerifier.settleClaimsAttested()` with publisher co-signature per batch.
- **Relay POST** — `signForRelay()` POSTs signed batches to publisher relay endpoints after signing.
- **EIP-1193 provider bridge** — `window.datum` compatible with `ethers.BrowserProvider`. Supports signing, RPC proxy, concurrent requests.
- **13-contract support** — PaymentVault, BudgetLedger, CampaignLifecycle, AttestationVerifier added.

## Testing

```bash
npm test          # 165/165 Jest tests
npm run build     # Webpack build (0 errors)
```

Test coverage: Blake2 hashing, claim builder, provider bridge, engagement, quality scoring, behavior chain, claim export, phishing list, content safety, SDK detection, error codes, wallet manager, interest profile, and more.

## Next Steps

1. **Alpha-2 testnet deploy** — Deploy 13 contracts to Paseo, update `deployed-addresses.json` with live addresses.
2. **Relay Blake2 migration** — Relay bot must switch claim hash from keccak256 to Blake2-256.
3. **E2E validation** — Full browser E2E on Paseo: create campaign, vote, browse, submit claims, verify settlement.
4. **Open testing (A3.5)** — External testers complete the full flow.

## Rebuild After Changes

```bash
npm run build
```

Then reload the extension in Chrome: `chrome://extensions` -> click the reload icon on the DATUM card.
