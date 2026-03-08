# DATUM Browser Extension (Alpha)

Privacy-preserving ad network on Polkadot Hub. Users earn DOT for relevant ad impressions recorded locally in their browser.

**Status:** All alpha-scope code complete (V2 overhaul, P6 claim portability, P16 behavioral analytics, P19 second-price auction). Pending local devnet E2E validation.

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

| File | Size | Role |
|------|------|------|
| `dist/popup.js` | 570 KB | React popup UI (7 tabs) |
| `dist/background.js` | 366 KB | MV3 service worker (polling, claim queue, auction, engagement, auto-submit) |
| `dist/content.js` | 18.1 KB | Content script (page classification, ad slot injection, engagement tracking) |

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` directory (not the repo root)

## Configure

Open the extension popup → **Settings** tab:

| Setting | Value |
|---------|-------|
| Network | Local (dev) / Paseo / Westend / Kusama / Polkadot Hub |
| RPC URL | e.g. `http://localhost:8545` for local devchain |
| Contract Addresses | 9 addresses — auto-loaded from `deployed-addresses.json` or paste from deploy script output |
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
| Campaigns | CampaignList | Active campaigns with block/unblock, collapsible category filter, campaign info expansion |
| Claims | ClaimQueue | Pending claims, submit/relay, sign for publisher, earnings estimate, attestation badges, **export/import (P6)** |
| Earnings | UserPanel | User balance (DOT), withdraw, engagement stats (dwell, viewable, viewability rate), per-campaign breakdown |
| Publisher | PublisherPanel | Balance + withdraw + relay submit + take rate management |
| My Ads | AdvertiserPanel | Campaign owner controls: pause/resume/complete/expire, campaign creation with category selector |
| Govern | GovernancePanel | V2 voting (vote with conviction 0-6, evaluateCampaign, withdraw with slash), slash finalization + reward claiming |
| Settings | Settings | Network, RPC, 9 contract addresses, IPFS gateway, auto-submit, ad preferences, interest profile, wallet management |

## Local Devchain

```bash
# Start substrate devchain (Docker required)
cd ../alpha
docker compose up -d  # or ./scripts/start-substrate.sh

# Deploy 9 contracts with full wiring
npx hardhat run scripts/deploy.ts --network substrate

# Fund your wallet
TARGET=0xYourAddress npx hardhat run scripts/fund-wallet.ts --network substrate

# Set up a test campaign (registers publisher, creates + activates campaign)
npx hardhat run scripts/setup-test-campaign.ts --network substrate
```

Deploy script writes `deployed-addresses.json` to both `alpha/` and `alpha-extension/` — the extension auto-loads addresses on next reload.

## Claim Export/Import (P6)

Export and import claim state between browsers/devices:

1. **Export:** Claims tab → "Export Claims" → signs with wallet → downloads encrypted `.dat` file
2. **Import:** Claims tab → "Import Claims" → select `.dat` file → decrypts with wallet signature → merges with existing state

- Encryption: AES-256-GCM with HKDF key derived from wallet signature of fixed message
- Import validates: address match, on-chain nonce check, deduplication
- Merge strategy: keeps higher nonce, appends only new claims

## Architecture

```
background/
  index.ts              — Service worker entry, alarm setup, message routing
  auction.ts            — Vickrey second-price auction (P19)
  behaviorChain.ts      — Per-(user, campaign) engagement hash chain (P16)
  behaviorCommit.ts     — Behavior commitment bytes32 (P16)
  campaignMatcher.ts    — Legacy fallback selector
  campaignPoller.ts     — Polls contracts every 5 min, caches all statuses
  claimBuilder.ts       — Builds hash-chain claims with auction CPM + quality weighting
  claimQueue.ts         — Persists pending claims, provides batches
  interestProfile.ts    — Exponential-decay category weights
  publisherAttestation.ts — Publisher co-sig requests
  userPreferences.ts    — Block/silence/rate-limit/minCPM
  zkProofStub.ts        — Dummy ZK proof generator (P16)

content/
  index.ts              — Page classification, auction selection, engagement tracking
  taxonomy.ts           — 26-category multi-signal classifier
  adSlot.ts             — Ad banner injection + auction badge
  engagement.ts         — IntersectionObserver engagement capture (P16)

popup/
  App.tsx               — 7-tab shell
  AdvertiserPanel.tsx   — Campaign owner controls (NEW)
  CampaignList.tsx      — Active campaigns + block/filter/info
  ClaimQueue.tsx        — Claims + submit + relay + export/import
  GovernancePanel.tsx   — V2 voting + evaluate + slash
  PublisherPanel.tsx    — Publisher management
  Settings.tsx          — Full configuration + ad preferences
  UserPanel.tsx         — Earnings + engagement stats
  WalletSetup.tsx       — Embedded wallet setup

shared/
  abis/                 — 9 contract ABIs from alpha/artifacts/
  claimExport.ts        — P6 encrypted export/import (NEW)
  contracts.ts          — V2 contract factories
  messages.ts           — Chrome message type definitions
  networks.ts           — Network configs (local, Paseo, Westend, Kusama, Polkadot Hub)
  types.ts              — TypeScript types, 26 categories + subcategories, hierarchy
  walletManager.ts      — Embedded wallet (AES-256-GCM + PBKDF2)
  dot.ts                — parseDOT / formatDOT helpers
```

## 9 Contract System

| Contract | Purpose |
|----------|---------|
| DatumPauseRegistry | Global emergency pause |
| DatumTimelock | 48h admin delay (owns Campaigns + Settlement) |
| DatumPublishers | Publisher registry + take rates |
| DatumCampaigns | Campaign lifecycle + budget escrow |
| DatumGovernanceV2 | Dynamic voting + evaluateCampaign + inline slash |
| DatumGovernanceSlash | Slash pool finalization + winner claims |
| DatumSettlement | Hash-chain claims + 3-way payment split |
| DatumRelay | EIP-712 gasless settlement + publisher co-sig |
| DatumZKVerifier | Stub ZK verifier (accepts any non-empty proof) |

## Testing

```bash
# Alpha contract tests (100/100)
cd ../alpha && npx hardhat test

# Build extension
cd ../alpha-extension && npm run build
```

## Rebuild After Changes

```bash
npm run build
```

Then reload the extension in Chrome: `chrome://extensions` → click the reload icon on the DATUM card.
