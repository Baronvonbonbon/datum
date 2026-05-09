# DATUM Alpha-4 Threat Model — Follow-up Items

**Date:** 2026-05-09
**Status:** Captured for reference only — not tracked, no commitment to a delivery order.
**Source:** Role-by-role threat-model walkthrough after the three audit passes
(`SECURITY-AUDIT-alpha4-{hotpath,governance,rest}-2026-05-08.md`) plus their fix
commits (`9b15285`, `368ce39`, `42744ec`). Everything below is **open work** —
items already addressed in those commits aren't repeated here.

The list is organized roughly by impact + effort. Pick what makes sense when
you next sit down for a security pass.

---

## Open vectors worth fixing

### 1. Advertiser freezes user earnings via mid-campaign `requiresDualSig` flip

**Vector.** `DatumCampaigns.setCampaignRequiresDualSig(campaignId, true)` is
callable by the advertiser at any time, including after the campaign has
been Active and accumulating impressions. Once flipped on, every queued
user claim chain becomes un-settleable without the advertiser's EIP-712
co-sig — which a malicious advertiser can simply refuse to provide. The
advertiser keeps their budget; users lose their earnings.

**Fix.** Lock the toggle once the campaign is Active. One-line in
`DatumCampaigns.setCampaignRequiresDualSig`:

```solidity
require(c.status != CampaignStatus.Active, "E22");
```

Alternative if you want post-creation flexibility: track
`requiresDualSigSinceBlock` and apply only to claims with `nonce > sinceNonce`,
so in-flight chains finish under the prior rule. More work, more complex.

**Severity if unfixed:** Medium. Direct value-extraction by advertiser.

---

### 2. Publisher `setRelaySigner` rotation timing window

**Vector.** A publisher rotating their relay signer key has a brief window
where both old and new keys are valid (the moment of change). If the old
key was compromised, the attacker can sign attestations during the
rotation block.

**Fix.** Add a cooldown between rotations and emit a public event so
monitors notice:

```solidity
mapping(address => uint256) public relaySignerRotatedBlock;
uint256 public constant RELAY_SIGNER_ROTATION_COOLDOWN = 1000; // ~1.7h

function setRelaySigner(address signer) external whenNotPaused {
    require(_publishers[msg.sender].registered, "Not registered");
    require(
        block.number >= relaySignerRotatedBlock[msg.sender] + RELAY_SIGNER_ROTATION_COOLDOWN,
        "E22"
    );
    relaySigner[msg.sender] = signer;
    relaySignerRotatedBlock[msg.sender] = block.number;
    emit RelaySignerUpdated(msg.sender, signer);
}
```

**Severity if unfixed:** Low. Narrow window, requires prior key compromise.

---

### 3. Council guardian / member mutual exclusivity

**Vector.** Today the guardian veto is meant to be an independent check on
council proposals, but the contract doesn't enforce that the guardian
isn't also a council member. A guardian-member could veto peers' proposals
unilaterally.

**Fix.** One-line checks on both setters:

```solidity
function setGuardian(address _guardian) external onlyCouncil {
    require(!isMember[_guardian], "E11");
    guardian = _guardian;
    emit GuardianSet(_guardian);
}

function addMember(address member) external onlyCouncil {
    require(member != guardian, "E11");
    require(!isMember[member], "E00");
    // …
}
```

**Severity if unfixed:** Low. Council-design hardening.

---

### 4. Reputation reporter compromise destroys any publisher's reputation

**Vector.** `DatumSettlement.recordSettlement(publisher, campId, settled, rejected)`
trusts the authorized reporter (typically the relay-bot EOA) implicitly. A
compromised reporter key can submit fabricated counts to inflate or
demolish any publisher's reputation. The protocol's BM-9 anomaly detection
itself becomes unreliable if the reporter is malicious.

**Fix.** Stop trusting bare counts. Two clean options:

- **Event Merkle proof.** Reporter submits a Merkle proof of `ClaimSettled` /
  `ClaimRejected` events from a specific block range. Settlement verifies
  the root against an on-chain block-hash anchor (or a relayer-bot-signed
  finality attestation), then increments the counters from the leaf set.
- **Inline accounting in Settlement.** Move the reputation increments into
  `_processBatch` itself — counters update from on-chain truth, never via
  external reporter. Requires more storage but eliminates the trust
  assumption entirely.

The inline path is simpler and probably better. The reporter pattern
exists today only because reputation tracking was originally a separate
satellite (alpha-3) before the merge into Settlement.

