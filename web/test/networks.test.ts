import { describe, it, expect } from "vitest";
import {
  NETWORK_CONFIGS,
  DEFAULT_SETTINGS,
  getCurrencySymbol,
  getExplorerUrl,
  getNetworkDisplayName,
} from "../src/shared/networks";

// Snapshot of the live alpha-core Paseo deploy (ALPHA_5_PASEO in networks.ts).
// If a re-deploy changes these, the failing test is the signal to update both
// networks.ts (incl. DEPLOY_VERSION) and this snapshot at the same time — keeps
// the source of truth aligned with the addresses the UI ships.
const ALPHA_5_KEY_ADDRESSES = {
  campaigns:           "0xE0C1C18af2532af8b36E8DfB7A67A78744BdB07F",
  publishers:          "0x86776018850b61c1e9202d73F031993818c33173",
  settlement:          "0x7832E3c00643992d0811dd866d543A84Cff7Eb9f",
  pauseRegistry:       "0x36e4Ae11e7c3D3b19795Af191ec72FF8567E2eC3",
  governanceRouter:    "0xCcaE1A080D24e62962d7e830Db61709C1967F6D0",
  council:             "0xe2EDCbb22D04B283Df571f9478AF80A610892f60",
  identityVerifier:    "0xA8EF5A85fAe0F5B6a4D8077DA68e2bd4153e9697",
  mintCoordinator:     "0x648B0329Dc5e50ab6A73bEcE8F6F2C8F14C4F98D",
  peopleChainIdentity: "0xd6d3dEf54E359E8E828876C8b95B3062908F998d",
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
