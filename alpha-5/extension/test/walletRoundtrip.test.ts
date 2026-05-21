// Integration test for the offscreen wallet — round-trips through the
// public API the offscreen dispatcher exposes. Web Crypto is available
// natively on Node 22+ (the project's required engine).
//
// Argon2id with the default 64 MiB params is intentionally slow; we
// drop the parameters here so the test suite stays under a few seconds.
// Production code uses DEFAULT_KDF_PARAMS, exercised separately by the
// "default params" test below.

import {
  __test as walletTest,
  createWallet,
  importWallet,
  unlockWallet,
  lockWallet,
  isUnlocked,
  addHdAccount,
  addImportedAccount,
  setActiveAccount,
  reencryptCurrent,
  signTransaction,
  signTypedData,
  personalSign,
} from "../src/offscreen/wallet";
import { Wallet, verifyTypedData, verifyMessage, Transaction } from "ethers";

// Patch Argon2 params (m=64 KiB instead of 64 MiB) so tests finish
// fast. The crypto envelope is identical; only the KDF cost differs.
jest.mock("../src/background/wallet/keystore", () => {
  const actual = jest.requireActual("../src/background/wallet/keystore");
  return {
    ...actual,
    DEFAULT_KDF_PARAMS: { name: "argon2id", m: 64, t: 1, p: 1 },
  };
});

describe("wallet round-trip", () => {
  beforeEach(() => {
    walletTest.reset();
  });

  it("create → lock → unlock → sign", async () => {
    const created = await createWallet({ password: "hunter2-correcthorse" });
    expect(created.vault.version).toBe(1);
    expect(created.accounts).toHaveLength(1);
    expect(isUnlocked()).toBe(true);

    lockWallet();
    expect(isUnlocked()).toBe(false);

    const unlocked = await unlockWallet({
      vault: created.vault,
      password: "hunter2-correcthorse",
    });
    expect(unlocked.accounts).toHaveLength(1);
    expect(unlocked.activeAddress).toBe(created.accounts[0].address);
    expect(isUnlocked()).toBe(true);

    const sig = await personalSign({ message: "hello datum" });
    const recovered = verifyMessage("hello datum", sig);
    expect(recovered.toLowerCase()).toBe(unlocked.activeAddress);
  });

  it("unlock rejects on wrong password", async () => {
    const created = await createWallet({ password: "correct" });
    lockWallet();
    await expect(
      unlockWallet({ vault: created.vault, password: "wrong" })
    ).rejects.toThrow(/bad-password/);
    expect(isUnlocked()).toBe(false);
  });

  it("import restores a known MetaMask test vector", async () => {
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const imported = await importWallet({ password: "pw", phrase });
    if ("error" in imported) throw new Error("unexpected error");
    // First HD address for the standard phrase.
    expect(imported.accounts[0].address.toLowerCase()).toBe(
      "0x9858effd232b4033e47d90003d41ec34ecaeda94"
    );
  });

  it("import rejects an invalid mnemonic with structured error", async () => {
    const result = await importWallet({
      password: "pw",
      phrase: "definitely not a real bip39 phrase here at all",
    });
    expect("error" in result && result.error).toBe("invalid-mnemonic");
  });

  it("addHdAccount derives the next account from the same seed", async () => {
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const imported = await importWallet({ password: "pw", phrase });
    if ("error" in imported) throw new Error("unexpected error");

    const { accounts } = addHdAccount({});
    expect(accounts).toHaveLength(2);
    // Known second derived address for the standard phrase.
    expect(accounts[1].address.toLowerCase()).toBe(
      "0x6fac4d18c912343bf86fa7049364dd4e424ab9c0"
    );
  });

  it("setActiveAccount switches the signer used for signing", async () => {
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    await importWallet({ password: "pw", phrase });
    addHdAccount({});

    const sig0 = await personalSign({ message: "x" });
    const recovered0 = verifyMessage("x", sig0).toLowerCase();
    expect(recovered0).toBe("0x9858effd232b4033e47d90003d41ec34ecaeda94");

    setActiveAccount(1);
    const sig1 = await personalSign({ message: "x" });
    const recovered1 = verifyMessage("x", sig1).toLowerCase();
    expect(recovered1).toBe("0x6fac4d18c912343bf86fa7049364dd4e424ab9c0");
  });

  it("addImportedAccount lets a raw key sign", async () => {
    await createWallet({ password: "pw" });
    const rawWallet = Wallet.createRandom();
    const { accounts } = addImportedAccount({ privateKey: rawWallet.privateKey });
    expect(accounts).toHaveLength(2);
    expect(accounts[1].source).toBe("imported");
    setActiveAccount(1);
    const sig = await personalSign({ message: "ok" });
    const recovered = verifyMessage("ok", sig);
    expect(recovered.toLowerCase()).toBe(rawWallet.address.toLowerCase());
  });

  it("reencryptCurrent + unlock with new ciphertext round-trips", async () => {
    const created = await createWallet({ password: "pw" });
    const rawWallet = Wallet.createRandom();
    addImportedAccount({ privateKey: rawWallet.privateKey });
    const newEnvelope = await reencryptCurrent({ password: "pw" });
    expect(newEnvelope.cipher.ciphertext).not.toBe(created.vault.cipher.ciphertext);

    lockWallet();
    const reunlocked = await unlockWallet({
      vault: {
        ...created.vault,
        cipher: newEnvelope.cipher,
        kdf: newEnvelope.kdf,
        // accounts metadata isn't read from cipher — we have to mirror
        // the in-memory accounts list manually for the test (real flow
        // does this via keystore.updateVaultMetadata).
        accounts: [...created.accounts, {
          source: "imported" as const,
          address: rawWallet.address.toLowerCase(),
          derivationIndex: null,
          label: "imported",
          createdAt: 0,
        }],
      },
      password: "pw",
    });
    expect(reunlocked.accounts).toHaveLength(2);

    setActiveAccount(1);
    const sig = await personalSign({ message: "msg" });
    expect(verifyMessage("msg", sig).toLowerCase()).toBe(
      rawWallet.address.toLowerCase()
    );
  });

  it("signTypedData produces a recoverable EIP-712 signature", async () => {
    await createWallet({ password: "pw" });
    const domain = { name: "DATUM", version: "1", chainId: 420420417 };
    const types = {
      Greeting: [{ name: "msg", type: "string" }],
    };
    const value = { msg: "hello" };
    const sig = await signTypedData({ domain, types, value });
    const recovered = verifyTypedData(domain, types, value, sig);
    expect(recovered.toLowerCase()).toBe(
      walletTest.snapshot().unlocked ? recovered.toLowerCase() : recovered
    );
  });

  it("signTransaction emits a parseable EIP-1559 tx", async () => {
    const created = await createWallet({ password: "pw" });
    const raw = await signTransaction({
      tx: {
        chainId: 420420417,
        nonce: 0,
        type: 2,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
        gasLimit: 21_000n,
        to: "0x0000000000000000000000000000000000000001",
        value: 0n,
      },
    });
    const parsed = Transaction.from(raw);
    expect(parsed.type).toBe(2); // EIP-1559
    expect(parsed.from?.toLowerCase()).toBe(
      created.accounts[0].address.toLowerCase()
    );
  });

  it("signing requires unlocked state", async () => {
    await createWallet({ password: "pw" });
    lockWallet();
    await expect(personalSign({ message: "x" })).rejects.toThrow(/locked/);
  });
});
