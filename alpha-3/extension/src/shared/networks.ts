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
  reports: "",
  rateLimiter: "",
  reputation: "",
  tokenRewardVault: "",
  publisherStake: "",
  challengeBonds: "",
  publisherGovernance: "",
  nullifierRegistry: "",
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
      // Alpha-3 v8 — 26 contracts (full FP) redeployed on Paseo 2026-04-20
      campaigns:           "0x3CBa9E154C7ee369496a66Ea18119702E6D69F03",
      publishers:          "0x2d3938B16A711B3e393224776b1D1da5ceCF6FE7",
      governanceV2:        "0x56ed8CA43E6F992aA3Ff3eB42dEAaB1DfBe0ae83",
      governanceSlash:     "0x1428533537E81F2988ce8Ae09D48Ea4C84069b2B",
      settlement:          "0x76653aF142011a1d58e6cA02e98E689d475e7823",
      relay:               "0xFA649AdfDcC12fE2aA2b80E3e1A76E4751402F06",
      pauseRegistry:       "0x305303dF07C7F9E265B6EBD3b7940F6e7c8EafD4",
      timelock:            "0x8b755205058F8B7162a2f362057c8a2391C948B4",
      zkVerifier:          "0x31F2DE45F985E24BFb0BC833B77e557491187f3f",
      budgetLedger:        "0x663F713D1AD3E3361736F6A60F623067b3A7EF6E",
      paymentVault:        "0xD51ce700B0cF51DA3E8385681ACB1c10c2407f20",
      lifecycle:           "0xF055Ac11e29aa075fEd7b85053014F57e0FB34E3",
      attestationVerifier: "0xb7fD46F20Ed92d86d7F3a9F529D6aC354Da34585",
      targetingRegistry:   "0x23460C40c7EFA277551cDC7Fb2972B0aaAB03fB9",
      campaignValidator:   "0x30bCC00bc3c8E6cFFDD2798861B2C9Df03d20b20",
      claimValidator:      "0xB60BbCB71B9aF440B0B585222702288749ef46BC",
      governanceHelper:    "0xd4E3585285b9B16084308bdd081055F72D45b920",
      reports:             "0x5731262EC3fcdbe69c57c401F1aBe5b11A80956b",
      rateLimiter:         "0xdE2d58ecd15642E2d5DaE9B0D515D3085F506C5A",
      reputation:          "0xD753A0E58EbA05D7A80Be2b74c73E4b2F8876774",
      tokenRewardVault:    "0x6a6e613d2401103c0c1D17FFD2Ecd2Bb534d2886",
      publisherStake:      "0x19fcA6d61ECD39414Be361d3E98E49a8789F821F",
      challengeBonds:      "0xAb5882D9B25bda105B09a3A5848868f352eaE11B",
      publisherGovernance: "0xe1720D4e77F6544dabB9338C5B219C918027011D",
      nullifierRegistry:   "0xdd61AB14b9b6950498172d2bA156A18103b98254",
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
