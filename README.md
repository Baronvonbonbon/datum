# DATUM

**Decentralized Ad Targeting Utility Marketplace**

An experiment in building an automated, privacy-preserving ad exchange on Polkadot Hub using pallet-revive (PolkaVM). DATUM explores the feasibility of on-chain programmatic advertising where users are directly compensated in DOT for their attention, no personal data leaves the user's device, and advertisers receive cryptographic assurance that impressions are real.

## Motivation

The digital advertising industry is built on surveillance. Users are tracked across the web, their behavior profiled and sold, while receiving nothing in return. Ad fraud costs advertisers billions annually, and publishers depend on opaque intermediaries that extract most of the value.

DATUM asks: what if the economics worked differently?

- **Users** earn DOT for viewing ads. Their browsing data stays on their device. The only information that leaves is a cryptographic attestation that they participated in an ad campaign.
- **Advertisers** get verifiable impressions backed by hash-chain proofs, settled transparently on-chain with no intermediary markup.
- **Publishers** embed a lightweight SDK on their sites, set their own take rates and content categories, and receive payment directly through smart contract settlement.

## How it works

1. **Advertisers** create campaigns by depositing DOT into the DatumCampaigns contract, specifying a bid CPM and category target. Campaigns can target a specific publisher or be **open** (any matching publisher can serve them).
2. **Governance reviewers** stake DOT to vote on campaign quality with conviction multipliers (0-6x). Campaigns activate when aye votes cross a majority threshold with quorum; nay votes can terminate bad campaigns. Losing-side voters pay a symmetric slash (10% of stake), distributed to winning-side voters.
3. **Publishers** embed the DATUM SDK (`<script src="datum-sdk.js">`) on their sites, declaring ad categories and providing a `<div id="datum-ad-slot">` placement. The SDK performs a challenge-response handshake with the extension for two-party impression attestation.
4. **Users** browse the web with the DATUM Chrome extension. The extension detects the SDK, filters campaigns by category overlap, runs a second-price auction, and records impressions as hash-chain claims -- all on-device. When no campaigns match, a default house ad appears linking to the Polkadot philosophy.
5. **Settlement** happens when claims are submitted on-chain. The contract validates the hash chain, deducts from campaign budget, and splits payment three ways: publisher (configurable 30-80%), user (75% of remainder), and protocol (25% of remainder).

No ad server. No tracking pixels. No user profiles leaving the browser.

### Walkthrough — Alice, Bob, Carol, and Dave

Four people use DATUM. **Alice** is a user who browses the web. **Bob** publishes a tech blog. **Carol** is an advertiser selling hardware wallets. **Dave** reviews campaigns as a governance voter.

#### Step 1 — Bob registers as a publisher and sets up the SDK

Bob opens the DATUM extension, goes to the **Publisher** tab, and registers his address on the DatumPublishers contract. He sets his take rate at 40% (capped between 30-80%). This means Bob keeps 40% of every impression payment that flows through his campaigns.

Bob then sets his **content categories** — he checks "Computers & Electronics" and "Science" from the 26-category taxonomy. The extension calls `setCategories(bitmask)` on-chain, recording which ad categories Bob's site accepts.

Finally, Bob copies the **SDK embed snippet** from the Publisher tab and adds it to his site:

```html
<script src="datum-sdk.js" data-categories="5,24" data-publisher="0xBob..."></script>
<div id="datum-ad-slot"></div>
```

The SDK tag declares Bob's categories and publisher address. The `<div>` is where ads will render inline on Bob's page. When a DATUM user visits, the SDK performs a challenge-response handshake with their extension — creating a two-party attestation that the impression is real.

#### Step 2 — Carol creates a campaign

Carol opens the **My Ads** tab and creates a campaign:
- Deposits **10 DOT** as the escrow budget
- Sets a daily cap of **1 DOT** (prevents burning through budget in one day)
- Bids **0.05 DOT per 1000 impressions** (her maximum CPM)
- Toggles **"Open Campaign"** — this means any publisher matching her category can serve the ad. (Alternatively, she could select Bob specifically as the publisher.)
- Picks the "Computers & Electronics" category
- Fills out the ad creative: title, body text, CTA button label, and a landing page URL (HTTPS only)
- Pins the creative metadata to IPFS (the extension validates it against content safety rules before pinning)

The campaign goes on-chain with status **Pending**. Carol's 10 DOT is locked in the DatumCampaigns contract. The creative's IPFS hash is stored as a bytes32 event. Because Carol chose an open campaign, the on-chain publisher field is `address(0)` — any registered publisher matching the category can serve it.

