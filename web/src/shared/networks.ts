import { ContractAddresses, NetworkName, WebAppSettings } from "./types";

export const CURRENCY_SYMBOL: Record<NetworkName, string> = {
  local: "devDOT",
  polkadotTestnet: "PAS",
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
};

export const NETWORK_CONFIGS: Record<NetworkName, { name: string; chainId: number; rpcUrl: string; addresses: ContractAddresses }> = {
  local: {
    name: "Local Devnet",
    chainId: 31337,
    rpcUrl: "http://localhost:8545",
    addresses: { ...EMPTY_ADDRESSES },
  },
  polkadotTestnet: {
    name: "Paseo Testnet",
    chainId: 420420417,
    rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
    addresses: {
      // Alpha-2 (13 contracts) — deployed on Paseo 2026-03-26
      campaigns: "0xd14f889c1DafC1AD47788bfA47890353596380b9",
      publishers: "0x903D787B06B4b1E0036b162C3EfFd9984e73620b",
      governanceV2: "0xcb2B5b586E0726A7422eb4E5bD049382a19769A4",
      governanceSlash: "0x7A3032672bd5AeA348aD203287DedA58A62401ae",
      settlement: "0x13bF0d24C67b7a5354c675e00D7154bcc4A5738E",
      relay: "0x4D8B2CE56D40a3c423A7C1b91861C6186ceb59Ef",
      pauseRegistry: "0xEE1C347bDd5A552DC7CEDFdC51903ec7C82EC52D",
      timelock: "0x7CE40Ff62073f64fA6061A39023342Ab6Cf7c8Cc",
      zkVerifier: "0x80C547a15C59e26317C85C32C730e85F8067D87D",
      budgetLedger: "0xbCB853B7306fa27866717847FAD0a11f5bd65261",
      paymentVault: "0x31D64e88318937CeA791A4E54Bc9abCeab51d23C",
      lifecycle: "0xb789c62b90d525871ECCF54E5d0D5Eae87BF62fe",
      attestationVerifier: "0x1d84219251e8750FB7121AE92b2994887dDd9E18",
    },
  },
  westend: {
    name: "Westend",
    chainId: 420420421,
    rpcUrl: "https://westend-asset-hub-eth-rpc.polkadot.io",
    addresses: { ...EMPTY_ADDRESSES },
  },
  kusama: {
    name: "Kusama",
    chainId: 420420424,
    rpcUrl: "https://kusama-asset-hub-eth-rpc.polkadot.io",
    addresses: { ...EMPTY_ADDRESSES },
  },
  polkadotHub: {
    name: "Polkadot Hub",
    chainId: 420420416,
    rpcUrl: "https://polkadot-asset-hub-eth-rpc.polkadot.io",
    addresses: { ...EMPTY_ADDRESSES },
  },
};

export function getNetworkDisplayName(network: NetworkName): string {
  return NETWORK_CONFIGS[network]?.name ?? network;
}

export const DEFAULT_SETTINGS: WebAppSettings = {
  rpcUrl: NETWORK_CONFIGS.polkadotTestnet.rpcUrl,
  network: "polkadotTestnet",
  contractAddresses: NETWORK_CONFIGS.polkadotTestnet.addresses,
  ipfsGateway: "https://dweb.link/ipfs/",
  pinataApiKey: "",
};
