# S12: On-Chain Address Blocklist — Design Analysis

**Date:** 2026-03-22 (design) / 2026-03-23 (implemented)
**Status:** IMPLEMENTED — Phase 1 (global blocklist) + Phase 2 (per-publisher allowlist)
**Gitignored:** Yes — internal reference, not for public repo

---

## 1. The Problem

Today, DATUM's anti-abuse filtering happens **only in the browser extension**:

- `phishingList.ts` checks advertiser addresses and CTA URLs against a deny list
- `campaignPoller.ts` skips campaigns from blocked advertisers
- `contentSafety.ts` rejects malicious metadata content
- `content/index.ts` re-checks CTA URLs before rendering

**The gap:** Anyone who calls the contracts directly (bypassing the extension) can:

1. **Register as a publisher** with a known-scam address
2. **Create campaigns** advertising phishing sites
3. **Submit claims** and collect settlement payments
4. **Vote in governance** with funds from illicit sources

The contracts themselves have zero awareness of whether an address is flagged. The extension is a convenience layer, not a security boundary.

### Why this matters at each stage

| Stage | Risk Level | Reason |
|-------|-----------|--------|
| Alpha/testnet | Low | Small user base, testnet funds, manual monitoring |
| Kusama | Medium | Real funds, but smaller ecosystem, faster response time |
| Polkadot mainnet | High | Real funds, regulatory expectations, public reputation |

---

## 2. What S12 Would Do

Add an **on-chain deny list** checked at contract entry points, so blocked addresses are rejected at the protocol level regardless of whether the caller uses the extension.

### Enforcement points

| Contract | Function | Check |
|----------|----------|-------|
| DatumPublishers | `registerPublisher()` | `msg.sender` not blocked |
| DatumCampaigns | `createCampaign()` | `msg.sender` (advertiser) not blocked |
| DatumCampaigns | `createCampaign()` | `publisher` param not blocked (if not open campaign) |
| DatumGovernanceV2 | `vote()` | `msg.sender` not blocked |
| DatumSettlement | `_validateClaim()` | `claim.publisher` not blocked |

### What it would NOT do

- Block withdrawals from already-earned balances (funds already in PaymentVault)
- Block existing campaigns retroactively (they keep running)
- Block governance evaluation of already-voted campaigns
- Check domain names or content (that stays in the extension)

---

## 3. Design Options

### Option A: Centralized Blocklist on DatumPublishers

A single `mapping(address => bool) public blocked` on DatumPublishers, managed by the contract owner (or timelock). Other contracts call `publishers.isBlocked(addr)` via staticcall.

**Pros:**
- Simple — one contract, one storage map, one admin
- Publishers already has 22,377 B PVM spare — easily fits
- Other contracts add ~500-800 B each for the staticcall check
- Consistent with how `pauseRegistry` works (single source of truth)

**Cons:**
- Centralized — one entity (owner/timelock) decides who gets blocked
- No appeal process unless you build one
- Could be perceived as censorship

**PVM cost estimate:**
- Publishers: +~1,500 B (mapping + add/remove functions + isBlocked view)
- Campaigns: +~800 B (staticcall in createCampaign)
- GovernanceV2: +~800 B — **risky, only 1,213 B spare**
- Settlement: +~800 B (staticcall in _validateClaim) — tight at 3,543 B spare
- **Total: ~3,900 B across 4 contracts**

### Option B: Governance-Managed Blocklist (Separate Contract)

A standalone `DatumBlocklist` contract with its own governance:
- Proposals to add/remove addresses require conviction vote
- Time-delayed execution (like timelock)
- Anyone can propose, community votes

**Pros:**
- Decentralized — community decides, not one admin
- Built-in appeal: propose removal, vote to unblock
- Separates blocklist governance from protocol governance

**Cons:**
- New contract (~15-20 KB PVM)
- Slower response (voting + grace period before block takes effect)
- Scammers can operate during the delay
- Governance overhead for what should be a quick admin action
- Could be gamed (whale votes to block competitors)

### Option C: Hybrid — Admin Blocklist + Governance Override

Owner/timelock can add addresses immediately (fast response). Governance can override (unblock) via conviction vote. Combines speed with accountability.

**Pros:**
- Fast emergency response (admin blocks immediately)
- Democratic override (governance can reverse bad blocks)
- Best of both worlds

**Cons:**
- More complex logic
- Larger PVM footprint
- Two pathways to reason about

### Option D: Per-Campaign Allowlist/Blocklist (Advertiser-Managed)

