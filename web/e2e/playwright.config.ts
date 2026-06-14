import { defineConfig } from "@playwright/test";

// Live-settlement harness config. Drives the built /demo page (real
// claimBuilder/claimCore via the in-page daemon) against the LIVE Paseo deploy +
// relay. Uses the system Chrome (channel) so no browser is downloaded. Headless
// works because /demo is a normal web page (the daemon, not an MV3 extension).
//
// Point at an already-running web server with DEMO_BASE_URL to skip the built-in
// `vite dev` (which serves current source incl. the latest networks.ts addresses).
const BASE = process.env.DEMO_BASE_URL || "http://127.0.0.1:5174";

export default defineConfig({
  testDir: ".",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    channel: "chrome",
    headless: true,
    baseURL: BASE,
    actionTimeout: 30_000,
    trace: "retain-on-failure",
  },
  webServer: process.env.DEMO_BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --host 127.0.0.1 --port 5174 --strictPort",
        cwd: "..",
        url: "http://127.0.0.1:5174/",
        timeout: 180_000,
        reuseExistingServer: true,
        stdout: "ignore",
        stderr: "pipe",
      },
});
