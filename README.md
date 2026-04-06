# DATUM

**Decentralized Ad Targeting Utility Marketplace**

An experiment in building an automated, privacy-preserving ad exchange on Polkadot Hub using pallet-revive (PolkaVM). Advertisers create campaigns denominated in DOT; publishers embed a lightweight SDK; users earn DOT (and optionally ERC-20 tokens) for verified impressions — all settled on-chain with no intermediary, no surveillance, and no personal data leaving the browser.

---

## Roles and Revenue Streams

### Advertisers

Advertisers deposit DOT into escrow when creating a campaign and define a bid CPM, daily cap, and targeting tags. They can target a specific publisher or create an **open campaign** (`publisher = address(0)`) that any matching publisher can serve.

**Revenue / cost flows:**
- **Spend:** DOT escrow is deducted per verified impression at the clearing CPM.
- **Reclaim:** Unspent escrow is returned via `CampaignLifecycle.completeCampaign()`.
- **Governance outcome:** If a campaign fails governance review (nay quorum), 90% of remaining budget is refunded and 10% is slashed to nay voters. Advertisers whose campaigns pass can claim slash rewards from nay-side voters.
- **ERC-20 sidecar:** Advertisers can optionally pair a campaign with an ERC-20 token reward by supplying a `rewardToken` address and a `rewardPerImpression` amount when calling `createCampaign()`. They pre-seed the `DatumTokenRewardVault` with tokens before the campaign goes live. Settlement credits tokens to users on every impression alongside DOT; if the token budget runs dry, DOT settlement continues unaffected.

### Publishers

Publishers register on-chain, set their take rate (30–80%), configure targeting tags, and embed the SDK on their sites. A relay signer EOA (typically the relay bot) co-signs attestations so users can settle at zero gas cost.

**Revenue / cost flows:**
- **DOT take rate:** A configurable share (30–80%) of every clearing payment flows directly to the publisher's balance in `DatumPaymentVault`. The rate is snapshot-locked at campaign creation — mid-campaign changes don't affect existing campaigns.
- **ERC-20 token rewards:** If the campaign has a token reward configured, publishers receive token credits proportional to their take rate from `DatumTokenRewardVault` on each settled impression.
- **Gas costs:** Publishers running a relay bot pay gas for attested batch submissions; this is offset by the take rate income at any meaningful impression volume.
- **Withdrawal:** Pull-payment via `PaymentVault.withdrawPublisher()` (DOT) and `TokenRewardVault.withdraw(token)` (ERC-20) at any time. An optional `withdrawTo(recipient)` enables cold-wallet sweeps.

### Users

Users browse the web with the DATUM Chrome extension. The extension detects publisher SDK embeds, classifies pages against campaign targeting tags, runs a Vickrey second-price auction, and builds hash-chain claims entirely on-device. No browsing data leaves the browser.

**Revenue / cost flows:**
- **DOT impressions:** After the publisher take rate is deducted, 75% of the remainder goes to the user and 25% to the protocol. At a 40% publisher take and 0.05 DOT/1000 CPM, a user earns 0.0225 DOT per 1000 verified impressions.
- **ERC-20 sidecar tokens:** If the campaign has a token reward, users earn `impressionCount × rewardPerImpression` of the ERC-20 token per settlement, credited in `DatumTokenRewardVault`. Claimed via `withdraw(token)`.
- **Zero-gas path:** Users co-sign claims with the publisher relay signer (EIP-712); the relay bot submits the batch and pays gas. Users see their DOT and token balances grow with no on-chain interaction required.
- **Self-submit path:** Users can submit claims directly via `Settlement.settleClaims()` and pay gas themselves.

### Governance Voters

Any DOT holder can review pending campaigns in the Governance section of the web app. They stake DOT with a conviction multiplier (0–8×, nine levels) — higher conviction means more voting weight but a longer lockup period (0 days to 365 days).

**Revenue / cost flows:**
- **Slash rewards:** When a campaign resolves, the losing side (nay voters on activated campaigns, aye voters on terminated ones) has 10% of their stake redistributed proportionally to winning-side voters via `DatumGovernanceSlash`. Winning voters claim their share via `claimReward(campaignId)`.
- **Stake return:** Winning voters recover 100% of their stake after lockup expires. Losing voters receive 90%.
- **Opportunity cost:** Stake is locked for the conviction period with no additional yield beyond the slash reward. Higher conviction levels risk larger absolute losses on the losing side.

### Protocol (admin / treasury)

The protocol takes 25% of the advertiser-net (post-publisher-take) on every settlement and accumulates it in `DatumPaymentVault`. Governance slash pools that go unclaimed for 365 days are swept to the protocol. Admin actions (blocklist updates, fee changes, contract wiring) route through a 48-hour `DatumTimelock`.