#### Step 3 — Dave votes to activate the campaign

Dave opens the **Govern** tab and sees Carol's campaign in the Pending list. He reads the creative metadata and decides it's legitimate. He votes **Aye** with 0.5 DOT at conviction level 2 (4x weight multiplier, 4-day lockup):
- His vote weight: 0.5 DOT x 4 = 2.0 DOT effective
- His stake is locked for ~4 days (57,600 blocks)

Other voters also stake. Once total weighted votes exceed the quorum (100 DOT) and aye votes are above 50%, anyone can call **evaluateCampaign** — the campaign moves to **Active** and Carol's ads start appearing.

If the community had voted Nay instead (nay >= 50%), the campaign would be **Terminated**: 90% of Carol's budget refunded, 10% slashed to reward nay voters. Losing-side voters always pay a 10% slash on their stake.

#### Step 4 — Alice browses the web and sees an ad

Alice visits Bob's tech blog. The DATUM content script (running entirely in her browser):

1. **Detects the Publisher SDK** — Bob's page has the DATUM SDK tag. The extension reads his publisher address and declared categories.
2. **Classifies the page** against 26 categories using domain, title, and meta tag signals. Bob's site scores high for "Computers & Electronics."
3. **Filters campaigns by category overlap** — Carol's open campaign targets "Computers & Electronics" and Bob's SDK declares that same category. The campaign is eligible.
4. **Runs a second-price auction** — if multiple campaigns match, the highest effective bid wins but pays the second-highest price. Solo campaigns pay 70% of their bid. Alice's interest profile weights the bids (tech-interested users make tech campaigns bid higher).
5. **Performs a handshake** — the extension sends a random challenge to the SDK via `CustomEvent`. The SDK responds with a signature, creating a two-party attestation that this impression is real (not fabricated by a modified extension).
6. **Injects an ad inline** — Carol's creative renders inside Bob's `<div id="datum-ad-slot">` via Shadow DOM (isolated from page CSS/JS). When IPFS metadata is available, the ad displays the title as a header, creative body text, and a CTA button linking to the landing page URL. On metadata cache miss, the extension requests the background service worker to fetch from IPFS (using multiple gateway fallbacks for reliability). If no SDK slot exists, the ad appears as an overlay at the bottom-right of Alice's screen. If no campaigns matched at all, a default house ad linking to Polkadot's philosophy page appears instead.
7. **Tracks engagement** — an IntersectionObserver measures how long Alice sees the ad (dwell time), whether her tab is focused, scroll depth, and IAB viewability (50% visible for 1+ second). Low-quality views (under 1 second, unfocused tab) are rejected before any claim is built.
8. **Builds a hash-chain claim** — if engagement quality passes the threshold (score >= 0.3), the extension computes `keccak256(campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousClaimHash)` and queues the claim locally. The publisher field is Bob's address (resolved dynamically for open campaigns). No data about what Alice browsed leaves her device — only the cryptographic claim.

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

Funds accumulate as pull-payment balances. Bob withdraws from the **Publisher** tab, Alice from the **Earnings** tab. No push payments — everyone claims when they want.

#### Step 7 — Campaign lifecycle completes

Carol's campaign runs until one of these happens:
- **Budget exhausted** — the last settlement auto-completes the campaign
- **Carol completes it** — she clicks "Complete" in the My Ads tab, and any remaining budget is refunded
- **Governance terminates it** — if voters decide the campaign is harmful mid-run, nay votes can terminate it (90% refund to Carol, 10% to nay voters)
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

### Smart contracts (9 contracts, Solidity on PolkaVM)

| Contract | PVM Size | Role |
|----------|----------|------|
| `DatumPauseRegistry` | 4 KB | Global emergency pause circuit breaker |
| `DatumTimelock` | 18 KB | 48-hour admin delay for contract reference changes |
| `DatumPublishers` | 23 KB | Publisher registry, take-rate management (30-80%), category bitmask (26 categories) |
| `DatumCampaigns` | 49 KB | Campaign lifecycle: creation (open or publisher-specific), activation, pausing, completion, termination, expiry |
| `DatumGovernanceV2` | 40 KB | Conviction voting (0-6x), evaluateCampaign(), inline symmetric slash, minimumBalance dust prevention |
| `DatumGovernanceSlash` | 30 KB | Slash pool finalization and winner reward claims |
| `DatumSettlement` | 49 KB | Hash-chain validation, claim processing, 3-way payment split, open campaign resolution, optional ZK |
| `DatumRelay` | 46 KB | EIP-712 user + publisher co-signature verification for gasless settlement, open campaign co-sig skip |
| `DatumZKVerifier` | 1 KB | Stub ZK proof verifier (wired to Settlement for future Groth16 proofs) |

