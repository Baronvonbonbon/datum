# Claim settlement gas — A/B prototypes

Harness: `test/gas-ab.test.ts` — settles an N-claim single-campaign view batch via
`settleClaims`, reads `gasUsed` from the receipt. Warmup settle first so persistent
singleton slots are non-zero (keeps rows monotonic). Same setup as `settlement.test.ts`.

Marginal per-claim = (total(20) − total(10)) / 10. Fixed per-batch = total(1) − marginal.

## Baseline (branch point `f617f17`, unmodified)

| N  | total gas | per-claim (total/N) |
|----|-----------|---------------------|
| 1  |   353,004 | 353,004 |
| 5  |   531,274 | 106,254 |
| 10 |   754,067 |  75,406 |
| 20 | 1,199,867 |  59,993 |

- **Marginal per-claim ≈ 44,570 gas**
- **Fixed per-batch ≈ 308,400 gas**

The marginal is dominated by `DatumClaimValidator.validateClaim` running ~8
campaign/publisher-invariant external staticcalls **per claim** (getCampaignForSettlement,
getCampaignPot, isBlocked, allowlist count/gate/take-rate, activationBonds.isMuted,
requiresZk), plus per-claim cold SSTOREs to the nonce/hash/settled chain slots.

## #1 Hoist (campaign-invariant reads → once per batch)

`DatumClaimValidator.validateClaim` split into `resolveBatchContext` (all
campaign/publisher-invariant reads + gates, once per batch) + `validateClaimWithContext`
(per-claim-varying checks only). `DatumSettlementLogicB` resolves the context once before
the loop and hoists the S12 + CB1 publisher blocklist gates (publisher invariant via E34).
Single-actionType enforced per-claim (reason 21) so the hoisted pot read stays valid.
Back-compat `validateClaim` retained (composes the two) for direct callers/tests.

| N  | total gas | per-claim | Δ vs baseline |
|----|-----------|-----------|---------------|
| 1  |   356,215 | 356,215 | +3,211 |
| 5  |   483,749 |  96,749 | −47,525 |
| 10 |   643,120 |  64,312 | −110,947 |
| 20 |   962,065 |  48,103 | −237,802 (−19.8%) |

- **Marginal per-claim ≈ 31,880 gas** (was 44,570 → **−28.5%**)
- **Fixed per-batch ≈ 324,300 gas** (up ~16k: context now resolved once per batch)
- **≈1.40× more claims per batch** at the same gas ceiling (large-N regime).
- N=1 pays a ~3k penalty (two validator calls instead of one) — immaterial for the
  large relay batches this targets.
- 114/114 settlement + validator tests green; split is behaviour-neutral (back-compat
  wrapper), only the rejection-reason *precedence* shifts for pathological double-failure
  claims (e.g. eventCount==0 on an inactive campaign now reports the campaign reason first).

### Further per-claim levers (not done here)
- `budgetLedger.deductAndTransfer` still runs **per claim** (external call + SSTORE + DOT
  transfer). The batch already accumulates `agg.total`/`agg.publisherPayment`; debiting once
  per batch would cut another external call per claim — but it moves the budget-exhaustion
  boundary to batch granularity, so it needs its own correctness pass.
- `validateClaimWithContext` is still an external CALL per claim; inlining into LogicB
  would save the call overhead at the cost of LogicB bytecode (EIP-170 budget).

## #2 Slim wire format (replace in place)

## #2 Slim wire format (replace in place)

Per-claim calldata today = **736 B** (N=20 batch = 14,944 B). Breakdown for a view claim:

| group | fields | bytes | removable? |
|-------|--------|-------|------------|
| needed | publisher, eventCount, rateWei, actionType | 128 | no |
| replay-critical | nonce, previousClaimHash | 64 | **only with a signing-scheme replay guard** |
| safe-redundant | campaignId (dup of batch), claimHash (recomputed) | 64 | yes, no signing change |
| heavy/path-specific (zero for views) | zkProof[8]=256, actionSig[3]=96, nullifier, stakeRootUsed, powNonce, clickSessionHash | 480 | yes, via optional proof sidecar |

### Two findings that reshape #2
1. **It's a calldata-BYTES win, not an EVM-gas win.** The heavy fields are all-zero for a
   view claim, and zero calldata costs 4 gas/byte — so removing them saves only ~2.5k EVM
   gas/claim (vs #1's 12.7k). The real prize is **−74% calldata bytes** (736→192), which
   matters if the binding limit is Polkadot Hub PoV/weight (calldata-size bound), not EVM gas.
2. **Replay constraint on nonce/previousClaimHash.** These are derivable for on-chain
   *validation*, but they're the claim's commitment to a position in the per-(user,campaign,
   type) chain. The contract enforces `nonce==lastNonce+1` regardless of what's sent — so if
   the user's signature stops covering the nonce (because it's dropped from the wire), the
   *same* signed slim-claim can be settled repeatedly, each time taking the next nonce =
   **replay**. Removing them safely requires a batch-level replay guard (batch nonce/deadline)
   in the signed envelope — i.e. the relay+extension EIP-712 redesign (the "full end-to-end"
   depth). So a contracts-only #2 must KEEP nonce + previousClaimHash.

