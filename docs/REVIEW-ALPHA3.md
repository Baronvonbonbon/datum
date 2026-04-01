# DATUM Alpha-3 — Architecture Review & Improvement Report

**Date:** 2026-04-01
**Scope:** 17 smart contracts, 24-page web app, publisher SDK, relay bot
**Network:** Paseo Testnet (Chain ID 420420417)

---

## Executive Summary

DATUM Alpha-3 is a well-architected decentralized advertising protocol with 17 modular contracts, a full-featured React web app, and supporting infrastructure (SDK, relay). The system demonstrates thoughtful engineering in PVM bytecode optimization, pull-payment patterns, and satellite contract extraction. However, there are **22 contract-level issues** and **60+ web app UX gaps** that should be addressed before mainnet.

This report is organized into five sections:
1. [Contract Architecture Findings](#1-contract-architecture-findings)
2. [Web App UX Analysis](#2-web-app-ux-analysis)
3. [Cross-Cutting Concerns](#3-cross-cutting-concerns)
4. [Recommended New Features](#4-recommended-new-features)
5. [Prioritized Action Items](#5-prioritized-action-items)

---

## 1. Contract Architecture Findings

### 1.1 Security Issues

| # | Severity | Contract | Issue | Recommendation |
|---|----------|----------|-------|----------------|
| S1 | Medium | Campaigns | Manual `_locked` reentrancy flag only guards `createCampaign()`; `setMetadata()`, `togglePause()` unguarded | Replace with OZ ReentrancyGuard or extend flag to all write methods |
| S2 | Medium | GovernanceV2 | Manual `_locked` flag shared across `vote()`, `withdraw()`, `evaluateCampaign()`, `slashAction()` — if any cross-call occurs, behavior is undefined | Audit all external call chains; consider per-function locks |
| S3 | Low | Relay | EIP-712 signatures include deadline but no nonce-based anti-replay; chain reorgs could replay stale signatures | Add monotonic nonce per user to EIP-712 domain |
| S4 | Low | AttestationVerifier | No pause check — Settlement checks internally, but a paused-state attestation + settlement race is possible | Add `pauseRegistry.paused()` check for consistency |
| S5 | Info | ZKVerifier | Stub: accepts any non-empty proof (`proof.length > 0`); `zkProof` field in Claim struct is dead code | Either implement real verification or remove field pre-mainnet |
| S6 | Info | Settlement | No `receive()` function — ETH sent directly to Settlement is lost | Add `receive() external payable { revert("E03"); }` |

### 1.2 Design Fragilities

| # | Contract | Issue | Impact |
|---|----------|-------|--------|
| D1 | Publishers | `takeRateUpdateDelayBlocks` immutable at deploy (50 blocks) | Cannot be adjusted for mainnet without redeploy |
| D2 | BudgetLedger | Daily cap uses `block.timestamp / 86400` | Validator timestamp manipulation risk (low on PolkaVM, theoretical) |
| D3 | GovernanceV2 | Conviction weights/lockups hardcoded in if/else chain | Cannot update economic model without redeploy (intentional for PVM savings) |
| D4 | CampaignLifecycle | Termination slash fixed at 10% (hardcoded `1000` BPS in `drainFraction`) | Not configurable; governance can't adjust |
| D5 | GovernanceHelper | `campaigns` address is `immutable` | If Campaigns contract replaced, GovernanceHelper is bricked |
| D6 | Timelock | Single pending proposal at a time | Bottleneck for governance; can't queue parallel changes |
| D7 | CampaignLifecycle | `inactivityTimeoutBlocks` immutable (432k blocks = 30 days) | Cannot adjust without redeploy |

### 1.3 Dead Code & Technical Debt

| # | Contract | Issue | Recommendation |
|---|----------|-------|----------------|
| T1 | Publishers | `categoryBitmask` field + `setCategories()` deprecated but still functional | Remove in next version; TargetingRegistry owns targeting now |
| T2 | Campaigns | `uint8 categoryId` field in Campaign struct, always 0 | Remove from struct + CampaignCreated event |
| T3 | Publishers | `setCategories()` + `getCategories()` + `CategoriesUpdated` event | Remove; replaced by TargetingRegistry.setTags() |
| T4 | Settlement | Raw selector-based staticcalls (e.g., `0x5c975abb` for `paused()`) | Fragile/unmaintainable; document selectors or use typed interfaces |
| T5 | CampaignValidator | `targetingRegistry` can be `address(0)` (tag checks silently skipped) | Validate at deploy or add explicit warning |

### 1.4 Cross-Contract Dependency Map

```
PauseRegistry ←── (checked by 10 of 17 contracts)
       │
Publishers ──→ CampaignValidator ──→ TargetingRegistry
       │              │
       ↓              ↓
   Campaigns ───→ BudgetLedger ───→ PaymentVault
       │              │
       ↓              ↓
  GovernanceV2 ← CampaignLifecycle
       │
       ↓
GovernanceSlash ──→ GovernanceHelper

Settlement ←── ClaimValidator
    │
    ├── Relay (EIP-712 optional pub sig)
    └── AttestationVerifier (mandatory pub sig)
```

**Key observation:** Settlement is the most connected contract (6 direct dependencies). Any upgrade to Settlement requires coordinating BudgetLedger, PaymentVault, CampaignLifecycle, ClaimValidator, Relay, and AttestationVerifier references.

### 1.5 Contract Improvement Opportunities

**A. Configurable termination slash:** Move the 10% slash rate to a governance-adjustable parameter (via Timelock).

**B. Multi-proposal Timelock:** Support a queue of pending proposals with independent timers, enabling parallel governance actions.

**C. Block-based daily cap:** Replace `block.timestamp / 86400` with block-number-based day boundaries (`block.number / BLOCKS_PER_DAY`) for deterministic behavior.

**D. Settlement batching optimization:** Current max 10 batches x 50 claims = 500 claims per tx. Consider allowing dynamic batch sizes based on gas remaining.

**E. Campaign expiry keeper incentive:** `expirePendingCampaign()` and `expireInactiveCampaign()` are permissionless but offer no gas rebate. Consider adding a small keeper reward from the expired campaign's budget.

---

## 2. Web App UX Analysis

### 2.1 Page-by-Page Scorecard

| Page | Completeness | UX | Mobile | a11y | Errors | Priority Fixes |
|------|:---:|:---:|:---:|:---:|:---:|---|
| Overview | 9 | 7 | 6 | 5 | 6 | Loading skeletons, pause banner |
| Campaigns (Browse) | 8 | 6 | 5 | 5 | 7 | Sorting, scroll hint, pagination UX |
| Campaign Detail | 9 | 7 | 6 | 6 | 7 | Settlement history pagination, budget % |
| Publishers | 7 | 6 | 5 | 5 | 6 | Pagination, sorting, empty tag state |
| Advertiser Dashboard | 8 | 6 | 6 | 5 | 6 | Budget %, refresh button, action loading |
| Create Campaign | 9 | 7 | 5 | 5 | 7 | Debounce RPC, budget hints, wizard flow |
| Set Metadata | 8 | 6 | 5 | 5 | 6 | Field validation, image preview, pre-populate |
| Publisher Dashboard | 8 | 7 | 6 | 6 | 7 | Earnings graph, withdraw confirmation |
| Publisher Register | 9 | 8 | 7 | 7 | 8 | Take rate context, next-steps hint |
| Take Rate | 8 | 6 | 6 | 5 | 7 | Human-time countdown, same-rate validation |
| Tags | 8 | 7 | 5 | 5 | 7 | Collapse dimensions, bulk actions |
| Allowlist | 7 | 5 | 5 | 4 | 6 | Confirmation modal, bulk add, semantics |
| Earnings | 7 | 6 | 4 | 4 | 6 | CSV export, block-to-time, sort columns |
| SDK Setup | 8 | 7 | 6 | 5 | 7 | Tag warning, relay section collapse |
| Governance Dashboard | 8 | 6 | 5 | 5 | 6 | Filter labels, vote bar tooltips |
| Vote | 9 | 7 | 5 | 5 | 7 | Already-voted UX, conviction explainer |
| My Votes | 8 | 6 | 4 | 4 | 6 | Status filters, slash explanation, sort |
| Parameters | 8 | 5 | 6 | 5 | 9 | Param descriptions, transition conditions |
| Settings | 9 | 6 | 4 | 4 | 6 | Network validation, version string fix |
| **Average** | **8.1** | **6.4** | **5.3** | **5.1** | **6.6** | |

**Overall: 6.3/10** — Functionally complete but needs UX polish, mobile optimization, and accessibility work.

### 2.2 Critical UX Bugs

1. **Settings page shows "Alpha-2"** — should be "Alpha-3" (line 261 of Settings.tsx)
2. **Create Campaign calls `checkPublisher()` on every keystroke** — expensive RPC flood; needs debounce
3. **Publisher Earnings uses `queryFilterBounded(5000 blocks)`** — only shows last ~8 hours of settlements; should use `queryFilterAll`
4. **No pause check before transaction pages** — users can fill forms when protocol is paused; tx fails with cryptic "P" error
5. **Wallet switch in MetaMask not detected** — stale signer if user switches accounts mid-session

### 2.3 Top UX Improvements by Impact

#### Tier 1: High Impact, Low Effort (do first)

| # | Fix | Pages Affected | Effort |
|---|-----|----------------|--------|
| U1 | Fix "Alpha-2" → "Alpha-3" in Settings | Settings | 5 min |
| U2 | Add Retry buttons to all error states | All | 2 hrs |
| U3 | Humanize ALL error messages (no raw ethers errors) | All | 2 hrs |
| U4 | Add confirmation modals for dangerous actions (withdraw, complete, terminate) | 5 pages | 3 hrs |
| U5 | Show wallet balance in header | Layout | 1 hr |
| U6 | Debounce publisher address check in Create Campaign (200ms) | CreateCampaign | 30 min |
| U7 | Add mobile hamburger menu (collapse sidebar <640px) | Layout | 2 hrs |

#### Tier 2: High Impact, Medium Effort

| # | Fix | Pages Affected | Effort |
|---|-----|----------------|--------|
| U8 | Loading skeleton components (replace "—" placeholders) | Overview, Dashboard | 4 hrs |
| U9 | Auto-refresh data on tab focus (visibilitychange listener) | All data pages | 2 hrs |
| U10 | Budget percentage display ("0.5 PAS remaining, 50% of 1.0 PAS") | Dashboard, Detail | 2 hrs |
| U11 | Conviction slider live tooltip ("9x power, 90-day lockup") | Vote | 2 hrs |
| U12 | Role indicators in header ("Advertiser + Publisher + Voter") | Layout | 3 hrs |
| U13 | Add "Not registered" guards to publisher sub-pages | 6 pub pages | 2 hrs |
| U14 | Settlement history pagination + total count | CampaignDetail | 3 hrs |

#### Tier 3: High Impact, High Effort

| # | Fix | Pages Affected | Effort |
|---|-----|----------------|--------|
| U15 | Campaign analytics dashboard (impressions/day, cost/impression, ROI) | New page | 2 days |
| U16 | Publisher earnings graph (daily/weekly earnings trend) | Dashboard, Earnings | 1 day |
| U17 | Wizard-style Create Campaign flow (combine create + set metadata) | CreateCampaign, SetMetadata | 1 day |
| U18 | CSV export for earnings, votes, campaigns | 3 pages | 1 day |
| U19 | Real-time event notifications via WebSocket/polling | Global | 2 days |
| U20 | Dark/Light theme toggle | Global | 4 hrs |

### 2.4 Mobile Responsiveness Issues

The app is primarily desktop-oriented. Key mobile fixes needed:

1. **Sidebar:** Always visible, even on small screens. Needs hamburger menu at `<640px`
2. **Tables:** Campaigns, settlements, votes tables scroll horizontally with no indicator. Should collapse to card layout on mobile
3. **Touch targets:** Sliders (take rate, conviction), small buttons, and filter dropdowns are too small for finger taps. Minimum 44x44px
4. **Modals:** WalletConnect modal at fixed 360px; needs `width: min(360px, 90vw)`
5. **Code blocks:** SDK snippet in SDKSetup overflows. Needs `word-break: break-all` or horizontal scroll indicator

### 2.5 Accessibility (a11y) Issues

1. **Emoji icons without alt text** — How It Works section uses emoji (developer, megaphone, globe, scales); screen readers skip them
2. **Color-only indicators** — Status badges (green=active, red=terminated) and vote buttons (green=aye, red=nay) rely solely on color
3. **No focus indicators** — Keyboard navigation impossible; buttons lack `:focus-visible` outline
4. **Missing form labels** — Several inputs (filter dropdowns, search fields) lack associated `<label>` elements
5. **Disabled button opacity** — Disabled buttons use `opacity: 0.35` which is nearly invisible; needs color change + `cursor: not-allowed`

---

## 3. Cross-Cutting Concerns

### 3.1 Error Handling Inconsistency

Three different error patterns are used across the app:

| Pattern | Where | Problem |
|---------|-------|---------|
| `String(err).slice(0, 200)` | Explorer pages | Raw ethers errors shown to user |
| `humanizeError(err)` | Advertiser/Publisher pages | Good but incomplete coverage |
| Silent catch `{ /* ignore */ }` | Background fetches | User sees stale/empty data with no explanation |

**Recommendation:** Standardize on `humanizeError()` everywhere + add contextual retry buttons + dismissible error toasts for background failures.

### 3.2 Data Freshness Strategy

| Concern | Current State | Recommendation |
|---------|--------------|----------------|
| Block number | Polled every 10s | Reduce to 5s or use subscription |
| Campaign data | Loaded on mount only | Add visibilitychange auto-refresh |
| Event history | `queryFilterBounded` (10k blocks) on most pages | Use `queryFilterAll` + localStorage cache for incremental sync |
| Transaction confirmation | Manual refresh after tx | Auto-reload relevant data after tx receipt |
| Stale data indicator | None | Show "Last updated 2m ago" with refresh link |

### 3.3 SDK & Extension Integration

The SDK was updated to v2.0 with `data-tags` support. Remaining integration gaps:

1. **Extension still uses `data-categories` internally** — CATEGORY_TO_TAG bridge exists but extension should be updated to prefer `data-tags`
2. **No SDK version validation** — Publishers register SDK hash via `registerSdkVersion()` but nothing verifies the hash matches actual deployed SDK
3. **Relay URL discovery** — Currently from `data-relay` attribute; post-alpha should be registered on-chain for auditability

---

## 4. Recommended New Features

### 4.1 Protocol-Level Features

| # | Feature | Description | Complexity |
|---|---------|-------------|------------|
| F1 | **Campaign scheduling** | `startBlock` field on campaigns; governance vote happens pre-start, campaign auto-activates at scheduled block | Medium |
| F2 | **Keeper rewards** | Small reward from expired campaign budget for calling `expirePendingCampaign()` / `expireInactiveCampaign()` | Low |
| F3 | **Multi-proposal Timelock** | Queue of pending proposals with independent timers | Medium |
| F4 | **On-chain relay registry** | Publishers register relay URL on-chain (auditable, discoverable) | Low |
| F5 | **Campaign renewal** | Advertiser tops up budget on existing campaign without creating new one | Medium |
| F6 | **Publisher reputation score** | On-chain metric based on settlement volume, dispute rate, uptime | High |
| F7 | **Impression quality tiers** | Different CPM rates for different engagement levels (view, scroll, dwell, click) | High |
| F8 | **Dispute mechanism** | Users/publishers can flag suspicious settlements; governance resolves | High |

### 4.2 Web App Features

| # | Feature | Description | Complexity |
|---|---------|-------------|------------|
| W1 | **Campaign analytics page** | Impressions/day chart, cost/impression, ROI calculator, budget burn rate | High |
| W2 | **Publisher earnings dashboard** | Daily/weekly earnings graph, per-campaign breakdown, projected monthly revenue | Medium |
| W3 | **Activity feed** | Real-time notifications: "Campaign #5 activated", "Vote unlocked", "Earnings ready to claim" | Medium |
| W4 | **CSV export** | Export earnings, campaigns, votes as CSV for tax/accounting | Low |
| W5 | **Bulk campaign management** | Create/pause/complete multiple campaigns at once | Medium |
| W6 | **Campaign comparison** | Side-by-side comparison of campaign performance metrics | Low |
| W7 | **Publisher leaderboard** | Ranked list of publishers by earnings, impressions served, uptime | Low |
| W8 | **Governance participation stats** | Your voting history, win rate, total staked, total earned from slash | Medium |

### 4.3 SDK & Extension Features

| # | Feature | Description | Complexity |
|---|---------|-------------|------------|
| X1 | **SDK tag auto-detection** | SDK reads page meta tags (og:type, keywords) and suggests matching DATUM tags | Medium |
| X2 | **Multiple ad slots** | Support `datum-ad-slot-1`, `datum-ad-slot-2` for sites with multiple placements | Low |
| X3 | **Ad format options** | Banner, interstitial, native ad formats with different rendering | High |
| X4 | **A/B testing** | Advertisers can set multiple creatives; extension randomly selects per impression | Medium |
| X5 | **Publisher dashboard widget** | Embeddable earnings ticker for publishers to show on their own sites | Low |

---

## 5. Prioritized Action Items

### Phase 1: Quick Wins (1-2 days)

- [ ] Fix "Alpha-2" → "Alpha-3" in Settings page
- [ ] Debounce publisher address check in CreateCampaign (200ms)
- [ ] Add retry buttons to all error states
- [ ] Humanize all error messages via `humanizeError()`
- [ ] Show wallet balance in header
- [ ] Add confirmation modals for withdraw, complete, and terminate actions
- [ ] Fix Publisher Earnings to use `queryFilterAll` instead of bounded 5k blocks

### Phase 2: UX Polish (1 week)

- [ ] Loading skeleton components for stat cards and tables
- [ ] Auto-refresh on tab focus (visibilitychange listener)
- [ ] Budget percentage display on advertiser dashboard
- [ ] Conviction slider live tooltip with power + lockup duration
- [ ] Role indicators in header (Advertiser/Publisher/Voter badges)
- [ ] "Not registered" guards on all publisher sub-pages
- [ ] Settlement history pagination + total count on Campaign Detail
- [ ] Mobile hamburger menu + sidebar collapse

### Phase 3: Feature Build (2-4 weeks)

- [ ] Campaign analytics dashboard (impressions, cost, ROI)
- [ ] Publisher earnings graph (daily/weekly trend)
- [ ] Wizard-style Create Campaign + Set Metadata flow
- [ ] CSV export for earnings, votes, campaigns
- [ ] Global protocol-paused banner (block all transaction pages)
- [ ] Dark/Light theme toggle
- [ ] Wallet `accountsChanged` event listener

### Phase 4: Contract Hardening (pre-mainnet)

- [ ] Replace manual `_locked` with OZ ReentrancyGuard where feasible
- [ ] Remove deprecated `categoryBitmask` / `categoryId` fields
- [ ] Add `receive()` fallback to Settlement
- [ ] Add pause check to AttestationVerifier
- [ ] Implement block-based daily cap (replace timestamp-based)
- [ ] Upgrade Timelock to multi-proposal queue
- [ ] Implement or remove ZKVerifier integration
- [ ] Transfer contract ownership to Timelock/DAO

### Phase 5: New Capabilities (post-mainnet planning)

- [ ] Campaign renewal (top-up budget)
- [ ] On-chain relay registry
- [ ] Keeper rewards for expiry actions
- [ ] Campaign scheduling (future start block)
- [ ] Publisher reputation system
- [ ] Multiple ad slot support in SDK
- [ ] Activity feed + notifications

---

## Appendix A: Error Code Reference

| Code | Meaning | Used In |
|------|---------|---------|
| E00 | Zero address | Multiple |
| E01 | Not found | Multiple |
| E02 | Transfer failed | BudgetLedger, PaymentVault, GovernanceV2 |
| E03 | Zero balance / unsolicited ETH | PaymentVault, GovernanceV2 |
| E11 | Zero value | Campaigns |
| E12 | Invalid daily cap | Campaigns |
| E13 | Not advertiser/settlement | Campaigns |
| E14 | Invalid campaign state | Campaigns |
| E18 | Not owner | Multiple |
| E19 | Not governance/slash | GovernanceV2 |
| E26 | Daily cap exceeded | BudgetLedger |
| E27 | Below CPM floor | Campaigns |
| E40-E56 | Governance-specific | GovernanceV2, GovernanceSlash |
| E57 | Reentrancy | Campaigns, GovernanceV2 |
| E58 | Dust guard | GovernanceHelper |
| E62 | Blocked | Publishers, CampaignValidator |
| E63 | Not on allowlist | CampaignValidator |
| E64 | Inactivity timeout | CampaignLifecycle |
| E66 | Too many tags | TargetingRegistry |

## Appendix B: Contract Deployment (Paseo)

All 17 contracts deployed at addresses in `alpha-3/deployed-addresses.json`. Deployer: Alice (`0x94CC36412EE0c099BfE7D61a35092e40342F62D7`).

---

*Generated 2026-04-01. Review covers alpha-3 codebase at commit `48b004d`.*
