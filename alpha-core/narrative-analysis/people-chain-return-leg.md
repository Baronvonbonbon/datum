# People Chain Return-Leg — Research & Options

**Date:** 2026-05-17  
**Context:** Phase D of the trustless People Chain identity bridge (see
`/home/k/.claude/plans/fizzy-plotting-lerdorf.md` and `MAINNET-DEFERRED-ITEMS.md`).
Bridge contract is deployed and Phase C wiring is in. What's still open
is the **return leg** — how does an identity attestation get from People
Chain back to the Hub bridge's `xcmCallback` without an off-chain Diana?

This doc captures the runtime survey, the five paths considered, and the
recommendation. Treat it as the source-of-truth for "why we picked
what we picked" — future decisions should diff against this.

---

## 1. Hard constraints (confirmed from runtime source)

### People Chain Polkadot (para ID 1004) — pallet inventory

Source: `polkadot-fellows/runtimes/system-parachains/people/people-polkadot/src/lib.rs`,
`construct_runtime!` macro. 19 pallets:

> System, ParachainSystem, Timestamp, ParachainInfo,
> MultiBlockMigrations, WeightReclaim, Balances, TransactionPayment,
> Assets, AssetRate, AssetTxPayment, AssetsHolder, Authorship,
> CollatorSelection, Session, Aura, AuraExt, XcmpQueue, PolkadotXcm,
> CumulusXcm, MessageQueue, **Utility, Multisig, Proxy, Identity**.

Critically:
- **No `pallet-revive`.** No PolkaVM smart contracts.
- **No `pallet-contracts`.** No ink! smart contracts.
- **No `pallet-mmr`.** No Merkle Mountain Range commitments out of the box.

**Implication: custom logic on People Chain MUST be a FRAME pallet
landed by OpenGov runtime upgrade.** There is no "deploy a contract"
escape hatch.

### People Chain XCM configuration

Source: `xcm_config.rs` of the same runtime.

- `SafeCallFilter = Everything` — any dispatchable on People Chain is
  callable via XCM `Transact` (subject to origin checks).
- `ResponseHandler = PolkadotXcm` — `QueryResponse` mechanism is wired
  and works (for the limited response types it supports).
- Barrier grants unpaid execution only to `(ParentOrParentsPlurality,
  FellowsPlurality, ...)`. Sibling parachains (Polkadot Hub included)
  **pay execution fees**. Our bridge already provides `WithdrawAsset
  + PayFees` for this.

### `pallet-identity` surface

- **Writes:** `set_identity`, `request_judgement`, `provide_judgement`
  (registrar-only), `clear_identity`, `kill_identity` (gov), etc.
- **Reads:** storage queries only — `IdentityOf(account)`, `Registrars`,
  etc. **No dispatchable returns identity data.**

## 2. The core problem: XCM is write-only

Confirmed from `Cross-Consensus Query Language (XCQ)` Polkadot Forum
threads (2024+):

> "XCM by itself now couldn't actually express the idea of querying
> balances" — XCM is fundamentally a state-mutation scripting language,
> not a query language.

The XCM `QueryResponse` instruction can carry the following `Response`
variants:
```
Null | Assets | ExecutionResult | Version | PalletsInfo | DispatchResult
```

**None of these can carry "judgment level for user X".**

`DispatchResult` is just success/failure of a `Transact` — it can't
return data.

`ReportTransactStatus` reports the same shape. Not useful.

There is no off-the-shelf XCM primitive for "read storage value X on
chain Y, return it to me here, here's the callback."

## 3. The five options

| # | Path | Trust | Today? | Effort |
|---|---|---|---|---|
| 1 | Custom FRAME pallet on People Chain | Runtime only | No — OpenGov | Pallet ~2 wks; **OpenGov referendum + politics = months** |
| 2 | XCQ (Cross-Consensus Query Language) | Runtime only | **No** — `open-web3-stack/PVQ` has 0 releases, not on mainnet | Wait. 6–18 months at minimum |
| 3 | Diana stand-in indefinitely (current Phase C) | Diana's EOA | **Yes** — already shipped | Zero extra |
| 4 | Relay-chain state-proof verification | Crypto only | Partially — needs primitive to read relay state from pallet-revive (undocumented) | High; weeks of research |
| 5 | ZK proof of identity (`project_zk_path_b_people_chain.md`) | Crypto + MPC | No — separate ZK pipeline | Quarters; trusted-setup ceremony |

