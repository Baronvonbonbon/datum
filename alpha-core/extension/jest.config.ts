import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  moduleNameMapper: {
    "^@shared/(.*)$": "<rootDir>/src/shared/$1",
    // @noble/hashes 2.x ships ESM-only and Jest's CJS test harness can't
    // load it. Swap in a PBKDF2-backed stub for tests; production code
    // (webpack) still gets the real Argon2id via proper ESM resolution.
    "^@noble/hashes/argon2\\.js$": "<rootDir>/test/stubs/argon2-noble.js",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", {
      tsconfig: "tsconfig.test.json",
      diagnostics: {
        // Only type-check test files, not source (source validated by tsc/webpack)
        exclude: ["**/src/**"],
      },
    }],
  },
};

export default config;
