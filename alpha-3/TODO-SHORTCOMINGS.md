# Alpha-3 Shortcomings & Remediation Plan

**Generated:** 2026-04-28
**Scope:** 29 contracts on Paseo v8, extension, web app, SDK, relay

---

## CRITICAL — Must fix before mainnet

### C-1: No contract upgrade path
**Location:** All 29 contracts — no proxy pattern
**Risk:** Any bug discovered post-deploy requires full redeployment + state migration. On mainnet with real funds, this is catastrophic.
**Remedy:**
1. Implement UUPS (ERC-1967) proxies for the 5 highest-risk contracts first: Settlement, Campaigns, BudgetLedger, GovernanceRouter, PaymentVault.
2. Use OpenZeppelin `UUPSUpgradeable` + `Initializable`. Replace constructors with `initialize()`.
3. Gate `_authorizeUpgrade()` behind Timelock ownership.
4. Remaining contracts can stay immutable if their interfaces are stable (ZKVerifier, PauseRegistry, Publishers).
5. Test upgrade path with Hardhat `@openzeppelin/hardhat-upgrades` plugin.
**Effort:** Large — ~2 weeks. Architecture change.
**Ref:** BACKLOG.md MG-3.

### C-2: Single-party ZK trusted setup
**Location:** `circuits/impression.zkey`, `scripts/setup-zk.mjs`
**Risk:** Single contributor knows the toxic waste. Can forge proofs for any claim, minting unbounded settlement payments.
**Remedy:**
1. Run an MPC ceremony (minimum 3 independent contributors, ideally 10+).
2. Use snarkjs `groth16 contribute` for each participant.
3. Apply random beacon (e.g., ETH block hash) as final contribution.
4. Publish ceremony transcript + final ptau for auditability.
5. Re-export VK and proving key; redeploy ZKVerifier with new VK.
**Effort:** Medium — 1 week coordination + ceremony. Technical steps are straightforward.

### C-3: No external security audit
**Location:** All contracts
**Risk:** Internal audit (SECURITY-AUDIT-2026-04-20.md, 30 items) is thorough but not independent. Unknown unknowns in 29 contracts with complex cross-references.
**Remedy:**
1. Engage 2 independent audit firms (one for contracts, one for extension/relay).
2. Prioritize: Settlement, ClaimValidator, BudgetLedger, PaymentVault, GovernanceV2 (highest fund-flow risk).
3. Budget 4-6 weeks for audit + remediation cycle.
4. Publish audit reports.
**Effort:** Large — external dependency, 6-8 weeks total.
**Ref:** BACKLOG.md MG-4.

### C-4: PauseRegistry owner escape hatch
**Location:** `DatumPauseRegistry.sol:135-143` — owner `pause()`/`unpause()` bypass guardians
**Risk:** Owner key compromise = instant unpause of a paused system, even if guardians paused it for good reason. Undermines the 2-of-3 guardian model (SM-6).
**Remedy:**
1. Remove direct owner `pause()`/`unpause()`. All pause/unpause must go through guardian approval.
2. Alternatively: owner can only `pause()` (not `unpause()`). Unpause always requires 2-of-3 guardians.
3. Transfer PauseRegistry ownership to Timelock so even the escape hatch has 48h delay.
**Effort:** Small — contract change + redeploy.

### C-5: No timelock on blocklist operations
**Location:** `DatumPublishers.sol` — `blockPublisher()`/`unblockPublisher()` are instant onlyOwner
**Risk:** Compromised owner key can instantly unblock a malicious publisher, or block a legitimate one with no warning.
**Remedy:**
1. Transfer Publishers ownership to Timelock.
2. Add an emergency `blockPublisher()` path that bypasses timelock (blocking is protective), but `unblockPublisher()` must always go through 48h delay.
3. Emit events with reason codes for auditability.
**Effort:** Small-Medium — ownership transfer + selective bypass logic.
**Ref:** BACKLOG.md MG-1.

