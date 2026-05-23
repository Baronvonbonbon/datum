import { ContractAddresses, NetworkName, WebAppSettings } from "./types";

export const CURRENCY_SYMBOL: Record<NetworkName, string> = {
  local: "devDOT",
  polkadotTestnet: "PAS",
  paseoEvm: "PAS",
  westend: "WND",
  kusama: "KSM",
  polkadotHub: "DOT",
};

export function getCurrencySymbol(network: NetworkName): string {
  return CURRENCY_SYMBOL[network] ?? "DOT";
}

const EMPTY_ADDRESSES: ContractAddresses = {
  campaigns: "",
  publishers: "",
  governanceV2: "",
  settlement: "",
  relay: "",
  pauseRegistry: "",
  timelock: "",
  zkVerifier: "",
  budgetLedger: "",
  paymentVault: "",
  lifecycle: "",
  attestationVerifier: "",
  claimValidator: "",
  tokenRewardVault: "",
  publisherStake: "",
  challengeBonds: "",
  publisherGovernance: "",
  parameterGovernance: "",
  clickRegistry: "",
  governanceRouter: "",
  council: "",
};

// Alpha-5 Paseo addresses — 43-contract deploy of 2026-05-21.
//
// Source of truth: alpha-5/deployed-addresses.json. When that file
// changes (re-deploy), this block must be updated alongside. We keep
// the values inline rather than importing the JSON so the webapp
// build stays self-contained and works on Cloudflare's "cd web &&
// npm install + vite build" runner where the alpha-5 tree may not be
// available at module-resolution time.
//
// Field name mapping:
//   JSON's `campaignLifecycle` → `lifecycle`            (legacy name)
//   JSON's `blocklistCurator`  → both `blocklistCurator`
//                                 AND `councilBlocklistCurator`
//                                 (alpha-4 alias for back-compat)
// Alpha-5 v5 Paseo deploy — 2026-05-23T12:23:32Z. Adds the advertiser
// fraud track (DatumAdvertiserStake + DatumAdvertiserGovernance — now
// actually deployed, not just modifier-wired), plus DatumInterestCommitments
// (ZK Path-A user-interest roots) and DatumTagCurator (governance-curated
// tag lane). 13 contracts × 33 PG-routable selectors on the
// ParameterGovernance whitelist; 20 of those selectors are PG-tunable
// parameters across the Phase A + Phase B surface. Previous v4 addresses
// archived at alpha-5/deployed-addresses.v4-pre-advertiser-track.json.
const ALPHA_5_PASEO: ContractAddresses = {
  // Core
  campaigns:            "0x3a7AB32f47f789A59c0dd659fd2DB08E4662E149",
  publishers:           "0xAAED2e515574b330A16320A6Df5669274c6Abb80",
  governanceV2:         "0x7974823244F2c46b8b952F6F84B8AcA811353ecB",
  settlement:           "0x19562f8808d4e382e5B4d28c787271f384f96c35",
  relay:                "0xB06CB43977d9691ED220f434EEa730425BfF03ec",
  pauseRegistry:        "0xfC4B9b1c47EbF4F7A3f2a274C57F6C7Ab307FbD0",
  timelock:             "0x33578f113FF1502f90A9A98683ce66735Cae9B6e",
  zkVerifier:           "0x8698D81C63Bc7DAf5F578bD9Aa232d79069f9981",
  // Satellites
  budgetLedger:         "0xA7FBB6ef2EFb509764E38EB5396f597346524592",
  paymentVault:         "0xfc7e1Cd05EdB4d7203eF6cbfE07762FA4B09eD73",
  lifecycle:            "0x99A876954Bf4294e59938f5A031e41D508e372b4",
  attestationVerifier:  "0xc8F5c55754c8D40157A4b51A09eB768f4c0af459",
  claimValidator:       "0xF7E64A7124050d4322d26C6AB653C0414D96D2f6",
  tokenRewardVault:     "0x27D55103394f2E69E8Ae867290e0F0F4FD50933f",
  // Fraud prevention
  publisherStake:       "0x1A7903Af6B47E6d0a071DD7a70Ffb89Fe5A39147",
  challengeBonds:       "0xB50FBF1D919e3EAc2F096b78206cCB59F791F4e8",
  publisherGovernance:  "0xd046c9a9B5E1Ad97e8f2d290F16611B0f4C45EE9",
  advertiserStake:      "0xda5e6D741C210eD6AE63Da2cd6d57f0Dd81d70cE",
  advertiserGovernance: "0xf27324C6093e5C45309cE4F84B72BA967EFe9A18",
  interestCommitments:  "0xc05d837C35122523022AaA14AeaF9AAbB4C20aa6",
  tagCurator:           "0x54bd74f71F24e41d065A6f233D2a28Eb5598E672",
  parameterGovernance:  "0xE28851Fd4CFD71A16Be7AAb80e953f53bB6b3102",
  clickRegistry:        "0x9Eca5ce274AFAFbC8D0B7E56CbdaD3106Bf55f27",
  // Governance ladder
  governanceRouter:     "0xeeeD1f19c9ff23B7b1C748c96ab7FC853ee57062",
  council:              "0xD474805bc19aCc0BDaA3bdDAf73DA17787C6c150",
  // Alpha-5 additions
  relayStake:           "0x14fE1aB5ceeDb6dEb1ec2afEe2e7b8267d899539",
  relayGovernance:      "0xe2D0572333A2A5B7EA288F5De941c0E685EaE3e0",
  powEngine:            "0x94De8B916D68d154365762925ef29C04Fa5f0378",
  publisherReputation:  "0xdD56e1947B713d29CefAC302946a1c9B7959cF27",
  nullifierRegistry:    "0xE6a853105e170C0B72EEF8aD632941f71d07C258",
  settlementRateLimiter:"0xc27c028b53390f80e10FF5e14645F6ed442dcb00",
  campaignCreative:     "0xBfA458a72d86860973697ac5291DC1C5fEFFbC81",
  reports:              "0x5FD07CCaDba4863A50CCF17e8D5645a23812Ec60",
  campaignAllowlist:    "0x53B3DA56aE87fc3893555ef4e2ae8DB2B0EDce3c",
  tagSystem:            "0xA3548857670E5DF54cc06ab3bBBbf0F12233a406",
  blocklistCurator:     "0x106a8a54BcF6fAdF80f44D6EBb0b2C515E4dAaeC",
  councilBlocklistCurator: "0x106a8a54BcF6fAdF80f44D6EBb0b2C515E4dAaeC",  // alpha-4 alias
  activationBonds:      "0xeb3ffFD9eaAF7E7fb56BB166ce5f300143c0c59A",
  stakeRoot:            "0x4C63C5C8751cdb8dD316070c8d40C00D13911fa8",
  stakeRootV2:          "0x55310eddE16743Bc0F7FD5aC396351FcA5cF8047",
  identityVerifier:     "0xC9905F505f74b65c9445B8bC3d958523AA935CC1",
  emissionEngine:       "0xa1b78B668155b76ABc4B8Ba40d87ed58181608bC",
  mintCoordinator:      "0xAb66b639F61C10746BC4C876Fc9d6a2Df1759aF2",
  dualSig:              "0x9B4c0f81cF2a46c5C52a91D33EA022dbF7E8e04b",
  peopleChainIdentity:  "0x858dd5fCC448A023F12810E016187D6912247FCc",
  peopleChainXcmBridge: "0x4118c4c6cd5F88DA032Fc17317f779218Fc71230",
  peopleChainBondedReporter: "0x69B897773B3FB5d7238b211AA0DBC844bb4c85DC",
  settlementLogicA:     "0x2931dA48e191cA767449fe4E8C80c8B4C716A26f",
  settlementLogicB:     "0x896a56d7d6b3538ba241733863993A7c418f732D",
  // Token plane (not yet deployed on Paseo) — leave undefined so the
  // UI surfaces the disabled state until a future deploy fills them in.
};

