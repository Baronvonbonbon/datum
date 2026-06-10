# Off-chain porting guide — slim claim wire format (#2)

The #2 prototype changed the on-chain `Claim` wire format and the EIP-712 signing
scheme. Any off-chain code that **builds claims**, **signs an EIP-712 envelope**, or
**submits a batch** must be updated to match. This file is the spec.

> Status (off-chain now aligned): the in-repo off-chain consumers have been updated
> to this spec — the extension (`claimCore.ts` slim helpers, `index.ts`/`ClaimQueue.tsx`
> settleClaimsAttested + dual-sig relay paths, `publisherAttestation.ts`), the web demo
> daemon (`extensionDaemon.ts`) + advertiser cosign (`Cosign.tsx`), the generic
> `docs/relay-bot-template/relay-bot.mjs` (slim ABI + EIP-712 + firstNonce + content
> claimsHash + settleClaimsFor build) and the `relay-bot.example` envelope, plus the
> extension/web ABIs (`sync-abis.mjs`). Extension type-checks clean; templates pass
> `node --check`. The SDK (`sdk/datum-sdk.js`) is the attestation *handshake* layer
> (challenge/response), not the settlement wire — unchanged. The live production
> relay-bot is gitignored (outside this repo) — apply §1–§5 there. None of this is
> exercised by `hardhat test`; verify on a live testnet settle.

## 1. The slim `Claim` tuple (what the contract now accepts)

```solidity
struct ClaimProof {            // optional sidecar — OMIT for plain view claims
  bytes32   clickSessionHash;  // type-1
  bytes32   stakeRootUsed;     // ZK path A (also in claim-hash preimage)
  bytes32   nullifier;         // ZK
  bytes32   powNonce;          // PoW
  bytes32[8] zkProof;          // ZK
  bytes32[3] actionSig;        // type-2 (CPA)
}
struct Claim {
  address publisher;
  uint256 eventCount;
  uint256 rateWei;
  uint8   actionType;
  ClaimProof[] proof;          // [] for a plain view claim; [one entry] otherwise
}
```

**Removed from the wire** (derived on-chain now — do NOT send): `campaignId` (it's at the
batch level), `nonce`, `previousClaimHash`, `claimHash`.

ethers builder for a plain view claim:
```js
{ publisher, eventCount, rateWei, actionType, proof: [] }
```
For a ZK / click / CPA / PoW claim, one proof entry with the relevant field set and the rest
`ZeroHash` / zero-arrays (see `test/helpers/slimClaim.ts:mkProof`).

## 2. `SignedClaimBatch` gains `firstNonce`

```solidity
struct SignedClaimBatch {
  address user;
  uint256 campaignId;
  uint256 firstNonce;   // NEW: nonce that will be assigned to claims[0]
  Claim[] claims;
  uint256 deadlineBlock;
  address expectedRelaySigner;
  address expectedAdvertiserRelaySigner;
  bytes userSig; bytes publisherSig; bytes advertiserSig;
}
```

**`firstNonce` MUST equal the current on-chain `lastNonce(user, campaignId, actionType) + 1`.**
Read it before building the batch:
```js
const firstNonce = (await settlement.lastNonce(user, campaignId, actionType)) + 1n;
```
This is the replay anchor: once the batch settles, `lastNonce` advances past `firstNonce`, so a
resubmission reverts `E86`. (Submit promptly; a batch is only valid against the chain head it
was built for.)

## 3. EIP-712 typehashes

### Relay path — user signature (`DatumRelay`, domain `"DatumRelay"` v1)
Unchanged shape (already range-based); the user signs a nonce **range**:
```
ClaimBatch(address user,uint256 campaignId,uint256 firstNonce,uint256 lastNonce,uint256 claimCount,uint256 deadlineBlock)
```
- `firstNonce` = on-chain `lastNonce+1`; `lastNonce` = `firstNonce + claims.length - 1`;
  `claimCount` = `claims.length`.

