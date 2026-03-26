# DATUM Browser Extension

Privacy-preserving ad network on Polkadot Hub. Users earn DOT for relevant ad impressions recorded locally in their browser.

## Requirements

- Node 18+
- Chrome / Chromium (Manifest V3)
- [SubWallet](https://subwallet.app/) browser extension for wallet signing

## Build

```bash
npm install
npm run build
```

Output is written to `dist/`. The build uses webpack 5 with full inlining (no code splitting), so the output is three files:

| File | Role |
|------|------|
| `dist/popup.js` | React popup UI |
| `dist/background.js` | MV3 service worker (polling, claim queue, auto-submit) |
| `dist/content.js` | Content script (page classification, ad slot injection) |

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` directory (not the repo root)

## Configure

Open the extension popup → **Settings** tab:

| Setting | Value |
|---------|-------|
| Network | Local (dev) / Westend / Polkadot Hub |
| RPC URL | e.g. `http://localhost:8545` for local devchain |
| Contract Addresses | Paste addresses from `scripts/deploy.ts` output |
| Publisher Address | Leave blank to use connected wallet address |
| Auto-submit | Enable to have claims submitted automatically on a timer |

## Local Devchain

See [`../poc/`](../poc/) for Hardhat PoC contracts and deployment scripts.

```bash
# Start substrate devchain (Docker required)
cd ../poc
./scripts/start-substrate.sh

# Deploy contracts
npx hardhat run scripts/deploy.ts --network substrate

# Fund your SubWallet address
TARGET=0xYourAddress npx hardhat run scripts/fund-wallet.ts --network substrate

# Set up a test campaign (registers Alith as publisher, creates + activates campaign)
npx hardhat run scripts/setup-test-campaign.ts --network substrate
```

## Architecture

```
background/
  index.ts          — Service worker entry point, alarm setup, message routing
  campaignPoller.ts — Polls DatumCampaigns every 5 min, caches to storage
  claimBuilder.ts   — Builds hash-chain claim from impression + chain state
  claimQueue.ts     — Persists pending claims, provides SUBMIT_CLAIMS batches

content/
  index.ts          — Classifies page, checks campaigns, records impressions
  taxonomy.ts       — Maps page titles/hostnames to ad categories
  adSlot.ts         — Injects dismissible ad banner

popup/
  App.tsx           — Tab shell (Claims / Publisher / Settings)
  ClaimQueue.tsx    — Shows pending claims, submit / sign-for-relay buttons
  PublisherPanel.tsx — Publisher registration, campaign creation, reward claims
  UserPanel.tsx     — User balance display and withdrawal
  Settings.tsx      — Network, RPC, contract address configuration

offscreen/
  index.ts          — Auto-submit via offscreen document (access to window.ethereum)

shared/
  types.ts          — TypeScript interfaces mirroring Solidity structs
  networks.ts       — RPC URLs and contract addresses per network
  dot.ts            — parseDOT / formatDOT helpers
  contracts.ts      — ethers contract factories (ABIs inlined)
  messages.ts       — Chrome message type definitions
```

## Testing

```bash
# Unit + integration tests (Hardhat EVM)
cd ../poc && npx hardhat test

# Substrate (pallet-revive) tests
cd ../poc && npx hardhat test --network substrate
```

## Rebuild After Changes

```bash
npm run build
```

Then reload the extension in Chrome: `chrome://extensions` → click the reload icon on the DATUM card.
