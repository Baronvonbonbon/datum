import { ContractAddresses, NetworkName, StoredSettings } from "./types";

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
    },
  },
  paseo: {
    rpcUrl: "https://paseo-asset-hub-eth-rpc.polkadot.io",
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
    },
  },
};

export const DEFAULT_SETTINGS: StoredSettings = {
  rpcUrl: NETWORK_CONFIGS.local.rpcUrl,
  network: "local",
  publisherAddress: "",
  autoSubmit: false,
  autoSubmitIntervalMinutes: 10,
  contractAddresses: NETWORK_CONFIGS.local.addresses,
  ipfsGateway: "https://dweb.link/ipfs/",
  pinataApiKey: "",
};
