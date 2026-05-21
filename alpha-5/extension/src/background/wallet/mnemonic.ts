// BIP-39 mnemonic helpers.
//
// Thin wrapper over ethers v6 `Mnemonic`. Centralizes the strength
// choices (12 vs 24 words), the optional BIP-39 passphrase (25th word),
// and the seed-derivation step so the rest of the wallet code doesn't
// need to know which library backs it.
//
// All functions here are pure — no side effects, no I/O. The seed
// returned by `mnemonicToSeed` is sensitive material; the caller (the
// offscreen wallet host) is responsible for keeping it in memory only
// while the vault is unlocked.

import { Mnemonic } from "ethers";

/// BIP-39 strength in bits. 128 → 12 words, 256 → 24 words.
/// We default to 12 because the extra entropy of 24 words exceeds
/// what's useful against any realistic attacker, and 12 is easier for
/// users to back up. Power users can opt into 24 at generate time.
export type MnemonicStrength = 128 | 256;

/// Number of words for a given strength. Used for UI rendering and
/// validation when the user types in a phrase.
export function wordCountForStrength(strength: MnemonicStrength): 12 | 24 {
  return strength === 256 ? 24 : 12;
}

/// Generate a fresh BIP-39 mnemonic at the given strength.
/// Uses ethers' internal crypto.getRandomValues call to source entropy.
export function generateMnemonic(strength: MnemonicStrength = 128): string {
  // ethers expects entropy as a hex string. Pull from Web Crypto so the
  // call is identical in service-worker, offscreen, and popup contexts.
  const byteCount = strength / 8;
  const entropy = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(entropy);
  const hex = "0x" + Array.from(entropy, (b) => b.toString(16).padStart(2, "0")).join("");
  return Mnemonic.fromEntropy(hex).phrase;
}

/// Validate that `phrase` is a syntactically valid BIP-39 mnemonic for
/// our supported strengths (12 or 24 words). Does NOT do checksum-only
/// validation — invalid checksum still throws inside ethers' parser.
/// Returns `null` on any failure (invalid checksum, wrong word count,
/// unknown words, etc.) so callers can render a clean error.
export function validateMnemonic(phrase: string): string | null {
  const normalized = normalizeMnemonic(phrase);
  const wordCount = normalized.split(" ").length;
  if (wordCount !== 12 && wordCount !== 24) return null;
  try {
    // ethers throws on bad checksum / unknown words.
    const m = Mnemonic.fromPhrase(normalized);
    return m.phrase;
  } catch {
    return null;
  }
}

/// Collapse whitespace + lowercase so the user can paste with extra
/// spacing, casing variation, or trailing newlines and we still
/// recognize the phrase. BIP-39 word lists are lowercase ASCII.
export function normalizeMnemonic(phrase: string): string {
  return phrase
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/// Convert a validated mnemonic + optional passphrase to a 64-byte seed
/// per BIP-39. The seed is the input to BIP-32 derivation.
/// Throws if `phrase` is invalid; callers should call `validateMnemonic`
/// first when the input comes from the user.
export function mnemonicToSeed(phrase: string, passphrase: string = ""): Uint8Array {
  const m = Mnemonic.fromPhrase(normalizeMnemonic(phrase), passphrase);
  // ethers returns the seed as a 0x-prefixed hex string.
  const hex = m.computeSeed();
  return hexToBytes(hex);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
