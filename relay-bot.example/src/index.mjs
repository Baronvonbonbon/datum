// Relay-bot entrypoint.
//
// Boot order:
//   1. Load .env and resolve config.
//   2. Initialize structured logger.
//   3. Wire signal handlers (SIGINT / SIGTERM → graceful shutdown).
//   4. (7b) Start pine provider, wait for peers ≥ 2 && finalizedHead != 0.
//   5. (7b) Spawn the polling primitives (campaigns, claims,
//      identity refresh requests) and submit batchers.
//   6. (7c) Open the localhost HTTP endpoint (/metrics, /events,
//      /health, /click, /bulletin/<cid>).
//
// This Stage-7a skeleton intentionally stops at step 3 — it boots,
// logs its config, advertises the planned wiring, then waits for
// SIGINT. The provider + submitters + HTTP endpoints arrive in
// Stages 7b, 7c, and 7d.

import "dotenv/config";
import { loadConfig } from "./config.mjs";
import { log, setLogLevel } from "./logging/structured.mjs";
import { snapshot } from "./logging/telemetry.mjs";

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    process.stderr.write(`startup: ${e.message}\n`);
    process.exit(1);
  }
  setLogLevel(cfg.logLevel);

  log.info("relay-bot starting", {
    network: cfg.network,
    pineChain: cfg.pineChain,
    httpBind: cfg.httpBind,
    httpPort: cfg.httpPort,
    settlementBatchSize: cfg.settlementBatchSize,
    clickBatchSize: cfg.clickBatchSize,
    stakeRootIntervalBlocks: cfg.stakeRootIntervalBlocks,
  });
  log.info("addresses loaded", {
    settlement: cfg.addresses.settlement,
    clickRegistry: cfg.addresses.clickRegistry,
    stakeRootV2: cfg.addresses.stakeRootV2,
    peopleChainIdentity: cfg.addresses.peopleChainIdentity,
  });

  // Stages 7b/7c/7d hook in here. The current skeleton just idles
  // so an operator can confirm config loads cleanly and the
  // systemd unit stays Active before any submission machinery is
  // wired up.
  log.warn("relay running in skeleton mode — no submitters wired", {
    next_stages: ["7b: pine provider", "7c: HTTP endpoints", "7d: submitters"],
  });

  let shutdownInProgress = false;
  const shutdown = (reason) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    log.info("shutdown requested", { reason, snapshot: snapshot() });
    // Stages 7b+ add: await pine.disconnect(), close HTTP, drain queues.
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException", { err: String(err?.stack ?? err) });
    process.exit(2);
  });
  process.on("unhandledRejection", (err) => {
    log.error("unhandledRejection", { err: String(err?.stack ?? err) });
    process.exit(2);
  });

  // Keep the event loop alive in skeleton mode.
  await new Promise(() => {});
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
  process.exit(2);
});
