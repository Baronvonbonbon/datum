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
  campaigns:           "0x1Fe36fE7A096C6CfF9C9F55f02A1Cce1a44DE3c6",
  publishers:          "0x357606eB86A75A88Aef257dB161C25fc10714183",
  settlement:          "0xA81766522Ea4e11bd9374Cd2b0A8a66Ac7b98dB8",
  pauseRegistry:       "0xac7f7c6B36887a487b63421e4D7A6aD54da40e91",
  governanceRouter:    "0x44F8e4ceD19c767932F5540229C0454eAf2a695e",
  council:             "0x4c0981d4b2521903Dcb8dc1B3D4C280DE063546d",
  identityVerifier:    "0x77850A7490C6CE65AB936d1Bba58baf6f33d8c50",
  mintCoordinator:     "0xeD00bD4ac8b4f0Fa40710226Bd56a17D60a18350",
  peopleChainIdentity: "0xCF44b939a03ae511a880020428505a9bc68e76ff",
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
