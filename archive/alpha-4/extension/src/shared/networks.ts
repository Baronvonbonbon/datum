import { ContractAddresses, NetworkName, StoredSettings } from "./types";

/** Currency symbol per network (DOT only for mainnet Polkadot Hub). */
export const CURRENCY_SYMBOL: Record<NetworkName, string> = {
  local: "devDOT",
  polkadotTestnet: "PAS",
  westend: "WND",
  kusama: "KSM",
  polkadotHub: "DOT",
};

/** Get the currency symbol for the given network name. */
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
  paymentVault: "",
  budgetLedger: "",
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

export const NETWORK_CONFIGS: Record<
  NetworkName,
  { rpcUrl: string; addresses: ContractAddresses; pineChain?: string }
> = {
  local: {
    rpcUrl: "http://localhost:8545",
    addresses: { ...EMPTY_ADDRESSES },
  },
  polkadotTestnet: {
    rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
    pineChain: "paseo-asset-hub",
    addresses: {
      // Alpha-4 — 20 contracts; addresses populated by deploy script writing deployed-addresses.json into the bundle.
      campaigns:           "",
      publishers:          "",
      governanceV2:        "",
      settlement:          "",
      relay:               "",
      pauseRegistry:       "",
      timelock:            "",
      zkVerifier:          "",
      budgetLedger:        "",
      paymentVault:        "",
      lifecycle:           "",
      attestationVerifier: "",
      claimValidator:      "",
      tokenRewardVault:    "",
      publisherStake:      "",
      challengeBonds:      "",
      publisherGovernance: "",
      parameterGovernance: "",
      clickRegistry:       "",
      governanceRouter:    "",
      council:             "",
    },
  },
  westend: {
    rpcUrl: "https://westend-asset-hub-eth-rpc.polkadot.io",
    pineChain: "westend-asset-hub",
    addresses: { ...EMPTY_ADDRESSES },
  },
  kusama: {
    rpcUrl: "https://kusama-asset-hub-eth-rpc.polkadot.io",
    pineChain: "kusama-asset-hub",
    addresses: { ...EMPTY_ADDRESSES },
  },
  polkadotHub: {
    rpcUrl: "https://polkadot-asset-hub-eth-rpc.polkadot.io",
    pineChain: "polkadot-asset-hub",
    addresses: { ...EMPTY_ADDRESSES },
  },
};

export const DEFAULT_SETTINGS: StoredSettings = {
  rpcUrl: NETWORK_CONFIGS.polkadotTestnet.rpcUrl,
  network: "polkadotTestnet",
  publisherAddress: "",
  autoSubmit: false,
  autoSubmitIntervalMinutes: 10,
  contractAddresses: NETWORK_CONFIGS.polkadotTestnet.addresses,
  ipfsGateway: "https://dweb.link/ipfs/",
  pinataApiKey: "",
};