---

### Option 1 — Custom FRAME pallet `pallet-datum-identity-relay`

**Mechanics:**
1. Develop pallet in a fork of People Chain runtime.
2. Pallet exposes one dispatchable: `identity_query(origin, user: AccountId32)`.
3. Pallet reads `pallet_identity::IdentityOf(user)` storage; maps
   `Judgement::Reasonable | KnownGood` → level 1/2.
4. Pallet constructs an outbound XCM `Transact` back to Polkadot Hub
   bridge, calling `xcmCallback(user, level, validityBlocks)`.
5. Per-origin rate limit + per-user cooldown inside the pallet (anti-DoS).
6. Submit Polkadot OpenGov referendum to authorize the runtime upgrade.

**Pros:**
- Clean architecture; matches the bridge's existing assumptions.
- Trustless once landed — only the People Chain runtime + Polkadot Hub
  runtime + IXcm precompile are trust roots.
- Bridge contract requires **zero code changes** to flip — just
  `setSovereign(...)` to the new origin address, then `lockSovereign`.

**Cons:**
- OpenGov approval is a months-scale process with political surface.
- Each runtime upgrade requires re-approval. Pallet updates compound.
- Requires Substrate/Rust developer time. Out of scope for the EVM
  contracts team without recruiting.

**Pallet skeleton:** see `/home/k/.claude/plans/fizzy-plotting-lerdorf.md`
§"Follow-up: People Chain pallet `pallet-datum-identity-relay`".

---

### Option 2 — XCQ (Cross-Consensus Query Language)

**Status (verified 2026-05-17):**
- Polkadot Referendum **#776** funded XCQ design + development (Acala team).
- Implementation: `open-web3-stack/PVQ` on GitHub.
- **77 commits, ZERO releases.** Still in design/early prototype.
- Not deployed on Polkadot, Asset Hub, People Chain, or any system chain.
- No Solidity-callable interface.
- No mention in current Polkadot SDK release notes (as of v1.14.x).

**What XCQ would give us if mature:** an "extension-based" query layer
where Polkadot Hub could synchronously ask People Chain "what's the
identity judgment for X?" and get a typed response. Goal is a real read
primitive.

**Verdict: XCQ is the **right** long-term solution but it's not coming
this cycle.** Realistic timeline: 6–18 months at minimum to:
1. Reach 1.0 / stable release.
2. Get adopted into Polkadot SDK.
3. Land on People Chain via a runtime upgrade.
4. Become available to pallet-revive (so our EVM bridge can use it).

Watch the project. Don't depend on it.

---

### Option 3 — Diana stand-in indefinitely

**The current Phase C posture.**
- `peopleChainSovereign = Diana_EOA` on the bridge.
- Off-chain Diana daemon watches `RefreshInFlight(user)` events,
  reads People Chain identity via standard RPC, calls
  `bridge.xcmCallback(user, level, validityBlocks)` from her EOA.
- Bridge writes through to `cache.submitAttestation`.
- Settlement reads `cache.isVerified` per normal.

**Trust assumption:** Diana correctly maps People Chain registrar
judgments → levels. Identical trust to a typical Substrate-native
oracle.

**Pros:**
- **Already shipped.** Phase D is "deploy and run."
- Bridge code path is identical to the trustless future-state, so
  swap-in (when the pallet OR XCQ OR state-proof matures) is one
  `setSovereign(...)` call — no migration, no redeploy.
- Settlement's per-user `userMinIdentityLevel` and per-campaign
  `campaignMinIdentityLevel` gates continue to work transparently.

**Cons:**
- Single-EOA trust. If Diana's key is compromised, the bridge can
  attest arbitrary identity levels for arbitrary users. Mitigation:
  Diana is "stateless" — every attestation is verifiable off-chain
  against People Chain RPC, so cheaters are publicly detectable.