**Revenue / cost flows:**
- **Settlement fee:** 25% × (1 − publisher take rate) × clearing CPM × impressions per batch.
- **Unclaimed slash sweep:** `GovernanceSlash.sweepSlashPool()` reclaims slash rewards not collected within 365 days.
- **Fee extraction:** `PaymentVault.sweepProtocolFees(to)` transfers the accumulated protocol balance to any target address.

### Relay Bot (Eve)

A lightweight Node.js service run by a publisher (or third-party relay operator). It co-signs attestations with the publisher's relay signer key, accepts claim batches from users via HTTP, submits them on-chain, and records per-(publisher, campaign) reputation stats after each batch.

**Revenue / cost flows:**
- No direct on-chain revenue. Relay operators are compensated indirectly by the publisher (who pays gas on attested submissions) or may charge the publisher off-chain. A relay operator serving multiple publishers at scale can negotiate fees bilaterally.
- After each batch: parses `ClaimSettled` and `ClaimRejected` events and calls `DatumPublisherReputation.recordSettlement()` per unique `(publisher, campaignId)` pair (BM-8 reputation + BM-9 anomaly detection).

---

## ERC-20 Sidecar Tokens

Advertisers can pair any DOT campaign with an ERC-20 token reward — their own project token, a governance token, a stablecoin, or any Asset Hub token. The mechanism:

1. **Campaign creation:** `createCampaign(..., rewardToken, rewardPerImpression)` records the token address and per-impression reward amount on-chain in `DatumCampaigns`.
2. **Budget seeding:** Before or during the campaign, the advertiser calls `ERC20.approve(tokenRewardVault, amount)` then `TokenRewardVault.depositCampaignBudget(campaignId, token, amount)` to pre-fund the vault. The vault holds tokens per-campaign.
3. **Settlement credit:** On each settled impression, `DatumSettlement` calls `TokenRewardVault.creditReward(campaignId, token, user, amount)` non-critically — if the token budget is exhausted or the call reverts, DOT settlement proceeds unaffected.
4. **Withdrawal:** Users call `TokenRewardVault.withdraw(token)` to pull their accumulated ERC-20 balance. `withdrawTo(token, recipient)` enables cold-wallet sweeps.
5. **Reclaim:** Advertisers can recover unspent token budget via `reclaimExpiredBudget(campaignId, token)` after the campaign ends.

Publishers receive a proportional share of token rewards (mirroring their DOT take rate) credited to their vault balance.

---

## Settlement and Validation

```
[User Extension]
  hash-chain claim (blake2b: campaignId, publisher, user, impressions, CPM, nonce, prevHash)
      ↓
[AttestationVerifier.settleClaimsAttested(batch, publisherSig)]  ← relay path (zero gas for user)
      or
[Settlement.settleClaims(batch)]                                  ← direct path
      ↓
[DatumClaimValidator]
  ├─ chain continuity (nonces, prevHash)
  ├─ campaign active + publisher match
  ├─ clearing CPM ≤ bid CPM
  ├─ impression count ≤ 100,000
  ├─ S12 blocklist check (Publishers staticcall)
  ├─ BM-2 per-user impression cap
  ├─ BM-5 rate limiter (RateLimiter staticcall)
  ├─ BM-7 advertiser allowlist
  └─ ZK proof if requireZkProof=true (real Groth16 / BN254)
      ↓
[DatumBudgetLedger.deductSettlement(campaignId, amount)]
  ├─ daily cap check
  └─ deduct from escrow
      ↓
[DatumPaymentVault.credit(publisher, user, protocol, amounts)]
  ├─ publisher += takeRate%
  ├─ user     += 75% of remainder
  └─ protocol += 25% of remainder
      ↓ (non-critical, does not block DOT settlement)
[DatumTokenRewardVault.creditReward(campaignId, token, user, amount)]
  └─ user token balance += impressions × rewardPerImpression
      ↓
[Eve relay-bot: parse ClaimSettled / ClaimRejected events]
[DatumPublisherReputation.recordSettlement(publisher, campaignId, settled, rejected)]
```

---

## Architecture

### Smart Contracts — 21 contracts, Solidity on PolkaVM

