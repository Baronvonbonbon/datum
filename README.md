# DATUM

**Decentralized Ad Targeting Utility Marketplace**

An experiment in building an automated, privacy-preserving ad exchange on Polkadot Hub using pallet-revive (PolkaVM). DATUM explores the feasibility of on-chain programmatic advertising where users are directly compensated in DOT for their attention, no personal data leaves the user's device, and advertisers receive cryptographic assurance that impressions are real.

## Motivation

The digital advertising industry is built on surveillance. Users are tracked across the web, their behavior profiled and sold, while receiving nothing in return. Ad fraud costs advertisers billions annually, and publishers depend on opaque intermediaries that extract most of the value.

DATUM asks: what if the economics worked differently?

- **Users** earn DOT for viewing ads. Their browsing data stays on their device. The only information that leaves is a cryptographic attestation that they participated in an ad campaign.
- **Advertisers** get verifiable impressions backed by hash-chain proofs, settled transparently on-chain with no intermediary markup.
- **Publishers** set their own take rates and receive payment directly through smart contract settlement.

## How it works

1. **Advertisers** create campaigns by depositing DOT into the DatumCampaigns contract, specifying a bid CPM, category target, and publisher.
2. **Governance reviewers** stake DOT to vote on campaign quality with conviction multipliers (0-6x). Campaigns activate when aye votes cross a majority threshold with quorum; nay votes can terminate bad campaigns. Losing-side voters pay a symmetric slash (10% of stake), distributed to winning-side voters.
3. **Users** browse the web with the DATUM Chrome extension. The extension classifies pages against a 26-category taxonomy, runs a second-price auction across matching campaigns, and records impressions as hash-chain claims -- all on-device.
4. **Settlement** happens when claims are submitted on-chain. The contract validates the hash chain, deducts from campaign budget, and splits payment three ways: publisher (configurable 30-80%), user (75% of remainder), and protocol (25% of remainder).

No ad server. No tracking pixels. No user profiles leaving the browser.

### Revenue split

```
totalPayment     = (clearingCpm * impressions) / 1000
publisherPayment = totalPayment * snapshotTakeRate / 10000
remainder        = totalPayment - publisherPayment
userPayment      = remainder * 75%
protocolFee      = remainder * 25%
```

All amounts are in planck (1 DOT = 10^10 planck). Clearing CPM is determined by the on-device second-price auction, not hardcoded to bid CPM.

## Architecture

### Smart contracts (9 contracts, Solidity on PolkaVM)

| Contract | PVM Size | Role |
|----------|----------|------|
| `DatumPauseRegistry` | 4 KB | Global emergency pause circuit breaker |
| `DatumTimelock` | 18 KB | 48-hour admin delay for contract reference changes |
| `DatumPublishers` | 19 KB | Publisher registry and take-rate management (30-80%) |
| `DatumCampaigns` | 49 KB | Campaign lifecycle: creation, activation, pausing, completion, termination, expiry |
| `DatumGovernanceV2` | 38 KB | Conviction voting (0-6x), evaluateCampaign(), inline symmetric slash |
| `DatumGovernanceSlash` | 30 KB | Slash pool finalization and winner reward claims |
| `DatumSettlement` | 49 KB | Hash-chain validation, claim processing, 3-way payment split, optional ZK |
| `DatumRelay` | 46 KB | EIP-712 user + publisher co-signature verification for gasless settlement |
| `DatumZKVerifier` | 1 KB | Stub ZK proof verifier (wired to Settlement for future Groth16 proofs) |

All contracts compile to PolkaVM (RISC-V) bytecode under the 49,152-byte initcode limit using resolc v0.3.0 with optimizer mode `z`. DatumCampaigns and DatumSettlement ownership is transferred to DatumTimelock post-deploy for admin safety.

### Browser extension (Chrome MV3, 7 tabs)

| Tab | Function |
|-----|----------|
| Campaigns | Active campaigns with block/unblock, collapsible 26-category filter, campaign info |
| Claims | Pending claims, submit (you pay gas) or sign for publisher relay (zero gas), export/import |
| Earnings | User balance in DOT, withdraw, engagement stats (dwell, viewable, viewability rate) |
| Publisher | Publisher balance, withdraw, relay submit, take rate management |
| My Ads | Advertiser campaign controls: pause/resume/complete/expire, campaign creation |
| Govern | Conviction voting (0-6x), evaluateCampaign, withdraw with slash, slash finalization + reward claiming |
| Settings | Network, RPC, 9 contract addresses, IPFS gateway, auto-submit, ad preferences, interest profile, wallet |

Key subsystems:
- **Second-price auction** (P19) -- Vickrey auction: effectiveBid = bidCpm x interestWeight, solo campaigns at 70%, floor at 30%
- **Behavioral analytics** (P16) -- on-device engagement capture (dwell time, scroll depth, tab focus, viewability), behavior hash chain, quality scoring, engagement-weighted CPM
- **Claim portability** (P6) -- encrypted export/import of claim state (AES-256-GCM, HKDF key from wallet signature)
- **Embedded wallet** -- AES-256-GCM encrypted private key with PBKDF2 key derivation; signs all transactions directly

### Privacy model

The extension processes all browsing data locally. Page classification, campaign matching, auction, engagement tracking, and impression recording happen entirely on-device. The only data submitted on-chain is a hash-chain claim attesting that the user viewed N impressions for a given campaign. The claim contains no URLs, no page content, no browsing history. Category targeting and ad selection are resolved client-side via the on-device auction.

