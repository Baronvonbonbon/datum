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
      targetingRegistry: "",
      campaignValidator: "",
      claimValidator: "",
      governanceHelper: "",
    },
  },
  polkadotTestnet: {
    rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
    addresses: {
      // Alpha-2 Paseo deployment (2026-03-26)
      pauseRegistry: "0xEE1C347bDd5A552DC7CEDFdC51903ec7C82EC52D",
      timelock: "0x7CE40Ff62073f64fA6061A39023342Ab6Cf7c8Cc",
      zkVerifier: "0x80C547a15C59e26317C85C32C730e85F8067D87D",
      publishers: "0x903D787B06B4b1E0036b162C3EfFd9984e73620b",
      budgetLedger: "0xbCB853B7306fa27866717847FAD0a11f5bd65261",
      paymentVault: "0x31D64e88318937CeA791A4E54Bc9abCeab51d23C",
      campaigns: "0xd14f889c1DafC1AD47788bfA47890353596380b9",
      lifecycle: "0xb789c62b90d525871ECCF54E5d0D5Eae87BF62fe",
      settlement: "0x13bF0d24C67b7a5354c675e00D7154bcc4A5738E",
      governanceV2: "0xcb2B5b586E0726A7422eb4E5bD049382a19769A4",
      governanceSlash: "0x7A3032672bd5AeA348aD203287DedA58A62401ae",
      relay: "0x4D8B2CE56D40a3c423A7C1b91861C6186ceb59Ef",
      attestationVerifier: "0x1d84219251e8750FB7121AE92b2994887dDd9E18",
      targetingRegistry: "",
      campaignValidator: "",
      claimValidator: "",
      governanceHelper: "",
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
      targetingRegistry: "",
      campaignValidator: "",
      claimValidator: "",
      governanceHelper: "",
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
