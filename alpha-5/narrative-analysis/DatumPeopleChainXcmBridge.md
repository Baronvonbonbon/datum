# DatumPeopleChainXcmBridge

Hub-side XCM dispatcher for the People Chain identity bridge.
Dispatches identity queries to People Chain via the Polkadot IXcm
precompile and receives the response as a `Transact` callback into
`xcmCallback`, which then writes the attestation into
`DatumPeopleChainIdentity`.

```
user ──requestRefresh(user)──► bridge ──IXcm.execute──► precompile
                                                              │
                                                       outbound XCM
                                                              ▼
                                                     People Chain runtime
                                                              │
                                                       return XCM (Transact)
                                                              ▼
                                                       bridge.xcmCallback
                                                              │
                                                   cache.submitAttestation
```

The bridge address is what's wired as `xcmDispatcher` on
`DatumPeopleChainIdentity`. On Paseo, `peopleChainSovereign` (the
authorized caller of `xcmCallback`) is Diana — an off-chain oracle
stand-in — until the People Chain pallet ships on mainnet. The
contract code path is identical to the production trustless flow;
the swap is `setSovereign(realPalletAddress)`.

Companion: [`bonded-reporter-identity.md`](./bonded-reporter-identity.md).

## Two request entry points

- **`requestRefresh(user)` payable** — user (or anyone) pays the XCM
  weight. Per-user cooldown blocks flapping.
- **`requestRefreshFromCampaign(campaignId, user)`** — pulls from
  `campaignXcmRefreshEscrow[cid]`. Advertisers fund an escrow per
  campaign so users can refresh without paying directly (UX win).

Either path dispatches the same outbound XCM via
`xcmPrecompile.execute` with weight + fee parameters tuned by owner
within bounds.

## Outbound XCM encoding

`lib/XcmTransactEncoder` encodes the `Transact` instruction targeting
People Chain's `datum_identity_relay` pallet (`palletIndex`,
`callIndex`). The encoder + index constants are governance-tunable
until `lockPalletCallIndices()` fires.

## Inbound callback

`xcmCallback(user, level, validityBlocks)`:

- Gated to `msg.sender == peopleChainSovereign` (sovereign-only).
- Writes through `cache.submitAttestation(user, level, validityBlocks)`.
- Emits the inbound event for observability.

On Paseo, the sovereign is Diana (deployer EOA). On mainnet (when
ready), the sovereign would be the on-chain address that People
Chain's runtime maps to when delivering callbacks — that's the
"trustless return-leg" still under research (see
`people-chain-return-leg.md`). Until that ships, the deployer-as-
sovereign path stays as fallback.

## Lock-once references

| Reference | Lock function | Phase |
|---|---|---|
| `peopleChainSovereign` | `lockSovereign()` | post-OpenGov |
| `palletIndex` / `callIndex` | `lockPalletCallIndices()` | post-OpenGov |
| `campaignsContract` | `address(0)` lock-once on setter | any |

`xcmPrecompile` and `cache` are immutable (constructor-set).

## Escrow

`campaignXcmRefreshEscrow[campaignId]` — advertisers fund here via a
payable deposit. Each `requestRefreshFromCampaign` debits the escrow
by the configured per-call cost; advertiser can `withdrawXcmRefreshEscrow`
unused balance subject to a cooldown.

## Trust assumptions

- `xcmPrecompile` is the Polkadot Hub XCM gateway. On Paseo it's
  0x0a0000 (or a mock in tests); on mainnet it's whatever the runtime
  configures.
- `peopleChainSovereign` is the inbound trust root. A captured
  sovereign can forge attestations. Mitigated by `lockSovereign()`
  once the trustless mapping is live.
- The per-user cooldown is anti-grief (preventing flapping), not
  anti-Sybil — separate addresses can each request refreshes.

## Governance surface

- **`setSovereign(addr)`** — owner-only, locked by `lockSovereign`.
- **`setCampaignsContract(addr)`** — owner-only, one-shot lock at
  first set.
- **`setPalletCallIndices(palletIdx, callIdx)`** — owner-only, locked
  by `lockPalletCallIndices`.
- **Various fee + cooldown tuners** — owner-only, bounded.

## Upgrade

Upgradable via DatumGovernanceRouter. State to migrate includes
`peopleChainSovereign`, `palletIndex` / `callIndex`,
`campaignXcmRefreshEscrow`, and per-user cooldown state. The cache
pointer is immutable so re-deploying the bridge requires
coordinating with the identity contract's `setXcmDispatcher`.