| Group | Contract | Role |
|-------|----------|------|
| Infrastructure | `DatumZKVerifier` | Groth16 / BN254 verifier; verifying key set post-deploy |
| Infrastructure | `DatumPauseRegistry` | Global emergency pause circuit breaker |
| Infrastructure | `DatumTimelock` | 48h admin delay for sensitive config changes |
| Infrastructure | `DatumPaymentVault` | Pull-payment vault: publisher, user, and protocol DOT balances |
| Infrastructure | `DatumTokenRewardVault` | Pull-payment vault for ERC-20 sidecar token rewards; per-campaign budgets |
| Campaign | `DatumBudgetLedger` | Campaign escrow, daily caps, settlement deduction |
| Campaign | `DatumTargetingRegistry` | bytes32 tag registry (AND-logic, 32/publisher, 8/campaign) |
| Campaign | `DatumCampaignValidator` | Creation-time validation satellite: registration, tags, take rate |
| Campaign | `DatumCampaigns` | Campaign creation, metadata, status, relay signer + tag snapshots, token reward config |
| Campaign | `DatumCampaignLifecycle` | complete / terminate / expire + P20 inactivity timeout (30d) |
| Settlement | `DatumClaimValidator` | Claim validation: chain continuity, budget, blocklist, rate-limit, ZK proof |
| Settlement | `DatumSettlement` | Main entry: hash-chain validation, 3-way DOT split, non-critical token credit |
| Settlement | `DatumSettlementRateLimiter` | BM-5: window-based per-publisher impression cap (optional) |
| Settlement | `DatumAttestationVerifier` | EIP-712 mandatory publisher co-signature for all campaign settlements |
| Publisher | `DatumPublishers` | Registration, take rates, relay signer, profile, S12 blocklist, allowlists |
| Publisher | `DatumRelay` | EIP-712 gasless relay: publisher submits batches on behalf of users |
| Governance | `DatumGovernanceV2` | Conviction voting (9 levels, 0–8), symmetric slash, escalating lockups |
| Governance | `DatumGovernanceHelper` | Slash computation, dust guard, batch read helpers |
| Governance | `DatumGovernanceSlash` | Per-campaign slash pool finalization, winner rewards, 365d sweep |
| Satellites | `DatumReports` | Community reporting: `reportPage` / `reportAd`, reasons 1–5 |
| Satellites | `DatumPublisherReputation` | BM-8/BM-9: per-publisher settlement acceptance rate + cross-campaign anomaly detection |

All contracts compile to PolkaVM (RISC-V) bytecode via resolc v1.0.0, optimizer mode `z`. **326/326 tests passing** on Hardhat EVM. All 21 deployed on Paseo (v6, 2026-04-06).

### Browser Extension — `alpha-3/extension/`

4-tab popup (Claims, Earnings, Settings, Filters), 21-contract support, Blake2-256 claim hashing, mandatory publisher attestation (P1), event-driven campaign polling, Vickrey second-price auction, Shadow DOM ad injection, AES-256-GCM embedded wallet, auto-submit, claim export, tag-based campaign filtering.

### Web App — `web/`

React 18 + Vite 6 + TypeScript + ethers v6. 28 pages across 6 sections, 21-contract support, 0 TS errors.

| Section | Pages |
|---------|-------|
| Explorer | Overview, Campaigns, CampaignDetail, Publishers |
| Advertiser | Dashboard, CreateCampaign (with ERC-20 token reward config), CampaignDetail, SetMetadata, Analytics |
| Publisher | Dashboard (with token reward withdrawal), Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup, Profile |
| Governance | Dashboard, Vote, MyVotes, Parameters |
| Admin | Timelock, PauseRegistry, Blocklist, ProtocolFees, RateLimiter, Reputation |
| Settings | Network, RPC, 21 contract addresses, IPFS config |

### Publisher SDK — `sdk/`

Lightweight JS tag (~3 KB). `<script data-publisher="0x...">` + `<div id="datum-ad-slot">`. Challenge-response handshake with the extension; returns publisher co-signature for the attested settlement path.

### Publisher Relay — `relay-bot/` (gitignored)

Live systemd service (localhost:3400). HTTP challenge/submit endpoints. Co-signs attestations via EIP-712, submits batches via `DatumRelay` or `AttestationVerifier`, records `(publisher, campaignId)` reputation stats after each batch via `DatumPublisherReputation.recordSettlement()`.

---

## Walkthrough — Alice, Bob, Carol, Dave, Eve

**Alice** is a user. **Bob** runs a tech blog (publisher). **Carol** sells hardware wallets (advertiser). **Dave** reviews campaigns (governance voter). **Eve** runs a relay bot.

### Bob registers and configures

Bob registers on `DatumPublishers`, sets his take rate to 40%, assigns Eve's EOA as his relay signer, and sets targeting tags (`keccak256("topic:technology")`). He embeds the SDK:

```html
<script src="datum-sdk.js" data-publisher="0xBob..."></script>
<div id="datum-ad-slot"></div>
```

### Carol creates a campaign with a token sidecar

Carol creates a campaign: 10 DOT escrow, 1 DOT daily cap, 0.05 DOT/1000 CPM bid, open campaign (`publisher = address(0)`), required tag `topic:technology`. She also sets `rewardToken = 0xCarolToken` and `rewardPerImpression = 1e18` (1 token per impression), then pre-seeds the vault:

