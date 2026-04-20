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
      // Alpha-3 v8 — 26 contracts (full FP) redeployed on Paseo 2026-04-20
      campaigns:           "0x3CBa9E154C7ee369496a66Ea18119702E6D69F03",
      publishers:          "0x2d3938B16A711B3e393224776b1D1da5ceCF6FE7",
      governanceV2:        "0x56ed8CA43E6F992aA3Ff3eB42dEAaB1DfBe0ae83",
      governanceSlash:     "0x1428533537E81F2988ce8Ae09D48Ea4C84069b2B",
      settlement:          "0x76653aF142011a1d58e6cA02e98E689d475e7823",
      relay:               "0xFA649AdfDcC12fE2aA2b80E3e1A76E4751402F06",
      pauseRegistry:       "0x305303dF07C7F9E265B6EBD3b7940F6e7c8EafD4",
      timelock:            "0x8b755205058F8B7162a2f362057c8a2391C948B4",
      zkVerifier:          "0x31F2DE45F985E24BFb0BC833B77e557491187f3f",
      budgetLedger:        "0x663F713D1AD3E3361736F6A60F623067b3A7EF6E",
      paymentVault:        "0xD51ce700B0cF51DA3E8385681ACB1c10c2407f20",
      lifecycle:           "0xF055Ac11e29aa075fEd7b85053014F57e0FB34E3",
      attestationVerifier: "0xb7fD46F20Ed92d86d7F3a9F529D6aC354Da34585",
      targetingRegistry:   "0x23460C40c7EFA277551cDC7Fb2972B0aaAB03fB9",
      campaignValidator:   "0x30bCC00bc3c8E6cFFDD2798861B2C9Df03d20b20",
      claimValidator:      "0xB60BbCB71B9aF440B0B585222702288749ef46BC",
      governanceHelper:    "0xd4E3585285b9B16084308bdd081055F72D45b920",
      reports:             "0x5731262EC3fcdbe69c57c401F1aBe5b11A80956b",
      rateLimiter:         "0xdE2d58ecd15642E2d5DaE9B0D515D3085F506C5A",
      reputation:          "0xD753A0E58EbA05D7A80Be2b74c73E4b2F8876774",
      tokenRewardVault:    "0x6a6e613d2401103c0c1D17FFD2Ecd2Bb534d2886",
      publisherStake:      "0x19fcA6d61ECD39414Be361d3E98E49a8789F821F",
      challengeBonds:      "0xAb5882D9B25bda105B09a3A5848868f352eaE11B",
      publisherGovernance: "0xe1720D4e77F6544dabB9338C5B219C918027011D",
      nullifierRegistry:   "0xdd61AB14b9b6950498172d2bA156A18103b98254",
      parameterGovernance: "0xa60d039812c93c6f411736eA403301266d74b284",
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