### C-6: Timelock single-proposal bottleneck
**Location:** `DatumTimelock.sol:29` — `require(pendingTarget == address(0), "E35")`
**Risk:** Only one proposal can be pending at a time. During governance transitions or emergency multi-contract updates, this serializes all operations through a 48h queue. A 5-contract upgrade takes 10 days minimum.
**Remedy:**
1. Replace single-slot storage with a proposal mapping keyed by `proposalId = keccak256(target, data, salt)`.
2. Each proposal tracks its own timestamp independently.
3. Add `proposalCount` view and enumeration.
4. Keep `cancel()` scoped to specific proposal IDs.
5. Cap max concurrent proposals (e.g., 10) to bound storage growth.
**Effort:** Medium — contract rewrite + redeploy. Must re-transfer ownership of all timelocked contracts.

---

## HIGH — Should fix before mainnet

### H-1: ZK proves count, not engagement quality
**Location:** `circuits/impression.circom`, `DatumZKVerifier.sol`
**Risk:** Publisher can generate valid proofs for fabricated impressions (bot traffic, hidden iframes, zero-pixel ads). The circuit only proves "I served N impressions" not "N real humans saw the ad."
**Remedy:**
1. Short-term: Rely on reputation system + challenge bonds as economic deterrent (already implemented).
2. Medium-term: Add viewability signals to the circuit (scroll depth, viewport intersection, dwell time). Requires circuit redesign + new trusted setup.
3. Long-term: Trusted execution environment (TEE) attestation for browser environment integrity.
**Effort:** Large for circuit changes. Economic deterrents already in place.

### H-2: Extension is sole impression oracle
**Location:** `alpha-3/extension/src/background/`, `alpha-3/extension/src/content/`
**Risk:** Single client implementation = single point of failure and manipulation. A modified extension build can fabricate any impression data.
**Remedy:**
1. SDK (`sdk/`) provides alternative impression source — already exists but needs parity with extension.
2. Implement BM-7 sdkVersionHash verification in ClaimValidator (storage exists in Publishers, not yet enforced).
3. DNS-based SDK integrity verification (BACKLOG XM-4).
4. Long-term: Multiple independent client implementations with cross-validation.
**Effort:** Medium — SDK parity + enforcement logic.
**Ref:** BACKLOG.md XM-2, XM-4.

### H-3: No signing approval popup in extension
**Location:** `alpha-3/extension/` — no UI confirmation before signing settlement claims
**Risk:** User has no visibility into what they're signing. Malicious or buggy campaign could drain budget without user awareness.
**Remedy:**
1. Add a popup/notification when the extension signs a claim batch.
2. Show: campaign name, event count, estimated payment, publisher identity.
3. Allow per-campaign auto-sign settings (trusted campaigns skip popup).
4. Rate-limit signing requests to prevent popup fatigue attacks.
**Effort:** Medium — UI work + message passing between content/background/popup.
**Ref:** BACKLOG.md XH-1.

### H-4: Open relay griefing
**Location:** `DatumRelay.sol` — `submitBatch()` has no caller restriction
**Risk:** Anyone can submit valid signed batches. Griefing vector: front-run the relay bot to force gas waste, or submit stale batches to trigger nonce-chain failures.
**Remedy:**
1. Add optional `authorizedRelayers` mapping — if non-empty, only listed addresses can call `submitBatch()`.
2. Owner manages the relayer list (through Timelock).
3. Keep a permissionless fallback: if relay is down for >N blocks, anyone can submit (liveness guarantee).
**Effort:** Small — contract change.

### H-5: Centralized relay bot
**Location:** `relay-bot/relay-bot.mjs` — single Diana systemd service
**Risk:** Single relay = single point of liveness failure. If Diana goes down, no settlements process.
**Remedy:**
1. Document relay bot deployment for community operators.
2. Add relay bot health monitoring + alerting.
3. Implement relay redundancy: multiple authorized relayers with leader election or round-robin.
4. Expose relay metrics (settlements/hour, gas spent, queue depth).
**Effort:** Medium — ops + redundancy design.