All contracts compile to PolkaVM (RISC-V) bytecode under the 49,152-byte initcode limit using resolc v0.3.0 with optimizer mode `z`. DatumCampaigns and DatumSettlement ownership is transferred to DatumTimelock post-deploy for admin safety.

### Browser extension (Chrome MV3, 7 tabs)

| Tab | Function |
|-----|----------|
| Campaigns | Active campaigns with block/unblock, collapsible 26-category filter, campaign info |
| Claims | Pending claims, submit (you pay gas) or sign for publisher relay (zero gas), export/import |
| Earnings | User balance in DOT, withdraw, engagement stats (dwell, viewable, viewability rate) |
| Publisher | Publisher balance, withdraw, relay submit, take rate management, category checkboxes, SDK embed snippet |
| My Ads | Advertiser campaign controls: pause/resume/complete/expire, campaign creation (open or publisher-specific) |
| Govern | Conviction voting (0-6x), evaluateCampaign, withdraw with slash, slash finalization + reward claiming |
| Settings | Network, RPC (with connectivity test), 9 contract addresses (with mismatch detection), IPFS gateway, auto-submit (with deauth warning), ad preferences, interest profile |

Key subsystems:
- **Publisher SDK** -- lightweight JS tag (`datum-sdk.js`) with challenge-response handshake for two-party impression attestation; inline ad injection into publisher-provided `<div id="datum-ad-slot">`
- **Open campaigns** -- campaigns with `publisher = address(0)` are served by any publisher whose categories overlap; publisher resolved dynamically at impression time
- **Default house ad** -- when no campaigns match, a default ad linking to Polkadot philosophy appears (inline or overlay)
- **IPFS metadata rendering** -- ad overlay displays rich content from IPFS (title, body, CTA button); multi-gateway fallback (dweb.link, ipfs.io, cloudflare-ipfs, Pinata) with background fetch to bypass CSP
- **Second-price auction** (P19) -- Vickrey auction: effectiveBid = bidCpm x interestWeight, solo campaigns at 70%, floor at 30%
- **Behavioral analytics** (P16) -- on-device engagement capture (dwell time, scroll depth, tab focus, viewability), behavior hash chain, quality scoring, engagement-weighted CPM
- **Claim portability** (P6) -- encrypted export/import of claim state (AES-256-GCM, HKDF key from wallet signature)
- **Multi-account wallet** -- AES-256-GCM encrypted private keys with PBKDF2 key derivation; named accounts with switch/rename/delete, legacy migration; signs all transactions directly

### Privacy model

The extension processes all browsing data locally. Page classification, campaign matching, auction, engagement tracking, and impression recording happen entirely on-device. The only data submitted on-chain is a hash-chain claim attesting that the user viewed N impressions for a given campaign. The claim contains no URLs, no page content, no browsing history. Category targeting and ad selection are resolved client-side via the on-device auction.

## Repository layout

```
alpha/
  contracts/          Solidity source (9 contracts + interfaces + mocks)
  test/               Hardhat test suite (132 tests)
  scripts/            deploy.ts, setup-testnet.ts, e2e-full-flow.ts, fund-test-accounts.ts, setup-test-campaign.ts, benchmark-gas.ts, fund-wallet.ts
  hardhat.config.ts   Networks: hardhat, substrate (local Docker), polkadotTestnet, polkadotHub

alpha-extension/
  src/background/     Auction, engagement chain, claim builder, campaign poller, auto-submit
  src/content/        SDK detection, handshake, 26-category classifier, ad slot injection (inline + overlay + default), engagement tracking
  src/popup/          React UI: 7 tabs (Campaigns, Claims, Earnings, Publisher, My Ads, Govern, Settings)
  src/shared/         Types, ABIs, contract factories, claim export, wallet manager, networks

sdk/
  datum-sdk.js        Publisher SDK tag — CustomEvent protocol for handshake + category declaration
  example-publisher.html  Demo page with SDK integration

poc/                  PoC MVP (frozen, tagged poc-complete) -- 64/64 tests, 7 contracts
extension/            PoC extension (frozen)

ALPHA.md              Alpha build roadmap, checklist, PVM size lessons
SYSTEM-FLOW.md        Detailed process flows for every role and subsystem
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
npx hardhat test             # 132/132 pass

# Compile for PolkaVM
npx hardhat compile --network polkadotHub   # requires resolc v0.3.0
```

