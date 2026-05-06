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
      // Alpha-4 v1 — 21-contract EVM deploy 2026-05-06
      campaigns:           "0x364038B8d3E8fBEFA81D3D1249C4b62d5765880b",
      publishers:          "0x4D6d100F139bF13081abb8037472cd67A89519B2",
      governanceV2:        "0xE195CCC5dA11567b3501379985B5dfa4f0EC40b4",
      settlement:          "0x16F1fB8e96840cb2E50Db3D165683807761f568C",
      relay:               "0x82705970AF14754F61dAb6374a7ae9DC0a2706E1",
      pauseRegistry:       "0x03458E616a9C9460f0A63023b63B18a84C51EC82",
      timelock:            "0x0125909A25537422014eCE8b422A0c802f47b411",
      zkVerifier:          "0xd3C086583581DaFd2226365A4B1E1bEb13b4f3a2",
      budgetLedger:        "0xfF1DaA7CB3187EBb4D249567114e208fF4390B18",
      paymentVault:        "0x4fdE02a4c0aFfef31DC36D741F6a596A2aA87Fb6",
      lifecycle:           "0x4BE26c6078497C31f7310524F0e6F09d8A51C8b6",
      attestationVerifier: "0x765c2e7D64680Ee0987368c8489E89474cF18b0E",
      claimValidator:      "0x90EfB06Ad1f4c59a07863F2ddDe8e6cad411Ac84",
      tokenRewardVault:    "0x2B141116d0c26e8DcBfE08841214147c2F10506d",
      publisherStake:      "0xe5188a35c2dd926F1cCE35ee6f32a81A1aBa3108",
      challengeBonds:      "0x16c9a2Fc8D32D4106db60B38bD1D631E1A654f4D",
      publisherGovernance: "0x184254A2e51e3A92f840aCfDE292E926FFAf9DC1",
      parameterGovernance: "0x7ee17C46B68808FE22CF4B7deBD86EeB14BdFdC4",
      clickRegistry:       "0x2fe26529a4F3594Bcbccd36e200721e80349A5f4",
      governanceRouter:    "0x99388a88b74Fc51c17A5B6Eb37F6Cc55BF4dD091",
      council:             "0x90fe17488e1c17C1226F1c384a2Ef826dBFaa241",
    },
  },
  paseoEvm: {
    // Alpha-4 uses the same addresses as polkadotTestnet (EVM-only build)
    name: "Paseo EVM",
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
};
