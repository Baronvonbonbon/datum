import { describe, it, expect } from "vitest";
import {
  NETWORK_CONFIGS,
  DEFAULT_SETTINGS,
  getCurrencySymbol,
  getExplorerUrl,
  getNetworkDisplayName,
} from "../src/shared/networks";

// Snapshot of the alpha-core Paseo full redeploy of 2026-06-11. If a re-deploy
// changes these, the failing test is the signal to update both networks.ts
// (incl. DEPLOY_VERSION) and this snapshot at the same time — keeps the source
// of truth aligned with the addresses the UI ships.
const ALPHA_5_KEY_ADDRESSES = {
  campaigns:           "0xC781D6d4Ce0567466A31c6ec50E336df42b2D346",
  publishers:          "0xBc161945d7bdBCbfa419ee70956f7Fe67A1940CD",
  settlement:          "0x477B92F0e938326Fa4D0F8533C6F7F6D7B0D70ee",
  pauseRegistry:       "0xC9871944fabbb182602B1d2f626Fde868a155065",
  governanceRouter:    "0xAb22653cDcA7214636708721AeDAc289E8635e80",
  council:             "0x239e8c0bEbb5Fb5BC38da72dD51eac3f6e3b1b59",
  identityVerifier:    "0x26F5719e21Af2F9a5130b353438fD25Fc69064C8",
  mintCoordinator:     "0x561E47cEB7F3D42a96D468b94F6e3F2B25eA07cC",
  peopleChainIdentity: "0x317e14E122DC93349b5eCEAB9F073410d66165e6",
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

  it("populates the token plane fields (deployed in the 2026-06-11 redeploy)", () => {
    const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
    expect(addrs.wrapper).toBeTruthy();
    expect(addrs.mintAuthority).toBeTruthy();
    expect(addrs.vesting).toBeTruthy();
    expect(addrs.feeShare).toBeTruthy();
    // bootstrapPool was not part of this deploy — stays undefined.
    expect(addrs.bootstrapPool).toBeUndefined();
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
