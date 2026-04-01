# Alpha-3 Changelog

**Deployed:** 2026-03-31 on Paseo Testnet (Chain ID 420420417)

## Overview

Alpha-3 expands DATUM from 13 to 17 contracts with 4 new satellite modules, adds tag-based targeting infrastructure, applies all CRITICAL/HIGH security fixes, and deploys the full system to Paseo testnet. The browser extension gains event-driven campaign polling with O(1) lookups.

## Contracts (13 → 17)

### New contracts

| Contract | Role |
|----------|------|
| `DatumTargetingRegistry` | Tag-based targeting with `bytes32` tag hashes (replaces uint256 category bitmask) |
| `DatumCampaignValidator` | Cross-contract campaign creation validation (extracted from Campaigns) |
| `DatumClaimValidator` | Claim validation logic (extracted from Settlement) |
| `DatumGovernanceHelper` | Read-only governance aggregation queries |

### Security fixes applied (2026-03-28)

- **C-1:** Slash pool drain — GovernanceSlash finalization guard
- **C-2:** Reentrancy — ReentrancyGuard on all value-transfer paths
- **H-1:** Timelock overwrite — reject new proposals while one is pending
- **H-2:** Return data validation — check call return values
- **H-3:** GovernanceV2 pause — added pauseRegistry as 8th constructor parameter

### Contract changes

- GovernanceV2 constructor: 7 → 8 params (added `pauseRegistry`)
- Deploy script updated for 17-contract deploy + wiring
- 219/219 Hardhat EVM tests passing (up from 187)

## Browser Extension

### Event-driven campaign poller (O(1) lookups)

Replaced O(n) linear ID scan with event-driven discovery:

- **Phase 1:** `CampaignCreated` event queries — incremental from `lastBlock+1`, single RPC call per poll for new events
- **Phase 1b:** `CampaignMetadataSet` event capture for IPFS metadata hashes
- **Phase 2:** Batch-parallel status refresh (20 concurrent) for non-terminal campaigns only
- **Phase 2b:** Tag fetch for newly discovered campaigns
- **Phase 3:** Prune terminal campaigns, persist `Map<id, campaign>` index
- **Phase 4:** Stale metadata cleanup
- **Phase 5:** Batched IPFS metadata fetch (5 concurrent, multi-gateway fallback)

Key improvements:
- **No campaign count limit** — handles arbitrary number of campaigns (removed MAX_SCAN_ID=1000 cap)
- **O(1) lookup** via `getById(campaignId)` from indexed Map store
- **Incremental polling** — first poll scans all history, subsequent polls only query new blocks
- **`reset()`** method to force full re-scan

### 17-contract support

- 4 new ABIs added (TargetingRegistry, CampaignValidator, ClaimValidator, GovernanceHelper)
- Network configs updated with all 17 Paseo addresses
- Contract factories added for all 4 satellites
- 165/165 Jest tests passing

## Web App

- 17-contract support — 4 new ABI imports, factory functions, contract labels in Settings
- Deep-merge fix for `contractAddresses` in `SettingsContext` — new default keys no longer lost when merging with old localStorage data
- Null guard in contract factory `make()` — prevents crash on undefined addresses
- Paseo addresses updated from alpha-2 (13) to alpha-3 (17)

## Testnet Deployment (Paseo)

17 contracts deployed and wired on Paseo:

| Contract | Address |
|----------|---------|
| PauseRegistry | `0xA6c70e86441b181c0FC2D4b3A8fC98edf34044b8` |
| Timelock | `0x987201735114fa0f7433A71CFdeFF79f82EB1fE2` |
| ZKVerifier | `0xf65c841F2CEd53802Cbd5E041e65D28d8f5eB4D8` |
| Publishers | `0xB280e7b3D2D9edaF8160AF6d31483d15b0C8c863` |
| BudgetLedger | `0xc683899c9292981b035Cfc900aBc951A47Ed00c8` |
| PaymentVault | `0xF6E62B417125822b33B73757B91096ed6ebb4A2a` |
| TargetingRegistry | `0x668aA4d72FF17205DE3C998da857eBaD94835219` |
| CampaignValidator | `0xCebC8e1E81205b368B4BF5Fc53dAeA0e0b09c08E` |
| Campaigns | `0xd246ede4e6BE1669fecA9731387508a1Eb5A13A3` |
| CampaignLifecycle | `0x6514C058D2De1cd00A21B63e447770780C83dbB5` |
| Settlement | `0xaFF8010109249c3C8f2B5D762002b794Dd14E1d1` |
| ClaimValidator | `0xf1fbe1dfbD78a8E5317001721749382EdB50294a` |
| GovernanceV2 | `0x2F5a0FCEf51a2bD84D71f916E8886Ee35e5139Ff` |
| GovernanceHelper | `0x96c974e7733dc6f570Ae96800d6cc3604A2EA3B9` |
| GovernanceSlash | `0xb1c63CF0f3F27E569757a627FCCc5fe07A7D6BbD` |
| Relay | `0xDa293CbF712f9FF20FF9D7a42d8E989E25E6dd09` |
| AttestationVerifier | `0xA06CAf0A21B8324f611d7Bc629abA16e9d301Fa0` |

- Deployer: Alice `0x94CC36412EE0c099BfE7D61a35092e40342F62D7`
- Publisher 1: Diana (50% take rate, all 26 categories)
- Test campaign: Bob → Diana, 10 PAS, Active
- setup-testnet.ts rewritten with raw JsonRpcProvider (Paseo receipt bug workaround)

## Test Totals

| Component | Tests | Status |
|-----------|-------|--------|
| Alpha-3 contracts | 219 | Passing |
| Extension (alpha-3) | 165 | Passing |
| **Total** | **384** | **All passing** |
