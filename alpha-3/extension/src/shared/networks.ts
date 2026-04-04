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
};

export const NETWORK_CONFIGS: Record<
  NetworkName,
  { rpcUrl: string; addresses: ContractAddresses }
> = {
  local: {
    rpcUrl: "http://localhost:8545",
    addresses: { ...EMPTY_ADDRESSES },
  },
  polkadotTestnet: {
    rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
    addresses: {
      // Alpha-3 (20 contracts) — deployed on Paseo 2026-04-04 (v4: security fixes + S12 blocklist)
      campaigns:           "0xe28B053c6A6428Bb2D095e24c0AA0735145656B3",
      publishers:          "0xC0B5794A401C392116b14f6c682423130C0e689a",
      governanceV2:        "0xE318338b5c1D4d7DAD25CDd4E8B300b42129A930",
      governanceSlash:     "0x9152be906c27e12e20CD66574dDB067eFA306294",
      settlement:          "0xE1454CCD97b7F752617c90d29939f34C6D4d5f95",
      relay:               "0x143e6A59D4eeF103F417fC45cf685fD876023e19",
      pauseRegistry:       "0x9c65f8919Dca88d260637C015DC47f45993D36dD",
      timelock:            "0x0959e8Fb600D559EB0162A0aef560DB0fe87F3a4",
      zkVerifier:          "0xCaFCA05eE6f837c2F8e597f1a1dfe13b05463bF1",
      budgetLedger:        "0x4Dd3cad6fFF40d5bFd8cCf1f9b83aE2168DF38A3",
      paymentVault:        "0x850C12410eCf6733D5CF2C33861f23b6816c950B",
      lifecycle:           "0x1948A518F5F7412DAbeF0273a2755a0D510D23bC",
      attestationVerifier: "0x447ECc8bbA06F02A71a073f8ae2260FCb128A337",
      targetingRegistry:   "0x5E3D299bfB83B0E6dE54D6943e9c54e1bdf00676",
      campaignValidator:   "0x77EFC1B9a04cDF92610A567202Ac7F37e769a5f8",
      claimValidator:      "0x8Bf6C34A797C5bD919213493655C4A90E3Bb131e",
      governanceHelper:    "0xdDC82a51f33820Bdd92b26380eD797ed60d332Fa",
      reports:             "0x0bf309ba45aE61dEF6398AAE161E72770E6027CA",
      rateLimiter:         "0x5C128CCF8795394Ad2411b76CD9d8f158d6929F8",
      reputation:          "", // BM-8/BM-9 — deploy pending
    },
  },
  westend: {
    rpcUrl: "https://westend-asset-hub-eth-rpc.polkadot.io",
    addresses: { ...EMPTY_ADDRESSES },
  },
  kusama: {
    rpcUrl: "https://kusama-asset-hub-eth-rpc.polkadot.io",
    addresses: { ...EMPTY_ADDRESSES },
  },
  polkadotHub: {
    rpcUrl: "https://polkadot-asset-hub-eth-rpc.polkadot.io",
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