### Relay path — publisher attestation (`DatumRelay`)
```
PublisherAttestation(uint256 campaignId,address user,bytes32 claimsHash,uint256 deadlineBlock)
```
- **`claimsHash` changed**: it is now a content hash of the slim claims, NOT a hash of
  per-claim `claimHash` fields (those no longer exist). See §4.

### Dual-sig path (`DatumDualSigSettlement`, domain `"DatumSettlement"` v1)
```
ClaimBatch(address user,uint256 campaignId,uint256 firstNonce,bytes32 claimsHash,uint256 deadlineBlock,address expectedRelaySigner,address expectedAdvertiserRelaySigner)
```
- Added `firstNonce`; `claimsHash` is the content hash (§4). Both publisher and advertiser
  sign this same struct.

### Attested path (`DatumAttestationVerifier`, domain `"DatumAttestationVerifier"` v1)
```
PublisherAttestation(uint256 campaignId,address user,uint256 firstNonce,bytes32 claimsHash,uint256 deadlineBlock)
```
- Added `firstNonce`; `claimsHash` is the content hash (§4). `AttestedBatch` also gains a
  `firstNonce` field, anchored to `lastNonce+1`.

## 4. `claimsHash` — content hash over slim claims

The contracts compute (DualSig/Relay/Attestation `_hashClaims`):
```
claimsHash = keccak256( concat_i keccak256(abi.encode(claims[i])) )
```
where `abi.encode(claims[i])` is the **slim `Claim` tuple including the `proof` sidecar**.
ethers mirror (`test/helpers/slimClaim.ts:contentHashClaims`):
```js
const SLIM = "tuple(address publisher,uint256 eventCount,uint256 rateWei,uint8 actionType," +
  "tuple(bytes32 clickSessionHash,bytes32 stakeRootUsed,bytes32 nullifier,bytes32 powNonce,bytes32[8] zkProof,bytes32[3] actionSig)[] proof)";
const co = ethers.AbiCoder.defaultAbiCoder();
const claimsHash = ethers.keccak256(ethers.concat(
  claims.map(c => ethers.keccak256(co.encode([SLIM], [c])))
));
```

## 5. claimHash for ZK / PoW (clients that build proofs)

The on-chain claim hash is recomputed from the **derived** nonce/prevHash, so a client building
a ZK proof or solving PoW must predict it (`test/helpers/slimClaim.ts:computeClaimHash`):
```
claimHash = keccak256(abi.encode(
  campaignId, publisher, user, eventCount, rateWei, actionType,
  clickSessionHash, assignedNonce, prevHash, stakeRootUsed))
```
- `assignedNonce` = the nonce the contract will assign = `lastNonce+1` for the first claim,
  incrementing per settled claim.
- `prevHash` = the on-chain `lastClaimHash(user, campaignId, actionType)` (ZeroHash at genesis).
- For a view claim with no sidecar, `clickSessionHash` and `stakeRootUsed` are `ZeroHash`.
- PoW: find `powNonce` s.t. `keccak256(claimHash || powNonce) <= target`, put it in `proof[0]`.
- ZK: the circuit's public `claimHash` input must be this value.

## 6. Extension specifics (`alpha-5/extension/src`)

- The extension keeps `nonce` / `previousClaimHash` / `claimHash` **internally** (it tracks
  the local chain head to build the next claim and to derive `claimHash` for ZK/PoW) — that's
  fine. Only the **submitted/exported** shape must be slim.
- Rename the export's `impressionCount`→`eventCount`, `clearingCpmWei`→`rateWei` (already
  diverged from the contracts pre-#2) and emit `proof` material instead of flat `zkProof` /
  `nullifier` fields.
- Export the per-claim `nonce` so the relay can compute `firstNonce` for the envelope, and the
  current chain `prevHash` so ZK/PoW clients can derive `claimHash`.

## 7. Error code

`E86` — `revert` when the signed `firstNonce != lastNonce+1` (stale/replayed batch). Surface it
to clients as "batch is stale, rebuild against the current chain head."
