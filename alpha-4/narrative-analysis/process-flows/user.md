# User

The protocol's end-customer. A person who installs the browser extension
(or a wallet that speaks the protocol), sees ads on participating
publishers, and earns DOT (plus optional DATUM and ERC-20 rewards).

## On-chain footprint

Users are anonymous EOAs. The protocol doesn't have a "user registry";
any address can be the recipient of a settled claim. The user's
on-chain identity is just the address that signs the claim batch
envelope (relay path) or that submits direct settles (L0 path).

## End-to-end flow

### One-time setup (the first time a user interacts with the protocol)

1. **Generate a wallet.** The extension creates a fresh EOA, stores
   the key locally. The user can export to MetaMask/etc. later.
2. **Receive bootstrap DATUM** (optional). On the first qualifying
   impression against the protocol's house ad campaign,
   `DatumBootstrapPool` mints a one-time WDATUM grant via
   `mintAuthority.mintForBootstrap`. This is fire-and-forget; the user
   doesn't trigger it explicitly.
3. **Stake DATUM** (optional, only if claiming on Path A campaigns).
   - `DatumZKStake.setUserCommitment(Poseidon(secret))` — once per user.
     Lock-once after first deposit.
   - `DatumZKStake.deposit(amount)` — locks DATUM, starts earning
     stake-root inclusion.
4. **Publish interest commitment** (optional, only for ZK-gated
   campaigns with required category).
   - Wallet builds the user's interest set off-chain (16 categories in
     a 4-level Merkle tree).
   - `DatumInterestCommitments.setInterestCommitment(root)`.
   - Wait `ClaimValidator.minInterestAgeBlocks` (~100 blocks =
     ~10 min) before the commitment is usable in proofs.

### Steady state (per impression)

1. **Publisher serves an ad** — the extension intercepts and renders the
   creative, increments a local impression counter for that
   (user, campaignId).
2. **Extension constructs a claim** — fields include `campaignId,
   publisher, eventCount, ratePlanck, nonce` (incremented from
   `Settlement.lastNonce`), and `claimHash = keccak256(canonical encoding)`.
3. **For Path A (ZK-gated) campaigns:** wallet generates a Groth16
   proof off-chain using snarkjs + the impression.circom witness. The
   proof binds the claimHash, a fresh nullifier, the user's stake
   commitment, the campaign's minStake, the user's interest root, and
   the required category.
4. **Claim aggregation** — the extension stores claims in a local
   queue; periodically (or on user demand) the extension forwards the
   queue to the relay.
5. **Settlement** — see [Relay Operator](./relay-operator.md). The
   user is *passive* during this step on the relay path; they may also
   directly call `settleClaims` themselves at L0 campaigns if no relay
   is available.

### Earnings

After settlement, the user has balances credited:

- `DatumPaymentVault.userBalance[user]` (DOT) — pulled via
  `withdraw()`.
- `DatumTokenRewardVault.userTokenBalance[token][user]` (ERC-20 if the
  campaign offers it) — pulled via `withdraw(token)`.
- `WDATUM` (DATUM tokens) — minted by `DatumMintAuthority.mintForSettlement`
  directly to the user's EOA. Standard ERC-20; no pull needed.

### Optional user-sovereignty knobs

All settable directly by the user (no admin involvement):

- `DatumSettlement.setUserMinAssurance(level)` — refuse settlement
  below a level (e.g. demand ZK for high-value campaigns).
- `DatumSettlement.setUserBlocksPublisher(addr, true)` — refuse claims
  from this publisher.
- `DatumSettlement.setUserBlocksAdvertiser(addr, true)` — refuse
  claims from campaigns by this advertiser.
- `DatumSettlement.setUserPaused(true)` — kill-switch; rejects all
  incoming settlements (e.g. during suspected key compromise).
- `DatumZKStake.requestWithdrawal(amount)` — initiate 30-day exit.

### Exit

- `DatumZKStake.executeWithdrawal()` — after 30 days, pull staked
  DATUM out.
- `DatumInterestCommitments.setInterestCommitment(bytes32(0))` — clear
  commitment.
- Stop visiting publishers; the extension stops generating claims.

## Economic exposure

- **Capital at risk:** staked DATUM in `DatumZKStake` is slashable in
  principle, but in the current design *user-side slashing isn't wired*
  — only fraudulent publishers and advertisers are slashed. The user's
  staked DATUM is locked for 30 days minimum but recoverable in full
  unless a future protocol upgrade adds user-side slashing.
- **Earnings:** 75% of `(totalPayment - publisherTakeRate × totalPayment)`,
  i.e. roughly 37.5% of a typical CPM settlement (publisher 50%,
  user 37.5%, protocol 12.5%) at default `userShareBps = 7500`.

## Who polices the user

- `DatumClaimValidator` rejects malformed claims (bad nonce, wrong
  hash, bad PoW, fresh interest commitment, etc.).
- `DatumSettlement` enforces per-user-per-campaign caps
  (`MAX_USER_EVENTS = 100_000`), per-window caps (advertiser-set), and
  per-user-history floors (`minUserSettledHistory`).
- Leaky-bucket PoW makes high-velocity claim spamming expensive.
- Nullifier registry prevents per-window double-claims on ZK paths.

## Trust assumptions placed on the protocol

- That `DatumPaymentVault` honors withdrawals (set lock-once; settlement
  is the only contract that can credit but withdrawal is unconditional).
- That `DatumZKStake.executeWithdrawal` honors the 30-day lockup
  promise.
- That `DatumPauseRegistry.paused()` will not block withdrawals
  (it doesn't — only credits are paused).