Each advertiser sets their own allow/block list for their campaign. Each publisher sets their own allow/block list for who can target them.

**Pros:**
- No centralized authority — each party manages their own
- No global censorship risk
- Publishers can refuse to serve certain advertisers
- Advertisers can restrict which publishers run their ads

**Cons:**
- Does NOT solve the core S12 problem (blocking known scammers from the protocol)
- Adds complexity to campaign creation
- Storage cost per campaign
- Doesn't help users at all — they still see scam campaigns

---

## 4. Recommended Approach: Option A + Allowlisting Extension

**Option A (centralized blocklist on Publishers)** with two additions:

1. **Timelock protection** — blocklist changes go through the 48h timelock, same as all other admin actions. This prevents snap censorship.

2. **Per-publisher allowlist parameter** — publishers can set an `allowedAdvertisers` bitmask or list to restrict who can target them. This is a separate feature from the global blocklist, giving publishers voluntary control.

### Why Option A

- The protocol already has a centralized owner who can pause the entire system, change contract references, and modify parameters. A blocklist is less powerful than any of those existing admin capabilities.
- The timelock already provides transparency — anyone monitoring `ChangeProposed` events can see a block coming 48h in advance and raise objections.
- Response time matters for scams. A governance vote takes days/weeks. A scam campaign can drain user trust in hours.
- PVM fits. Option B adds a whole new contract; Option A adds ~4 KB spread across existing contracts.

### Why NOT GovernanceV2 enforcement

GovernanceV2 has only 1,213 B spare. Adding an 800 B staticcall is risky — one resolc update could push it over. **Recommendation: skip the vote() check.** A blocked address voting doesn't cause direct harm (they can't steal funds via voting), and the governance slash mechanism already penalizes bad actors financially.

---

## 5. Allowlisting (Per-Publisher)

Separate from the global blocklist, publishers should be able to restrict which advertisers can target them:

### Design

```solidity
// On DatumPublishers — per-publisher allowlist
mapping(address => mapping(address => bool)) public publisherAllowlist;
mapping(address => bool) public publisherAllowlistEnabled;

function setAllowlistEnabled(bool enabled) external;
function setAllowedAdvertiser(address advertiser, bool allowed) external;
```

### How it works

- By default, allowlisting is **disabled** — any advertiser can create a campaign targeting any publisher (current behavior).
- A publisher can enable their allowlist, then only pre-approved advertisers can create campaigns naming them.
- This is checked in `DatumCampaigns.createCampaign()` alongside the existing `pub.registered` check.
- Open campaigns (`publisher=address(0)`) bypass this entirely — they aren't targeted at a specific publisher.

### Benefits

- Publishers control their brand association
- Premium publishers can require advertiser vetting
- No global authority needed — each publisher decides for themselves
- Doesn't affect the permissionless nature of the protocol (open campaigns still work)

### PVM cost

- Publishers: +~2,000 B (two mappings + two setters + view)
- Campaigns: +~500 B (additional check in createCampaign)
- **Total: ~2,500 B**

---

## 6. Risk Analysis

### Risks of implementing S12

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Unfair blocking** — admin blocks a legitimate competitor | Medium | Timelock gives 48h notice; governance override (future); transparent on-chain |
| **Regulatory pressure** — government demands blocking political speech | Medium | Protocol is permissionless by default; blocklist only for provable scams; legal entity structure |
| **Admin key compromise** — attacker blocks legitimate addresses | Medium | Timelock delay; multisig ownership (Phase 4); monitoring alerts |
| **Gas cost** — checking blocklist on every createCampaign | Low | One SLOAD (~2,100 gas) per check; negligible vs campaign creation cost |
| **Storage bloat** — thousands of blocked addresses | Low | Each address = 32 bytes storage; 10,000 addresses = 320 KB; well within chain limits |
| **False sense of security** — users trust protocol-level filtering | Low | Extension-level filtering remains as defense-in-depth |

### Risks of NOT implementing S12

| Risk | Severity | Impact |
|------|----------|--------|
| **Scam campaigns drain user trust** | High | One visible scam on mainnet could damage protocol reputation permanently |
| **Phishing through direct contract calls** | Medium | Technically sophisticated scammers bypass extension; less likely but higher impact |
| **Regulatory non-compliance** | Medium | For EU/UK markets, lack of any content moderation capability could be a legal issue |
| **Publisher reputation damage** | Medium | Publishers can't prevent their address being used in malicious campaigns (open campaigns) |

