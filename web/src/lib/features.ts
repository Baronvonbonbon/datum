// Committed feature registry — single source of truth for which protocol
// features are "live" on the current deployment, used to OMIT nav entries,
// routes, and in-page sections for anything that is either (a) not deployed
// (its contract address is unset/zero in deployed-addresses.json) or (b) not in
// the required governance phase (router.phase()).
//
// Mirrors alpha-core/scripts/feature-modules.mjs (the deploy/runbook manifest)
// and alpha-core/extension/src/shared/features.ts (the extension mirror). Keep
// the three in sync when adding a feature.
//
// Design: the core MVP slim spine (settlement/relay/campaigns/...) is always on.
// Every deferred feature module is gated. A feature is enabled iff ALL its
// requiredKeys resolve to a non-zero address AND the live phase >= requiredPhase.

import type { ContractAddresses } from "@shared/types";

export type GovernancePhase = 0 | 1 | 2; // 0=Admin, 1=Council, 2=OpenGov

export interface FeatureDef {
  key: string;
  label: string;
  /** All must be present (non-zero) in deployed-addresses for the feature to be on. */
  requiredKeys: (keyof ContractAddresses)[];
  /** Minimum governance phase for the feature's UI to show. Default 0 (Admin). */
  requiredPhase?: GovernancePhase;
}

// ── Feature catalog ─────────────────────────────────────────────────────────
// Slim-spine surfaces (settlement, relay, campaigns, publishers, dual-sig,
// payment vault, pause registry, token-reward credit) are NOT gated — they are
// always part of the core. Only deferred modules appear here.
export const FEATURES: Record<string, FeatureDef> = {
  zk:                 { key: "zk",                 label: "Zero-Knowledge claims",     requiredKeys: ["zkVerifier"] },
  reputation:         { key: "reputation",         label: "Publisher reputation",      requiredKeys: ["publisherReputation"] },
  rateLimiter:        { key: "rateLimiter",        label: "Settlement rate limiter",   requiredKeys: ["settlementRateLimiter"] },
  clickRegistry:      { key: "clickRegistry",      label: "Click registry (CPC)",      requiredKeys: ["clickRegistry"] },
  tags:               { key: "tags",               label: "Tag targeting",             requiredKeys: ["tagSystem"] },
  tagCurator:         { key: "tagCurator",         label: "Tag curator",               requiredKeys: ["tagSystem", "tagCurator"] },
  campaignCreative:   { key: "campaignCreative",   label: "Bulletin creative",         requiredKeys: ["campaignCreative"] },
  campaignAllowlist:  { key: "campaignAllowlist",  label: "Campaign allowlist",        requiredKeys: ["campaignAllowlist"] },
  reports:            { key: "reports",            label: "Community reports",         requiredKeys: ["reports"] },
  // Fraud-prevention (stakes + bonds)
  publisherStake:     { key: "publisherStake",     label: "Publisher stake",           requiredKeys: ["publisherStake"] },
  advertiserStake:    { key: "advertiserStake",    label: "Advertiser stake",          requiredKeys: ["advertiserStake"] },
  challengeBonds:     { key: "challengeBonds",     label: "Challenge bonds",           requiredKeys: ["challengeBonds"] },
  activationBonds:    { key: "activationBonds",    label: "Activation bonds",          requiredKeys: ["activationBonds"] },
  // Governance ladder (phase-gated)
  governance:         { key: "governance",         label: "Conviction governance",     requiredKeys: ["governanceV2"] },
  parameterGov:       { key: "parameterGov",       label: "Parameter governance",      requiredKeys: ["parameterGovernance"] },
  publisherFraud:     { key: "publisherFraud",     label: "Publisher fraud track",     requiredKeys: ["publisherGovernance"] },
  advertiserFraud:    { key: "advertiserFraud",    label: "Advertiser fraud track",    requiredKeys: ["advertiserGovernance"] as (keyof ContractAddresses)[] },
  council:            { key: "council",            label: "Council",                   requiredKeys: ["council"], requiredPhase: 1 },
  blocklist:          { key: "blocklist",          label: "Blocklist curator",         requiredKeys: ["blocklistCurator"] },
  // Relay accountability
  relayAccountability:{ key: "relayAccountability",label: "Relay accountability",      requiredKeys: ["relayStake", "relayGovernance"] },
  // Identity / oracle
  identity:           { key: "identity",           label: "Identity verifier",         requiredKeys: ["identityVerifier"] as (keyof ContractAddresses)[] },
  stakeRoot:          { key: "stakeRoot",          label: "Stake-root oracle",         requiredKeys: ["stakeRoot"] as (keyof ContractAddresses)[] },
  peopleChain:        { key: "peopleChain",        label: "People Chain identity",     requiredKeys: ["peopleChainIdentity"] },
  // Token plane
  tokenPlane:         { key: "tokenPlane",         label: "DATUM token plane",         requiredKeys: ["wrapper", "mintAuthority"] },
  mintCoordinator:    { key: "mintCoordinator",    label: "Mint coordinator",          requiredKeys: ["mintCoordinator"] as (keyof ContractAddresses)[] },
  vesting:            { key: "vesting",            label: "Vesting",                   requiredKeys: ["vesting"] },
  feeShare:           { key: "feeShare",           label: "Fee share",                 requiredKeys: ["feeShare"] },
};

