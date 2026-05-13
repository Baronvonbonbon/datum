# DATUM Alpha-4 — Future Work

Items intentionally deferred from the checks-and-balances pass (CB1–CB7). Each requires significant design conversation before implementation. None are blockers for the next redeploy.

---

## CB8 — Anti-plutocracy in OpenGov

### Problem
`DatumGovernanceV2` weights conviction-locked PAS linearly. The largest holder by stake × conviction dominates every vote. The conviction multiplier (1×–21×) compresses the gap somewhat but doesn't eliminate it — a single whale with long lockup can outvote thousands of small holders.

### Options to weigh
1. **Quadratic conviction discount above a threshold.** Voting weight grows linearly with stake up to a soft cap, then sqrt(stake) above. Preserves small-holder agency without disenfranchising large stakeholders.
2. **Bicameral ratification (CB5 extended).** Already in scope: high-tier OpenGov actions require Council non-veto. Could extend to ALL governance, making Council a permanent upper house. Trade-off: slows routine governance.
3. **Reputation-weighted conviction.** Stake × conviction × reputation, where reputation tracks historical accuracy of votes (vote-aligned-with-outcome stays in good standing; vote-against-final-outcome decays reputation). Requires reputation primitive.
4. **Time-weighted whale discount.** Voting weight decays for an individual address as their cumulative cast-weight exceeds a threshold within a window. Limits sustained whale dominance without preventing one-off large stakes.

### Why deferred
Each option is a meaningful protocol-policy change and a significant engineering effort. The conviction system in alpha-4 has not yet been stress-tested in production with real PAS values. Premature optimization without empirical data risks introducing bugs without measurable benefit.

### Next step
Wait for ≥3 months of mainnet conviction-vote data; identify whether plutocracy is observed or theoretical; pick option based on observed failure mode.

---

## CB9 — Cold-key recovery surface

### Problem
Every role in the system has one terminal failure mode: lose the cold key, lose everything. Affected:
- **User:** loses access to all earned DOT in PaymentVault, all TokenRewardVault credits, all DAT holdings, all userMinAssurance / blocklist / userPaused preferences.
- **Publisher:** loses registration identity, accumulated reputation, take rate configuration, stake. Forced to register a new EOA from scratch.
- **Advertiser:** loses every running campaign and its budget.
- **Council member:** removed only by Council vote (handled), but their addMember record is gone.
- **Anyone with vested DATUM:** loses every unvested token.

This is a significant UX risk for non-technical users and a real operational risk for organizations.

### Options to weigh
1. **Social recovery surface (multi-sig with delay).** Each principal registers a set of guardians at the time of identity creation. After a long delay (e.g. 30 days), a guardian threshold can rotate the principal's address. Highest UX, highest complexity.
2. **Time-locked migration.** Principal stages an address rotation; goes live after a long window (e.g. 90 days) unless cancelled by the staged address. Lower complexity, requires the user to be alive and present at staging time (doesn't help with lost-key case but does help with key-rotation-for-hygiene case).
3. **ENS/identity-pallet-backed identity.** Principal identity is a name registered in an external identity system (Polkadot identity pallet, ENS-like). Recovery happens at the identity layer, not the protocol. Lowest complexity for the protocol; requires the identity system to exist with the desired semantics.
4. **Per-role recovery primitives.** Different recovery mechanisms per role (e.g. publisher recovery via Council-arbitrated proof; user recovery via social recovery; advertiser recovery via campaign-transfer flow). Highest flexibility, highest fragmentation.

### Why deferred
Cold-key recovery is a security/UX trade-off with no consensus best practice in the EVM ecosystem. Every existing recovery system has been exploited in production at least once. The protocol can ship without recovery and add it later under the same principle as bootstrap → governance handoff.

### Next step
Evaluate Polkadot's identity pallet / People Chain integration in Q3. If the identity layer provides recovery semantics, route through it rather than building protocol-native primitives.

---

## Other accumulated future items

### CB6-extension: MintAuthority pause wiring
`DatumPauseRegistry.CAT_TOKEN_MINT` exists but `DatumMintAuthority` does not consume it yet. The category is callable but unenforced. Wire it before the parachain sunset: add `IDatumPauseRegistry pauseRegistry` to MintAuthority, gate mintForSettlement/mintForBootstrap/mintForVesting on `!pauseRegistry.pausedTokenMint()`.

### CB5-extension: high-tier target registry
The current CB5 implementation provides the veto-window primitive but doesn't enforce which target functions MUST route through it. Operators decide via ownership transfer. A future addition: an on-chain selector registry that classifies (target, selector) pairs as high-tier, with a separate gate contract that wraps the targets and refuses direct calls for high-tier selectors. Adds enforcement instead of relying on operator discipline.

### M3-extension: BootstrapPool Sybil hardening
The L1 floor on house-ad campaign assurance is currently the only Sybil cost. If publisher cosig becomes cheap to obtain (e.g. small staking threshold), bootstrap can still be drained. Future hardening options:
- Require Proof-of-Personhood / identity attestation per claimant
- Cap claims per IP/fingerprint at the off-chain layer with attestation
- Lower bootstrapPerAddress over time (early adopters get more)

### General: post-mainnet monitoring framework
A standardized observability layer for events critical to checks-and-balances:
- `UserBlocklistRejected`, `UserPaused`, `UserMinAssuranceSet` for user self-sovereignty audit
- `HighTierProposed`, `HighTierVetoed`, `HighTierExecuted` for bicameral activity
- `BlocklistFailedClosed`, `AssuranceLookupFailed` for gradient inversion attempts
- `AdvertiserSlashed`, `MemberRelaySignerSet` for accountability events

Currently emitted but not standardized into a dashboard.