## Repository layout

```
alpha/
  contracts/          Solidity source (9 contracts + interfaces + mocks)
  test/               Hardhat test suite (100 tests)
  scripts/            deploy.ts, setup-test-campaign.ts, benchmark-gas.ts, fund-wallet.ts, etc.
  hardhat.config.ts   Networks: hardhat, substrate (local Docker), polkadotHub

alpha-extension/
  src/background/     Auction, engagement chain, claim builder, campaign poller, auto-submit
  src/content/        26-category classifier, ad slot injection, engagement tracking
  src/popup/          React UI: 7 tabs (Campaigns, Claims, Earnings, Publisher, My Ads, Govern, Settings)
  src/shared/         Types, ABIs, contract factories, claim export, wallet manager, networks

poc/                  PoC MVP (frozen, tagged poc-complete) -- 64/64 tests, 7 contracts
extension/            PoC extension (frozen)

ALPHA.md              Alpha build roadmap, checklist, PVM size lessons
MVP.md                Phased implementation plan with gate criteria
REVIEW.md             Design review, 11 issues resolved, trust assumptions
```

## Getting started

### Prerequisites

- Node.js 18+
- Docker (for the local substrate devchain)
- Chrome (the extension has an embedded wallet -- no external wallet extension required)

### Contracts

```bash
cd alpha
npm install

# Run tests (Hardhat EVM)
npx hardhat test             # 100/100 pass

# Compile for PolkaVM
npx hardhat compile --network polkadotHub   # requires resolc v0.3.0
```

### Extension

```bash
cd alpha-extension
npm install
npm run build                # output in dist/ (popup.js 570KB, background.js 366KB, content.js 18KB)
```

Load in Chrome: `chrome://extensions` -> Developer mode -> Load unpacked -> select `alpha-extension/dist/`

### Local devchain

```bash
cd alpha

# Start substrate node + eth-rpc adapter (Docker)
docker compose up -d

# Deploy 9 contracts with full wiring + ownership transfer
npx hardhat run scripts/deploy.ts --network substrate

# Create and activate a test campaign
npx hardhat run scripts/setup-test-campaign.ts --network substrate

# Fund a wallet for testing
TARGET=0xYourAddress npx hardhat run scripts/fund-wallet.ts --network substrate
```

Deploy script writes `deployed-addresses.json` to both `alpha/` and `alpha-extension/` -- the extension auto-loads addresses on reload.

### Claim export/import

The extension supports encrypted claim state portability (P6):

1. Claims tab -> "Export Claims" -> wallet signs authentication message -> downloads encrypted `.dat` file
2. Claims tab -> "Import Claims" -> select `.dat` file -> decrypts with wallet signature -> merges with existing state
3. Import validates address match, checks on-chain nonces, deduplicates, keeps higher nonce

## Status

- [x] **PoC** -- 7 contracts, 64/64 Hardhat tests, local devnet verified (tagged `poc-complete`)
- [x] **Alpha contracts** -- 9 contracts (V2 governance, global pause, admin timelock, PVM size reduction), 100/100 tests
- [x] **Alpha extension** -- V2 overhaul (7 tabs), second-price auction (P19), behavioral analytics (P16), claim portability (P6), 26-category taxonomy, engagement quality scoring, 0 webpack errors
- [ ] **Local devnet E2E** -- full runtime validation against substrate-contracts-node (A3.2)
- [ ] **Paseo testnet** -- deployment and open multi-account testing (A3.3-A3.5)
- [ ] **Mainnet** -- Kusama -> Polkadot Hub

## Why PolkaVM

DATUM targets Polkadot Hub via pallet-revive rather than an EVM chain:

- **Native DOT settlement** -- campaign escrow, governance stakes, and payments are all in native DOT with no bridges or wrapped tokens
- **Shared security** -- contracts execute on Polkadot Hub directly, inheriting relay chain security
- **XCM interoperability** -- future cross-chain features (fee routing, cross-chain governance) become native XCM calls
- **Ecosystem alignment** -- Polkadot identity primitives, OpenGov tooling, and treasury funding are directly accessible

The tradeoffs are real: resolc produces 10-20x larger bytecode than solc (DatumCampaigns and DatumSettlement have <400 bytes spare), cross-contract calls are more expensive, and the toolchain is maturing. But the Solidity source is portable -- if pallet-revive doesn't mature, deployment to an EVM parachain remains viable.

## Deferred (explicitly out of scope for alpha)

| Item | Status |
|------|--------|
| ZK proof of auction/engagement | Stub verifier deployed; real Groth16 requires BN128 pairing precompile (P9) |
| Decentralized KYB identity | Permissionless for alpha; evaluating zkMe and Polkadot PoP for beta (P10) |
| HydraDX XCM fee routing | Protocol fees accumulate in contract; XCM routing post-alpha (P11) |
| External wallet integration | Embedded wallet only; WalletConnect v2 post-alpha (P17) |
| Multi-publisher campaigns | Single publisher per campaign; open publisher pool post-alpha (P5) |
| Contract upgrade path | Non-upgradeable; UUPS proxy or migration for beta (P7) |
| Mandatory publisher attestation | Optional co-signature (degraded trust mode); mandatory post-alpha (P1) |
| Rich media ad rendering | Text creatives only; image/video post-alpha |

## License

MIT