### H-6: DatumRelay immutable references
**Location:** `DatumRelay.sol` — `settlement` and `campaigns` are set in constructor, no setters
**Risk:** If Settlement or Campaigns contracts need redeployment (see C-1), the Relay must also be redeployed. Breaks any external integrations pointing at the old Relay address.
**Remedy:**
1. Add `setSettlement()` and `setCampaigns()` with onlyOwner, gated behind Timelock.
2. Alternatively, if UUPS proxies (C-1) are adopted, Relay can point to stable proxy addresses.
**Effort:** Small — add two setter functions.

### H-7: Settlement has 16 external references
**Location:** `DatumSettlement.sol` — campaigns, claimValidator, budgetLedger, paymentVault, publishers, governance, lifecycle, tokenRewardVault, nullifierRegistry, rateLimiter, reputation, pauseRegistry, clickRegistry, etc.
**Risk:** Highest coupling in the system. Any misconfigured reference silently breaks settlement. `configure()` takes 4 args but there are 16 total references set across multiple functions.
**Remedy:**
1. Add a `validateConfiguration()` view that checks all references are non-zero and respond to expected interfaces.
2. Call `validateConfiguration()` at end of deploy script as a smoke test.
3. Consider a registry pattern: single `AddressRegistry` contract that Settlement reads from, reducing N setters to 1 registry pointer.
**Effort:** Small for validation view. Medium for registry pattern.

---

## MEDIUM — Should fix before public beta

### M-1: Hardcoded revenue split magic number
**Location:** `DatumSettlement.sol:443` — `uint256 userPayment = (rem * 7500) / 10000;`
**Risk:** 75/25 user/protocol split is a magic number with no named constant. Not governable — changing it requires contract redeploy.
**Remedy:**
1. Extract to named constant: `uint256 private constant USER_SHARE_BPS = 7500;`
2. Better: make it a governable parameter set via ParameterGovernance, stored as state variable with a setter gated by Timelock.
3. Add bounds: min 5000 bps (50%), max 9500 bps (95%) to prevent extreme values.
**Effort:** Small for constant. Medium for governable parameter.

### M-2: Unverifiable targeting tags
**Location:** `DatumTargetingRegistry.sol` — tags are arbitrary `bytes32` values
**Risk:** No on-chain tag dictionary or validation. Publishers can set meaningless tags. Advertisers can require non-existent tags. No discovery mechanism.
**Remedy:**
1. Maintain an on-chain tag registry with approved tags (owner-managed initially, governance-managed later).
2. `setTags()` validates each tag exists in registry.
3. Expose `listTags()` view for UI enumeration.
4. Already partially addressed by TX-5 tag dictionary trimming (see memory).
**Effort:** Small-Medium.

### M-3: No price discovery mechanism
**Location:** Campaign creation — advertiser sets rates manually per pot
**Risk:** No market signal for fair CPM/CPC/CPA rates. Advertisers overpay or underpay. No competition mechanism.
**Remedy:**
1. Short-term: Publish reference rates in documentation based on testnet data.
2. Medium-term: Implement a rate oracle that aggregates recent settlement rates per category.
3. Long-term: Auction-based pricing (second-price auction per impression slot).
**Effort:** Large — economic design problem. Low urgency for testnet.

### M-4: Untested governance phase transitions
**Location:** GovernanceRouter, AdminGovernance, Council, GovernanceV2
**Risk:** The Admin→Council→OpenGov transition path has never been exercised end-to-end on testnet. Timelock proposals for `router.setGovernor()` untested with real state.
**Remedy:**
1. Write a governance-transition test script that:
   a. Proposes `setGovernor(Council, councilAddr)` via Timelock
   b. Waits 48h (use `evm_increaseTime` in test, real wait on testnet)
   c. Executes the transition
   d. Verifies Council can activate/terminate campaigns
   e. Repeats for Council→OpenGov