```
ERC20(carolToken).approve(tokenRewardVault, 100_000e18)
tokenRewardVault.depositCampaignBudget(campaignId, carolToken, 100_000e18)
```

### Dave votes to activate

Dave votes Aye with 0.5 DOT at conviction 2 (3× weight, 3-day lockup → 1.5 DOT effective). Once weighted aye votes cross quorum (100 DOT), anyone calls `evaluateCampaign()` and the campaign goes Active.

### Alice browses Bob's site

The extension detects the SDK, classifies the page as `topic:technology`, wins the auction, performs the two-party handshake with the SDK, tracks engagement (IntersectionObserver + focus), and builds a Blake2-256 hash-chain claim. Claims auto-submit to Eve's relay every few minutes — Alice pays zero gas.

### Settlement splits the payment

At 0.05 DOT/1000 impressions, 40% publisher take:

```
Bob (40%):    0.020 DOT / 1000 impressions   → PaymentVault publisher balance
Alice (75%×60%): 0.0225 DOT / 1000 impressions → PaymentVault user balance
Protocol (25%×60%): 0.0075 DOT / 1000 impressions → PaymentVault protocol balance
Alice (token): 1000 × 1e18 = 1000 carolTokens → TokenRewardVault user balance
```

### Everyone withdraws

- Bob: `PaymentVault.withdrawPublisher()` + `TokenRewardVault.withdraw(carolToken)`
- Alice: `PaymentVault.withdrawUser()` (extension Earnings tab) + `TokenRewardVault.withdraw(carolToken)` (web app)
- Dave: `GovernanceV2.withdrawStake(campaignId)` after 3-day lockup; full stake back (winning side)
- Carol: `CampaignLifecycle.completeCampaign()` to reclaim unspent DOT; `TokenRewardVault.reclaimExpiredBudget()` to reclaim unspent tokens

---

## Getting Started

### Prerequisites

- Node.js 18+, Docker (local devchain), Chrome (extension has embedded wallet)

### Contracts

```bash
cd alpha-3
npm install
npx hardhat test                                          # 326/326 pass
npx hardhat compile --network polkadotHub                # resolc v1.0.0 required
```

### Web App

```bash
cd web && npm install && npm run dev
```

### Extension

```bash
cd alpha-3/extension && npm install && npm run build
# Load dist/ as unpacked extension in chrome://extensions
```

### Paseo Testnet (live)

All 21 contracts deployed on Paseo (Chain ID 420420417, v6 2026-04-06).

| Resource | |
|----------|-|
| Web App | https://datum.javcon.io |
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |

```bash
cd alpha-3
export DEPLOYER_PRIVATE_KEY="0x..."
npx hardhat run scripts/deploy.ts --network polkadotTestnet
npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet
```

Contract addresses: `alpha-3/deployed-addresses.json`. Full status: `STATUS.md`.

---

## Why PolkaVM

DATUM targets Polkadot Hub via pallet-revive rather than an EVM chain:

- **Native DOT settlement** — escrow, governance stakes, and payments are all in native DOT with no bridges or wrapped tokens
- **Shared security** — contracts execute on Polkadot Hub directly, inheriting relay chain validator security
- **XCM interoperability** — future cross-chain fee routing and governance tooling are native XCM calls
- **Asset Hub tokens** — ERC-20 sidecar rewards can be any Asset Hub token, making the mechanism naturally composable with the Polkadot ecosystem

The Solidity source is portable — if pallet-revive doesn't mature, deployment to an EVM parachain remains viable with no contract changes.

---

## Status

- [x] **Alpha-3 contracts** — 21 contracts, 326/326 tests, all deployed on Paseo v6 (2026-04-06)
- [x] **Real Groth16 ZK verifier** — BN254 ecPairing precompile, trusted setup, verifying key set on Paseo
- [x] **ERC-20 token reward vault** — DatumTokenRewardVault, per-campaign sidecar token rewards, pull-payment
- [x] **Publisher reputation** — DatumPublisherReputation BM-8/BM-9, relay bot wired, web admin UI
- [x] **Rate limiter** — DatumSettlementRateLimiter BM-5, window-based per-publisher cap
- [x] **Web app** — 28 pages, React + Vite, 21-contract support, 0 TS errors
- [x] **Browser extension** — 4 tabs, 21-contract, Blake2-256, Vickrey auction, tag-based filters
- [x] **Security audit** — all CRITICAL and HIGH findings fixed (C-1, C-2, H-1–H-3, S4, S6, T1–T3)
- [ ] **E2E browser validation** — full flow on Paseo with live extension + relay + web app
- [ ] **Open testing** — publish addresses, external tester onboarding
- [ ] **Mainnet** — Kusama → Polkadot Hub

See [STATUS.md](STATUS.md) for detailed status and [BACKLOG.md](BACKLOG.md) for open issues.

---

## License

Apache-2.0