### Achievable slim
- **Safe (no signing redesign):** remove campaignId + claimHash + move the 480 B of
  heavy fields to an optional `ClaimProof` sidecar (empty for views). 736 → **192 B/view
  claim (−74%)**, keeps nonce/prevHash, replay-safe.
- **Full (with signing redesign):** also drop nonce/prevHash behind a batch replay guard →
  **128 B (−83%)**. Touches relay + extension + EIP-712 domain.

### M2a — drop 4 derivable fields + firstNonce replay redesign (DONE)

Dropped `campaignId`, `nonce`, `previousClaimHash`, `claimHash` from the wire. The
contract assigns `nonce = lastNonce+1`, reads prevHash from storage, recomputes the
claim hash, and uses the batch-level campaignId. Replay for the signed gasless paths is
re-anchored on an explicit signed `firstNonce` required to equal `lastNonce+1`
(relay/dual-sig/attestation EIP-712 typehashes all gain `firstNonce`; cosig claimsHash now
binds to `keccak(abi.encode(slimClaim))`). New error **E86** on a stale anchor.

| metric | baseline | M2a | Δ |
|--------|----------|-----|---|
| raw Claim tuple | 736 B | **608 B** | −128 B |
| calldata / claim (N=20) | 747 B | **619 B** | −17% |
| gas / claim (marginal) | 44,570 | **30,652** | −31% (vs #1's 31,880: another −1.2k) |
| gas total (N=20) | 1,199,867 | **936,821** | −22% |

- Full suite **1659 passing, 0 failing**. Behaviour tests for now-removed semantics
  (claimHash tamper, prevHash genesis, nonce gap) rewritten to assert the derive-on-chain
  model; signed-path replay (R5/dual-sig) now reverts E86 instead of soft-rejecting.
- **Replay anchor:** initially reverted `E86`; now **graceful per-iteration skip** (see below).

### M2b — heavy-field sidecar (DONE)

Moved `clickSessionHash`, `stakeRootUsed`, `nullifier`, `powNonce`, `zkProof[8]`,
`actionSig[3]` into an optional `ClaimProof[] proof` sidecar (empty for plain view claims,
one entry for ZK/click/CPA/PoW). `mkProof()`/`computeClaimHash()` test helpers in
`test/helpers/slimClaim.ts`.

| metric | baseline | M2a | **M2b** |
|--------|----------|-----|---------|
| raw view Claim tuple | 736 B | 608 B | **224 B** |
| calldata / claim (N=20) | 747 B | 619 B | **235 B (−69%)** |
| gas / claim (marginal) | 44,570 | 30,652 | **~30,580** |
| gas total (N=20) | 1,199,867 | 936,821 | **936,124 (−22%)** |

- **Gas is flat vs M2a** — confirms the heavy fields were all-zero for view claims and cost
  ~nothing on EVM. M2b is a **calldata-bytes / Polkadot-PoV** win, not an EVM-gas win.
- Full suite **1659 passing, 0 failing**. ZK/PoW/click/nullifier tests rewritten to put proof
  material in the sidecar; the PoW solver now hashes against the on-chain-derived claim hash.

### M2d — graceful per-iteration skip (DONE)

Across all three signed paths (`DatumRelay.settleClaimsFor`,
`DatumDualSigSettlement.settleSignedClaims`, `DatumAttestationVerifier.settleClaimsAttested`),
a batch that is **stale** — expired `deadlineBlock` (reason 0) or `firstNonce != lastNonce+1`
(reason 1) — is now **skipped, not reverted**: its claims are folded into `result.rejectedCount`
and a `BatchSkippedStale(user, campaignId, firstNonce, claimCount, reason)` event is emitted.
**Malformed/malicious** inputs (bad sig, wrong signer, sig length, empty batch) still revert the
whole call. The relay/attestation paths compact valid batches before the single `settleClaims`;
the dual-sig path reads `lastNonce` fresh per iteration so two batches for the same chain in one
call work (first settles, second is then stale → skipped). `processVerifiedBatch` keeps its `E86`
require as defense-in-depth for direct callers.

- One stale/expired batch no longer DoS-es valid sibling batches in the same multi-user call
  (test `R-skip`). Full suite **1660 passing, 0 failing**.

### Net result (#1 + #2)

| | baseline | final |
|---|---|---|
| EVM gas / claim (marginal) | 44,570 | **~30,580 (−31%)** |
| calldata / claim | 736 B | **224 B (−70%)** |

For an EVM-gas-bound chain, ~1.46× more claims per batch. For a calldata/PoV-bound chain
(Polkadot Hub), ~3.3× more claims per fixed extrinsic-size budget.

### M2c — off-chain signers (relay-bot + extension)

Spec'd in **`OFFCHAIN-SLIM-PORTING.md`** rather than coded: the live relay-bot is gitignored
(outside this repo), the `docs/relay-bot-template` is stale alpha-2-era, and the extension
exports claims to the relay-bot rather than building the on-chain `SignedClaimBatch` itself —
so there is no in-repo, hardhat-testable off-chain signer to edit without a separate sync pass.
The porting guide gives the exact wire shape, the three EIP-712 typehashes (firstNonce +
content claimsHash), the `firstNonce == lastNonce+1` anchor, and the claimHash/PoW derivation.