2. Run on testnet before mainnet.
**Effort:** Medium — script writing + testnet execution.

### M-5: WalletConnect not implemented
**Location:** Web app — only injected provider (MetaMask/Talisman)
**Risk:** Excludes mobile users and hardware wallet users who connect via WalletConnect.
**Remedy:**
1. Add `@walletconnect/web3-provider` or `@web3modal/ethers`.
2. Abstract provider selection in a `useWallet()` hook.
3. Test with Polkadot-compatible WalletConnect relay.
**Effort:** Medium — standard integration.
**Ref:** BACKLOG.md XM-2.

### M-6: AdminGovernance uses low-level calls
**Location:** `DatumAdminGovernance.sol` — `router.call(abi.encodeWithSelector(...))` throughout
**Risk:** Silent failure — if the call reverts, the outer function still succeeds (return value not checked in some paths). Should use interface calls or check return values.
**Remedy:**
1. Define `IGovernanceRouter` interface with `activateCampaign()`, `terminateCampaign()`, `demoteCampaign()`.
2. Replace `router.call(...)` with `IGovernanceRouter(router).activateCampaign(...)`.
3. Or add `require(ok, "E02")` after every `.call()`.
**Effort:** Small — contract change + redeploy.

### M-7: Council cancel/veto event conflation
**Location:** `DatumCouncil.sol:232` — `cancel()` sets `p.vetoed = true` and emits `Vetoed` event
**Risk:** Off-chain indexers cannot distinguish owner cancellation from guardian veto. Audit trail is ambiguous.
**Remedy:**
1. Add separate `cancelled` bool to Proposal struct.
2. Emit `Cancelled(proposalId)` event distinct from `Vetoed(proposalId)`.
3. `cancel()` sets `p.cancelled = true`; `veto()` sets `p.vetoed = true`.
**Effort:** Small — contract change.

### M-8: Council member list is append-only
**Location:** `DatumCouncil.sol:54` — `_memberList` never shrinks
**Risk:** Over time, `_memberList` accumulates ghost entries (removed members with `isMember = false`). `getMembers()` iterates the full array, increasing gas cost linearly.
**Remedy:**
1. In `removeMember()`, swap-and-pop the removed member from `_memberList`.
2. Maintain a `memberIndex` mapping for O(1) lookup.
3. Or: accept the gas growth for testnet, fix for mainnet.
**Effort:** Small.

---

## LOW — Nice to have / long-term

### L-1: Conviction voting whale risk
**Location:** `DatumGovernanceV2.sol`, `DatumParameterGovernance.sol`, `DatumPublisherGovernance.sol`
**Risk:** Large token holder can dominate governance with high-conviction votes. No quadratic voting or delegation cap.
**Remedy:**
1. Implement vote cap per address (e.g., max 10% of quorum from single voter).
2. Or: quadratic voting where vote weight = sqrt(stake * conviction_weight).
3. Long-term consideration — acceptable for testnet with known participants.
**Effort:** Medium — governance redesign.

### L-2: PaymentVault potential dust lock
**Location:** `DatumPaymentVault.sol` — no minimum withdrawal, no dust sweep
**Risk:** Tiny balances (< existential deposit) may be unwithdrawable on Polkadot Hub. PolkaVM runtime enforces ED natively, but the mapping still holds the balance.
**Remedy:**
1. Add `sweepDust(address[] accounts)` owner function that sends sub-ED balances to treasury.
2. Or: enforce minimum withdrawal amount matching chain ED.
**Effort:** Small.

