// contractCatalog — human-readable metadata for every contract in
// ContractAddresses. Used by the ContractsTouched footer to render
// per-page lists of "this page touches:" with hover tooltips that
// explain what each contract does.
//
// Keep the blurbs short — one sentence each. Long-form documentation
// lives in HowItWorks and the protocol /upgrades page.

import type { ContractAddresses } from "./types";

export type ContractKey = keyof ContractAddresses;

export interface ContractEntry {
  /// Short display name (the on-chain symbol-ish identifier).
  name: string;
  /// One-sentence blurb. Surfaces as a tooltip on the contract name
  /// and as the description on the /protocol/upgrades page.
  blurb: string;
}

export const CONTRACT_CATALOG: Record<ContractKey, ContractEntry> = {
  // ── Core protocol ────────────────────────────────────────────────
  campaigns: {
    name: "DatumCampaigns",
    blurb:
      "Campaign registry — budgets, daily caps, CPMs, creative metadata, and lifecycle status.",
  },
  publishers: {
    name: "DatumPublishers",
    blurb: "Publisher registry — registration, take rates, tags, relay signers, profiles.",
  },
  governanceV2: {
    name: "DatumGovernanceV2",
    blurb: "Conviction-weighted voting on campaign activation and slashing.",
  },
  settlement: {
    name: "DatumSettlement",
    blurb:
      "On-chain settlement — verifies claim batches, splits the CPM between publisher and user, rejects rate-limit / chain-integrity / ZK failures.",
  },
  relay: {
    name: "DatumRelay",
    blurb:
      "Bonded relay operator path — submits user-signed claim batches on behalf of users without gas.",
  },
  pauseRegistry: {
    name: "DatumPauseRegistry",
    blurb:
      "Emergency pause flag with category granularity. Cannot drain escrow — only blocks new settlement.",
  },
  timelock: {
    name: "DatumTimelock",
    blurb: "48-hour timelock that guards every privileged protocol change once Phase 2 is reached.",
  },
  zkVerifier: {
    name: "DatumZKVerifier",
    blurb: "Groth16 verifier for the impression-validity ZK circuit (Poseidon-bound nullifiers).",
  },

  // ── Satellites ───────────────────────────────────────────────────
  budgetLedger: {
    name: "DatumBudgetLedger",
    blurb: "Per-campaign escrow accounting — spend and refund tracking.",
  },
  paymentVault: {
    name: "DatumPaymentVault",
    blurb:
      "Pull-payment vault for publishers and users — DOT accrued via settlement is withdrawn on demand.",
  },
  lifecycle: {
    name: "DatumCampaignLifecycle",
    blurb: "Campaign state-machine transitions: Pending → Active → Completed / Terminated.",
  },
  attestationVerifier: {
    name: "DatumAttestationVerifier",
    blurb: "EIP-712 verifier for publisher attestations and dual-sig advertiser cosigs.",
  },
  claimValidator: {
    name: "DatumClaimValidator",
    blurb:
      "Pre-settlement integrity gate — claim chain, budget, rate-limit, optional ZK proof, optional PoW.",
  },
  tokenRewardVault: {
    name: "DatumTokenRewardVault",
    blurb: "ERC-20 reward sidecar — users withdraw project tokens credited per impression.",
  },

  // ── Fraud prevention ─────────────────────────────────────────────
  publisherStake: {
    name: "DatumPublisherStake",
    blurb:
      "Bonding-curve publisher stake — required collateral scales with cumulative impressions.",
  },
  challengeBonds: {
    name: "DatumChallengeBonds",
    blurb:
      "Advertiser challenge bond — locked at campaign creation, returned on clean end, slashable on fraud.",
  },
  publisherGovernance: {
    name: "DatumPublisherGovernance",
    blurb:
      "Conviction-weighted publisher fraud track — propose, vote, slash; bonus to challenge-bond pool.",
  },
  parameterGovernance: {
    name: "DatumParameterGovernance",
    blurb: "Bicameral parameter changes with veto window between Council and OpenGov.",
  },
  clickRegistry: {
    name: "DatumClickRegistry",
    blurb: "Optional click-through attestation registry for post-impression engagement signals.",
  },

  // ── Governance ladder ────────────────────────────────────────────
  governanceRouter: {
    name: "DatumGovernanceRouter",
    blurb:
      "Stable proxy that registers and resolves every upgradable contract. Owned by Timelock.",
  },
  council: {
    name: "DatumCouncil",
    blurb: "Phase-1 N-of-M Council — fastest gov path while alpha/beta is malleable.",
  },

  // ── Optional / alpha-5 ──────────────────────────────────────────
  councilBlocklistCurator: {
    name: "DatumBlocklistCurator",
    blurb: "Delegated Council blocklist curator — fast removal of egregious campaigns.",
  },
  peopleChainIdentity: {
    name: "DatumPeopleChainIdentity",
    blurb: "Cached People Chain identity proofs — gates higher-assurance features.",
  },
  peopleChainXcmBridge: {
    name: "DatumPeopleChainXcmBridge",
    blurb: "Trustless XCM-dispatched identity refresh from People Chain.",
  },
  wrapper: {
    name: "DatumWrapper",
    blurb: "ERC-20 wrapper for the DATUM token — commit-fund-claim mint flow.",
  },
  mintAuthority: {
    name: "DatumMintAuthority",
    blurb: "Caps and rate-limits DATUM token issuance; locks once OpenGov ratifies.",
  },
  bootstrapPool: {
    name: "DatumBootstrapPool",
    blurb: "Genesis liquidity pool for the DATUM token — phased emissions.",
  },
  vesting: {
    name: "DatumVesting",
    blurb: "Linear-vesting schedules for team/treasury allocations.",
  },
  feeShare: {
    name: "DatumFeeShare",
    blurb: "Protocol-fee distribution — routes a share of settlement fees to stakers.",
  },
  relayStake: {
    name: "DatumRelayStake",
    blurb: "Bonded stake for relay operators — slashed on misbehaviour.",
  },
  relayGovernance: {
    name: "DatumRelayGovernance",
    blurb: "Conviction-weighted slashing track for misbehaving relay operators.",
  },
  powEngine: {
    name: "DatumPowEngine",
    blurb: "Anti-Sybil PoW gate — ClaimValidator reads enforcePow() to decide whether to require solutions.",
  },
  publisherReputation: {
    name: "DatumPublisherReputation",
    blurb:
      "Per-publisher acceptance-vs-rejection score; anomaly detection flags outliers.",
  },
  nullifierRegistry: {
    name: "DatumNullifierRegistry",
    blurb:
      "Per-user / per-campaign / per-window ZK nullifiers — prevents replay across windows.",
  },
  settlementRateLimiter: {
    name: "DatumSettlementRateLimiter",
    blurb:
      "Per-publisher rolling-window impression cap — settlement rejects when exceeded.",
  },
  campaignCreative: {
    name: "DatumCampaignCreative",
    blurb: "Bulletin-Chain-backed creative storage carve-out (parallel to IPFS).",
  },
  reports: {
    name: "DatumReports",
    blurb:
      "Community reporting — flag campaigns or publishers; surfaces to governance for review.",
  },
  campaignAllowlist: {
    name: "DatumCampaignAllowlist",
    blurb:
      "Per-publisher campaign opt-in/opt-out allowlist — publishers approve or block individual campaigns.",
  },
  tagSystem: {
    name: "DatumTagSystem",
    blurb: "Publisher tag self-declaration + campaign requirement matching (replaces categories).",
  },
  blocklistCurator: {
    name: "DatumBlocklistCurator",
    blurb: "Alpha-5 alias of councilBlocklistCurator.",
  },
  activationBonds: {
    name: "DatumActivationBonds",
    blurb: "Optimistic activation bonds — small bond per campaign creation, refunded on clean end.",
  },
  stakeRoot: {
    name: "DatumStakeRoot",
    blurb: "Path A oracle V1 — owner-managed reporter set for off-chain attested state.",
  },
  stakeRootV2: {
    name: "DatumStakeRootV2",
    blurb: "Path A oracle V2 — permissionless bonded reporters; runs in shadow mode pre-cutover.",
  },
  identityVerifier: {
    name: "DatumIdentityVerifier",
    blurb: "Groth16 verifier for People Chain identity ZK circuit.",
  },
  emissionEngine: {
    name: "DatumEmissionEngine",
    blurb: "Per-batch dynamic-rate token emission alongside DOT settlement.",
  },
  mintCoordinator: {
    name: "DatumMintCoordinator",
    blurb: "Orchestrates DATUM token minting per settlement batch.",
  },
  dualSig: {
    name: "DatumDualSigSettlement",
    blurb: "Hybrid dual-sig settlement entry — publisher + advertiser cosig path.",
  },
  peopleChainBondedReporter: {
    name: "DatumPeopleChainBondedReporter",
    blurb: "Bonded fast-path reporter for People Chain identity refresh.",
  },
  settlementLogicA: {
    name: "DatumSettlementLogicA",
    blurb: "Settlement two-Logic split — Logic A path internals (called via Settlement entry).",
  },
  settlementLogicB: {
    name: "DatumSettlementLogicB",
    blurb: "Settlement two-Logic split — Logic B path internals (called via Settlement entry).",
  },
  advertiserGovernance: {
    name: "DatumAdvertiserGovernance",
    blurb: "Conviction-weighted advertiser fraud track (CB4) — mirrors publisher direction.",
  },
  advertiserStake: {
    name: "DatumAdvertiserStake",
    blurb: "Advertiser escrow slashed by advertiserGovernance on upheld fraud.",
  },
};

export function getContractEntry(key: ContractKey): ContractEntry | undefined {
  return CONTRACT_CATALOG[key];
}
