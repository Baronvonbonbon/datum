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
export const DEPLOY_VERSION = "2026-06-17T-launch-controls";
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
  campaigns:            "0xE0C1C18af2532af8b36E8DfB7A67A78744BdB07F",
  publishers:           "0x86776018850b61c1e9202d73F031993818c33173",
  governanceV2:         "0x14A94cD4F409A4dD6ac85eC1bEB128Bb85CFbE16",
  settlement:           "0x7832E3c00643992d0811dd866d543A84Cff7Eb9f",
  relay:                "0x7Db03df460B3A8E3079ff87014614898fECDbC5b",
  pauseRegistry:        "0x36e4Ae11e7c3D3b19795Af191ec72FF8567E2eC3",
  timelock:             "0x153524982cFeDdebdE5834fBDAAb14615A2c13e1",
  zkVerifier:           "0xc1Fa219546cF9De4f5Dde19FAF96144351D54955",
  // Satellites
  budgetLedger:         "0xCA9411af5a30729D59eE2F46056021Ac9a2415a8",  // v2: multi-claim fan-out + paginated migrate (escrow migrated), 2026-06-15
  paymentVault:         "0xe511B0E7e114671e452dA34fAeb1081bB5a413F8",
  lifecycle:            "0x7e516f82632404d5Ab4A7eE5492bacCdE14171ee",  // JSON: campaignLifecycle
  attestationVerifier:  "0xd271a6DAB17eb64F79d0d053e30B2B217920Fa7e",
  claimValidator:       "0x3bCb2D6fE89c8526577Ada23904495F4327b9153",  // v2: validateBatch (multi-claim fan-out), 2026-06-15
  tokenRewardVault:     "0x170a6C2998A2B71D5396378Be3315D2AAE1C623C",  // v2: asset gate hardened (no decimals() req), 2026-06-12
  // Fraud prevention
  publisherStake:       "0x21C660E1fC21fd3C92832D0394334a8262138626",
  challengeBonds:       "0xb9f6BeF188B4Ff56FdAC71Da4056B8b682B1B222",
  publisherGovernance:  "0xa37f0b1537957B14b2C084132a2EBf386d560905",
  advertiserStake:      "0x70d4F239534aa2e0a6462FFfb654C7E69Fa854f1",
  advertiserGovernance: "0xE6C13421af29Cc02F47661e428f3d0e3F228b6Ea",
  interestCommitments:  "0xB7B8DBf0Ec01A71C281a6f38d87662B4A377cf10",
  tagCurator:           "0x49d26Aa5Cf4456Da189192908c6726C541ac4692",
  parameterGovernance:  "0x1f45698e88759872DDEED0d789068519FE55bD4b",
  clickRegistry:        "0x5369a13873Cb9Dc3ad8670b5F357766cfb63d771",
  // Governance ladder
  governanceRouter:     "0xCcaE1A080D24e62962d7e830Db61709C1967F6D0",
  council:              "0xe2EDCbb22D04B283Df571f9478AF80A610892f60",
  // Carve-outs (alpha-4 EIP-170)
  powEngine:            "0xE4E30FfF57f65645edE7b0F91ACca7A939EF0104",
  publisherReputation:  "0x2D40F1Ff336d31485fB8D7598E10e7088De50b84",
  nullifierRegistry:    "0x7FDf7C90561ddCdfbfC4a3ff531DBD2794303709",
  settlementRateLimiter:"0x5ec216fa969BA310F3420505661326100E560ea5",
  campaignCreative:     "0xd5FB31A85a02a91980b65B400db37867Ef984338",
  reports:              "0xB01684dc59F77DB5f2f24C0C02512230ef2b7406",
  campaignAllowlist:    "0x7238384cc39b099FC3297A217fB665BD8acdFCab",
  tagSystem:            "0x0C953Ae1251dcA4E2A34dC3aF3771156394dD974",
  blocklistCurator:     "0x782746ba006E6ee2f1652B5348455E9cc7e74189",
  councilBlocklistCurator: "0x782746ba006E6ee2f1652B5348455E9cc7e74189",  // alpha-4 alias
  activationBonds:      "0x6B684Da2b2C4Ea703E93B2b146ca53DEb7761EC9",
  stakeRoot:            "0xA07727C3703c443817a7Fa80CecaE5F33d81b112",
  stakeRootV2:          "0xb8a02aB4C37C9C821fd58BB2A55f216de7AC9f89",
  identityVerifier:     "0xA8EF5A85fAe0F5B6a4D8077DA68e2bd4153e9697",
  emissionEngine:       "0x9cbE5e8FA7d5d43F9dD3d1C84B54394C28e630Df",  // v2: emission on/off switch (2026-06-12)
  mintCoordinator:      "0x648B0329Dc5e50ab6A73bEcE8F6F2C8F14C4F98D",  // original (immutably-authorized minter); Settlement routes here
  dualSig:              "0x1341b8613d1ce62f9F542fd98e08ceDf83Cb24E9",
  peopleChainIdentity:  "0xd6d3dEf54E359E8E828876C8b95B3062908F998d",
  peopleChainXcmBridge: "0x9376FF4F793EEd2608b3c6854a0A378f0B1A2543",
  peopleChainBondedReporter: "0x6c779d3391b993670Cc34D641f6Bf16dDd7D4928",
  settlementLogicA:     "0x8D53d052252570bDB5aff3440D32839A555F2a1E",
  settlementLogicB:     "0xeAC2577A11ab903A3786530B0E02A7605F995044",  // v2: batched deduct/transferSettled settle path, 2026-06-15
  relayStake:           "0x0304C4B962054F2fCd210f952Bb4e2068a0430bD",
  relayGovernance:      "0xD3797f9EcDd97Cc8616609AF2Bdcd36dE662C208",
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
