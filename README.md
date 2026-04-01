# DATUM

**Decentralized Ad Targeting Utility Marketplace**

An experiment in building an automated, privacy-preserving ad exchange on Polkadot Hub using pallet-revive (PolkaVM). DATUM explores the feasibility of on-chain programmatic advertising where users are directly compensated in DOT for their attention, no personal data leaves the user's device, and advertisers receive cryptographic assurance that impressions are real.

## Motivation

The digital advertising industry is built on surveillance. Users are tracked across the web, their behavior profiled and sold, while receiving nothing in return. Ad fraud costs advertisers billions annually, and publishers depend on opaque intermediaries that extract most of the value.

DATUM asks: what if the economics worked differently?

- **Users** earn DOT for viewing ads. Their browsing data stays on their device. The only information that leaves is a cryptographic attestation that they participated in an ad campaign.
- **Advertisers** get verifiable impressions backed by hash-chain proofs, settled transparently on-chain with no intermediary markup.
- **Publishers** embed a lightweight SDK on their sites, set their own take rates and content tags, and receive payment directly through smart contract settlement.

## How it works

1. **Advertisers** create campaigns by depositing DOT into the DatumCampaigns contract, specifying a bid CPM and targeting tags. Campaigns can target a specific publisher or be **open** (any matching publisher can serve them).
2. **Governance reviewers** stake DOT to vote on campaign quality with conviction multipliers (0-8x). Campaigns activate when aye votes cross a majority threshold with quorum; nay votes can terminate bad campaigns. Losing-side voters pay a symmetric slash (10% of stake), distributed to winning-side voters.
3. **Publishers** embed the DATUM SDK (`<script src="datum-sdk.js">`) on their sites, declaring targeting tags and providing a `<div id="datum-ad-slot">` placement. The SDK performs a challenge-response handshake with the extension for two-party impression attestation.
4. **Users** browse the web with the DATUM Chrome extension. The extension detects the SDK, filters campaigns by tag overlap, runs a second-price auction, and records impressions as hash-chain claims -- all on-device. When no campaigns match, a default house ad appears linking to the Polkadot philosophy.
5. **Settlement** happens when claims are submitted on-chain. The contract validates the hash chain, deducts from campaign budget, and splits payment three ways: publisher (configurable 30-80%), user (75% of remainder), and protocol (25% of remainder).

No ad server. No tracking pixels. No user profiles leaving the browser.

### Walkthrough — Alice, Bob, Carol, and Dave

Four people use DATUM. **Alice** is a user who browses the web. **Bob** publishes a tech blog. **Carol** is an advertiser selling hardware wallets. **Dave** reviews campaigns as a governance voter.

#### Step 1 — Bob registers as a publisher and sets up the SDK

Bob opens the DATUM web app, goes to the **Publisher** section, and registers his address on the DatumPublishers contract. He sets his take rate at 40% (capped between 30-80%). This means Bob keeps 40% of every impression payment that flows through his campaigns.

Bob then sets his **targeting tags** — he registers tags like `topic:technology` and `topic:electronics` on the DatumTargetingRegistry. Tags are bytes32 hashes (`keccak256("topic:technology")`), and Bob can register up to 32 tags describing his site's content.

Finally, Bob copies the **SDK embed snippet** from the Publisher section and adds it to his site:

```html
<script src="datum-sdk.js" data-categories="5,24" data-publisher="0xBob..."></script>
<div id="datum-ad-slot"></div>
```

The SDK tag declares Bob's publisher address. The `<div>` is where ads will render inline on Bob's page. When a DATUM user visits, the SDK performs a challenge-response handshake with their extension — creating a two-party attestation that the impression is real.

#### Step 2 — Carol creates a campaign

Carol opens the **Advertiser** section and creates a campaign:
- Deposits **10 DOT** as the escrow budget
- Sets a daily cap of **1 DOT** (prevents burning through budget in one day)
- Bids **0.05 DOT per 1000 impressions** (her maximum CPM)
- Toggles **"Open Campaign"** — this means any publisher matching her tags can serve the ad. (Alternatively, she could select Bob specifically as the publisher.)
- Sets targeting tags (e.g. `topic:technology`) — up to 8 tags per campaign, matched by AND-logic against publisher tags
- Fills out the ad creative: title, body text, CTA button label, and a landing page URL (HTTPS only)
- Pins the creative metadata to IPFS (validated against content safety rules before pinning)