- `lockOracleReporter()` cannot be called — Diana keeps her direct
  cache-write fallback. Two-track trust (bridge OR direct).

**This is significantly more durable than originally framed.** It might
be the realistic production posture for 12+ months given Option 1's
politics and Option 2's timeline.

---

### Option 4 — Relay-chain state-proof verification

**Hypothesis:** Use the relay chain as a trust anchor.

Mechanics:
1. User generates a Merkle proof of `pallet_identity::IdentityOf[user]`
   against People Chain block N's state root.
2. User submits to bridge with `(block_number, state_root, proof)`.
3. Bridge verifies:
   - State root is for People Chain at block N (somehow attested by
     relay chain).
   - Merkle proof of identity entry is valid against that state root.
4. If both pass, bridge writes `(user, level, validityBlocks)` to cache.

**Trustless + synchronous in a single EVM call** — best of both worlds.

**The hard part — step 3a.** How does Polkadot Hub trust that the
submitted state root is actually People Chain's?

Possibilities:
- **Relay-chain head storage.** The relay chain records every
  parachain's head hash (a commit to state root) in
  `paras::Heads`. Polkadot Hub's `pallet-cumulus` has the validation
  data from the relay chain. **Question: can pallet-revive read this
  state from a smart contract?** Not via any documented precompile.
- **Trusted relayer.** Have a separate actor post state roots to Hub.
  Now trust shifts to the relayer; not fully trustless. (Worse than
  Diana since Diana doesn't carry as much state.)
- **Custom precompile.** Add a "relay-chain state reader" precompile
  to Polkadot Hub. Requires Polkadot OpenGov runtime upgrade on Hub —
  same political surface as Option 1 plus the work to build the
  precompile.

**Verdict:** Worth a 1–2 week spike to investigate whether ANY
documented pallet-revive primitive exposes relay-chain state to
smart contracts. If yes, this leapfrogs all other options. If no,
it's blocked on the same OpenGov politics as Option 1 (with worse
implementation cost).

---

### Option 5 — ZK proof of identity

Tracked separately in `memory/project_zk_path_b_people_chain.md`.

- User generates a ZK proof binding their secret to their People
  Chain identity registration.
- Bridge verifies proof, writes cache.
- Trustless (crypto + MPC trusted setup).

