# DATUM

**Decentralized Ad Targeting Utility Marketplace**

An experiment in building an automated, privacy-preserving ad exchange on Polkadot Hub using pallet-revive (PolkaVM). DATUM explores the feasibility of on-chain programmatic advertising where users are directly compensated in DOT for their attention, no personal data leaves the user's device, and advertisers receive cryptographic assurance that impressions are real.

## Motivation

The digital advertising industry is built on surveillance. Users are tracked across the web, their behavior profiled and sold, while receiving nothing in return. Ad fraud costs advertisers billions annually, and publishers depend on opaque intermediaries that extract most of the value.

DATUM asks: what if the economics worked differently?

- **Users** earn DOT for viewing ads. Their browsing data stays on their device. The only information that leaves is a cryptographic attestation that they participated in an ad campaign.
- **Advertisers** get verifiable impressions backed by hash-chain proofs, settled transparently on-chain with no intermediary markup.
- **Publishers** set their own take rates and receive payment directly through smart contract settlement.

This project was inspired by the Basic Attention Token and by early conversations in the Polkadot ecosystem about content monetization and Web3-native economic models. With Proof of Personhood and JAM on the horizon, the infrastructure is approaching the maturity needed for viable alternatives to the surveillance-advertising model. DATUM is one experiment in what the digital economy of individual agents might look like.

## How it works

1. **Advertisers** create campaigns by depositing DOT into the DatumCampaigns contract, specifying a bid CPM, category target, and publisher.
2. **Governance reviewers** stake DOT to vote on campaign quality. Campaigns activate when aye votes cross a threshold; nay votes can terminate bad campaigns, slashing 10% of remaining budget to reviewers and refunding 90% to the advertiser.
3. **Users** browse the web with the DATUM Chrome extension. The extension classifies pages locally, matches against active campaigns, and records impressions as hash-chain claims -- all on-device.
4. **Settlement** happens when claims are submitted on-chain. The contract validates the hash chain, deducts from campaign budget, and splits payment three ways: publisher, user, and protocol.

No ad server. No tracking pixels. No user profiles leaving the browser.

### Revenue split

```
totalPayment     = (clearingCpm * impressions) / 1000
publisherPayment = totalPayment * snapshotTakeRate / 10000
remainder        = totalPayment - publisherPayment
userPayment      = remainder * 75%
protocolFee      = remainder * 25%
```

All amounts are in planck (1 DOT = 10^10 planck).

## Architecture

### Smart contracts (Solidity on PolkaVM)

Six contracts deployed to Polkadot Hub via pallet-revive:

| Contract | Role |
|----------|------|
| `DatumPublishers` | Publisher registry and take-rate management |
| `DatumCampaigns` | Campaign lifecycle: creation, activation, pausing, termination, expiry |
| `DatumGovernanceVoting` | Stake-weighted conviction voting; activates or terminates campaigns |
| `DatumGovernanceRewards` | Reward claims and stake withdrawal for governance reviewers |
| `DatumSettlement` | Hash-chain validation, claim processing, 3-way payment split |
| `DatumRelay` | EIP-712 user + publisher co-signature verification for relayed settlement (users pay zero gas) |

All contracts compile to PolkaVM (RISC-V) bytecode under the 49,152-byte initcode limit using resolc with optimizer mode `z`.

### Browser extension (Chrome MV3)

A Chrome extension that handles the entire user-side flow:

- **Background service worker** -- polls for active campaigns, builds hash-chain claims from impressions, manages auto-submission via offscreen documents
- **Content script** -- classifies pages against a 10-category taxonomy, matches active campaigns by category, injects ad creative, records impressions locally
- **Popup UI** -- wallet connection, campaign list with IPFS metadata, claim queue management, manual/relay submission, publisher campaign creation, user and publisher withdrawal
- **Offscreen document** -- enables wallet signing for auto-submit (MV3 service workers have no DOM)

### Privacy model

The extension processes all browsing data locally. Page classification, campaign matching, and impression recording happen entirely on-device. The only data submitted on-chain is a hash-chain claim attesting that the user viewed N impressions for a given campaign. The claim contains no URLs, no page content, no browsing history. Category targeting is resolved client-side.

## Repository layout

```
poc/
  contracts/          Solidity source (6 contracts + interfaces + mocks)
  test/               Hardhat test suite (58 tests)
  scripts/            Deployment, benchmarking, campaign setup, metadata tools
  metadata/           Sample campaign metadata JSON files
  BENCHMARKS.md       Gas measurements on pallet-revive dev chain

extension/
  src/background/     Service worker: polling, claim building, auto-submit
  src/content/        Page classification, ad slot injection
  src/popup/          React UI: campaigns, claims, earnings, publisher, settings
  src/offscreen/      Offscreen document for auto-submit signing
  src/shared/         Types, ABIs, contract factories, CID encoding, networks

MVP.md                Phased implementation plan with gate criteria
REVIEW.md             Design review and issue resolution log
```

