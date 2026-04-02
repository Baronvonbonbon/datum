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
      // Alpha-3 (17 contracts) — deployed on Paseo 2026-03-31
      campaigns: "0xd246ede4e6BE1669fecA9731387508a1Eb5A13A3",
      publishers: "0xB280e7b3D2D9edaF8160AF6d31483d15b0C8c863",
      governanceV2: "0x2F5a0FCEf51a2bD84D71f916E8886Ee35e5139Ff",
      governanceSlash: "0xb1c63CF0f3F27E569757a627FCCc5fe07A7D6BbD",
      settlement: "0xaFF8010109249c3C8f2B5D762002b794Dd14E1d1",
      relay: "0xDa293CbF712f9FF20FF9D7a42d8E989E25E6dd09",
      pauseRegistry: "0xA6c70e86441b181c0FC2D4b3A8fC98edf34044b8",
      timelock: "0x987201735114fa0f7433A71CFdeFF79f82EB1fE2",
      zkVerifier: "0xf65c841F2CEd53802Cbd5E041e65D28d8f5eB4D8",
      budgetLedger: "0xc683899c9292981b035Cfc900aBc951A47Ed00c8",
      paymentVault: "0xF6E62B417125822b33B73757B91096ed6ebb4A2a",
      lifecycle: "0x6514C058D2De1cd00A21B63e447770780C83dbB5",
      attestationVerifier: "0xA06CAf0A21B8324f611d7Bc629abA16e9d301Fa0",
      targetingRegistry: "0x668aA4d72FF17205DE3C998da857eBaD94835219",
      campaignValidator: "0xCebC8e1E81205b368B4BF5Fc53dAeA0e0b09c08E",
      claimValidator: "0xf1fbe1dfbD78a8E5317001721749382EdB50294a",
      governanceHelper: "0x96c974e7733dc6f570Ae96800d6cc3604A2EA3B9",
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