**Status:** Years out. Multiple blockers:
- Circuit design and security review.
- Trusted-setup MPC ceremony.
- Anonymity-set size analysis (per memory: "narrows the anonymity set
  to {users staking + with interests + on People Chain}").
- Settlement-side verification gas cost.

Document, don't pursue this quarter.

## 4. Cross-cutting observations

### The bridge architecture survives all five paths

The current `DatumPeopleChainXcmBridge` contract has these invariants:
- `xcmCallback(address, uint8, uint64)` is the only write path into
  the cache.
- `peopleChainSovereign` is the only authorized caller.
- The callback is contract-agnostic about how `(user, level, validity)`
  was determined upstream.

This means every option above plugs in by **swapping the sovereign**:

| Option | `peopleChainSovereign` becomes |
|---|---|
| 1 (custom pallet) | The People Chain XCM-derived sovereign address |
| 2 (XCQ) | An XCQ-driven response router contract |
| 3 (Diana) | Diana's EOA (current state) |
| 4 (state proof) | A `StateProofVerifier` contract on Hub |
| 5 (ZK) | A `ZkIdentityVerifier` contract on Hub |

`setSovereign(addr)` + eventually `lockSovereign()` does the swap. No
redeploy, no migration, no user-facing change.

### `oracleReporter` is the meaningful trust knob

The cache (`DatumPeopleChainIdentity`) has two writer paths:
1. `xcmDispatcher` (bridge, today).
2. `oracleReporter` (Diana's direct path, untouched today).

`lockOracleReporter()` is the one-way commitment that "we trust only
the bridge path." Calling it is the moment the system becomes
trustless under whichever Option we pick.

**On Paseo, do NOT call `lockOracleReporter()`** — keep both writer
paths active as belt-and-suspenders while validating.

### Most other parachains face this same problem

The "I want to read another parachain's storage" pattern is broadly
useful — staking weights for governance, balance for fee discounts,
identity for sybil resistance, etc. XCQ is being built precisely
because this is a generally missing primitive. We're not solving a
DATUM-specific problem; we're an early implementer of a general
pattern.

This argues for the **Option 1 custom pallet** path — if we land
`pallet-datum-identity-relay`, the work might generalize and accrue
political tailwind. It might even justify a broader RFC for
"parachain-to-parachain identity reads."

## 5. Recommendation

**Three concurrent tracks, ordered by ROI:**

### Track A — Ship Phase D with Diana (this week)
Deploy to Paseo, run Diana daemon, validate end-to-end. Settlement's
identity gate works. Bridge architecture proven. **Treat Option 3 as
indefinite-but-good-enough.**

### Track B — Start the custom pallet (months)
Begin `pallet-datum-identity-relay` development in a People Chain
runtime fork. Parallel-track to Track A. No dependency on Paseo
deployment. The pallet itself is small; the political surface is
the bottleneck. Frame it as a generally-useful identity-relay primitive
to attract broader Polkadot ecosystem support, not just a DATUM-specific
ask.

### Track C — Spike Option 4 (1–2 weeks, optional)
Investigate whether pallet-revive on Polkadot Hub can access
relay-chain state through any precompile or system extrinsic. If yes,
this changes the picture significantly. Concrete tasks:
1. Survey pallet-revive precompiles (the 0x00..0aXXXX range).
2. Survey Polkadot Hub system contracts.
3. Check `pallet-cumulus` exposure of `validation_data`.
4. If primitives exist, prototype a `StateProofVerifier` library and
   measure gas cost.

### What NOT to do
- **Don't depend on XCQ for any 2026 timeline.** Watch it; build for
  a future flip if it ships.
- **Don't pursue Option 5 (ZK) this quarter.** Years out.
- **Don't call `lockOracleReporter()` on Paseo.** Keep Diana's direct
  path as fallback during validation.

## 6. Companion: pre-mainnet single-oracle hardening

`bonded-reporter-identity.md` (2026-05-17) — design doc for the
multi-reporter pattern that replaces single-Diana before mainnet.
Mirrors `DatumStakeRootV2` (permissionless bonded reporters,
optimistic resolution, slashing). The bonded reporter pattern is
**complementary** to whichever trustless return-leg matures first
(Options 1, 4, or 5 above): the bonded set covers the operational
trust gap *today*, the runtime / pallet / proof path covers the
architectural trust gap *eventually*.

## 7. Updates needed elsewhere

- `MAINNET-DEFERRED-ITEMS.md` §2 People Chain entry — reflect that the
  pallet is research-blocked, not just "future work."
- `plans/fizzy-plotting-lerdorf.md` — note that Phase F is months-scale
  due to OpenGov, not weeks.
- `memory/project_alpha4_people_chain_identity.md` — link to this doc
  for the "why Diana stays" rationale.

## Sources

- People Chain Developer Docs:
  https://docs.polkadot.com/polkadot-protocol/architecture/system-chains/people/
- polkadot-fellows/runtimes — People Chain Polkadot lib.rs + xcm_config.rs
- "XCM as a Standard for Reading And Interacting with Parachains" —
  Polkadot Forum:
  https://forum.polkadot.network/t/xcm-as-a-standard-for-reading-and-interacting-with-parachains/266
- "Cross-Consensus Query Language (XCQ)" — Polkadot Forum:
  https://forum.polkadot.network/t/cross-consensus-query-language-xcq/7583
- open-web3-stack/PVQ (XCQ reference implementation):
  https://github.com/open-web3-stack/PVQ
- Polkadot Referendum #776 — XCQ Funding:
  https://polkadot.polkassembly.io/referenda/776
- "People Chain Launch and Identity Migration Plan" — Polkadot Forum:
  https://forum.polkadot.network/t/people-chain-launch-and-identity-migration-plan/5930
- XCM Precompile reference:
  https://docs.polkadot.com/smart-contracts/precompiles/xcm/
- XCM Instructions & Register Specification — Polkadot Wiki:
  https://wiki.polkadot.network/learn/learn-xcm-instructions/
