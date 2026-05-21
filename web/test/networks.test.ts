import { describe, it, expect } from "vitest";
import {
  NETWORK_CONFIGS,
  DEFAULT_SETTINGS,
  getCurrencySymbol,
  getExplorerUrl,
  getNetworkDisplayName,
} from "../src/shared/networks";

// Snapshot of the alpha-5 Paseo deploy of 2026-05-21. If a re-deploy
// changes these, the failing test is the signal to update both
// networks.ts and this snapshot at the same time — keeps the source
// of truth aligned with the addresses the UI ships.
const ALPHA_5_KEY_ADDRESSES = {
  campaigns:           "0x34663ec5Dd63A4517eBb4C763FEE6966FfB47a2e",
  publishers:          "0xBcF1ef361020dC430eb7460aFCa66709BCbcC883",
  settlement:          "0x4745230354F48610EF905424176A81685C93F62B",
  pauseRegistry:       "0x7FF4E11716EE89c58DE46F2bA980FF6754Dac8cb",
  governanceRouter:    "0xfD25A6e7a239Fc37A57Aa99458B7Ecb24BE74d69",
  council:             "0xad191e330C1cB497844213bf81B1A5305D99F244",
  identityVerifier:    "0xA993b68f79e3B0bF00c73a12f4C71CEC0AB92E62",
  mintCoordinator:     "0xb1D9EBEcF960F326b1e521c5E61568bb881ff2CA",
  peopleChainIdentity: "0x54BDDEd50B553445c3d4b9C35b7278403d0dd7F3",
};

describe("networks: polkadotTestnet addresses", () => {
  it("matches the alpha-5 deploy snapshot for key contracts", () => {
    const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
    for (const [name, expected] of Object.entries(ALPHA_5_KEY_ADDRESSES)) {
      expect((addrs as any)[name]).toBe(expected);
    }
  });

  it("exposes the chain id Paseo's eth-rpc gateway expects", () => {
    expect(NETWORK_CONFIGS.polkadotTestnet.chainId).toBe(420420417);
  });

  it("declares pineChain so the smoldot path activates", () => {
    expect(NETWORK_CONFIGS.polkadotTestnet.pineChain).toBe("paseo-asset-hub");
  });

  it("populates the alpha-5-new optional fields", () => {
    const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
    expect(addrs.relayStake).toBeTruthy();
    expect(addrs.relayGovernance).toBeTruthy();
    expect(addrs.powEngine).toBeTruthy();
    expect(addrs.activationBonds).toBeTruthy();
    expect(addrs.stakeRoot).toBeTruthy();
    expect(addrs.stakeRootV2).toBeTruthy();
    expect(addrs.identityVerifier).toBeTruthy();
    expect(addrs.dualSig).toBeTruthy();
  });

  it("populates both blocklistCurator and councilBlocklistCurator (alias)", () => {
    const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
    expect(addrs.blocklistCurator).toBe(addrs.councilBlocklistCurator);
    expect(addrs.blocklistCurator).toBeTruthy();
  });

  it("leaves the token plane fields undefined (not yet deployed)", () => {
    const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
    expect(addrs.wrapper).toBeUndefined();
    expect(addrs.mintAuthority).toBeUndefined();
    expect(addrs.bootstrapPool).toBeUndefined();
    expect(addrs.vesting).toBeUndefined();
    expect(addrs.feeShare).toBeUndefined();
  });
});

describe("networks: other configs", () => {
  it("paseoEvm legacy alias is empty for new code paths", () => {
    expect(NETWORK_CONFIGS.paseoEvm.addresses.campaigns).toBe("");
  });

  it("local devnet has empty addresses (CI seeds them at runtime)", () => {
    expect(NETWORK_CONFIGS.local.addresses.campaigns).toBe("");
  });

  it("westend / kusama / polkadotHub have empty addresses (no deploy yet)", () => {
    expect(NETWORK_CONFIGS.westend.addresses.campaigns).toBe("");
    expect(NETWORK_CONFIGS.kusama.addresses.campaigns).toBe("");
    expect(NETWORK_CONFIGS.polkadotHub.addresses.campaigns).toBe("");
  });
});

describe("networks: helpers", () => {
  it("getCurrencySymbol returns PAS for Paseo, DOT for Hub", () => {
    expect(getCurrencySymbol("polkadotTestnet")).toBe("PAS");
    expect(getCurrencySymbol("paseoEvm")).toBe("PAS");
    expect(getCurrencySymbol("polkadotHub")).toBe("DOT");
    expect(getCurrencySymbol("kusama")).toBe("KSM");
    expect(getCurrencySymbol("westend")).toBe("WND");
  });

  it("getCurrencySymbol falls back to DOT for unknown networks", () => {
    expect(getCurrencySymbol("nonexistent" as any)).toBe("DOT");
  });

  it("getExplorerUrl returns Blockscout for Paseo", () => {
    expect(getExplorerUrl("polkadotTestnet")).toMatch(/blockscout/);
  });

  it("getNetworkDisplayName maps network keys to human-readable labels", () => {
    expect(getNetworkDisplayName("polkadotTestnet")).toBe("Paseo Testnet");
    expect(getNetworkDisplayName("polkadotHub")).toBe("Polkadot Hub");
  });
});

describe("networks: DEFAULT_SETTINGS", () => {
  it("defaults to polkadotTestnet", () => {
    expect(DEFAULT_SETTINGS.network).toBe("polkadotTestnet");
    expect(DEFAULT_SETTINGS.contractAddresses.campaigns).toBe(
      ALPHA_5_KEY_ADDRESSES.campaigns
    );
  });
});
