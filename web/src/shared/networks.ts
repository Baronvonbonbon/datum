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
  adminGovernance: "",
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
      // Alpha-3 v7 — full 29-contract redeploy 2026-04-26 (governance ladder + OZ fixes)
      campaigns:           "0xe81b841d8aa13352bE4a7E593D5916bD205323F2",
      publishers:          "0xE12F7Ad3f6EF1F27daD08a7551F5DEFBDc506CA8",
      governanceV2:        "0x54B1F60F396c64D68819530641E255E5e5Ae0aED",
      governanceSlash:     "0xdB799cFe78f54c04cc099e6F481a16e85faE0D33",
      settlement:          "0xF861ae3FA15F7c3CA4e5D71BFB5C4f75eB8C2fF9",
      relay:               "0xf473C6570Dd3a4b854F0e2103986d41e08920299",
      pauseRegistry:       "0x2BC4B296c82e2491358F059a238c2e5f26528f24",
      timelock:            "0x6d9E59f4d7c3cE2EE3946a085200Af517959b818",
      zkVerifier:          "0x5Ea16537f5c20CbDD30959dD22589666bE296271",
      budgetLedger:        "0x3FdfA73472C4D2e534d5eF50c568f19AA4c84922",
      paymentVault:        "0x838E93416a38A5d05904B67E4C9BFd34bB3ee524",
      lifecycle:           "0x8835BEe830b036d582cf9f79E20B9899A090679A",
      attestationVerifier: "0xEEDC77133a578add7F2c22bc643a3f051656aB89",
      targetingRegistry:   "0x5241DA2af587CA8d0bfF2736290E5498Dabc4176",
      campaignValidator:   "0x44976385794271Fc12FD8EA6A470Aa4FE59B6339",
      claimValidator:      "0xD06100d5A9a5757D444F9603653E6c697a06762D",
      governanceHelper:    "0x9b488594a7bcba3BD966354Ba7b49636C3B7348F",
      reports:             "0x7cAb1D53a64A88443d7be4C97dd6718709772942",
      rateLimiter:         "0x10E372864e0fEB9e2F831332f779333B51De3f2C",
      reputation:          "0x8aD9BD12130728404d161c7ade67fAf24dE1AA17",
      tokenRewardVault:    "0xbfB6Ed005ea0B5085eE9cC0CB2fE81AA34D53767",
      publisherStake:      "0xBB699c50FdF4387829449134f19DE48e3acFf906",
      challengeBonds:      "0x2158dAbcD2eB8a21b698f88cAef0fC890019dC5E",
      publisherGovernance: "0xb1B60f7E2851808b2C7FC0Ab83d73f23Bb09cC07",
      nullifierRegistry:   "0x3a3B08a275C95fb3EcDBC011a81351b7Ff16c270",
      parameterGovernance: "0x87246ab36dB2d29DFf356d37a7661eC3a28E58cD",
      adminGovernance:     "0xa3f1f698f33DAbD76992d9dFC6a5495ED33478BE",
      governanceRouter:    "0x0dD31875b7675A6F4Bc0128bf34c545f0ADFE503",
      council:             "0x5B3e80476634689259499FeC35C2b1D68289d40D",
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
      // FP-1–FP-5 + governance ladder: pending next paseoEvm redeploy
      publisherStake:      "",
      challengeBonds:      "",
      publisherGovernance: "",
      nullifierRegistry:   "",
      parameterGovernance: "",
      adminGovernance:     "",
      governanceRouter:    "",
      council:             "",
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
