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
// Source of truth: alpha-core/deployed-addresses.json. When that file
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
// archived at alpha-core/deployed-addresses.v4-pre-advertiser-track.json.
// Live Paseo deploy 2026-05-25 (C0+C1+C2 — claim-hash schema bump + policy envelope).
// Previous v5 addresses archived at alpha-4/deployed-addresses.json.bak-2026-05-06.
// Synced from alpha-core/deployed-addresses.json (deployedAt 2026-05-23). Live
// router resolution still overlays these on load via DatumGovernanceRouter,
// but the hardcoded values are what get used on cold-load (before the router
// resolve returns) — they MUST match the active deploy or first-render reads
// hit dead bytecode and revert.
const ALPHA_5_PASEO: ContractAddresses = {
  // Core
  campaigns:            "0x1Fe36fE7A096C6CfF9C9F55f02A1Cce1a44DE3c6",
  publishers:           "0x357606eB86A75A88Aef257dB161C25fc10714183",
  governanceV2:         "0x925C323557DE415E0cc8aB36A795B2908e0ED4A4",
  settlement:           "0xA81766522Ea4e11bd9374Cd2b0A8a66Ac7b98dB8",
  relay:                "0xEc183ceadCFE99cf741A6A53d357ffd583941BB0",
  pauseRegistry:        "0xac7f7c6B36887a487b63421e4D7A6aD54da40e91",
  timelock:             "0x4aEB56824d6E4D3e8EdB39DCF0ac875e6dFA8480",
  zkVerifier:           "0x2fC5d97608Bd3836124268e064c7aA4024312Cf5",
  // Satellites
  budgetLedger:         "0x6c24bBEEC2F368968B8e8b5Cb82a6726f66f7AC9",
  paymentVault:         "0x49Cbe782Fb2Bc5216E7AE0A29598451De6759265",
  lifecycle:            "0xe58eEDdf0029F109dF8d5b788836557D3Dd1F8f9",
  attestationVerifier:  "0x290710d76458C71f143F0369A6cecF7555F3F242",
  claimValidator:       "0x8B8BA033E88c7327441a0b7462123Ef2D35a7212",
  tokenRewardVault:     "0xA43111340dD5Fb55086892FA45553D935bB03211",
  // Fraud prevention
  publisherStake:       "0x1ffc5Fb6B2F2318B952d7C10f9908DCbb2104Ddd",
  challengeBonds:       "0xbcb2562f98a6568D05e5140bC93137Fbd76F175b",
  publisherGovernance:  "0x1CDB046B1Cc7985dB86381e58B59D9cd68641E9f",
  advertiserStake:      "0x8Eb466b4D341f7E335734d26fc5a060D1948636F",
  advertiserGovernance: "0x2820448bA725C5A5e298066E2D10Ef22adE9C7B7",
  interestCommitments:  "0x480bE8e1Fc61247eD2dB1c43A9d9b9Fd8245316c",
  tagCurator:           "0x2486244A5B8c4Bd2390e332A785139Cc99531d2c",
  parameterGovernance:  "0x65aAd61c29eb81Fb4699af29307137C9Aa879A87",
  clickRegistry:        "0x4fCFAF1Ea86d60361B53C6044E178b0fA9B9F62d",
  // Governance ladder
  governanceRouter:     "0x44F8e4ceD19c767932F5540229C0454eAf2a695e",
  council:              "0x4c0981d4b2521903Dcb8dc1B3D4C280DE063546d",
  // Carve-outs (alpha-4 EIP-170)
  powEngine:            "0xB07df9ef45daa337b481d66Bb4929F0A4b18e8c5",
  publisherReputation:  "0xD087C5f0c7bC39Fa1e48C5801dac4799503c06af",
  nullifierRegistry:    "0x947624b57FD48a725Fa5C0f768F95563FAAE0906",
  settlementRateLimiter:"0x395c0f156fd2533c242467A24D43b4fE507541EB",
  campaignCreative:     "0xCb557515229C89522dB9B2D3CE6b5F14F54A12FA",
  reports:              "0x6aa3F56cF2374D083090dC2f4158F35D80867800",
  campaignAllowlist:    "0xF3BEE042f717089f29e43EC43a8bCE150311E6c0",
  tagSystem:            "0x28c1Ec43BEE96efaB6851d724738F1689c9a9d89",
  blocklistCurator:     "0xf4627bB53a854db2bB5d458F778B1E89d0A09D98",
  councilBlocklistCurator: "0xf4627bB53a854db2bB5d458F778B1E89d0A09D98",  // alpha-4 alias
  activationBonds:      "0xb86a33a529Ca0044664e1671E3b46F37605D4C01",
  stakeRoot:            "0xc069068994616b29AE131Fc709F0CD5Fa8E9Cca1",
  stakeRootV2:          "0x5D3d64AA57bb093b10249749Ee914C259Ae43dD4",
  identityVerifier:     "0x77850A7490C6CE65AB936d1Bba58baf6f33d8c50",
  emissionEngine:       "0xFFA9199AD02ef1Bf67aF29339aC14BB4a1633D7c",
  mintCoordinator:      "0xeD00bD4ac8b4f0Fa40710226Bd56a17D60a18350",
  dualSig:              "0x56c69BA2D43b86F4E0dB56139ADDdDF4F833eD30",
  peopleChainIdentity:  "0xCF44b939a03ae511a880020428505a9bc68e76ff",
  peopleChainXcmBridge: "0x7E6d15bA29EE6D800A19354c27072b51696D53b9",
  peopleChainBondedReporter: "0x2DC46Aa3de0E28d9820031149d39a0a2721d1f4a",
  settlementLogicA:     "0x0554E0C7dB45de921Fa771361173c40FAE8b3CfA",
  settlementLogicB:     "0x6D3790889552360C375BfE49D5BAb1fD7b1f8Ee3",
  relayStake:           "0x5Bf314ea0353BbD006241f7eFA106f9B0D6f1b5d",
  relayGovernance:      "0x8Aa9D4dcA810096119Ce0F4152ad4f25eab8bC55",
  // Brand layer (deployed 2026-05-26 — separate deploy, not in deployed-addresses.json)
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