### Extension

```bash
cd alpha-extension
npm install
npm run build                # output in dist/ (popup.js 603KB, background.js 379KB, content.js 39KB)
```

Load in Chrome: `chrome://extensions` -> Developer mode -> Load unpacked -> select `alpha-extension/dist/`

### Local devchain

```bash
cd alpha

# Start substrate node + eth-rpc adapter (Docker)
docker compose up -d

# Deploy 9 contracts with full wiring + ownership transfer
npx hardhat run scripts/deploy.ts --network substrate

# Run full E2E flow (campaign lifecycle, settlement, withdrawals, pause, slash, timelock)
npx hardhat run scripts/e2e-full-flow.ts --network substrate

# Fund 24 test accounts (advertisers, viewers, publishers, voters, ED edge cases)
npx hardhat run scripts/fund-test-accounts.ts --network substrate

# Or fund a single wallet
TARGET=0xYourAddress npx hardhat run scripts/fund-wallet.ts --network substrate
```

Deploy script writes `deployed-addresses.json` to both `alpha/` and `alpha-extension/` -- the extension auto-loads addresses on reload.

**Devchain notes:** Pallet-revive gas is in weight units (~10^15). Each contract call costs ~5x10^21 planck in gas, so test accounts need ~10^24 planck each. The eth-rpc denomination rounding rule rejects transfers where `value % 10^6 >= 500_000` — use clean multiples of 10^6 planck for all on-chain values.

### Paseo (live deployment)

All 9 contracts are deployed on Paseo (Chain ID 420420417):

| Contract | Address |
|----------|---------|
| PauseRegistry | `0xFa0e0D4cb23a9616f780Cb0Ad4055E9b5fE6d1bD` |
| Timelock | `0x68003Ae2711dE93e66882591FD80F10105183831` |
| Publishers | `0x3dF89c128F7E3b80d3220f0EB3c8bf8C0F351d46` |
| Campaigns | `0x1337cD3be712079688EbbD2DA2455F981522ab1d` |
| GovernanceV2 | `0x708356253c389bE1b0182e2c757468052Ec8CbA8` |
| GovernanceSlash | `0xF6232d3050e34240250Ff514e6279C63DEBDfD86` |
| Settlement | `0x6dCbe782CFa9255adc94fdb821E6A7bc092fccc3` |
| Relay | `0x0c2F453B48f4eC13f4c6f4d5708765A2f57Ca65B` |
| ZKVerifier | `0x00e95AC62efAf6250c0f15df4812122C8854DF90` |

**RPC:** `https://eth-rpc-testnet.polkadot.io/` | **Explorer:** https://blockscout-testnet.polkadot.io/ | **Faucet:** https://faucet.polkadot.io/

```bash
cd alpha
export DEPLOYER_PRIVATE_KEY="your-key"

# Deploy (if redeploying)
npm run deploy:testnet

# Automated post-deploy setup (fund accounts, register publishers, create campaign, vote, activate)
npm run setup:testnet
```

The extension defaults to Paseo with these addresses hardcoded. Build and load in Chrome to test against live contracts.

**Gas benchmarks (testnet, gasPrice=10^12):**

| Function | Gas | Cost (DOT) | ~USD @$5 |
|----------|-----|-----------|----------|
| `createCampaign` | 210,696 | 0.2107 | $1.05 |
| `vote` | 106,762 | 0.1068 | $0.53 |
| `evaluateCampaign` | 3,898 | 0.0039 | $0.02 |
| `settleClaims (1)` | 112,215 | 0.1122 | $0.56 |
| `settleClaims (5)` | 73,868 | 0.0739 | $0.37 |
| `withdraw` | 1,762 | 0.0018 | $0.01 |

Settlement batching is sub-linear: per-claim drops from 0.112 DOT to 0.015 DOT in a 5-claim batch.

### Claim export/import

The extension supports encrypted claim state portability (P6):

1. Claims tab -> "Export Claims" -> wallet signs authentication message -> downloads encrypted `.dat` file
2. Claims tab -> "Import Claims" -> select `.dat` file -> decrypts with wallet signature -> merges with existing state
3. Import validates address match, checks on-chain nonces, deduplicates, keeps higher nonce

