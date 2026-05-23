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
// Alpha-5 v4 Paseo deploy — 2026-05-23T02:21:58Z. Parameter Governance
// Phase B landed: DatumActivationBonds + DatumGovernanceV2 +
// DatumMintCoordinator + DatumAdvertiserStake + DatumAdvertiserGovernance
// now expose `parameterGovernance` and route 17 recurring-tune setters
// through `onlyOwnerOrPG` alongside Phase A's 3 setters.
// Previous v3 addresses archived at
// alpha-5/deployed-addresses.v3-pre-phase-b.json.
const ALPHA_5_PASEO: ContractAddresses = {
  // Core
  campaigns:            "0x2566Cd601657A3198F17F85Ab5a9471906Ee835d",
  publishers:           "0x4967A71B8391f5583F180a793725232aEbfbcFA1",
  governanceV2:         "0x7595a22D291c43F681AC81a957703e7911f827C2",
  settlement:           "0x9fF2410EfC532f5256049fc8806401Bf7D91551D",
  relay:                "0x412719bfbAf66d27B9B05865797F8c967c90c116",
  pauseRegistry:        "0x3c66E7429449dac0e5464A1fe0b094C7d7fD9066",
  timelock:             "0x1D027a2F68Aee90753eaF9B6FDd39bb167Be84d8",
  zkVerifier:           "0xb3905F6Be18B9BcB2C36509914b59a1a90358E64",
  // Satellites
  budgetLedger:         "0x6E0D4c069cc9c6b9675FBFAdAC433A6240D2AA7f",
  paymentVault:         "0x693AE8e0a170eEa2d26Ee7D1136A8048Ef20C68B",
  lifecycle:            "0x9E1ccdB6C02F0eA1b862F5927A9E1BfA57E8c6a5",
  attestationVerifier:  "0xf295dA941B0A7162a4186e514cDA336a6faBBC5A",
  claimValidator:       "0xcBBb2903292fFD31E580cFD919E57EAc54094081",
  tokenRewardVault:     "0xe25699C531F52EB921e4e6B472Fe793a9d60dc69",
  // Fraud prevention
  publisherStake:       "0x35849FfC23801157fAb3a98F3284f974a64e716D",
  challengeBonds:       "0x5E30e319D09A0720d3Ddb843E8de18c8874EDEdD",
  publisherGovernance:  "0x41cfb101a7D01017aA6F00f6db799A6064756E48",
  parameterGovernance:  "0xf2331eEa514b4b0C64ae51820ddF88dBD35Faa78",
  clickRegistry:        "0xd74538EA53f0ecd6356DA3d2F424f6bA20f623cF",
  // Governance ladder
  governanceRouter:     "0x3e1B80D1362af847d74F536Af0A13D5828BD89Cc",
  council:              "0xe2FBd2AF05Ea1A94D31E13F0B4Ae3a0Ab92f8201",
  // Alpha-5 additions
  relayStake:           "0x2568e5AE03fa72763ABf772f9cc0DF8c1756d2Af",
  relayGovernance:      "0x80368399a0b78D80151Fe0aC43c5f84680A0c2af",
  powEngine:            "0x187091a7c74143818a1e15661Db1A9bfA29cd544",
  publisherReputation:  "0x58Ab752B56274D35AB01b9E8FA9D035C50C929F9",
  nullifierRegistry:    "0x4D61378560fdcEc83e71D2383c3F2029183Ec147",
  settlementRateLimiter:"0x1E352394Ca581A60E17E7c9369a566a8C1e26912",
  campaignCreative:     "0x15A0eE7c32Ab101Dfd783e5f7345D88f966c6642",
  reports:              "0xFc7e8b26C312689078421DA7a24B961078b00251",
  campaignAllowlist:    "0xCDC9dC6A14524c7E46719f1836777B88DBfFD6Cd",
  tagSystem:            "0xA39e0eA62FCf7B8E6a3B26e15E62242777E77bEa",
  blocklistCurator:     "0x37a3CF45C5E201639f5807A2993e368c785D234A",
  councilBlocklistCurator: "0x37a3CF45C5E201639f5807A2993e368c785D234A",  // alpha-4 alias
  activationBonds:      "0x57bD66d06BE7AaA81803262f9b9ff69123a79221",
  stakeRoot:            "0x517915c8781d31C5Fc7a819F8E9F95c0a6DCDb6B",
  stakeRootV2:          "0x692e1FC09FdA8f4dD79d9c8c02Ef6F26f2Bd58B1",
  identityVerifier:     "0xb82E2A97b9452b73FD1061BCda042931be99C532",
  emissionEngine:       "0xC9a4B120A806c756527137c9f7ecd06D80588Ece",
  mintCoordinator:      "0x993b1353aD866B1B4AbF18fB9492CD20ABA2a935",
  dualSig:              "0xF42F3cC31ce4689Fa58B6561f5368c3ce8a2809f",
  peopleChainIdentity:  "0xdFD797a442406cb3b36B5D07fFC86c15146b074f",
  peopleChainXcmBridge: "0xA6beFCd42245F71f80FD65D058965D70751d9C01",
  peopleChainBondedReporter: "0x148F0F5C2C48a85f59B46f11B31030dFA2665BC5",
  settlementLogicA:     "0x7556a7b282E7D115dA9423166a3ce3456ccCE548",
  settlementLogicB:     "0xb079BAf25b2C9f30ae68752fad239bb86428BA18",
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