// ── Nav / route → feature mapping ───────────────────────────────────────────
// A path (or path prefix) maps to the feature that must be enabled for it to
// appear. Paths NOT listed here are core (always shown). Most-specific match
// wins (longest prefix).
export const PATH_FEATURE: Record<string, string> = {
  "/identity/zk": "zk",
  "/identity/people-chain": "peopleChain",
  "/publisher/categories": "tags",
  "/publisher/stake": "publisherStake",
  "/publisher/allowlist": "campaignAllowlist",
  "/governance": "governance",
  "/governance/activation-bonds": "activationBonds",
  "/governance/advertiser-fraud": "advertiserFraud",
  "/governance/publisher-fraud": "publisherFraud",
  "/governance/council": "council",
  "/governance/parameters": "parameterGov",
  "/governance/my-votes": "governance",
  "/protocol/tag-curator": "tagCurator",
  "/protocol/parameter-governance": "parameterGov",
  "/protocol/publisher-stake": "publisherStake",
  "/protocol/challenge-bonds": "challengeBonds",
  "/protocol/blocklist": "blocklist",
  "/protocol/mint-authority": "tokenPlane",
  "/protocol/sybil-defense": "publisherStake",
  "/token": "tokenPlane",
  "/token/mint-coordinator": "mintCoordinator",
  "/token/wrapper": "tokenPlane",
  "/token/vesting": "vesting",
  "/token/fee-share": "feeShare",
};

const ZERO = "0x0000000000000000000000000000000000000000";

function keyPresent(addresses: Partial<ContractAddresses> | undefined, k: keyof ContractAddresses): boolean {
  const v = addresses?.[k];
  return typeof v === "string" && v.length === 42 && v !== ZERO;
}

/** Is a feature live on this deployment + phase? */
export function isFeatureEnabled(
  key: string,
  addresses: Partial<ContractAddresses> | undefined,
  phase: GovernancePhase = 0,
): boolean {
  const f = FEATURES[key];
  if (!f) return true; // unknown key = treat as core/always-on
  if (!f.requiredKeys.every((k) => keyPresent(addresses, k))) return false;
  if (f.requiredPhase != null && phase < f.requiredPhase) return false;
  return true;
}

/** Most-specific path → feature lookup. Returns null when the path is core. */
export function featureForPath(path: string): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const prefix of Object.keys(PATH_FEATURE)) {
    if ((path === prefix || path.startsWith(prefix + "/")) && prefix.length > bestLen) {
      best = PATH_FEATURE[prefix];
      bestLen = prefix.length;
    }
  }
  return best;
}

/** Should this path be visible? Core paths always; feature paths per gate. */
export function isPathEnabled(
  path: string,
  addresses: Partial<ContractAddresses> | undefined,
  phase: GovernancePhase = 0,
): boolean {
  const feat = featureForPath(path);
  return feat == null ? true : isFeatureEnabled(feat, addresses, phase);
}