## Status

- [x] **PoC** -- 7 contracts, 64/64 Hardhat tests, local devnet verified (tagged `poc-complete`)
- [x] **Alpha contracts** -- 9 contracts (V2 governance, global pause, admin timelock, PVM size reduction, open campaigns, publisher categories), 132/132 tests
- [x] **Alpha extension** -- V2 overhaul (7 tabs), Publisher SDK + handshake, open campaign support, default house ad, second-price auction (P19), behavioral analytics (P16), claim portability (P6), 26-category taxonomy, engagement quality scoring, multi-account wallet (MA-1 through MA-4), phishing list integration, IPFS metadata rendering in ad overlay (multi-gateway fallback), UX audit Phase 1+2 complete, 140/140 Jest tests, 0 webpack errors
- [x] **Publisher SDK** -- `datum-sdk.js` with challenge-response attestation protocol, inline ad injection, `example-publisher.html` demo
- [x] **Local devnet E2E** -- 9 contracts deployed on pallet-revive substrate devchain, all 6 E2E sections pass: campaign lifecycle, settlement (1M impressions, 16 DOT payment), withdrawals, pause/unpause, governance slash, timelock (A3.2)
- [x] **Paseo deployment** -- all 9 contracts deployed (Chain ID 420420417), ECRecover verified, test campaign active, 6 accounts funded, 2 publishers registered, Diana set to all 26 categories (A3.3)
- [x] **Publisher relay** -- publisher relay endpoint (Diana), co-signs attestations + submits claims, demo index page with inline ad slot
- [ ] **Browser E2E on Paseo** -- load extension in Chrome, verify full ad display + claim flow on testnet (A3.4)
- [ ] **Open testing** -- publish addresses, external tester instructions (A3.5)
- [ ] **Mainnet** -- Kusama -> Polkadot Hub

## Why PolkaVM

DATUM targets Polkadot Hub via pallet-revive rather than an EVM chain:

- **Native DOT settlement** -- campaign escrow, governance stakes, and payments are all in native DOT with no bridges or wrapped tokens
- **Shared security** -- contracts execute on Polkadot Hub directly, inheriting relay chain security
- **XCM interoperability** -- future cross-chain features (fee routing, cross-chain governance) become native XCM calls
- **Ecosystem alignment** -- Polkadot identity primitives, OpenGov tooling, and treasury funding are directly accessible

The tradeoffs are real: resolc produces 10-20x larger bytecode than solc (DatumCampaigns and DatumSettlement have <400 bytes spare), cross-contract calls are more expensive, and the toolchain is maturing. But the Solidity source is portable -- if pallet-revive doesn't mature, deployment to an EVM parachain remains viable.

## Known limitations

- **Daily cap timestamp:** `DatumCampaigns` uses `block.timestamp / 86400` for daily cap tracking. Block validators can manipulate timestamps by ±15 seconds, which is negligible relative to the 86,400-second daily period (<0.02% error).
- **Unclaimed slash rewards:** `DatumGovernanceSlash` has no expiry deadline for unclaimed rewards. Unclaimed funds remain locked. A sweep function is planned for beta (M4).
- **Denomination rounding:** The pallet-revive eth-rpc adapter rejects value transfers where `value % 10^6 >= 500_000`. All on-chain payment amounts (settlement splits, governance stakes, withdrawals) must be clean multiples of 10^6 planck. This is a pallet-revive/eth-rpc quirk, not an existential deposit issue.

## Deferred (explicitly out of scope for alpha)

| Item | Status |
|------|--------|
| ZK proof of auction/engagement | Stub verifier deployed; real Groth16 requires BN128 pairing precompile (P9) |
| Decentralized KYB identity | Permissionless for alpha; evaluating zkMe and Polkadot PoP for beta (P10) |
| HydraDX XCM fee routing | Protocol fees accumulate in contract; XCM routing post-alpha (P11) |
| External wallet integration | Multi-account embedded wallet; WalletConnect v2 post-alpha (P17) |
| ~~Multi-publisher campaigns~~ | **Done** — open campaigns (`publisher = address(0)`) allow any matching publisher (P5) |
| Contract upgrade path | Non-upgradeable; UUPS proxy or migration for beta (P7) |
| Mandatory publisher attestation | Optional co-signature (degraded trust mode); mandatory post-alpha (P1) |
| Rich media ad rendering | Text creatives with IPFS metadata (title, body, CTA); image/video post-alpha |

## License

MIT