The campaign goes on-chain with status **Pending**. Carol's 10 DOT is locked in the DatumCampaigns contract. The creative's IPFS hash is stored as a bytes32 event. Because Carol chose an open campaign, the on-chain publisher field is `address(0)` — any registered publisher matching the tags can serve it.

#### Step 3 — Dave votes to activate the campaign

Dave opens the **Governance** section and sees Carol's campaign in the Pending list. He reads the creative metadata and decides it's legitimate. He votes **Aye** with 0.5 DOT at conviction level 2 (4x weight multiplier, 3-day lockup):
- His vote weight: 0.5 DOT x 4 = 2.0 DOT effective
- His stake is locked for ~3 days

Other voters also stake. Once total weighted votes exceed the quorum (100 DOT) and aye votes are above 50%, anyone can call **evaluateCampaign** — the campaign moves to **Active** and Carol's ads start appearing.

If the community had voted Nay instead (nay >= 50%), the campaign would be **Terminated**: 90% of Carol's budget refunded, 10% slashed to reward nay voters. Losing-side voters always pay a 10% slash on their stake.

#### Step 4 — Alice browses the web and sees an ad

Alice visits Bob's tech blog. The DATUM content script (running entirely in her browser):

1. **Detects the Publisher SDK** — Bob's page has the DATUM SDK tag. The extension reads his publisher address and declared categories.
2. **Classifies the page** against targeting tags using domain, title, and meta tag signals.
3. **Filters campaigns by tag overlap** — Carol's open campaign targets `topic:technology` and Bob's tags include that. The campaign is eligible.
4. **Runs a second-price auction** — if multiple campaigns match, the highest effective bid wins but pays the second-highest price. Solo campaigns pay 70% of their bid. Alice's interest profile weights the bids (tech-interested users make tech campaigns bid higher).
5. **Performs a handshake** — the extension sends a random challenge to the SDK via `CustomEvent`. The SDK responds with a signature, creating a two-party attestation that this impression is real (not fabricated by a modified extension).
6. **Injects an ad inline** — Carol's creative renders inside Bob's `<div id="datum-ad-slot">` via Shadow DOM (isolated from page CSS/JS). When IPFS metadata is available, the ad displays the title as a header, creative body text, and a CTA button linking to the landing page URL. On metadata cache miss, the extension requests the background service worker to fetch from IPFS (using multiple gateway fallbacks for reliability). If no SDK slot exists, the ad appears as an overlay at the bottom-right of Alice's screen. If no campaigns matched at all, a default house ad linking to Polkadot's philosophy page appears instead.
7. **Tracks engagement** — an IntersectionObserver measures how long Alice sees the ad (dwell time), whether her tab is focused, scroll depth, and IAB viewability (50% visible for 1+ second). Low-quality views (under 1 second, unfocused tab) are rejected before any claim is built.
8. **Builds a hash-chain claim** — if engagement quality passes the threshold (score >= 0.3), the extension computes `blake2b(campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousClaimHash)` and queues the claim locally. The publisher field is Bob's address (resolved dynamically for open campaigns). No data about what Alice browsed leaves her device — only the cryptographic claim.

#### Step 5 — Claims are submitted on-chain

Alice can submit claims herself (paying gas) from the **Claims** tab, or sign them for Bob to relay (Bob pays gas, Alice pays nothing). If Alice enabled auto-submit, the extension submits every few minutes using a session-encrypted key.

The DatumSettlement contract validates each claim:
- Checks the hash chain is continuous (nonce = lastNonce + 1, previousClaimHash matches)
- Verifies the clearing CPM doesn't exceed the bid
- Deducts the payment from Carol's campaign budget via DatumCampaigns

#### Step 6 — Everyone gets paid

For each settled claim, the payment splits three ways:

```
Total payment: 0.05 DOT per 1000 views (clearing CPM from auction)
Bob (publisher, 40%):  0.020 DOT per 1000 views
Alice (user, 75% of remainder): 0.0225 DOT per 1000 views
Protocol (25% of remainder): 0.0075 DOT per 1000 views
```

Funds accumulate as pull-payment balances. Bob withdraws from the **Publisher** section in the web app, Alice from the **Earnings** tab in the extension. No push payments — everyone claims when they want.

#### Step 7 — Campaign lifecycle completes

Carol's campaign runs until one of these happens:
- **Budget exhausted** — the last settlement auto-completes the campaign
- **Carol completes it** — she clicks "Complete" in the Advertiser section, and any remaining budget is refunded
- **Governance terminates it** — if voters decide the campaign is harmful mid-run, nay votes can terminate it (90% refund to Carol, 10% to nay voters)
- **Inactivity timeout** — if no settlements occur for 30 days (432,000 blocks), anyone can call `expireInactiveCampaign` (P20)
- **Daily cap limits spending** — Carol never spends more than 1 DOT per day

Dave can withdraw his governance stake after his lockup expires. If he voted on the winning side, he gets his full stake back. If he voted on the losing side, he loses 10% — distributed to the winners after slash finalization.

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

### Smart contracts (17 contracts, Solidity on PolkaVM)

| Contract | Role |
|----------|------|
| `DatumZKVerifier` | Stub ZK proof verifier (real Groth16 post-alpha) |
| `DatumPauseRegistry` | Global emergency pause circuit breaker |
| `DatumPaymentVault` | Pull-payment vault (publisher/user/protocol balances) |
| `DatumTimelock` | Single-slot admin delay for governance changes |
| `DatumBudgetLedger` | Campaign escrow, daily caps, settlement tracking |
| `DatumPublishers` | Registry, take rates, S12 blocklist + allowlists |
| `DatumAttestationVerifier` | P1 mandatory publisher co-signature for all campaigns |
| `DatumGovernanceSlash` | Per-campaign slash pool finalization and winner rewards |
| `DatumCampaignLifecycle` | Complete/terminate/expire + P20 inactivity timeout |
| `DatumCampaigns` | Campaign creation, metadata, status management |
| `DatumTargetingRegistry` | Tag-based targeting (bytes32 tag hashes, AND-logic matching) |
| `DatumCampaignValidator` | Cross-contract campaign creation validation |
| `DatumClaimValidator` | Claim validation logic (extracted from Settlement) |
| `DatumRelay` | EIP-712 co-signature for gasless settlement |
| `DatumGovernanceV2` | Conviction voting (9 levels, 0-8), escalating lockups |
| `DatumGovernanceHelper` | Read-only governance aggregation helpers |
| `DatumSettlement` | Hash-chain validation, Blake2-256, 3-way payment split |

All contracts compile to PolkaVM (RISC-V) bytecode using resolc v1.0.0 with optimizer mode `z`. 219/219 tests passing.

### Browser extension — `alpha-3/extension/`

3-tab popup (Claims, Earnings, Settings), 17-contract support, Blake2-256 claim hashing, mandatory publisher attestation (P1), event-driven campaign polling with O(1) lookups, EIP-1193 provider bridge (`window.datum` compatible with `ethers.BrowserProvider`). 165/165 Jest tests, 0 webpack errors.

Key capabilities: Vickrey auction, engagement tracking, Blake2 hash-chain claims, IPFS multi-gateway, Shadow DOM ad injection, phishing list, content safety, AES-256-GCM multi-account wallet, auto-submit (B1), claim export (P6), timelock monitor (H2), relay POST, provider bridge for web app integration, batch-parallel RPC, tag-based campaign matching.

Previous extensions archived: alpha-2 in `archive/alpha-2/extension/`, alpha in `archive/alpha-extension/`.

### Web app

React + Vite, 24 pages covering all protocol roles: Explorer (browse without wallet), Advertiser (create/manage campaigns), Publisher (register/configure/earnings), Governance (vote/evaluate/slash), Admin (timelock/pause/blocklist/fees), Settings.

### Privacy model