**Severity if unfixed:** Medium. A single compromised EOA can poison
publisher reputation across the protocol.

---

### 5. SDK hash verification not enforced in the extension

**Vector.** `DatumPublishers.sdkVersionHash[publisher]` lets a publisher
register a hash of the SDK they intend to ship. The extension reads
campaigns and renders ads but **never verifies the SDK actually loaded on
the page matches that hash**. A publisher can register one SDK and embed
a tampered one without detection.

**Fix.** In `extension/.../content/sdkDetector.ts`, after detecting the
SDK script:

1. Fetch the actual JS bytes from the script tag's `src`.
2. Hash via `keccak256` (matching whatever encoding the publisher used —
   document this in the SDK README).
3. Compare against the on-chain `sdkVersionHash`.
4. On mismatch: refuse to inject ads + queue a `reportPage` candidate for
   the user.

Caveats: cross-origin reads are restricted; may need a content-script
fetch with `mode: "cors"`. The publisher's SDK hosting must allow this.

**Severity if unfixed:** Medium. Off-chain integrity gap; the on-chain
mechanism (BM-7) exists but isn't enforced.

---

### 6. ZK trusted setup is single-party (testnet posture)

**Vector.** `circuits/impression.circom` was set up with a single-party
ceremony for development. A malicious setup operator could in principle
forge any proof. Memory + audit doc both flag this.

**Fix.** Run an MPC ceremony with ≥3 independent participants
(`snarkjs powersOfTau`-style multi-contributor) before mainnet deploy.
Publish the contribution transcript so anyone can verify their preferred
participant joined.

**Severity if unfixed:** **Hard mainnet blocker.** Don't ship to
Kusama / Polkadot Hub without this.

---

### 7. External professional audit

Three internal passes surfaced a high, 13 mediums, and 10 lows — most
fixed in this round. A fresh adversarial reviewer will find more.
Kusama deploy with the audit-fix commits, then book a Trail-of-Bits /
Spearbit / similar before Polkadot Hub mainnet.

---

## Acknowledged but accepted (no fix planned)

These were noted in the audit docs as "won't-fix" or "design choice":

- **I-2** (hot path) — Daily-cap timestamp skew ~12 s at day boundaries.
- **I-4** (hot path) — Dual-sig collapses to single-sig when publisher == advertiser.
- **I-5** (hot path) — Demoted-and-orphaned campaigns lock funds if governance
  is bricked. Mitigated by the governance ladder + Timelock.
- **G-I2** — GovernanceV2 50/50 ties go to nay (`>=` vs `>`). Conservative
  tie-breaker; document in user-facing governance docs.
- **R-I1** — `setMetadata` and `setCampaignRequiresDualSig` accept any
  campaign status. Reasonable for archival metadata; the dual-sig flag
  has no effect post-Active anyway.
- **R-I2** — `DatumClickRegistry._sessionHash` uses `abi.encodePacked` on
  fixed-size fields. Currently safe; revisit if the schema grows.
- **L-2** (hot path) — *Was* deferred for migration coordination; landed in
  commit `8027927` (`abi.encode` switch) when the user requested. Already done.

---

## Cross-cutting design observations (not bugs)

- **DOT-weighted governance everywhere.** Every voting surface
  (GovernanceV2, Council, ParameterGovernance, PublisherGovernance) is
  ultimately stake-weighted. Long-term sybil resistance probably needs an
  identity overlay (People Chain integration is in
  `project_abuse_vectors.md`).
- **Owner == Timelock is load-bearing.** A great many findings degrade
  to "owner trust" — the protective layer is the Timelock + multisig
  setup at deploy time. Document the deploy invariants and verify them
  on every redeploy.
- **`receive() {}` audit.** Three contracts now revert on stray native
  deposits (`BudgetLedger`, `Timelock`, `ChallengeBonds`,
  `TokenRewardVault`) and three accept (`PaymentVault`, `Council`,
  `GovernanceV2` — all need it for legitimate inbound). Worth a one-line
  audit-checklist item: any new contract should explicitly `revert("E03")`
  unless it has a documented internal path that requires open `receive()`.

---

## Threat model context

The full role-by-role analysis lives in chat history (the message dated
2026-05-09 immediately preceding this doc). This file captures only the
actionable open items so it can be re-read without rebuilding the
context. The fully-mitigated vectors per role aren't repeated.
