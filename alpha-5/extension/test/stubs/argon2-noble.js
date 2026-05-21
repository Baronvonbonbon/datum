// Test-only stub for `@noble/hashes/argon2.js`.
//
// @noble/hashes ships ESM-only; ts-jest can't load the package's `.js`
// entrypoint from its CJS test harness, and we don't want to add
// babel-jest just to transform one tiny dependency.
//
// Production code (loaded by webpack) gets the real Argon2id via
// proper ESM resolution. Tests use this stub, which substitutes a
// PBKDF2-SHA256 implementation built on Node's Web Crypto. The
// envelope shape (32-byte key) is identical, so end-to-end vault
// encrypt → persist → decrypt round-trips work the same way; only
// the KDF hardness differs (and tests don't exercise that property).
//
// Function signature matches @noble/hashes:
//   argon2idAsync(password: Uint8Array, salt: Uint8Array, opts: { m, t, p, dkLen }) → Uint8Array

const ITERATIONS = 1000; // fast — tests are not benchmarking hardness

async function argon2idAsync(password, salt, opts) {
  const dkLen = opts?.dkLen ?? 32;
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    password,
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    key,
    dkLen * 8
  );
  return new Uint8Array(bits);
}

module.exports = {
  argon2idAsync,
  // The other exports aren't used by our code but expose them in case
  // a future import lands.
  argon2id: argon2idAsync,
  argon2dAsync: argon2idAsync,
  argon2iAsync: argon2idAsync,
};