### L-3: No GDPR/privacy compliance path
**Location:** On-chain data — campaign IDs, publisher addresses, settlement amounts are permanent
**Risk:** EU users may request data deletion. On-chain data is immutable.
**Remedy:**
1. Ensure no PII is stored on-chain (currently true — addresses are pseudonymous).
2. Extension stores impression data locally — add "clear my data" in settings.
3. Document the privacy architecture: what's on-chain (pseudonymous) vs. off-chain (deletable).
4. Legal review for GDPR Article 17 compliance.
**Effort:** Small for documentation. Legal review is external dependency.

### L-4: No E2E browser validation
**Location:** Extension + testnet
**Risk:** The full flow (load extension → see ad → generate impression → relay settlement → verify on-chain) has never been tested end-to-end in a real browser against live contracts.
**Remedy:**
1. Write a Playwright/Puppeteer E2E test that:
   a. Loads extension in Chrome
   b. Navigates to demo page with SDK-tagged ad slot
   c. Waits for impression registration
   d. Triggers relay settlement
   e. Verifies PaymentVault balance change on-chain
2. Run against Paseo testnet.
**Effort:** Medium — test infrastructure.
**Ref:** Next Steps item 8.

### L-5: Single reputation reporter
**Location:** `DatumPublisherReputation.sol` — single `reporter` address (Diana relay bot)
**Risk:** If reporter key is compromised, reputation scores can be manipulated. Single reporter = single point of trust.
**Remedy:**
1. Add multi-reporter support: N authorized reporters, scores averaged or median.
2. Or: make Settlement itself the reporter (direct callback after settlement, no external dependency).
3. Settlement already has the data — `recordSettlement()` could be an internal call.
**Effort:** Small-Medium.

### L-6: Daily cap uses wall-clock division
**Location:** `DatumBudgetLedger.sol` — `block.timestamp / 86400` for daily window
**Risk:** Block timestamps can drift. Day boundaries are UTC-dependent. A settlement straddling midnight could double-spend the daily cap.
**Remedy:**
1. Accept for testnet — the risk is bounded (one extra day's cap at most).
2. For mainnet: use block numbers instead (14,400 blocks = 24h at 6s).
3. Or: add a 1-hour grace overlap where both windows are checked.
**Effort:** Small.

### L-7: No circuit breaker on settlement volume
**Location:** `DatumSettlement.sol`
**Risk:** A bug or exploit could drain BudgetLedger in a single block via rapid settlement calls.
**Remedy:**
1. Add a global per-block or per-hour settlement cap (total planck settled).
2. RateLimiter exists per-publisher but not globally.
3. PauseRegistry is the current circuit breaker but requires manual intervention.
**Effort:** Small-Medium.
**Ref:** BACKLOG safe rollout — oracle circuit breaker.

---

## Already addressed (removed from findings)

- **LP-1 (MAX_SCAN_ID):** Fixed — `campaignPoller.ts:7` confirms no scan limit.
- **SM-6 (PauseRegistry guardians):** Partially addressed — 2-of-3 guardian approval exists. Remaining issue (owner bypass) tracked as C-4.
- **FP contracts UI:** All integrated (T1-A through T2-D complete).
- **Security audit items:** All 30 internal items implemented (SECURITY-AUDIT-2026-04-20.md).

---

## Priority execution order

1. **C-3** External audit — start immediately (longest lead time)
2. **C-4** PauseRegistry owner bypass — small fix, high impact
3. **C-5** Timelock on blocklist — small fix, high impact
4. **C-6** Timelock multi-proposal — unblocks governance operations
5. **H-3** Signing popup — user trust prerequisite
6. **M-1** Revenue split constant — trivial fix
7. **M-6** AdminGovernance interface calls — trivial fix
8. **C-1** UUPS proxies — largest effort, do after audit feedback
9. **C-2** MPC ceremony — coordinate during audit period
10. **H-6, H-7** Relay setters + Settlement validation — quick wins
11. **M-4** Governance transition test — run on testnet
12. **L-4** E2E browser test — validates the full stack
13. Everything else by priority tier