---

## 7. Gas Impact Analysis

### Per-transaction cost of blocklist check

```
SLOAD (cold):   2,100 gas    — first check of an address per transaction
SLOAD (warm):     100 gas    — subsequent checks of the same address
Staticcall:     2,600 gas    — cross-contract call overhead
ABI encode:       ~200 gas    — encoding the address parameter
Total (cold):  ~4,900 gas    — first blocklist check per tx
Total (warm):  ~2,900 gas    — subsequent checks in same tx
```

### Context: what the operations already cost

| Operation | Current gas | Blocklist overhead | % increase |
|-----------|------------|-------------------|------------|
| createCampaign | ~150,000 | +4,900 | +3.3% |
| registerPublisher | ~80,000 | +2,100 (local check) | +2.6% |
| settleClaims (per claim) | ~50,000 | +4,900 | +9.8% |

Settlement has the highest relative increase, but it's per-claim, and the absolute cost is still small. On Polkadot Hub with weight-based gas, these translate to fractions of a cent.

### Storage cost

Blocking one address = writing one storage slot = 20,000 gas (one-time admin cost). Blocking 100 addresses costs ~2M gas — a single transaction on Polkadot Hub.

---

## 8. Implementation Plan

### Phase 1: Global Blocklist (S12 core)

Add to `DatumPublishers`:
```solidity
mapping(address => bool) public blocked;

event AddressBlocked(address indexed addr);
event AddressUnblocked(address indexed addr);

function blockAddress(address addr) external onlyOwner {
    blocked[addr] = true;
    emit AddressBlocked(addr);
}

function unblockAddress(address addr) external onlyOwner {
    blocked[addr] = false;
    emit AddressUnblocked(addr);
}

function isBlocked(address addr) external view returns (bool) {
    return blocked[addr];
}
```

Add to `DatumCampaigns.createCampaign()`:
```solidity
// After existing publisher check
require(!publishers.isBlocked(msg.sender), "E62");
if (publisher != address(0)) {
    require(!publishers.isBlocked(publisher), "E62");
}
```

Add to `DatumSettlement._validateClaim()`:
```solidity
// Check publisher not blocked (after campaign lookup)
// Only if we have PVM headroom — Settlement at 3,543 B spare
```

### Phase 2: Per-Publisher Allowlist

Add to `DatumPublishers`:
```solidity
mapping(address => bool) public allowlistEnabled;
mapping(address => mapping(address => bool)) public allowedAdvertisers;
```

Add check to `DatumCampaigns.createCampaign()`:
```solidity
if (publisher != address(0) && publishers.allowlistEnabled(publisher)) {
    require(publishers.allowedAdvertisers(publisher, msg.sender), "E63");
}
```

### Phase 3: Extension Integration

- `phishingList.ts` can query on-chain blocklist via `publishers.isBlocked(addr)`
- Extension blocklist becomes a local cache/supplement, not the only defense
- `errorCodes.ts` gets E62 (address blocked) and E63 (not on publisher allowlist)

### New error codes

| Code | Meaning |
|------|---------|
| E62 | Address is blocked (advertiser or publisher on protocol deny list) |
| E63 | Advertiser not on publisher's allowlist |

---

## 9. What This Enables (Opportunities)

### Immediate

- **Scam response:** Block a scam address in one transaction, effective protocol-wide
- **Publisher brand safety:** Publishers can curate which advertisers they work with
- **Regulatory compliance:** Demonstrable content moderation capability for legal requirements

### Future (builds on S12)

- **F11: On-chain domain blocklist** — extend the blocklist to include domain hashes, so settlement can reject claims with phishing CTA URLs at the protocol level
- **Reputation scoring** — track block/unblock history, build on-chain reputation
- **Governance-managed blocklist (Option B)** — if decentralization demand grows, migrate blocklist management to governance vote while keeping the admin emergency-block capability
- **Cross-chain blocklist** — when multi-chain (P11/XCM), share blocklist state across chains
- **Advertiser deposit** — require a refundable deposit at campaign creation; forfeit if blocked (economic deterrent)

### What it does NOT solve (and shouldn't try to)

- Content quality (that's the extension's job via contentSafety.ts)
- Domain phishing (extension-level, unless F11 is built)
- Sybil attacks (blocked address can create new address)
- Off-chain fraud (social engineering, etc.)

---

## 10. Recommendation

