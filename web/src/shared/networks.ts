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
// Alpha-5 v3 Paseo deploy — 2026-05-22T23:49:02Z. Second redeploy of
// the day to add Phase A setters to DatumParameterGovernance's
// whitelist (couldn't be retrofitted onto v2 because PG self-owns the
// whitelist post-bootstrap, making it effectively immutable for the
// life of that PG instance). DatumCampaigns + DatumCampaignLifecycle
// keep their v2 storage layout; deploy.ts now includes setMinimumCpmFloor,
// setPendingTimeoutBlocks, and setInactivityTimeoutBlocks as PG-routable
// selectors. Previous v2 addresses archived at
// alpha-5/deployed-addresses.v2-pre-pg-whitelist.json.
const ALPHA_5_PASEO: ContractAddresses = {
  // Core
  campaigns:            "0x6276D88A5EE58e64192ce5606C0cd19FF69e3C32",
  publishers:           "0xBC5C4Ec33eb6429c1fD46e3FbAcb25295bDb6D18",
  governanceV2:         "0x1050C57C8795485F236e2272abd88C84D6b34A08",
  settlement:           "0x461aA96f4F4b24312e32eD3629fb4C3bd0479Fa3",
  relay:                "0x9aBAe6291ccC61b352FABCa2AACb4D5C1C348D11",
  pauseRegistry:        "0x5D87f348B8d2C307210f8BbC63cB8BFbe008F402",
  timelock:             "0xB0614a357dceC798d0ccb5d17F5F91d6515cB01A",
  zkVerifier:           "0xC2FB28B97597c462f639fA2D212C9f3EcbA0ED16",
  // Satellites
  budgetLedger:         "0xE70E0d8129498A338f8e3DbF978B98A6e8D47f58",
  paymentVault:         "0x24aB454DaA1da4dE1a2Eab09beB09FB852991D51",
  lifecycle:            "0x3793129991694935289E2404efa0B822B82b0Ee8",
  attestationVerifier:  "0xC1fe2Da0A7b8506185c6a6DE86dd951b49A4934C",
  claimValidator:       "0x4f1F83D644587A2EdE16d07AA9ac7fB121a4aCcd",
  tokenRewardVault:     "0x2152E1F993c048a9dC090BdBf2dF48B1C69CDe85",
  // Fraud prevention
  publisherStake:       "0x84fb3951A872cfc389602279c0C6E39fFe9A9e9D",
  challengeBonds:       "0xF53eA043bDc1e0b136A554474827559561f4DEb3",
  publisherGovernance:  "0xBdfd51Fba31FcBC0aCe11E240F9A847c58c7c40f",
  parameterGovernance:  "0xDA52ed6948eB0A0b2103AF9226D896F7640bB3F2",
  clickRegistry:        "0xd64FBBb5E51459154107fFFA905D4710EF158FEb",
  // Governance ladder
  governanceRouter:     "0x84eFc447DBBc43fa017D92FA4DfF199862ce96C1",
  council:              "0x82E5FD945f9164Fc63688dfb4e180fC9986A81b2",
  // Alpha-5 additions
  relayStake:           "0x7DFEB850B65bb4b430711037EdD0ca7ff793A1eA",
  relayGovernance:      "0x2dbD8Ee39a39De948056Fe06234bC27202Ec37B0",
  powEngine:            "0x398A70D5F58c151D485657836d3fc8E6Ac331F9c",
  publisherReputation:  "0xc8ee39b5178b6FBa81430d90a1cA689F1273ECF8",
  nullifierRegistry:    "0xcCCb05C426252F7bbeB1E8a89E5cdA176C49f6b5",
  settlementRateLimiter:"0x7895e8bAbc16b1B8A04064c5BFb1AaD2d3dd5DB2",
  campaignCreative:     "0xAf6c52bBAb14359723b657De416109368eCfA806",
  reports:              "0x582Fb263021990EDb4b5674036C6C17Cf9675a02",
  campaignAllowlist:    "0x9bDAf04e9A36bf4EbF1675d0113a67A31Fb0a07e",
  tagSystem:            "0x6E361a05439aDf54db53B449Ad7e052BA9fAE797",
  blocklistCurator:     "0x5685F467B517C6ae4779E58dC601bFB01a17476A",
  councilBlocklistCurator: "0x5685F467B517C6ae4779E58dC601bFB01a17476A",  // alpha-4 alias
  activationBonds:      "0x91eAC2eEeBCA78dACfeE078125718a8058C3949c",
  stakeRoot:            "0x18e68f58bbB09C99B48dfC513dD4e6B9169b9d55",
  stakeRootV2:          "0x9eD4018F8eF727D311C07d6e71c906e0dEe12948",
  identityVerifier:     "0xED46DaF208451bb88128B7dF588ec1BfB5068418",
  emissionEngine:       "0x8289CA82d7A900c860565af09C7d267A5162a290",
  mintCoordinator:      "0xE5C691A34c90568DeBb5EB8Bc8166250a5BB11fe",
  dualSig:              "0xD7dE7Dd724F4B64e4dB8c9d30fb27e14C29dbE04",
  peopleChainIdentity:  "0xA853Ea76713cbd4104b7d479b0673e752f6Bd0E1",
  peopleChainXcmBridge: "0x1431d4d9aa9435Ad3b4663d2101F703418c70892",
  peopleChainBondedReporter: "0xA6137f8FF8284eaC4fA4062e704f81253E8Ba0bc",
  settlementLogicA:     "0xC153d02c5878c770F91820E58A1E72B33AF1049B",
  settlementLogicB:     "0xc8e0aEb349385306f02D1e84Fe2f809de0456c4C",
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
