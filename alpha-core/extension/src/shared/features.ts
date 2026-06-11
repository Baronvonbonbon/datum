// Extension mirror of web/src/lib/features.ts — the committed feature registry.
// The extension popup is wallet-core (Accounts/Send/Receive/History/Earnings/
// Settings), so unlike the webapp it has no feature *pages* to omit; this mirror
// exists for SSOT consistency and to gate the few feature-conditional Settings
// surfaces (e.g. the "Stake & Fraud Health" section) on whether the feature's
// contracts are deployed. Keep in sync with web/src/lib/features.ts and
// alpha-core/scripts/feature-modules.mjs.

import type { ContractAddresses } from "./types";

export type GovernancePhase = 0 | 1 | 2;

export interface FeatureDef {
  key: string;
  label: string;
  requiredKeys: (keyof ContractAddresses)[];
  requiredPhase?: GovernancePhase;
}

export const FEATURES: Record<string, FeatureDef> = {
  zk:                 { key: "zk",                 label: "Zero-Knowledge claims",  requiredKeys: ["zkVerifier"] },
  reputation:         { key: "reputation",         label: "Publisher reputation",   requiredKeys: ["publisherReputation"] },
  rateLimiter:        { key: "rateLimiter",        label: "Rate limiter",           requiredKeys: ["settlementRateLimiter"] },
  tags:               { key: "tags",               label: "Tag targeting",          requiredKeys: ["tagSystem"] },
  publisherStake:     { key: "publisherStake",     label: "Publisher stake",        requiredKeys: ["publisherStake"] },
  challengeBonds:     { key: "challengeBonds",     label: "Challenge bonds",        requiredKeys: ["challengeBonds"] },
  fraudPrevention:    { key: "fraudPrevention",    label: "Stake & fraud health",   requiredKeys: ["publisherStake"] },
  governance:         { key: "governance",         label: "Conviction governance",  requiredKeys: ["governanceV2"] },
  council:            { key: "council",            label: "Council",                requiredKeys: ["council"], requiredPhase: 1 },
  relayAccountability:{ key: "relayAccountability",label: "Relay accountability",   requiredKeys: ["relayStake", "relayGovernance"] },
  peopleChain:        { key: "peopleChain",        label: "People Chain identity",  requiredKeys: ["peopleChainIdentity"] },
  tokenPlane:         { key: "tokenPlane",         label: "DATUM token plane",      requiredKeys: ["wrapper", "mintAuthority"] },
};

const ZERO = "0x0000000000000000000000000000000000000000";

function keyPresent(addresses: Partial<ContractAddresses> | undefined, k: keyof ContractAddresses): boolean {
  const v = addresses?.[k];
  return typeof v === "string" && v.length === 42 && v !== ZERO;
}

/** Is a feature live on this deployment + phase? Unknown keys = core/always-on. */
export function isFeatureEnabled(
  key: string,
  addresses: Partial<ContractAddresses> | undefined,
  phase: GovernancePhase = 0,
): boolean {
  const f = FEATURES[key];
  if (!f) return true;
  if (!f.requiredKeys.every((k) => keyPresent(addresses, k))) return false;
  if (f.requiredPhase != null && phase < f.requiredPhase) return false;
  return true;
}
