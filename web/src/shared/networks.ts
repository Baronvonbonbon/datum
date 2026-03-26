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
      // Alpha (9 contracts) — deployed on Paseo
      campaigns: "0x1337cD3be712079688EbbD2DA2455F981522ab1d",
      publishers: "0x3dF89c128F7E3b80d3220f0EB3c8bf8C0F351d46",
      governanceV2: "0x708356253c389bE1b0182e2c757468052Ec8CbA8",
      governanceSlash: "0xF6232d3050e34240250Ff514e6279C63DEBDfD86",
      settlement: "0x6dCbe782CFa9255adc94fdb821E6A7bc092fccc3",
      relay: "0x0c2F453B48f4eC13f4c6f4d5708765A2f57Ca65B",
      pauseRegistry: "0xFa0e0D4cb23a9616f780Cb0Ad4055E9b5fE6d1bD",
      timelock: "0x68003Ae2711dE93e66882591FD80F10105183831",
      zkVerifier: "0x00e95AC62efAf6250c0f15df4812122C8854DF90",
      // Alpha-2 satellites — fill after alpha-2 deploy
      budgetLedger: "",
      paymentVault: "",
      lifecycle: "",
      attestationVerifier: "",
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

export const DEFAULT_SETTINGS: WebAppSettings = {
  rpcUrl: NETWORK_CONFIGS.polkadotTestnet.rpcUrl,
  network: "polkadotTestnet",
  contractAddresses: NETWORK_CONFIGS.polkadotTestnet.addresses,
  ipfsGateway: "https://dweb.link/ipfs/",
  pinataApiKey: "",
};
