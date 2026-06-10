# DatumCampaignCreative

Unified per-campaign creative-mapping sidecar. Carved out of
DatumCampaigns for EIP-170. Owns both the legacy IPFS metadata hash
and the Polkadot Bulletin Chain creative reference, including the
escrow + renewer-trust-gradient that lets advertisers safely
permission keepers to refresh expiring Bulletin storage.

Creative data is fully orthogonal to the campaign hot path — no
settlement, validation, or governance flow reads it. Frontends are
the sole consumers.

## Why two creative paths

- **Legacy IPFS metadata** — `setMetadata(campaignId, ipfsHash)`
  stores a 32-byte hash. Cheap, immutable, but IPFS retention is
  off-chain best-effort.
- **Bulletin Chain reference** — `setBulletin(campaignId, ref,
  retentionUntilBlock)` plus the renewal flow. The Bulletin Chain
  is Polkadot's transient-storage parachain; references expire after
  ~2 weeks on Paseo. Renewable, but the cost-of-renewal must be
  paid each cycle.

Frontends consult the module by campaignId and prefer the Bulletin
reference when set, falling back to the IPFS hash otherwise.

## Bulletin lifecycle

```
ADVERTISER ══► setBulletin(id, ref, expiry)        (one-shot at creation)
ADVERTISER ══► fundBulletinRenewalEscrow {payable} (per-campaign DOT escrow)
ADVERTISER ══► setApprovedBulletinRenewer(id, kpr, true)
ADVERTISER ══► setOpenBulletinRenewal(id, true)    (anyone-can-renew mode)

KEEPER     ══► requestBulletinRenewal(id)          (signal intent; emits event)
KEEPER     ──→ off-chain: push new creative to Bulletin Chain
KEEPER     ══► confirmBulletinRenewal(id, newRef, newExpiry)
                  │
                  └── pays bulletinRenewerReward (DOT) from escrow
                       (refunded if advertiser self-renews)

ANYONE     ══► markBulletinExpired(id)             (clears stale reference)
```

## Trust gradient on renewers

Three modes, each more permissive than the previous:

- **Advertiser-only** (default). Only the campaign advertiser may
  call `confirmBulletinRenewal`. Maximum control, minimum keeper
  availability.
- **Approved renewer set**. Advertiser calls
  `setApprovedBulletinRenewer(id, renewer, true)` for each trusted
  keeper EOA. Those addresses can confirm renewals + earn the reward.
- **Open renewal**. Advertiser flips `setOpenBulletinRenewal(id, true)`.
  Anyone can confirm. Trade-off: higher availability, vulnerability
  to malicious renewers re-uploading garbage. Mitigated by per-call
  escrow cap + per-renewal expiry advancement bound.

## Escrow + reward

Per-campaign `bulletinRenewalEscrow[id]` holds advertiser-deposited
DOT. Each non-advertiser confirmation pays `bulletinRenewerReward`
(default 0.01 DOT) to the keeper from the escrow. If the advertiser
self-renews, no payment fires (the advertiser pays the gas and gets
no reward).

The reward is owner-tunable up to `MAX_BULLETIN_RENEWER_REWARD`
(10 DOT). Calibration vs Bulletin Chain gas costs + adversary budget
is operational discipline.

## Anti-grief bounds

- **`MAX_RETENTION_ADVANCE_BLOCKS = 220_000`** (~15.3 days @ 6s).
  Per-renewal cap on how much `newExpiry` can advance. Prevents a
  single fraudulent confirmation from claiming a year of retention.
- **`METADATA_COOLDOWN_BLOCKS = 14_400`** (~24h @ 6s). Inter-update
  cooldown on non-Pending campaigns so creative re-uploads can't be
  used to mid-flight censor live impressions.
- **`BULLETIN_RENEWAL_LEAD_BLOCKS = 14_400`**. `requestBulletinRenewal`
  reverts if the current expiry is more than this far in the future
  (no point requesting renewal of fresh content).

## Authorization model

Authorization is via reads against DatumCampaigns:

- Advertiser-only setters → `campaigns.getCampaignAdvertiser(id) ==
  msg.sender`.
- Cooldown on non-Pending → `campaigns.getCampaignStatus(id) !=
  Pending` triggers the `METADATA_COOLDOWN_BLOCKS` check.

There's no separate role registry; the campaign object is the
source of truth.

## Governance surface

- **`setBulletinRenewerReward(amount)`** — owner-only, `whenNotFrozen`,
  capped at `MAX_BULLETIN_RENEWER_REWARD`.
- **`setCampaigns(addr)`** / **`setPauseRegistry(addr)`** — owner-only,
  locked by `lockPlumbing`.
- **`lockPlumbing()`** — owner-only, `whenOpenGovPhase`.

## Trust assumptions

- DatumCampaigns is the authoritative source of campaign advertiser
  + status. A captured Campaigns upgrade could lie about the
  advertiser, but the upgrade itself flows through governance.
- Bulletin Chain availability is an external dependency. If a
  reference expires and no keeper renews, the creative reference goes
  stale; settlement is unaffected.
- The escrow is per-campaign and isolated; one campaign's renewer
  cannot drain another campaign's escrow.

## Upgrade

Upgradable via DatumGovernanceRouter. `_migrate` would copy the
per-campaign mappings (`_ref`, `bulletinRenewalEscrow`,
`approvedBulletinRenewer`, `openBulletinRenewal`) plus the legacy
metadata mappings. Per Phase A scope, advertiser-curated state is
preserved across upgrades. Bulletin Chain integration Phase C
(trustless auth model) is blocked on Bulletin's own auth design.
