import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  normalizeMnemonic,
  wordCountForStrength,
} from "../src/background/wallet/mnemonic";
import { deriveAccount, deriveAddress, pathForAccount } from "../src/background/wallet/derivation";

describe("wallet/mnemonic", () => {
  describe("generateMnemonic", () => {
    it("returns a 12-word phrase by default", () => {
      const phrase = generateMnemonic();
      expect(phrase.split(" ")).toHaveLength(12);
    });

    it("returns a 24-word phrase at 256-bit strength", () => {
      const phrase = generateMnemonic(256);
      expect(phrase.split(" ")).toHaveLength(24);
    });

    it("emits a valid BIP-39 checksum", () => {
      for (let i = 0; i < 5; i++) {
        const phrase = generateMnemonic();
        expect(validateMnemonic(phrase)).toBe(phrase);
      }
    });

    it("returns different phrases on repeat calls", () => {
      const a = generateMnemonic();
      const b = generateMnemonic();
      expect(a).not.toBe(b);
    });
  });

  describe("validateMnemonic", () => {
    it("accepts a known-good phrase", () => {
      const phrase =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      expect(validateMnemonic(phrase)).toBe(phrase);
    });

    it("accepts the phrase normalized (extra spaces, casing)", () => {
      const phrase =
        "  Abandon abandon\tabandon  abandon abandon abandon abandon abandon abandon abandon abandon about\n";
      expect(validateMnemonic(phrase)).toBe(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
      );
    });

    it("rejects an invalid checksum", () => {
      // 11 abandons + bicycle is wrong-checksum for "about" at index 11.
      const phrase =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon bicycle";
      expect(validateMnemonic(phrase)).toBeNull();
    });

    it("rejects a phrase of the wrong length", () => {
      expect(validateMnemonic("abandon abandon abandon")).toBeNull();
    });

    it("rejects a phrase with unknown words", () => {
      expect(
        validateMnemonic(
          "xxxx abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        )
      ).toBeNull();
    });
  });

  describe("normalizeMnemonic + wordCountForStrength", () => {
    it("normalize collapses whitespace + lowercases", () => {
      expect(normalizeMnemonic("  HELLO\tWORLD\n")).toBe("hello world");
    });

    it("wordCount mapping", () => {
      expect(wordCountForStrength(128)).toBe(12);
      expect(wordCountForStrength(256)).toBe(24);
    });
  });

  describe("mnemonicToSeed", () => {
    it("returns a 64-byte seed for the BIP-39 test vector", () => {
      // Standard BIP-39 test vector: empty passphrase, 12 abandons + about.
      const phrase =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      const seed = mnemonicToSeed(phrase, "");
      expect(seed).toBeInstanceOf(Uint8Array);
      expect(seed.length).toBe(64);
      const hex = Array.from(seed, (b) => b.toString(16).padStart(2, "0")).join("");
      // Expected from BIP-39 spec.
      expect(hex).toBe(
        "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
      );
    });

    it("differs with a BIP-39 passphrase", () => {
      const phrase =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      const seedNoPassphrase = mnemonicToSeed(phrase);
      const seedWithPassphrase = mnemonicToSeed(phrase, "TREZOR");
      expect(seedNoPassphrase).not.toEqual(seedWithPassphrase);
    });
  });
});

describe("wallet/derivation", () => {
  // BIP-39 standard test vector → known address for m/44'/60'/0'/0/0.
  const phrase =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  it("pathForAccount", () => {
    expect(pathForAccount(0)).toBe("m/44'/60'/0'/0/0");
    expect(pathForAccount(5)).toBe("m/44'/60'/0'/0/5");
  });

  it("rejects negative or non-integer indices", () => {
    expect(() => pathForAccount(-1)).toThrow();
    expect(() => pathForAccount(1.5)).toThrow();
  });

  it("deriveAccount produces the expected MetaMask-compatible address for index 0", () => {
    const account = deriveAccount(phrase, "", 0);
    // Well-known MetaMask test vector for the standard phrase.
    expect(account.address.toLowerCase()).toBe(
      "0x9858effd232b4033e47d90003d41ec34ecaeda94"
    );
  });

  it("deriveAddress matches deriveAccount.address", () => {
    expect(deriveAddress(phrase, "", 0).toLowerCase()).toBe(
      "0x9858effd232b4033e47d90003d41ec34ecaeda94"
    );
    expect(deriveAddress(phrase, "", 1).toLowerCase()).toBe(
      "0x6fac4d18c912343bf86fa7049364dd4e424ab9c0"
    );
  });

  it("different account indices produce different addresses", () => {
    const a0 = deriveAddress(phrase, "", 0);
    const a1 = deriveAddress(phrase, "", 1);
    expect(a0).not.toBe(a1);
  });
});
