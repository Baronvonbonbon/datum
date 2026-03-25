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

export const NETWORK_CONFIGS: Record<
  NetworkName,
  { rpcUrl: string; addresses: ContractAddresses }
> = {
  local: {
    rpcUrl: "http://localhost:8545",
    addresses: {
      campaigns: "",
      publishers: "",
      governanceV2: "",
      governanceSlash: "",
      settlement: "",
      relay: "",
      pauseRegistry: "",
      timelock: "",
      zkVerifier: "",
      paymentVault: "",
      budgetLedger: "",
      lifecycle: "",
      attestationVerifier: "",
    },
  },
  polkadotTestnet: {
    rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
    addresses: {
      // Alpha-1 testnet addresses (will be updated after alpha-2 deploy)
      campaigns: "0x1337cD3be712079688EbbD2DA2455F981522ab1d",
      publishers: "0x3dF89c128F7E3b80d3220f0EB3c8bf8C0F351d46",
      governanceV2: "0x708356253c389bE1b0182e2c757468052Ec8CbA8",
      governanceSlash: "0xF6232d3050e34240250Ff514e6279C63DEBDfD86",
      settlement: "0x6dCbe782CFa9255adc94fdb821E6A7bc092fccc3",
      relay: "0x0c2F453B48f4eC13f4c6f4d5708765A2f57Ca65B",
      pauseRegistry: "0xFa0e0D4cb23a9616f780Cb0Ad4055E9b5fE6d1bD",
      timelock: "0x68003Ae2711dE93e66882591FD80F10105183831",
      zkVerifier: "0x00e95AC62efAf6250c0f15df4812122C8854DF90",
      paymentVault: "",
      budgetLedger: "",
      lifecycle: "",
      attestationVerifier: "",
    },
  },
  westend: {
    rpcUrl: "https://westend-asset-hub-eth-rpc.polkadot.io",
    addresses: {
      campaigns: "",
      publishers: "",
      governanceV2: "",
      governanceSlash: "",
      settlement: "",
      relay: "",
      pauseRegistry: "",
      timelock: "",
      zkVerifier: "",
      paymentVault: "",
      budgetLedger: "",
      lifecycle: "",
      attestationVerifier: "",
    },
  },
  kusama: {
    rpcUrl: "https://kusama-asset-hub-eth-rpc.polkadot.io",
    addresses: {
      campaigns: "",
      publishers: "",
      governanceV2: "",
      governanceSlash: "",
      settlement: "",
      relay: "",
      pauseRegistry: "",
      timelock: "",
      zkVerifier: "",
      paymentVault: "",
      budgetLedger: "",
      lifecycle: "",
      attestationVerifier: "",
    },
  },
  polkadotHub: {
    rpcUrl: "https://polkadot-asset-hub-eth-rpc.polkadot.io",
    addresses: {
      campaigns: "",
      publishers: "",
      governanceV2: "",
      governanceSlash: "",
      settlement: "",
      relay: "",
      pauseRegistry: "",
      timelock: "",
      zkVerifier: "",
      paymentVault: "",
      budgetLedger: "",
      lifecycle: "",
      attestationVerifier: "",
    },
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
