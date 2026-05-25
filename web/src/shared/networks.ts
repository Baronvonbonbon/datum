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
// Live Paseo deploy 2026-05-25 (C0+C1+C2 — claim-hash schema bump + policy envelope).
// Previous v5 addresses archived at alpha-4/deployed-addresses.json.bak-2026-05-06.
const ALPHA_5_PASEO: ContractAddresses = {
  // Core
  campaigns:            "0x1F562F52880A5DEae5573b4eF891b00d516fCa55",
  publishers:           "0x3962eD1718087D2cb86D1f86b211908Dde19f43c",
  governanceV2:         "0x545FF39e24aBfF8eB422BA8c818B52bf154f21B4",
  settlement:           "0xF9aB9f9F1404c468f0d9311F57b0C0773DC7d134",
  relay:                "0x3D3ba70885ad621887c623f3c3c1d647fd70da85",
  pauseRegistry:        "0x43e7BD41cEFf5DFAE2902E6f5DD7F2ed9a101F4e",
  timelock:             "0x8212BE3095099b74A371360A1df36B5518cE26a9",
  zkVerifier:           "0x2d9f6A12738A58eFcC25A817AC0B705829A67eaf",
  // Satellites
  budgetLedger:         "0xdeCcDC990D8FAe770dB11429ce7811C9A286dD24",
  paymentVault:         "0x93348e3cEC5f69163291dBc24e3f551CA08B54c1",
  lifecycle:            "0xD2d90659f17C85EB3bddcC3058e5EbBAa0C50595",
  attestationVerifier:  "0xCf2Fd5B156581Bd85c2DD533B74031A9dc5D063a",
  claimValidator:       "0x40522021929A6296508F794031c341e6454b52E8",
  tokenRewardVault:     "0xd31Dca059128feF8650057D3F1009C5Fe218Fb87",
  // Fraud prevention
  publisherStake:       "0x2c385C842fBe56dC1711Ca4222bfde292427CA26",
  challengeBonds:       "0x72F2474418C6D88d3F12016675299265283015c6",
  publisherGovernance:  "0xFaE7496570D1856E4CC8c865A6E3B023C87e56C5",
  parameterGovernance:  "0x7E28beF81F69330eC0Cfa67ceF7912e74FD309cd",
  clickRegistry:        "0xe076Dd669842f38CA7F1EdBC333d69C927302AA0",
  // Governance ladder
  governanceRouter:     "0xC82626Fb07A23b5c0e458449BD76F2a933a3BfDe",
  council:              "0x3aFC5535d5d8Eb199E9729ba772075b35ADAF1dd",
  // Carve-outs (alpha-4 EIP-170)
  powEngine:            "0x7AA0EBe4e96e0d3dFd3a84DCf053e7A6b5366645",
  publisherReputation:  "0x26629EC81aEbd93d7A3dC1B4381CA79e7a1aF684",
  nullifierRegistry:    "0x0b50b9cfbEf02f2C0C6783a5D2f547c1adE82493",
  settlementRateLimiter:"0x9b7831931D2B4D06F55270099b4B75F40B5f07C2",
  campaignCreative:     "0xf414743fa402A0a9815171A44bF007e3DEcea0C5",
  reports:              "0xA842957b2E7FF4816b75C329936D9A29bA81b12C",
  campaignAllowlist:    "0x2cc2a268B3C9645de052a9B53dE7e8de1d03D293",
  tagSystem:            "0xd8fAE8304A1D24f58556b0a3d8b35cC321fc2129",
  blocklistCurator:     "0xB35B6bF0cC626C159EDE22b93ce7B74e7D516b19",
  councilBlocklistCurator: "0xB35B6bF0cC626C159EDE22b93ce7B74e7D516b19",  // alpha-4 alias
  activationBonds:      "0x152468Fa5Dff8A7553FBc7AC5C9c538b88a80294",
  stakeRoot:            "0xf8944e563E355182C4b27c423CA575F110cBc633",
  stakeRootV2:          "0x2b0e91B67FB64560978cc9088b8B18D25C5a6BFe",
  identityVerifier:     "0xEda39f3183623218AE617A697aabC422d2030258",
  emissionEngine:       "0xf1c1645E978bfbD0e3b81dEe1dedaED8B04380d2",
  mintCoordinator:      "0xB7048bF91393292c812Dd88A5A2AcD87E092119E",
  dualSig:              "0xF4b41Ec188fDEe1F7c29065992E7b04e515ccc7e",
  peopleChainIdentity:  "0xe9eC0D3cD531B41cd121FF6Def7a6a1B3691EFA7",
  peopleChainXcmBridge: "0x3f1fB73bC40D93081f21343570cC9EE1Adcc113C",
  peopleChainBondedReporter: "0x0dE7Bb3B1Bb13DD70a542F92509A191f127c7621",
  settlementLogicA:     "0xc4FD146Afa3Ab29c29d75b6B2A23846c01675821",
  settlementLogicB:     "0xF4e1b55aac177b381Fd0a1B780C91EE20A811011",
  // Not deployed in this run (alpha-5 future scope): advertiserStake/Governance,
  // interestCommitments, tagCurator, relayStake/Governance, token plane.
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