**Implement Phase 1 (global blocklist) now.** It's the lowest-risk, highest-value hardening item remaining. The timelock already provides transparency and delay. PVM fits on all target contracts except GovernanceV2 (skip the vote check — blocked addresses voting is low-risk).

**Defer Phase 2 (per-publisher allowlist) to post-alpha.** It's a nice-to-have for publisher brand safety but doesn't address the core S12 security gap. It can be added later without breaking changes.

**Do NOT implement Option B (governance-managed blocklist) for alpha.** The governance overhead is too high for what should be a fast admin action. Revisit for mainnet if decentralization of moderation becomes a priority.

### Decision matrix

| Approach | Security | Decentralization | PVM Cost | Complexity | Recommendation |
|----------|----------|-------------------|----------|------------|----------------|
| Do nothing | Weak | N/A | 0 | None | No — unacceptable for mainnet |
| Option A (admin blocklist) | Strong | Low | ~2-4 KB | Low | **Yes — implement now** |
| Option A + allowlist | Strong | Medium | ~4-6 KB | Medium | Phase 2 (post-alpha) |
| Option B (governance) | Medium | High | ~15-20 KB | High | Defer to mainnet |
| Option C (hybrid) | Strong | Medium-High | ~20+ KB | High | Defer to mainnet |
| Option D (per-campaign) | Weak | High | ~3-5 KB | Medium | No — doesn't solve S12 |

---

## 11. Open Questions

1. **Should blocked addresses be able to withdraw existing balances from PaymentVault?** Recommendation: Yes — blocking withdrawals risks locking legitimate funds if there's a false positive. The timelock delay provides time to appeal before the block takes effect.

2. **Should the blocklist be append-only (no unblock)?** Recommendation: No — allow unblocking. Mistakes happen. The timelock provides the transparency layer.

3. **Should we block campaign creation for blocked publishers, or also block settlement claims targeting blocked publishers?** Recommendation: Both, if Settlement has PVM headroom. Blocking only creation still allows existing campaigns with a newly-blocked publisher to settle claims.

4. **Should blocklist changes go through the timelock?** Recommendation: Yes for mainnet. For alpha/testnet, direct owner control is acceptable for faster iteration. The owner can always be transferred to the timelock later.

---

## 12. Implementation Notes (2026-03-23)

### What was implemented

- **Phase 1 (Global Blocklist):** `blocked` mapping on DatumPublishers, `blockAddress()`/`unblockAddress()` (onlyOwner), `isBlocked()` view. Checked in `registerPublisher()` and `DatumCampaigns.createCampaign()` (both msg.sender and publisher param).
- **Phase 2 (Per-Publisher Allowlist):** `allowlistEnabled` mapping, `_allowedAdvertisers` nested mapping, `setAllowlistEnabled()`/`setAllowedAdvertiser()` (publisher-managed), `isAllowedAdvertiser()` view. Checked in `createCampaign()` only when `allowlistEnabled(publisher)` is true. Open campaigns bypass allowlist.
- **Error codes:** E62 (address blocked), E63 (not on publisher's allowlist).
- **Events:** `AddressBlocked`, `AddressUnblocked`, `AllowlistToggled`, `AdvertiserAllowlistUpdated`.
- **Tests:** 25 tests in `test/blocklist.test.ts` (BK1-BK6, AL1-AL6).

### What was NOT implemented (deferred)

- **Settlement blocklist check:** Skipped — Settlement has only 3,543 B PVM spare. Adding a staticcall to `isBlocked()` in `_validateClaim()` would cost ~800 B. Can be added post-alpha if headroom allows or Settlement is restructured. Existing campaigns with a newly-blocked publisher can still settle claims.
- **GovernanceV2 vote() check:** Skipped — only 1,213 B spare, no room. Blocked addresses voting is low-risk (no fund theft via voting; slash mechanism penalizes bad actors).
- **Timelock gating:** Blocklist uses direct `onlyOwner` for alpha. **MUST be migrated to timelock-gated before mainnet launch** for transparency and abuse prevention.
- **Governance-managed blocklist (Option B):** Deferred to mainnet. **Future goal: open blocklist management to governance control** so the community can propose/vote on blocking decisions, with admin retaining emergency-block capability (Option C hybrid).

### PVM impact

| Contract | Before S12 | After S12 | Delta | Spare |
|----------|-----------|----------|-------|-------|
| Publishers | 26,775 | 35,741 | +8,966 | 13,411 |
| Campaigns | 38,023 | 42,466 | +4,443 | 6,686 |
| **Total delta** | — | — | **+13,409** | — |
