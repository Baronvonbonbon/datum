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
  targetingRegistry: "",
  campaignValidator: "",
  claimValidator: "",
  governanceHelper: "",
  reports: "",
  rateLimiter: "",
  reputation: "",
  tokenRewardVault: "",
};

export const NETWORK_CONFIGS: Record<NetworkName, { name: string; chainId: number; rpcUrl: string; explorerUrl: string; addresses: ContractAddresses }> = {
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
    addresses: {
      // Alpha-3 v7 — Settlement redeployed (BM-10) on Paseo 2026-04-07
      campaigns: "0xb181415cd7C59fe182A3DeF20546b6d6089CD394",
      publishers: "0x2d3938B16A711B3e393224776b1D1da5ceCF6FE7",
      governanceV2: "0x38c55B6855050276648E44b5A621C671ca25e14e",
      governanceSlash: "0x147972F36ab3e85a0dFa18204e9F59b21B7a6C46",
      settlement: "0x9353dAb26e178cAA4103A7708b0ea63FC340F731",
      relay: "0xFDF0dD9f81d1139Cb3CBc00b2CeeDE2dCdc97173",
      pauseRegistry: "0x305303dF07C7F9E265B6EBD3b7940F6e7c8EafD4",
      timelock: "0x8b755205058F8B7162a2f362057c8a2391C948B4",
      zkVerifier: "0x31F2DE45F985E24BFb0BC833B77e557491187f3f",
      budgetLedger: "0x663F713D1AD3E3361736F6A60F623067b3A7EF6E",
      paymentVault: "0x4ad66Fd735Fe50706663023d88eB88EebF42e6dc",
      lifecycle: "0xb42280d0A3A24Be8f87aAbF261e11CEfF78d2b8a",
      attestationVerifier: "0x73C002D6cf9dFEdb6257F7c9210e04651BFeA2af",
      targetingRegistry: "0x23460C40c7EFA277551cDC7Fb2972B0aaAB03fB9",
      campaignValidator: "0x30bCC00bc3c8E6cFFDD2798861B2C9Df03d20b20",
      claimValidator: "0x616e47592Fabc4F2A94E1A2FEFd86EE86572C0C2",
      governanceHelper: "0x2567027e5a308f29aa887c4bdfaE9F8dbF19ff65",
      reports: "0x070cba0Ab1b084c5E35eF79db58916947DeF96ea",
      rateLimiter: "0xdE2d58ecd15642E2d5DaE9B0D515D3085F506C5A",
      reputation: "0xd7a60FA27349A1fF312735E84F19ed75309cCdeA",
      tokenRewardVault: "0x53439D5006Af4F542CeaC0e09B43B11Bb2B0C731",
    },
  },
  westend: {
    name: "Westend",
    chainId: 420420421,
    rpcUrl: "https://westend-asset-hub-eth-rpc.polkadot.io",
    explorerUrl: "https://blockscout-westend.polkadot.io",
    addresses: { ...EMPTY_ADDRESSES },
  },
  kusama: {
    name: "Kusama",
    chainId: 420420424,
    rpcUrl: "https://kusama-asset-hub-eth-rpc.polkadot.io",
    explorerUrl: "https://blockscout-kusama.polkadot.io",
    addresses: { ...EMPTY_ADDRESSES },
  },
  polkadotHub: {
    name: "Polkadot Hub",
    chainId: 420420416,
    rpcUrl: "https://polkadot-asset-hub-eth-rpc.polkadot.io",
    explorerUrl: "https://blockscout.polkadot.io",
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
  ipfsGateway: "https://dweb.link/ipfs/",
  pinataApiKey: "",
  ipfsProvider: "pinata",
  ipfsApiKey: "",
  ipfsApiEndpoint: "",
  theme: "dark",
};
