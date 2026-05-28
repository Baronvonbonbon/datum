/// Vitest configuration. Reuses the project's vite.config (aliases,
/// optimizeDeps, etc.) so tests resolve modules the same way the
/// production build does. Adds jsdom + setup for testing-library.

import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./test/setup.ts"],
      globals: false,
      // Exclude the alpha-5 extension source from tests — it's only
      // here for the @ext alias and its own tests live separately.
      exclude: [
        "node_modules",
        "dist",
        "../alpha-5/**",
      ],
      // The webapp's modules don't share state across tests; reset
      // the in-memory module cache between test files so singletons
      // (walletConnector, future event bus, etc.) start clean.
      isolate: true,
    },
  })
);
