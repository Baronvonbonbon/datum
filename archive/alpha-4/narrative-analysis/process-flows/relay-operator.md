# Relay Operator

The off-chain service that aggregates user claims and submits batches
on-chain. Can be the publisher themselves (the "publisher-relay" path)
or a third-party relay service that holds publisher hot keys with their
authorization.

## On-chain footprint

The relay operator has no specific on-chain identity. They submit
transactions from one or more EOAs; the key thing the protocol checks
is "is this msg.sender authorized for this batch?" The authorization
paths are:

1. `msg.sender == batch.user` — direct user submission (L0 path).
2. `msg.sender == settlement.relayContract` — the canonical Relay
   contract calling through to Settlement.
3. `msg.sender == settlement.attestationVerifier` — strict attestation
   path.
4. `msg.sender == publishers.relaySigner(claims[0].publisher)` — the
   publisher's hot key submitting directly.

A relay operator typically uses path 2 (via `DatumRelay`) for L1
campaigns or path 4 (direct from publisher hot key) for L0/L1.

## End-to-end flow

### Setup

1. **Deploy or join a Relay contract.** Most deployments share the
   protocol's canonical `DatumRelay`. A third-party relay might deploy
   their own for product differentiation.
2. **Get added to `authorizedRelayers`** by Relay's owner (typically
   Timelock). Per the H-4 "liveness fallback": if the authorized list
   is empty, anyone may call. So bootstrap doesn't require
   pre-authorization.
3. **Obtain publisher hot keys** — each publisher who wants this relay
   to submit for them calls `DatumPublishers.setRelaySigner(relayHotKey)`.
   The relay holds the corresponding private key.
4. **Run the off-chain service** — typically a Node.js daemon
   (`relay-bot/`) that:
   - Polls the extension/SDK for incoming claims.
   - Aggregates claims per (user, campaignId, actionType).
   - Computes claim hashes, EIP-712 envelopes.
   - Signs envelopes with the appropriate publisher hot key.
   - Submits batches.
   - Monitors `ClaimRejected` events and surfaces them back to the
     extension for state reconciliation.

### Per-batch flow

```
1. Receive raw claims from extension(s).
2. Group by (publisher, campaignId, user, actionType).
3. For each group:
   a. Sort by nonce ascending.
   b. Detect chain gaps; truncate or discard as policy requires.
   c. Build the EIP-712 envelope:
      - For DatumRelay path: PublisherAttestation typehash with
        (campaignId, user, claimsHash, deadlineBlock).
      - For dual-sig (settleSignedClaims): ClaimBatch typehash with
        (user, campaignId, claimsHash, deadlineBlock,
         expectedRelaySigner, expectedAdvertiserRelaySigner).
   d. Sign with the publisher's hot key.
   e. For L2: ask the advertiser's relay signer to cosign (off-chain
      coordination, typically via a separate HTTP endpoint).
4. Submit:
   - DatumRelay.settle(...) — L1 default.
   - DatumSettlement.settleSignedClaims(...) — L2.
   - DatumSettlement.settleClaims(...) directly, if msg.sender is
     the publisher's relay signer — equivalent to Relay path but
     skipping the wrapper.
5. Watch receipt:
   - ClaimSettled events → mark claims settled in DB, increment SDK
     counters.
   - ClaimRejected events → surface reason code to extension.
   - Gap-set rejection (reason 7) → invalidate downstream queued
     claims for that (user, campaign, actionType).
```

### Multi-user batching

`settleClaimsMulti(UserClaimBatch[])` accepts up to 10 users × 10
campaigns per tx. The relay uses this when the publisher hot key wants
to amortise gas across many users. Each `UserClaimBatch` is
independently authorized — the same `msg.sender` gate applies.

### Reputation tracking

The relay reads `ClaimSettled` / `ClaimRejected` events post-batch and
updates an off-chain DB. This used to feed an on-chain
`recordSettlement(reporter)` entry on `DatumPublisherReputation`, but
that contract was inlined into Settlement in alpha-4 with the reporter
path removed (threat-model #4: a single compromised reporter could
poison every publisher's reputation). Reputation now updates
internally from `_processBatch`.

The relay still reads the on-chain reputation getters
(`getReputationScore`, `getPublisherStats`, `isAnomaly`) to gate
behavior — e.g. refusing to relay for a publisher whose score is
below a threshold.

### Failure recovery

- **Nonce-gap event:** relay detects ClaimRejected reason 7. It must
  re-sync the chain state: read `Settlement.lastNonce(user, campaign,
  actionType)`, discard local claims with `nonce ≤ lastNonce`, resume
  from the next.
- **Publisher relay-key rotation:** if the publisher rotates
  `relaySigner`, in-flight cosigs become invalid (E84). The relay must
  obtain the new key from the publisher and resign.
- **Pause:** if `pauseRegistry.pausedSettlement()` returns true, the
  relay queues claims locally until the pause lifts. Submitted batches
  during pause revert with "P".

### Wallet / key management

The relay operator's biggest operational risk is **hot-key
compromise**. The publisher relay signer is a hot key by definition —
it must be online to sign batches. Mitigations:

- Publishers should rotate their relaySigner periodically.
- Relays can run HSM-backed signing (the protocol doesn't care; it
  just verifies the resulting signature).
- Spending limits: the relay can self-impose limits before signing,
  even though the protocol doesn't enforce them at the signer level.

## Economic exposure

- **Gas cost** — the relay pays gas to submit batches. Some
  arrangements have the publisher reimburse off-chain.
- **No direct on-chain stake** — the relay isn't a slashable role.
  The publisher's stake is the cryptographic backstop; a compromised
  relay just means the publisher will rotate keys.

## Who polices the relay

- **Publishers:** can rotate `relaySigner` to kick out a relay.
- **Timelock-owned Relay contract:** can remove from
  `authorizedRelayers` to revoke the H-4 path.
- **Settlement gates:** the relay can't bypass any of the validation
  in `ClaimValidator` or the AssuranceLevel gate. A relay submitting
  garbage claims just sees them rejected at the gate.

## Trust assumptions placed on the relay

- That it submits batches promptly so users earn timely settlements.
- That it doesn't censor specific users or specific claim types.
- That it doesn't drop claims (lose them between extension and chain).

These are all trust-the-operator concerns the protocol can't enforce
on-chain; they're addressed by publisher choice (publishers can switch
relays) and by relay reputation (off-chain).
