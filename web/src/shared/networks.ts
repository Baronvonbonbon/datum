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

// Alpha-core Paseo addresses — full core redeploy of 2026-06-11.
//
// DEPLOY_VERSION stamps the active deploy. SettingsContext compares a
// persisted copy of this stamp against the current value on load; on a
// mismatch it flushes any cached contractAddresses from localStorage so a
// returning browser can't keep pointing at a previous deploy's (now-dead)
// contracts. Bump this whenever the address block below is re-synced.
export const DEPLOY_VERSION = "2026-06-12T-vault-v2-decimals-fix";
//
// Source of truth: alpha-core/deployed-addresses.json. When that file
// changes (re-deploy), this block AND DEPLOY_VERSION must be updated
// alongside. We keep the values inline rather than importing the JSON so
// the webapp build stays self-contained and works on Cloudflare's "cd web
// && npm install + vite build" runner where the alpha-core tree may not be
// available at module-resolution time.
//
// Field name mapping:
//   JSON's `campaignLifecycle` → `lifecycle`            (legacy name)
//   JSON's `blocklistCurator`  → both `blocklistCurator`
//                                 AND `councilBlocklistCurator`
//                                 (alpha-4 alias for back-compat)
// JSON keys not modeled in ContractAddresses (assetHubPrecompile,
// campaignsMigrationLogic, tokenAssetId) are intentionally omitted — they
// are deploy/extension concerns, not webapp call targets.
//
// The hardcoded values are what get used on cold-load (before any live
// router resolve returns) — they MUST match the active deploy or
// first-render reads hit dead bytecode and revert.
const ALPHA_5_PASEO: ContractAddresses = {
  // Core
  campaigns:            "0xC781D6d4Ce0567466A31c6ec50E336df42b2D346",
  publishers:           "0xBc161945d7bdBCbfa419ee70956f7Fe67A1940CD",
  governanceV2:         "0x750F20ceAec68c8405B29D7b4a28d58Ac217bfDE",
  settlement:           "0x477B92F0e938326Fa4D0F8533C6F7F6D7B0D70ee",
  relay:                "0x05eDD6c97cca1111169B19174cfE4987939EeE08",
  pauseRegistry:        "0xC9871944fabbb182602B1d2f626Fde868a155065",
  timelock:             "0xF0F3111A9217950A336E2DBf7310aC6A79cE6eC6",
  zkVerifier:           "0x2C2613c0838f8a0065A3e497a56068875605Bf24",
  // Satellites
  budgetLedger:         "0x1E4Ed63Af3E0561D6c51F231f6BF14404Be0B858",
  paymentVault:         "0xD489173e75289608ef766b8F8857D734982bad31",
  lifecycle:            "0x54197f23C63A774391Fa27CD25470e63dF3FE2c0",  // JSON: campaignLifecycle
  attestationVerifier:  "0xCCA37672489D0b023B3aaDb338E3474E3E4D4fd4",
  claimValidator:       "0x2988fA3E3c9D42d7FB641e287419Dc2974511FD4",
  tokenRewardVault:     "0x6D371368806F4795ADAe8b1e1F403c75086Ed4e1",  // v2: asset gate hardened (no decimals() req), 2026-06-12
  // Fraud prevention
  publisherStake:       "0xC4b9dA10d78cB1b4482c020fd3917b52B8B9D55A",
  challengeBonds:       "0x7320FfA3d0A83a48DA96d9639d032E7Ee1191f06",
  publisherGovernance:  "0x08cB4533C102cF771eb859E5a9d3f6A29Dd2258D",
  advertiserStake:      "0xB4C976a1075B6F2C555a784A0741dF1B26Ce4d60",
  advertiserGovernance: "0xA783e692ad9A83D895d8533A082a178631c21506",
  interestCommitments:  "0x1eD029c142Ba8181E242599feB495b4EA7aFD020",
  tagCurator:           "0xCB24fAF5bb383e5E4Fba9EaB8e3251f3453A42CD",
  parameterGovernance:  "0xa831cc422DA225E3B0c5Cb4148ED36507Aa25697",
  clickRegistry:        "0xc83ab97cCFfFB3Ec4201300470efeae4E5D8Fc80",
  // Governance ladder
  governanceRouter:     "0xAb22653cDcA7214636708721AeDAc289E8635e80",
  council:              "0x239e8c0bEbb5Fb5BC38da72dD51eac3f6e3b1b59",
  // Carve-outs (alpha-4 EIP-170)
  powEngine:            "0x378D1C3e856fdEC596680A86b4A73ff9215CFa82",
  publisherReputation:  "0xA180c851025A139abA1D2197F345548121825434",
  nullifierRegistry:    "0x9485Ac29018E259a0691526381f5ab756525f96c",
  settlementRateLimiter:"0x8e83F4B3cf5317A66A93d0ea90549b39ca3f627f",
  campaignCreative:     "0xC25091c039747120797724FFf1401f892eF6157e",
  reports:              "0xA7aDb0411E9faD09Ad8Ad4C01dCeE19b39E725b1",
  campaignAllowlist:    "0x08f3ef697f49a21a04F71793dc993e314bf697EE",
  tagSystem:            "0x78c9404fEAc5885Ba9B1fa01Cc39e617047ea569",
  blocklistCurator:     "0xdcAD33da87EE4007e57d03e95AC13bEEcdB69B0b",
  councilBlocklistCurator: "0xdcAD33da87EE4007e57d03e95AC13bEEcdB69B0b",  // alpha-4 alias
  activationBonds:      "0x8609C948cd70BBd7f49395CfBAeb215F81028044",
  stakeRoot:            "0xd51E85c519A3E9F288434bDD6CD4B34248B3f8F9",
  stakeRootV2:          "0xb5d3a08735C4D47BE03866eA020fa66A2bBCB7d3",
  identityVerifier:     "0x26F5719e21Af2F9a5130b353438fD25Fc69064C8",
  emissionEngine:       "0xff7336D7846A57425461E426839564956f5d78b7",  // v2: emission on/off switch (2026-06-12)
  mintCoordinator:      "0x561E47cEB7F3D42a96D468b94F6e3F2B25eA07cC",  // original (immutably-authorized minter); Settlement routes here
  dualSig:              "0xE343Fd0986c8fF3B15DFe1107afd911dab950053",
  peopleChainIdentity:  "0x317e14E122DC93349b5eCEAB9F073410d66165e6",
  peopleChainXcmBridge: "0xF26d3a2FB051e87E822FD041c73feab3276BECfd",
  peopleChainBondedReporter: "0x0834FC89F115f23548DfFcE6c77414A3300d2cf7",
  settlementLogicA:     "0x0014DFb6564C3BA281f97AeDD4CB8B173266e642",
  settlementLogicB:     "0xCCEd48AD37405188f6ff00a3b029D03f40336F40",
  relayStake:           "0xc4Ea887E850FC56Af70A8a048eee16211B415408",
  relayGovernance:      "0x7AD25683f625eF1C9db4f164aB1937B93AB503d1",
  // Token plane (deployed in the 2026-06-11 full redeploy)
  wrapper:              "0xb867f7b0Ee4b528e447b17ad57a72a1aa6fB07a5",
  mintAuthority:        "0xE278117D8ec09159D2736266d3b308D2A24c5B02",
  vesting:              "0x347644840bd6517b60EAb79d2AbF3b974fC0f7FE",
  feeShare:             "0xfeee95ab852fB26C6Fe7235F9A986b0576E15887",
  // Brand layer (deployed 2026-05-26 — separate deploy lineage, not part
  // of the core redeploy and not present in deployed-addresses.json)
  brandRegistry:        "0x1d1370E261dca558962b176FaD5851E0d5Ef388e",
  brandCurator:         "0x8E7F392aB97D2D9c099820aa0aB2c6255d0d307B",
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
  // Stamp of the deploy these addresses came from. On load, a persisted
  // copy that doesn't match triggers an address flush (see SettingsContext).
  addressesVersion: DEPLOY_VERSION,
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
