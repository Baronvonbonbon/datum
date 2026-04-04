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
      // Alpha-3 (19 contracts) — deployed on Paseo 2026-04-04
      campaigns: "0x9f327495b396d0F903BD100687ff05BcabA33109",
      publishers: "0x9B1e56799b84FCeAc10501C99aC56c631C256621",
      governanceV2: "0x87666cf232CbD4c84eF241BE9A724e4b31B5A0b8",
      governanceSlash: "0xcf7C1159c08FFaFC5B084db372DA13D009204266",
      settlement: "0x70D61a0bEc3999fBAff76C374E7014a1d69B7a9e",
      relay: "0x8048C3F0110243c3A18f5bB420D76169357a13d3",
      pauseRegistry: "0x5437AB7C64d8BB85A7CB727edAaa74641F325249",
      timelock: "0xE274b452c0555Ae3b8C26FE8EBcA473A6b672Db9",
      zkVerifier: "0x68A307E1fbCE630e6Ee877a398B729D88003c635",
      budgetLedger: "0xA1dCaDdFdCa9CCB8b12D14A7E96f95E0c5B63d2b",
      paymentVault: "0xe69bF9fb563519Fe846DCf746dc408f9F31bD7bA",
      lifecycle: "0xc2968C1A6417f697E9CE160863308054B5846B96",
      attestationVerifier: "0x7BD8aE65557acBf4bb2f26AFB9ed0F087AA09B74",
      targetingRegistry: "0x6a3bDd8d4ff574319bEfCD5d5d735499eeC11e8A",
      campaignValidator: "0xBEE7d8A4FC5d76d0E52418764D091fBb71fDA3F2",
      claimValidator: "0xdAfD255086f993B82cd556199a38F4227B870DD6",
      governanceHelper: "0xc85CC80b3daaA05b0b9FfED5Bc5E30EA04c1d8A2",
      reports: "0x78DaE8f647623C72284ACeD43D58Ba62cAffE329",
      rateLimiter: "0x4C80144a1d282b456c56F8c82B5E0FE805d539ed",
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