The extension processes all browsing data locally. Page classification, campaign matching, auction, engagement tracking, and impression recording happen entirely on-device. The only data submitted on-chain is a hash-chain claim attesting that the user viewed N impressions for a given campaign. No URLs, page content, or browsing history leaves the browser.

## Repository layout

```
alpha-3/              Canonical contracts (17), tests (219), extension (165 tests), process flows
  contracts/          Solidity source (17 contracts + interfaces + mocks)
  test/               Hardhat test suite (219 tests)
  extension/          Browser extension (3 tabs, 165 Jest tests, Blake2, P1, provider bridge)
  hardhat.config.ts   Networks: hardhat, substrate (local Docker), polkadotTestnet, polkadotHub

web/                  Web app (React + Vite, 24 pages)
  src/pages/          Explorer, Advertiser, Publisher, Governance, Admin, Settings
  src/shared/         Alpha-3 ABIs (17), types, networks, conviction curve, error codes
  src/components/     Shared UI components
  src/context/        Wallet + Settings providers

sdk/                  Publisher SDK (datum-sdk.js + example)
docs/                 Demo page + relay template
archive/              PoC, alpha (9-contract), alpha-2 (13-contract), alpha extension, old extension

STATUS.md             Current project status + critical path
```

## Getting started

### Prerequisites

- Node.js 18+
- Docker (for the local substrate devchain)
- Chrome (the extension has an embedded wallet -- no external wallet extension required)

### Contracts

```bash
cd alpha-3
npm install

# Run tests (Hardhat EVM)
npx hardhat test             # 219/219 pass

# Compile for PolkaVM
npx hardhat compile --network polkadotHub   # requires resolc v1.0.0
```

### Web app

```bash
cd web
npm install
npm run dev                  # Vite dev server
npm run build                # Production build (dist/)
npm run type-check           # TypeScript validation
```

### Local devchain

```bash
cd alpha-3

# Start substrate node + eth-rpc adapter (Docker)
docker compose up -d

# Deploy 17 contracts with full wiring + ownership transfer
npx hardhat run scripts/deploy.ts --network substrate

# Post-deploy setup (fund accounts, register publishers, create test campaign)
npx hardhat run scripts/setup-testnet.ts --network substrate
```

**Devchain notes:** Pallet-revive gas is in weight units (~10^15). Each contract call costs ~5x10^21 planck in gas, so test accounts need ~10^24 planck each. The eth-rpc denomination rounding rule rejects transfers where `value % 10^6 >= 500_000` — use clean multiples of 10^6 planck for all on-chain values.

### Paseo testnet (live)

17 alpha-3 contracts are deployed on Paseo (Chain ID 420420417) with an active test campaign. The web app is live at **https://datum.javcon.io**.

| Resource | URL |
|----------|-----|
| Web App | https://datum.javcon.io |
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | https://blockscout-testnet.polkadot.io/ |
| Faucet | https://faucet.polkadot.io/ (select "Paseo") |

Contract addresses are in `alpha-3/deployed-addresses.json`. Deployment details are in `STATUS.md`.

```bash
cd alpha-3
export DEPLOYER_PRIVATE_KEY="0x..."

# Deploy 17 contracts + wire + ownership transfer
npx hardhat run scripts/deploy.ts --network polkadotTestnet

# Fund accounts, register publishers, create test campaign
npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet
```

### Claim export/import

The extension supports encrypted claim state portability (P6):

1. Claims tab -> "Export Claims" -> wallet signs authentication message -> downloads encrypted `.dat` file
2. Claims tab -> "Import Claims" -> select `.dat` file -> decrypts with wallet signature -> merges with existing state
3. Import validates address match, checks on-chain nonces, deduplicates, keeps higher nonce

## Status

See [STATUS.md](STATUS.md) for detailed project status and critical path.

