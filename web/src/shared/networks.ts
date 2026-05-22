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
const ALPHA_5_PASEO: ContractAddresses = {
  // Core
  campaigns:            "0x34663ec5Dd63A4517eBb4C763FEE6966FfB47a2e",
  publishers:           "0xBcF1ef361020dC430eb7460aFCa66709BCbcC883",
  governanceV2:         "0xad7650335C401200f4b7eA51E1D813EFFc4A50f6",
  settlement:           "0x4745230354F48610EF905424176A81685C93F62B",
  relay:                "0xD0e8a663ab360e2df00a0999476A92eBb6303112",
  pauseRegistry:        "0x7FF4E11716EE89c58DE46F2bA980FF6754Dac8cb",
  timelock:             "0x299f5fb99A4b5498aAEB73E48C2fE26CF0ead78e",
  zkVerifier:           "0xFfe6ca4D9e0A5ff38Ef697ad1553497F479daeDa",
  // Satellites
  budgetLedger:         "0xc679C24a283Ac580Ec3Ccd9A5BFc3C94acf61bA2",
  paymentVault:         "0xED3B961df0Dc83b99FCF84D0501ea1E60245dCc2",
  lifecycle:            "0x776E43ADd6C0b6E5F6CC07Af21DF4c9e5C8E04F1",
  attestationVerifier:  "0x20f3ef882f876Cf80A42e7BBEf600AbB4Aa9736C",
  claimValidator:       "0xA5795A1d40c9050268D0D63C3c9944BFc847988B",
  tokenRewardVault:     "0x39a3dc4C0Fe66E49F651F8Fe3684BF1b6c613883",
  // Fraud prevention
  publisherStake:       "0x3ddc2d14BA89Fc1aC51c6c58D740e992A3cB043a",
  challengeBonds:       "0x35f1787e82405C57F071b4CB607B92Be5889b70d",
  publisherGovernance:  "0xdc7e54080253300eD5c2CA3BD50667fF3eA42eF0",
  parameterGovernance:  "0x710a5f1D93D2F3a5C11cf3166D636cBBbAC50446",
  clickRegistry:        "0x19Dc1CaA534676aAF3452FACe4Be5B9FF3d88345",
  // Governance ladder
  governanceRouter:     "0xfD25A6e7a239Fc37A57Aa99458B7Ecb24BE74d69",
  council:              "0xad191e330C1cB497844213bf81B1A5305D99F244",
  // Alpha-5 additions
  relayStake:           "0xe7D5F794a126008157770b4bCbBcBf4Ad60D134a",
  relayGovernance:      "0x804B6d37EA48cbDcB649f0b72ED3318d8D8200bC",
  powEngine:            "0x395665da7517cfd8E85295021bfCc8bd90cfa9EC",
  publisherReputation:  "0x7C463CCe043eE06f1608c3Bf7228e2E83B48Af3e",
  nullifierRegistry:    "0x52D04561684c7F8C144D489De3C8D1Ee62C21F27",
  settlementRateLimiter:"0x569d35047b0b00859236065948e62fAF28fb01E5",
  campaignCreative:     "0x4e7a98E619c6579B6dD993a360B21580f10B4Cc9",
  reports:              "0xB8937B2a896884335aFbedAaD73Bc2d63e9e95BE",
  campaignAllowlist:    "0x2A9bF057E696d4982e1361542586ec0A7eC92eE0",
  tagSystem:            "0x9C7FD74e2F3e280D0f8F5207c34bD97CAcB54e01",
  blocklistCurator:     "0x00568E8FA775EF085AeD15d7bE514e58029C5dE0",
  councilBlocklistCurator: "0x00568E8FA775EF085AeD15d7bE514e58029C5dE0",  // alpha-4 alias
  activationBonds:      "0x638E46086a6D8246772b0b264F10ec73091305c8",
  stakeRoot:            "0x7cFeF79601751A161d345eEE90f7cc9E54B5245c",
  stakeRootV2:          "0x5dd39B7eDE7842131BD51524B9B3486338b55958",
  identityVerifier:     "0xA993b68f79e3B0bF00c73a12f4C71CEC0AB92E62",
  emissionEngine:       "0xC4699e9a163B6274256Da4DbDA6C9018ab822B3b",
  mintCoordinator:      "0xb1D9EBEcF960F326b1e521c5E61568bb881ff2CA",
  dualSig:              "0x7c1725B2b763623e49E2799FE140E4552956e088",
  peopleChainIdentity:  "0x54BDDEd50B553445c3d4b9C35b7278403d0dd7F3",
  peopleChainXcmBridge: "0x4CB3192E0c996FcaB4182138C5342453c94DCFF6",
  peopleChainBondedReporter: "0xE2F08A297525F718654416754B0Cc5Bd33BD963e",
  settlementLogicA:     "0x4DfB4327E35EaA0BF6f1Dc09AaFeFfD4951d5671",
  settlementLogicB:     "0x9b6d0d8451116Ca88A04C345c61ea3f636753389",
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
};
