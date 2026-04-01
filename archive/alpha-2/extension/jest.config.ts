import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  moduleNameMapper: {
    "^@shared/(.*)$": "<rootDir>/src/shared/$1",
    // Map .js extension imports to bare module name (ESM → CJS in Jest)
    "^(@noble/hashes)/blake2\\.js$": "$1/blake2.js",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", {
      tsconfig: "tsconfig.test.json",
      diagnostics: {
        // Only type-check test files, not source (source validated by tsc/webpack)
        exclude: ["**/src/**"],
      },
    }],
    // Transform @noble/hashes ESM packages
    "^.+node_modules/@noble/hashes/.+\\.js$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  transformIgnorePatterns: [
    "/node_modules/(?!@noble/hashes/)",
  ],
};

export default config;