- [x] **PoC** -- 7 contracts, 64/64 tests (archived)
- [x] **Alpha** -- 9 contracts deployed on Paseo, 132/132 tests (archived)
- [x] **Alpha-2** -- 13 contracts, 187/187 tests, extension 165/165, Paseo deploy (archived)
- [x] **Alpha-3 contracts** -- 17 contracts (4 new satellites: TargetingRegistry, CampaignValidator, ClaimValidator, GovernanceHelper), 219/219 tests
- [x] **Extension (alpha-3)** -- 165/165 tests, 17-contract, event-driven polling, O(1) lookups, batch-parallel RPC
- [x] **Web app** -- 24 pages, React + Vite, 17-contract support, deep-merge settings fix
- [x] **Publisher SDK + relay** -- SDK embed tag, reference relay implementation, demo page
- [x] **Paseo testnet** -- 17 alpha-3 contracts deployed, test campaign active, all wiring validated
- [x] **Blake2 hash migration** -- extension + relay both use `@noble/hashes/blake2.js`, matches Settlement on PolkaVM
- [x] **Security audit (CRITICAL/HIGH)** -- C-1, C-2, H-1, H-2, H-3 all fixed
- [ ] **E2E browser validation** -- full flow on Paseo with extension + relay + web app
- [ ] **Open testing** -- publish addresses, external tester flow
- [ ] **Mainnet** -- Kusama -> Polkadot Hub

## Why PolkaVM

DATUM targets Polkadot Hub via pallet-revive rather than an EVM chain:

- **Native DOT settlement** -- campaign escrow, governance stakes, and payments are all in native DOT with no bridges or wrapped tokens
- **Shared security** -- contracts execute on Polkadot Hub directly, inheriting relay chain security
- **XCM interoperability** -- future cross-chain features (fee routing, cross-chain governance) become native XCM calls
- **Ecosystem alignment** -- Polkadot identity primitives, OpenGov tooling, and treasury funding are directly accessible

The tradeoffs are real: resolc produces 10-20x larger bytecode than solc (some alpha-3 contracts exceed the 49,152 B nominal limit but deploy fine on Paseo), cross-contract calls are more expensive, and the toolchain is maturing. But the Solidity source is portable -- if pallet-revive doesn't mature, deployment to an EVM parachain remains viable.

## Known limitations

- **Daily cap timestamp:** `DatumCampaigns` uses `block.timestamp / 86400` for daily cap tracking. Block validators can manipulate timestamps by ±15 seconds, which is negligible relative to the 86,400-second daily period (<0.02% error).
- **Unclaimed slash rewards:** `DatumGovernanceSlash.sweepSlashPool()` reclaims unclaimed rewards after 365 days (M4 — implemented).
- **Denomination rounding:** The pallet-revive eth-rpc adapter rejects value transfers where `value % 10^6 >= 500_000`. All on-chain payment amounts (settlement splits, governance stakes, withdrawals) must be clean multiples of 10^6 planck. This is a pallet-revive/eth-rpc quirk, not an existential deposit issue.
- **PVM size limit:** The nominal 49,152 B limit is not enforced on Paseo testnet. GovernanceV2 deploys at ~57 KB. This may be enforced on mainnet.

## Deferred (explicitly out of scope for alpha)

| Item | Status |
|------|--------|
| ZK proof of auction/engagement | Stub verifier deployed; real Groth16 requires BN128 pairing precompile (P9) |
| Decentralized KYB identity | Permissionless for alpha; evaluating zkMe and Polkadot PoP for beta (P10) |
| HydraDX XCM fee routing | Protocol fees accumulate in contract; XCM routing post-alpha (P11) |
| External wallet integration | Multi-account embedded wallet; WalletConnect v2 post-alpha (P17) |
| ~~Multi-publisher campaigns~~ | **Done** — open campaigns (`publisher = address(0)`) allow any matching publisher (P5) |
| Contract upgrade path | Non-upgradeable; UUPS proxy or migration for beta (P7) |
| ~~Mandatory publisher attestation~~ | **Done** — `DatumAttestationVerifier` enforces EIP-712 publisher co-sig for all campaigns (P1) |
| Rich media ad rendering | Text creatives with IPFS metadata (title, body, CTA); image/video post-alpha |
| ~~Tag-based targeting~~ | **Done** — `DatumTargetingRegistry` with bytes32 tag hashes replaces category bitmask (TX-1) |

## License

Apache-2.0
