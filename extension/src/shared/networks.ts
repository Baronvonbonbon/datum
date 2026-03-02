import { ContractAddresses, NetworkName, StoredSettings } from "./types";

export const NETWORK_CONFIGS: Record<
  NetworkName,
  { rpcUrl: string; addresses: ContractAddresses }
> = {
  local: {
    rpcUrl: "http://localhost:8545",
    addresses: {
      // Populated after local deployment — update via Settings
      campaigns: "",
      publishers: "",
      governanceVoting: "",
      governanceRewards: "",
      settlement: "",
      relay: "",
    },
  },
  westend: {
    rpcUrl: "https://westend-asset-hub-eth-rpc.polkadot.io",
    addresses: {
      campaigns: "",
      publishers: "",
      governanceVoting: "",
      governanceRewards: "",
      settlement: "",
      relay: "",
    },
  },
  kusama: {
    rpcUrl: "https://kusama-asset-hub-eth-rpc.polkadot.io",
    addresses: {
      campaigns: "",
      publishers: "",
      governanceVoting: "",
      governanceRewards: "",
      settlement: "",
      relay: "",
    },
  },
  polkadotHub: {
    rpcUrl: "https://polkadot-asset-hub-eth-rpc.polkadot.io",
    addresses: {
      campaigns: "",
      publishers: "",
      governanceVoting: "",
      governanceRewards: "",
      settlement: "",
      relay: "",
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
};
