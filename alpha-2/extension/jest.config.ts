import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  moduleNameMapper: {
    "^@shared/(.*)$": "<rootDir>/src/shared/$1",
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
