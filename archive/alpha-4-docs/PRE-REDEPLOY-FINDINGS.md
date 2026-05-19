# DATUM Alpha-4 — Pre-Redeploy Exploit / Gap Findings

Audit of the surface not yet on Paseo as of 2026-05-13, evaluated against the stated invariants:
- Low-assurance = open / trust assumed; **trust should decrease as campaign validation level increases**.
- Governance should follow the same gradient: **open permissiveness → guarded rails over time**.
- Action should become **more community-driven** monotonically.

# Findings

## HIGH — break the trust gradient or enable theft

### H1. `DatumWrapper.wrap()` has no atomic deposit accounting
`wrap(amount)` mints WDATUM 1:1 against the *caller's claim* that they pre-transferred canonical DATUM, then checks only the global invariant `totalSupply <= canonicalHeld` (`token/DatumWrapper.sol:80-88`). There is no per-caller record of who funded which canonical. Any slack in the canonical reserve — from a donation, off-by-one from `MintAuthority`, or a precompile.transfer landing in a different tx than the wrap — is captured by **whoever calls `wrap` first**. The invariant cannot detect this because both totalSupply and canonicalHeld are scalars.
**Why it matters here:** WDATUM is the asset behind fee-share, governance bribes, and bridging. A free-mint primitive against latent slack is a quiet, reproducible theft path.
**Fix:** require `precompile.transferFrom(msg.sender, address(this), amount)` *inside* `wrap`, so the contract pulls canonical itself — there is no untracked window.

