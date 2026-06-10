# DatumReports

Community reporting of ad creatives and publisher pages. An alpha-3
satellite that got merged into DatumCampaigns during the early
alpha-4 EVM consolidation, then carved back out for mainnet EIP-170.

Each `(user, campaign)` pair can submit at most one page report and
one ad report. Eligibility is gated on having at least
`MIN_EVENTS_TO_REPORT = 1` settled event for the campaign — a
sock-puppet sybil can't accumulate that without actually serving
real impressions through the protocol.

## Two report types

- **`reportPage(campaignId, reason)`** — content-violation on the
  publisher's page hosting the ad. Increments
  `pageReports[campaignId]` + `publisherReports[publisher]`.
- **`reportAd(campaignId, reason)`** — advertiser content violation
  on the ad creative. Increments `adReports[campaignId]` +
  `advertiserReports[advertiser]`.

`reason` ∈ [1, 5]. Reason codes are off-chain conventions; the
contract doesn't ascribe semantics beyond "non-zero, ≤ 5".

Duplicate reports from the same `(reporter, campaign)` revert E68.

## Eligibility check

Optional. If `settlement` is wired, the report-entry calls
`ISettlementReportGate(settlement).userCampaignSettled(reporter,
campaignId, actionType)` for actionTypes 0/1/2 and sums them. If
the total < `MIN_EVENTS_TO_REPORT`, the report reverts E62.

If `settlement == address(0)`, the eligibility gate is skipped. This
is used in test fixtures and pre-wired devnets; production wires
Settlement before the network goes live.

## Counters

Four mappings:

- `pageReports[campaignId]` — total page reports for this campaign
- `adReports[campaignId]` — total ad reports
- `publisherReports[publisher]` — cross-campaign publisher tally
- `advertiserReports[advertiser]` — cross-campaign advertiser tally

Plus two duplicate-prevention mappings (`_hasReportedPage` /
`_hasReportedAd`).

## What downstream consumes the counters

Off-chain dashboards and governance bots. The counters drive:

- Curator decisions to add to the publisher blocklist (via
  DatumCouncilBlocklistCurator).
- Campaign demote proposals (via DatumGovernanceV2 termination /
  demote flow).
- Advertiser slash proposals (via DatumAdvertiserGovernance).

None of this happens on-chain automatically. The counters are an
observational signal; the actions on them are governance-mediated.

## Governance surface

- **`setCampaigns(addr)`** — owner-only, locked by `lockPlumbing`.
  Must be set; `address(0)` reverts E00.
- **`setSettlement(addr)`** — owner-only, locked by `lockPlumbing`.
  `address(0)` is allowed (disables eligibility gate).
- **`lockPlumbing()`** — owner-only, `whenOpenGovPhase`. Requires
  `campaigns` set (Settlement remains optional).

## Trust assumptions

- DatumCampaigns is the authoritative source for `(advertiser,
  publisher, status)` per campaign.
- A reporter can game the eligibility gate by farming impressions on
  the target campaign — but doing so requires going through Settlement
  (which charges PoW, rate limits, etc.). The 1-event floor is
  intentionally low to keep reporting accessible; the design assumes
  sybil cost is the off-chain Settlement cost, not a high on-chain
  floor.
- Counters are public state; observers see who reported what.

## Upgrade

Upgradable via DatumGovernanceRouter. State to migrate includes the
counters plus the `_hasReported*` dedup maps. Without preserving the
dedup state, a v1 reporter could re-report on v2 — usually fine
(counters just inflate), but `_migrate` should copy them anyway for
strict semantics.