## Getting started

### Prerequisites

- Node.js 18+
- Docker (for the local substrate devchain)
- Chrome with [SubWallet](https://subwallet.app/) extension

### Contracts

```bash
cd poc
npm install

# Run tests (Hardhat EVM)
npm test                  # 58/58 pass

# Compile for PolkaVM
npm run compile:polkavm   # requires @parity/resolc
```

### Extension

```bash
cd extension
npm install
npm run build             # output in dist/
```

Load in Chrome: `chrome://extensions` -> Developer mode -> Load unpacked -> select `extension/dist/`

### Local devchain

```bash
cd poc

# Start substrate node + eth-rpc adapter (Docker)
./scripts/start-substrate.sh

# Deploy contracts
npx hardhat run scripts/deploy.ts --network substrate

# Create and activate a test campaign
npx hardhat run scripts/setup-test-campaign.ts --network substrate

# Fund a wallet for testing
npx hardhat run scripts/fund-wallet.ts --network substrate -- --target 0xYourAddress
```

### Campaign metadata

```bash
cd poc

# Validate a metadata JSON file
npx hardhat run scripts/upload-metadata.ts -- --file metadata/sample-crypto.json

# Set metadata on-chain (after pinning to IPFS)
npx hardhat run scripts/upload-metadata.ts -- --cid QmXyz... --campaign 1
```

## Status

- [x] **Phase 1** -- Local substrate validation (Gate G1 complete)
  - 58 tests on Hardhat EVM, 44/46 on pallet-revive (2 skipped by design)
  - All 6 contracts under 49,152-byte PVM initcode limit
  - Publisher relay with EIP-712 user signatures + optional publisher co-signatures
  - Gas benchmarks recorded
- [x] **Phase 2** -- Browser extension (code complete, runtime testing in progress)
  - Full popup UI: campaigns, claims, earnings, publisher panel, settings
  - Campaign poller, claim builder, hash-chain management
  - Manual submit, sign-for-relay, auto-submit via offscreen
  - IPFS metadata pipeline: CID encoding, creative rendering, developer CLI
  - Publisher co-signature verification in DatumRelay (two-party impression attestation)
- [ ] **Phase 3** -- Testnet deployment (Paseo or Westend)
- [ ] **Phase 4** -- Mainnet (Kusama -> Polkadot Hub)

## Why PolkaVM

DATUM targets Polkadot Hub via pallet-revive rather than an EVM chain. This is deliberate:

- **Native DOT settlement** -- campaign escrow, governance stakes, and payments are all in native DOT with no bridges or wrapped tokens
- **Shared security** -- contracts execute on Polkadot Hub directly, inheriting relay chain security
- **XCM interoperability** -- future cross-chain features (fee routing via HydraDX, cross-chain governance) become native XCM calls
- **Ecosystem alignment** -- Polkadot identity primitives (Proof of Personhood), OpenGov tooling, and treasury funding are directly accessible

The tradeoffs are real: resolc produces 10-20x larger bytecode than solc, cross-contract calls are more expensive, and the toolchain is still maturing. The 49,152-byte initcode limit forced splitting from 3 contracts to 6 and required aggressive size optimization. But the Solidity source is portable -- if pallet-revive doesn't mature, deployment to an EVM parachain remains viable.

## Deferred (explicitly out of scope)

| Item | Status |
|------|--------|
| ZK proof of auction outcome | `zkProof` field reserved in Claim struct; circuit work is a separate track |
| Decentralized KYB identity | MVP uses T1 allowlist; evaluating zkMe and Polkadot PoP for post-MVP |
| HydraDX XCM fee routing | Protocol fees accumulate in contract; XCM routing is post-MVP |
| Rich media ad rendering | MVP renders text creatives; image/video support post-MVP |
| Viewability dispute mechanism | Requires oracle or ZK; post-MVP |
| Advanced governance game theory | MVP uses 10% slash cap; symmetric risk, dispute bonds, graduated response post-MVP |
| Contract ownership transfer | Manual owner pattern for PVM size; add `transferOwnership()` for multisig migration pre-mainnet |
| Impression attestation | Publisher co-signature verification implemented in DatumRelay (degraded trust mode when absent); post-MVP: mandatory attestation mode, publisher attestation endpoints, then ZK/TEE |
| Clearing CPM auction | MVP fixed-price (`clearingCpm = bidCpm`); post-MVP: batch auction with second-price clearing |
| Admin timelock | MVP admin setters immediate; post-MVP: 48-hour timelock with on-chain exit window |
| Multi-publisher campaigns | MVP single publisher per campaign; post-MVP: open publisher pool |
| Contract upgrade path | MVP non-upgradeable; post-MVP: proxy or migration for Settlement |

## License

MIT