### H2. AssuranceLevel gate fails OPEN on revert
`DatumSettlement.sol:720-722` reads campaign level via `try/catch` and defaults to **0** (most permissive) on revert. Same fail-open shape on the legacy `getCampaignRequiresDualSig` (line 762-770). A misconfigured or hot-swapped Campaigns interface, a function-selector mismatch, or a campaign created at a level the lookup can't return — all silently downgrade L2 campaigns to L0.
**Why it matters here:** this is the *one gate* that implements your "trust decreases with level." Fail-open on the gate inverts the gradient — high-assurance campaigns become *more* exploitable than low ones (advertiser thinks they're protected by dual-sig, but a stale read makes that not so).
**Fix:** fail closed. Treat revert as "max enforced level," reject the batch, emit a loud event. Operators eat a DoS, advertisers don't eat a forged settlement.

### H3. `MintAuthority.transferIssuerTo` has no timelock and no successor constraint
`token/DatumMintAuthority.sol:178-182` is plain `onlyOwner`. The function transfers the **Asset Hub canonical issuer** away from this contract. After execution, the new authority is the sole minter of DATUM forever — no rollback path exists at the Asset Hub level.
**Why it matters here:** this is the single highest-blast-radius call in the system, and it's gated by the *least* protection. Audit pass 2 left it intentionally mutable for the §5.5 sunset path; that decision needs to be revisited before mainnet.
**Fix:** two-step accept (successor must call `acceptIssuerRole()`); minimum timelock delay independently configurable and longer than the standard router timelock; ideally a `lockSuccessorClass()` that constrains successors to a known interface ID.

## MEDIUM — gradient leaks under specific configurations

### M1. `userMinAssurance` is not enforced on the dual-sig path
The user-floor check (`DatumSettlement.sol:728`) only runs in the `!advertiserConsented` branch. A user who set `userMinAssurance = 2` is correctly protected against relay-path submissions for L0/L1 campaigns, but if a publisher+advertiser pair submits a forged dual-sig batch naming that user, the floor is skipped — by intent (dual-sig is L2, which satisfies the floor). The leak is that **a user has no way to demand L3 (ZK)** because the enum only goes to 2 (`require(level <= 2, "E11")` on line 390), even though ZK verification exists per-claim. A user wanting "only ZK settlement" cannot express it.
**Fix:** widen the enum and have `_processBatch` consult ZK status — even for dual-sig batches — when the user's floor is 3.

### M2. Settlement-side blocklist fails OPEN by design (regardless of AssuranceLevel)
`DatumSettlement.sol:853-857` explicitly favors liveness over blocking when `publishers.isBlocked()` reverts. The comment defends this as "soft policy." At L0 this is defensible (prefer paying users over rare DoS), but at L2 the advertiser has signed a batch under the assumption that protocol-level blocklist is enforced. **Same lookup, same fail-open, regardless of trust tier.**
**Fix:** make fail-open conditional on AssuranceLevel — for level ≥ 1, treat revert as block.

### M3. BootstrapPool Sybil resistance is *entirely* delegated to house-ad campaign config
`DatumBootstrapPool.claim` is settlement-gated (`require(msg.sender == settlement)`), so a Sybil must produce a settlement against the house-ad campaign — meaning their cost floor is whatever AssuranceLevel that campaign is configured at. If house-ad is L0 with no stake gate, every fresh EOA gets 3 WDATUM and the 1M reserve drains in 333K EOAs.
**Fix:** read the house-ad campaign's AssuranceLevel inside BootstrapPool at claim time, refuse to pay if below a hardcoded floor (e.g., require L1). Don't trust operators to configure the upstream campaign correctly.

### M4. Governance ladder has no phase-forward lock
`DatumGovernanceRouter.setGovernor(newPhase, newGovernor)` accepts *any* phase, including moving from OpenGov → Council → Admin (`DatumGovernanceRouter.sol:102-107`). Two-step accept prevents typos, not malicious successor choice. The Timelock owner retains the ability to *de-decentralize* the system forever.
**Why it matters here:** this is the exact monotonicity stated for governance. The invariant is "more community-driven over time"; the code lets it go either way.
**Fix:** add `lockPhaseFloor()` — once Phase 1 is reached, `setGovernor` rejects any proposal with `newPhase < Phase.Council`; once Phase 2 is reached, `newPhase < Phase.OpenGov` is rejected.

### M5. Tag-approval gate is a centralized censorship surface with no decentralization endpoint
`DatumCampaigns.approveTag`, `removeApprovedTag`, `approveTags`, `setEnforceTagRegistry` are all `onlyOwner` with no lock and no governance routing. An advertiser whose required tag isn't on the approved list cannot run a campaign at all. This sits *before* AssuranceLevel — even an L2 campaign can be excluded by tag policy.
**Fix:** route the tag dictionary through GovernanceRouter once Phase 1 is live (or a separate `tagCurator` shim mirroring CouncilBlocklistCurator's pattern), with a `lockTagOwnership()` cutover.

## LOW — design notes & doc corrections

### L1. CouncilBlocklistCurator is **not** a single-tx "fast lane" (correction to PROCESS-FLOW doc)
`onlyCouncil` checks `msg.sender == council` (the contract), not membership (`DatumCouncilBlocklistCurator.sol:39-42`). Every block/unblock still flows through `DatumCouncil.propose → vote → executionDelay → vetoWindow → execute`. The curator's actual value is decoupling council *rotation* from blocklist *state* — when a v1→v2 council swap happens, the blocklist isn't reset. The PROCESS-FLOW writeup framed it as a speed lane; that was wrong.

### L2. AssuranceLevel-1 enforcement leaks via permissionless `DatumRelay`
At L1, `_processBatch` accepts batches where `msg.sender == relayContract`. But `DatumRelay` is currently in *open* mode (`lockRelayerOpen()` not called per deploy state). Any unauthorized actor can submit through it, and the L1 check just rubber-stamps the fact-of-arrival via the relay address. The publisher sig check exists inside Relay — but Relay's pre-Settlement verification is what L1 trusts, not the Relay-set-membership. As long as that sig check is sound, this is fine; but it means **`DatumRelay`'s liveness threshold + sig verification are the actual L1 enforcement**, not the relayer ACL.
**Recommendation:** before mainnet, call `lockRelayerOpen()` after vetting a relayer set, so L1 trust isn't just "any EOA that passes Relay's stateless checks."

### L3. `_ahAddressOf` mock-shim is still on the production unwrap path
`DatumWrapper.sol:109-111` derives an EVM-shaped recipient from a 32-byte AccountId for the precompile call. Comment labels it devnet-only; the function is unconditionally called from `unwrap`. On mainnet (real XCM-backed precompile) this conversion may map a valid AccountId to a non-existent EVM address.
**Fix:** before mainnet, the wrapper's unwrap must call an XCM-aware precompile entrypoint that accepts the raw AccountId.

### L4. Most `DatumCampaigns` policy levers stay owner-mutable forever
`setMaxCampaignBudget`, `setDefaultTakeRateBps`, `setEnforceTagRegistry`, `setBulletinRenewerReward`, `approveTag`/`removeApprovedTag` — all `onlyOwner`, no lock, no route through GovernanceRouter. Compare to the `lockBootstrap` / `lockPlumbing` patterns elsewhere — these policy levers don't get the same treatment. Fine in Phase 0/1; should be lockable or governance-routed by Phase 2.

# Summary against the stated invariants

| Invariant | Status | Findings |
|---|---|---|
| Trust assumed at low levels, *decreasing* at high levels | **Inverted in two places** | H2 (gate fails open), M2 (blocklist fails open regardless of level) |
| Highest-stakes actions = strongest gating | **Inverted** | H3 (Asset Hub issuer transfer has the weakest gate in the system) |
| Governance monotonically decentralizes | **No on-chain enforcement** | M4 (no phase-floor lock), M5 (tag policy has no decentralization endpoint), L4 (policy levers don't lock) |
| User-side opt-out for high-assurance | **Capped at L2** | M1 (no L3/ZK floor expressible) |

The two structural changes that would do the most to align code with the invariants:
1. **Fail-closed on every AssuranceLevel/blocklist read at level ≥ 1**.
2. **Add `lockPhaseFloor()` + lock-or-route every remaining `onlyOwner` policy lever before Phase 2.**

Together they convert "operators must configure correctly" into "the contract enforces the gradient."
