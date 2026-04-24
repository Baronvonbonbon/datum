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
  governanceSlash: "",
  settlement: "",
  relay: "",
  pauseRegistry: "",
  timelock: "",
  zkVerifier: "",
  budgetLedger: "",
  paymentVault: "",
  lifecycle: "",
  attestationVerifier: "",
  targetingRegistry: "",
  campaignValidator: "",
  claimValidator: "",
  governanceHelper: "",
  reports: "",
  rateLimiter: "",
  reputation: "",
  tokenRewardVault: "",
  publisherStake: "",
  challengeBonds: "",
  publisherGovernance: "",
  nullifierRegistry: "",
  parameterGovernance: "",
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
    addresses: {
      // Alpha-3 v11 — full 26-contract redeploy 2026-04-23
      campaigns:           "0xFAc18eCcc47b5e152945ffb646dB41EFAE2d001C",
      publishers:          "0xAE4bF9cae6619d7030330415Dd6347D141D44f21",
      governanceV2:        "0x804c223d456474F390c3c8def3ADd3Bf2AB0c659",
      governanceSlash:     "0x4f0fA3Cf88A39234A490693595AedDb728D6439E",
      settlement:          "0x6A2A6723A6EC2e2f9AF0cdaeF6335D1FF1B86022",
      relay:               "0x8c1E922f59D856750713fDfCC3C5D4956D3Ac132",
      pauseRegistry:       "0x983b3aDf73bF97303A8196de8444B09DD0Fd3f12",
      timelock:            "0x683FDCf25e31Ad7fb77dAC678f44C960fad939D6",
      zkVerifier:          "0x8bD07A787e2CEe1efA1B40903f1e314b20ca0dCD",
      budgetLedger:        "0x60396c4d9F9B28B0CabeF01992b693C0C33ddcB0",
      paymentVault:        "0x920F8c934096981d37089D344860f27F19974d94",
      lifecycle:           "0x2DFd58713e069Ca2bd96908943DC4C12701F1f10",
      attestationVerifier: "0xFA942Cce478c5B39faDD85B36b820fE2623A7821",
      targetingRegistry:   "0xD7b8E6E9931aa048731d84C39b2faDaf36BD20cC",
      campaignValidator:   "0xcD3498e4fDF5B07a297D494DdB69FaC243E99Cb7",
      claimValidator:      "0x41CE932996A71a4e6F7109C42b049734D307a028",
      governanceHelper:    "0x994bFA776Adbb50675fbc338B23e82D7A98949d3",
      reports:             "0xE92afff7d5AF544B83DD93ad45544D4E25eaF9aC",
      rateLimiter:         "0xb37eC3dE7D79078D4C7f246b37C0F24424Aa9F50",
      reputation:          "0x2901EA33305089a3DFCAAa635755AB07b0E105CA",
      tokenRewardVault:    "0x73a75A67b5C2F24d806cb3789f3F0b148668a6E7",
      publisherStake:      "0x28A795F93cFec3B72896506cCae0727AD6fE6684",
      challengeBonds:      "0x2e38f8a961663DC4bEd97D99f651c96eF16085D2",
      publisherGovernance: "0x4244219A861ae42f326e6893c80d6374e4C361c3",
      nullifierRegistry:   "0x354005240bCE1D29b94Ba3132073EAEc2B8B720A",
      parameterGovernance: "0x9e320F5791A3Ac49Ef260162Ed9B1de54e0C8709",
    },
  },
  paseoEvm: {
    // Same Passet Hub chain as polkadotTestnet (chain ID 420420417).
    // Contracts compiled with standard solc EVM bytecode (not resolc/PVM).
    // keccak256 hashing, no PolkaVM precompiles — full EVM compatibility.
    name: "Paseo EVM",
    chainId: 420420417,
    rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
    explorerUrl: "https://blockscout-testnet.polkadot.io",
    addresses: {
      campaigns:          "0xe640090e39FaD81909645eE268bBB85aaaDc0eC9",
      publishers:         "0xd5836Ab66AaaE80584B63f3a7e8a26caF08ACCB3",
      governanceV2:       "0x9D803C45AF693D92adF7c712CEAA945188247D3B",
      governanceSlash:    "0x4dD073891011C644532fC3c2686E62243a0eC6fe",
      settlement:         "0x79d7C9F8Da4f6b5E192d6F1967cd9507244561b7",
      relay:              "0xB3233c233dbe5e29431b3EB233F7C49275d1ef02",
      pauseRegistry:      "0x6168aC28Ae49b14c89a1b1c0Bc0188467465FF93",
      timelock:           "0x1f92C71dEa2609867C2900E44887F632411659f8",
      zkVerifier:         "0x7c0497a56dDC4Cc2bAe19a78A9CD7c600d5c7aF9",
      budgetLedger:       "0x91207AffC31d659c3B04FA78cb0892BCF94D0FBB",
      paymentVault:       "0x151F1813e4E92F72b73bC4B0170AF12E6daFF67b",
      lifecycle:          "0x9f0a897303dD325258Df26FFa90513e0888b60bE",
      attestationVerifier:"0x0651a2ed5116007Ee6A39d46fA4c43809f4a7d18",
      targetingRegistry:  "0x76428f03565C3610F03038C409f7514AA0c34a70",
      campaignValidator:  "0xF20E63D3149563b6A2D96753271a6821141eA23B",
      claimValidator:     "0xF88D9524D501877954633519701740f2B6807d7C",
      governanceHelper:   "0x7a151ECc1C3F968A0c329181af55cdC8050EE796",
      reports:            "0x3716092fDa93A677fd801D54A579325d654EF09b",
      rateLimiter:        "0x352F918eadA09e86C15e050F033083103AC0f7f4",
      reputation:         "0x730092bFCbfD0aa089b5B0eD854038a9DeC0Eb1e",
      tokenRewardVault:   "0x39087147C834dD1Af152B39c6fEA1a5928614839",
      // FP-1–FP-5: deployed pending next testnet run
      publisherStake:     "",
      challengeBonds:     "",
      publisherGovernance: "",
      nullifierRegistry:  "",
    },
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
};