export const NETWORK_CONFIGS: Record<NetworkName, { name: string; chainId: number; rpcUrl: string; explorerUrl: string; addresses: ContractAddresses; pineChain?: string }> = {
  local: {
    name: "Local Devnet",
    chainId: 31337,
    rpcUrl: "http://localhost:8545",
    explorerUrl: "",
    addresses: { ...EMPTY_ADDRESSES },
  },
  polkadotTestnet: {
    name: "Paseo Testnet",
    chainId: 420420417,
    rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
    explorerUrl: "https://blockscout-testnet.polkadot.io",
    pineChain: "paseo-asset-hub",
    addresses: ALPHA_5_PASEO,
  },
  paseoEvm: {
    // Same backend as polkadotTestnet — kept for the alpha-4 EVM
    // build that ran in parallel during the alpha-3 → alpha-4
    // transition. New code should use polkadotTestnet.
    name: "Paseo EVM (alpha-4 legacy)",
    chainId: 420420417,
    rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
    explorerUrl: "https://blockscout-testnet.polkadot.io",
    addresses: { ...EMPTY_ADDRESSES },
  },
  westend: {
    name: "Westend",
    chainId: 420420421,
    rpcUrl: "https://westend-asset-hub-eth-rpc.polkadot.io",
    explorerUrl: "https://blockscout-westend.polkadot.io",
    pineChain: "westend-asset-hub",
    addresses: { ...EMPTY_ADDRESSES },
  },
  kusama: {
    name: "Kusama",
    chainId: 420420424,
    rpcUrl: "https://kusama-asset-hub-eth-rpc.polkadot.io",
    explorerUrl: "https://blockscout-kusama.polkadot.io",
    pineChain: "kusama-asset-hub",
    addresses: { ...EMPTY_ADDRESSES },
  },
  polkadotHub: {
    name: "Polkadot Hub",
    chainId: 420420416,
    rpcUrl: "https://polkadot-asset-hub-eth-rpc.polkadot.io",
    explorerUrl: "https://blockscout.polkadot.io",
    pineChain: "polkadot-asset-hub",
    addresses: { ...EMPTY_ADDRESSES },
  },
};

export function getExplorerUrl(network: NetworkName): string {
  return NETWORK_CONFIGS[network]?.explorerUrl ?? "";
}

export function getNetworkDisplayName(network: NetworkName): string {
  return NETWORK_CONFIGS[network]?.name ?? network;
}

export const DEFAULT_SETTINGS: WebAppSettings = {
  rpcUrl: NETWORK_CONFIGS.polkadotTestnet.rpcUrl,
  network: "polkadotTestnet",
  contractAddresses: NETWORK_CONFIGS.polkadotTestnet.addresses,
  ipfsGateway: "https://ipfs-datum.javcon.io/ipfs/",
  pinataApiKey: "",
  ipfsProvider: "selfhosted",
  ipfsApiKey: "",
  ipfsApiEndpoint: "",
  theme: "dark",
  // Pine smoldot is the canonical chain access path; visitors get
  // trustless reads without touching a centralized RPC. The Settings
  // toggle lets operators turn it off if their browser can't host
  // the WASM blob, but the default-on posture is what makes the
  // anonymous preview surfaces useful out of the box.
  usePine: true,
  // RPC fallback is off by default — pine handles the live pipeline.
  // Users opt in explicitly when they want to load history beyond
  // pine's rolling window. The opt-in is a per-browser preference and
  // a hover tooltip in the header explains the metadata-exposure
  // tradeoff before they flip it on.
  rpcEnabled: false,
};
