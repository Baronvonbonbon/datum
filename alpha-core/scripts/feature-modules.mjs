// Feature-module manifest — the single source of truth for the MODULAR feature
// layering on top of the core MVP slim spine. Documents, per feature group:
//   - contracts:    deployed-addresses.json keys the module deploys
//   - wire:         setters called ON the spine to activate the module
//                   ({ target, setter, argKey })  (all onlyOwner whenPlumbingUnlocked)
//   - reverseWire:  setters on the module pointing back at the spine
//   - requiredPhase: governance phase at which the feature's UI should appear
//   - ui:           nav paths the feature gates (mirrors web/src/lib/features.ts)
//
// The bulk rollout uses deploy.ts (non-MVP) which reuses the live slim spine and
// deploys+wires every module here in one idempotent run. This manifest is the
// SSOT for MODULAR-DEPLOY-RUNBOOK.md and for adding a single feature later via
// deploy-feature.mjs. Keep in sync with web/src/lib/features.ts +
// alpha-core/extension/src/shared/features.ts.
//
// Verified setters exist on the slim contracts (grep set* in contracts/). The
// deployer is the Phase-0 owner, so deploy-module → call-setter layers a feature
// live without touching the spine.

export const FEATURE_MODULES = {
  adExchangeCore: {
    label: "Ad-exchange core (reputation / rate-limit / clicks / ZK / tags / creative / allowlist / reports)",
    contracts: ["clickRegistry", "publisherReputation", "settlementRateLimiter", "zkVerifier",
                "tagSystem", "tagCurator", "campaignCreative", "campaignAllowlist", "reports"],
    wire: [
      { target: "settlement",     setter: "setRateLimiter",      argKey: "settlementRateLimiter" },
      { target: "settlement",     setter: "setClickRegistry",    argKey: "clickRegistry" },
      { target: "claimValidator", setter: "setClickRegistry",    argKey: "clickRegistry" },
      { target: "claimValidator", setter: "setZKVerifier",       argKey: "zkVerifier" }, // env WIRE_ZK_PREDICATE=1 in deploy.ts
      { target: "claimValidator", setter: "setCampaignAllowlist",argKey: "campaignAllowlist" },
      { target: "campaigns",      setter: "setTagSystem",        argKey: "tagSystem" },
      { target: "tagSystem",      setter: "setTagCurator",       argKey: "tagCurator" },
      // publisherReputation is wired by settlement.setReputation (see deploy.ts); reports/creative are standalone.
    ],
    requiredPhase: 0,
    ui: ["/identity/zk", "/publisher/categories", "/publisher/allowlist", "/protocol/tag-curator"],
  },

  fraudPrevention: {
    label: "Fraud-prevention (publisher/advertiser stake + challenge/activation bonds)",
    contracts: ["publisherStake", "advertiserStake", "challengeBonds", "activationBonds"],
    wire: [
      { target: "settlement",     setter: "setPublisherStake",  argKey: "publisherStake" },
      { target: "settlement",     setter: "setAdvertiserStake", argKey: "advertiserStake" },
      { target: "campaigns",      setter: "setChallengeBonds",  argKey: "challengeBonds" },
      { target: "campaigns",      setter: "setActivationBonds", argKey: "activationBonds" },
      { target: "campaigns",      setter: "setAdvertiserStake", argKey: "advertiserStake" },
      { target: "campaignLifecycle", setter: "setChallengeBonds", argKey: "challengeBonds" },
      { target: "claimValidator", setter: "setActivationBonds", argKey: "activationBonds" },
    ],
    requiredPhase: 0,
    ui: ["/publisher/stake", "/protocol/publisher-stake", "/protocol/challenge-bonds", "/governance/activation-bonds"],
  },

  governanceLadder: {
    label: "Governance ladder (GovernanceV2 / Council / ParameterGov / fraud tracks / blocklist curator)",
    contracts: ["governanceV2", "council", "parameterGovernance", "publisherGovernance",
                "advertiserGovernance", "blocklistCurator"],
    wire: [
      { target: "governanceRouter", setter: "setCouncil",            argKey: "council" },
      { target: "campaigns",        setter: "setParameterGovernance",argKey: "parameterGovernance" },
      { target: "governanceV2",     setter: "setParameterGovernance",argKey: "parameterGovernance" },
      { target: "governanceV2",     setter: "setActivationBonds",    argKey: "activationBonds" },
      { target: "publishers",       setter: "setBlocklistCurator",   argKey: "blocklistCurator" },
      // publisher/advertiser governance wire their own stake/bond refs (see deploy.ts).
    ],
    // Contracts deploy at Phase 0, but the UI is phase-gated: Council surfaces at
    // phase >= 1, full OpenGov voting at phase 2. The campaign-fraud tracks show
    // at phase 0 (Council-arbitrated).
    requiredPhase: 0,
    phaseGatedUi: { "/governance/council": 1 },
    ui: ["/governance", "/governance/parameters", "/governance/publisher-fraud",
         "/governance/advertiser-fraud", "/governance/my-votes", "/protocol/parameter-governance",
         "/protocol/blocklist"],
  },

  relayAccountability: {
    label: "Relay accountability (bonded relay stake + slashing governance)",
    contracts: ["relayStake", "relayGovernance"],
    wire: [
      { target: "relay",          setter: "setRelayStake",      argKey: "relayStake" },
      { target: "relayGovernance",setter: "setRelayStake",      argKey: "relayStake" },
    ],
    requiredPhase: 0,
    ui: [],
  },

  identityStakeRoot: {
    label: "Identity verifier + stake-root oracle (V1 + V2 shadow)",
    contracts: ["identityVerifier", "stakeRoot", "stakeRootV2"],
    wire: [
      { target: "claimValidator", setter: "setStakeRoot",       argKey: "stakeRoot" },
      { target: "stakeRootV2",    setter: "setIdentityVerifier",argKey: "identityVerifier" },
    ],
    requiredPhase: 0,
    ui: ["/protocol/sybil-defense"],
  },

  peopleChain: {
    label: "People Chain identity (cache + XCM bridge + bonded reporter) — testnet oracle/XCM mocks",
    contracts: ["peopleChainIdentity", "peopleChainXcmBridge", "peopleChainBondedReporter"],
    wire: [
      // bridge/reporter wire into the identity cache; oracle reporter = deployer
      // on testnet. Do NOT fire lockOracleReporter (no trustless return-leg yet).
    ],
    requiredPhase: 0,
    ui: ["/identity/people-chain", "/me/identity"],
  },

  tokenPlane: {
    label: "DATUM token plane (Wrapper / MintAuthority / Vesting / FeeShare + Mint/Emission + TagRegistry/ZKStake)",
    // Deployed by deploy-token.ts (separate from deploy.ts), then mint/emission
    // wired into settlement; tagRegistry/zkStake need the WDATUM address.
    contracts: ["wrapper", "mintAuthority", "vesting", "feeShare", "mintCoordinator",
                "emissionEngine", "tagRegistry", "zkStake"],
    wire: [
      { target: "settlement", setter: "setMintCoordinator", argKey: "mintCoordinator" },
    ],
    requiredPhase: 0,
    ui: ["/token", "/token/mint-coordinator", "/token/wrapper", "/token/vesting",
         "/token/fee-share", "/protocol/mint-authority"],
  },
};

// Deploy order (dependency-aware). Bonds/stakes before the governance that
// slashes them; token plane last (needs the rest wired).
export const DEPLOY_ORDER = [
  "adExchangeCore", "fraudPrevention", "governanceLadder",
  "relayAccountability", "identityStakeRoot", "peopleChain", "tokenPlane",
];
