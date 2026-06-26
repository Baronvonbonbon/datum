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
import { RelayProvider } from "./provider.mjs";
import { CampaignPoll } from "./poll/campaigns.mjs";
import { ClaimQueue } from "./poll/claims.mjs";
import { IdentityRequestPoll } from "./poll/identityRequests.mjs";
import { HttpServer } from "./http.mjs";
import { ClickBatch } from "./submit/clickRegistry.mjs";
import { ActionAttest } from "./submit/actionAttest.mjs";
import { Withdraw } from "./submit/withdraw.mjs";
import { AscendSpend } from "./submit/ascendSpend.mjs";
import { StakeRootCron } from "./submit/stakeRootV2.mjs";
import { HealthGate } from "./health.mjs";

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

  // Stage 7b — pine provider + polling primitives.
  const provider = new RelayProvider(cfg);
  await provider.start();

  // Health gate — the relay refuses to submit settlements while Settlement is
  // mis-wired (validateConfiguration == false) or mid-migration. Submit
  // pipelines below MUST consult `health.healthy` before sending. Fails closed.
  const health = new HealthGate({ provider, cfg, log });
  await health.checkOnce();
  if (!health.healthy) {
    log.warn("settlement unhealthy at boot — settlement submission gated until it recovers", health.status());
  }
  health.start();

  const campaignPoll = new CampaignPoll(provider, cfg);
  await campaignPoll.start();

  const claimQueue = new ClaimQueue(campaignPoll);

  const identityPoll = new IdentityRequestPoll(provider, cfg, ({ user }) => {
    // Stage 7d will hand off to submit/identityOracle. For now we
    // just observe.
    log.trace("identity refresh observed", { user });
  });
  await identityPoll.start();

  // Stage 7d — submit pipelines.
  const clickBatch = new ClickBatch({ provider, cfg, campaignPoll });
  clickBatch.start();

  // Optional type-2 action attestation signer (enabled when ACTION_VERIFIER_KEY is set).
  const actionAttest = new ActionAttest({ provider, cfg, campaignPoll });

  // Gasless withdraw submitter (the relay pays gas for user-signed cash-outs).
  const withdraw = new Withdraw({ provider, cfg });

  // Ascend (roguelike) gasless shop-spend submitter (enabled when ASCEND_BANK_ADDRESS is set).
  const ascendSpend = new AscendSpend({ provider, cfg });

  const stakeRootCron = new StakeRootCron({ provider, cfg });
  stakeRootCron.start();

  // Stage 7c — localhost HTTP endpoint.
  const http = new HttpServer({
    cfg,
    provider,
    claimQueue,
    clickBatch,
    actionAttest,
    withdraw,
    ascendSpend,
    health, // /health reflects settlement config + migration state
    bulletinGateway: null, // out-of-scope for the skeleton
  });
  http.start();

  log.info("relay running", {
    activeCampaigns: campaignPoll.snapshot().active.length,
    claimQueue: claimQueue.size(),
    clickQueue: clickBatch.size(),
  });

  let shutdownInProgress = false;
  const shutdown = async (reason) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    log.info("shutdown requested", { reason, snapshot: snapshot() });
    try {
      await http.stop();
      stakeRootCron.stop();
      clickBatch.stop();
      identityPoll.stop();
      campaignPoll.stop();
      health.stop();
      await provider.stop();
    } catch (e) {
      log.warn("shutdown cleanup error", { err: String(e?.message ?? e) });
    }
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown("SIGINT"); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
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
