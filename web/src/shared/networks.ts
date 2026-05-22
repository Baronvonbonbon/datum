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
// Alpha-5 v2 Paseo deploy — 2026-05-22T21:07:58Z. DatumCampaigns v2 +
// DatumCampaignLifecycle v2 ship the Phase A parameter-governance change
// (minimumCpmFloor / pendingTimeoutBlocks / inactivityTimeoutBlocks
// demoted from immutable to onlyOwnerOrPG-tunable with lock-once
// cypherpunk end-state). Every other contract redeployed in the same
// run for clean wiring; previous v1 addresses archived at
// alpha-5/deployed-addresses.v1-pre-phase-a.json.
const ALPHA_5_PASEO: ContractAddresses = {
  // Core
  campaigns:            "0xE91325865e1C46Eb9c610584f26e0C0F4360a681",
  publishers:           "0xA6b7777d5D9cd67883F3167ab7b487400F0fe43B",
  governanceV2:         "0xC5A2F5069AeB7d8c0BeF0334Ef5c374ECe18560b",
  settlement:           "0x1B4A4A4dab241A351Ee126a981235b74f07Be4d4",
  relay:                "0xC73e219e88e4A4af161B1f1273510BF128c3b2FF",
  pauseRegistry:        "0x9dD575e2A35778E95bE512f7e7875157eF08c949",
  timelock:             "0xB3DD01Cf5A9AeD364F2cC7aec3E286e7759A3C6b",
  zkVerifier:           "0x516AC7236D8a6Bb1DaEDd9ea42054c7DFCF1c9Cb",
  // Satellites
  budgetLedger:         "0x094CD6e9e3351d770aD6083c0B7b079a503FD4aB",
  paymentVault:         "0x16f342F8413aD513B083685BBFd18e578ed6F96d",
  lifecycle:            "0xC20b0d8E29A80b4D7f12B864551DAe9F4Fa1e79e",
  attestationVerifier:  "0xdD6AB2F89AADE34aafecdcBbB8d46FA343C4749a",
  claimValidator:       "0x460646538B8d550a86999058eC1394e7ddA11873",
  tokenRewardVault:     "0xb99Ff78D7Ec9AB74964aB9260f4aa22f838E7b14",
  // Fraud prevention
  publisherStake:       "0xc1f74Ba2c78eAB366AE980CbB4f5fD0fC481A50b",
  challengeBonds:       "0xae8fEdE1411a33384797b3A47d454b27596F21b5",
  publisherGovernance:  "0xd33c9d3c4575b0e870731374B982424302BC50EA",
  parameterGovernance:  "0xd11F128EdB889299b6E4F1c8C7b2E791fA9BF964",
  clickRegistry:        "0xe8c96c244a79b10793e890c6C9B1404b3A02B9eb",
  // Governance ladder
  governanceRouter:     "0xc4Ba06C6beF787eE24152b23B81Af6b0e494c5a9",
  council:              "0x505C4b82F2D5Dfcd110F83cb508064d9168dA281",
  // Alpha-5 additions
  relayStake:           "0x41f472E1d4876Afd4F756869d007c6D59618a1d8",
  relayGovernance:      "0x88b5bdaE96C2D83fF8e75bD2E4Be4E2400b4fB75",
  powEngine:            "0x85AE43A70DF462b11726Cc4fedD90cCB6b2e38c8",
  publisherReputation:  "0xb9fD77725f5DF9C9ECdE0Aa13a307f5a18410676",
  nullifierRegistry:    "0x5635b7110D5cb478021e9B73A7ffe9C055a94f3d",
  settlementRateLimiter:"0x5c0005f51dD65013ddE902C8958D8Cd72346B136",
  campaignCreative:     "0xd4f9EedF7868626dBbe2171Fe3414e5B494D0111",
  reports:              "0xd14BB4635B7Ea3F3345EB0dff333aE86b2C2F011",
  campaignAllowlist:    "0xD25858d665FE2E5AeE6Ca882fCE42B29250c2E3D",
  tagSystem:            "0x787a5D7F59CF3e3192d4F2e0e2C358Fa219D641c",
  blocklistCurator:     "0x3e37895cfbd8f26953Eb5a78e09Cc1eC73b0cF3e",
  councilBlocklistCurator: "0x3e37895cfbd8f26953Eb5a78e09Cc1eC73b0cF3e",  // alpha-4 alias
  activationBonds:      "0xb909008D157C786b3B557100c9e1DaC62019fb1b",
  stakeRoot:            "0xC59C5605D20651f155417058591824a0F5FD19cC",
  stakeRootV2:          "0xED361e54227Bc54d893A2c80097592A047Baf1BA",
  identityVerifier:     "0x39e75a66A072db8C9af2988eb4F1F38507C66CC3",
  emissionEngine:       "0x79d22c1D966d46d0CAa733A69960bfAcfF8a5d21",
  mintCoordinator:      "0xE5A3ADA49E7D05A164c5BA8d6AC3C8c5D32Ea279",
  dualSig:              "0x9E5BCf0121ce01F715F99DCc1409169E8b634B54",
  peopleChainIdentity:  "0xD08a2465461C0BD0F0b87eFC74719a7a92ba8A0e",
  peopleChainXcmBridge: "0x4DF40984Ff458425eA812E8CbFf4eCE53d53cb48",
  peopleChainBondedReporter: "0xCD6244fdBc087Bb60d4303D68c6D33125046b085",
  settlementLogicA:     "0x374b07B937018B1dFB4DC2d984a4E0d8C4a71A52",
  settlementLogicB:     "0xCBAAdF9a6132563047E5515b5Fa7e52155fc6BFe",
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
