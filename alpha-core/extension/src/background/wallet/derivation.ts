// BIP-32 / BIP-44 derivation helpers for Ethereum-compatible accounts.
//
// Path: m/44'/60'/0'/0/N where N is the account index.
//   - 44'  → BIP-44 purpose
//   - 60'  → Ethereum coin type (pallet-revive on Polkadot Hub is
//            Ethereum-compatible, so this is the correct coin type)
//   - 0'   → first BIP-44 account
//   - 0    → external chain (vs change=1)
//   - N    → 0-indexed account
//
// Pure functions; the only state is the integer index. Imported keys
// (raw secp256k1 0x-private-key strings) bypass derivation entirely
// and are stored alongside HD accounts under a `source: "imported"`
// flag — `derivationPath` is `null` for those.

import { HDNodeWallet, Mnemonic } from "ethers";

/// Standard Ethereum BIP-44 root path. New HD accounts derive from
/// this with a trailing index appended.
export const ETH_BIP44_ROOT = "m/44'/60'/0'/0";

/// Compute the full path for the Nth HD account.
export function pathForAccount(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`invalid account index: ${index}`);
  }
  return `${ETH_BIP44_ROOT}/${index}`;
}

/// Derive an `HDNodeWallet` for the Nth HD account from a mnemonic.
/// Used by the offscreen wallet host to materialize signing keys on
/// demand. The returned wallet holds the raw private key in memory;
/// callers should drop the reference as soon as signing completes.
export function deriveAccount(
  phrase: string,
  passphrase: string,
  index: number
): HDNodeWallet {
  const m = Mnemonic.fromPhrase(phrase, passphrase);
  return HDNodeWallet.fromMnemonic(m, pathForAccount(index));
}

/// Derive just the public address for an account index. Convenience for
/// listing accounts in the popup UI without spinning up the full signer.
/// Doesn't drop the private key from memory — call this from contexts
/// that already hold the seed (offscreen). For an unlocked-state read,
/// prefer `deriveAccount(...).address` so the lifetime is explicit.
export function deriveAddress(
  phrase: string,
  passphrase: string,
  index: number
): string {
  return deriveAccount(phrase, passphrase, index).address;
}
