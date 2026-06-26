// Localhost HTTP endpoint.
//
// /metrics, /events, /health give the /publisher dashboard a
// JSON view of relay state. /click + /claim are the SDK's POST
// targets. /bulletin/<cid> is a read-only IPFS/Bulletin gateway
// proxy — the SDK requests these to render Bulletin creatives.
//
// Server is bound to 127.0.0.1 on testnet; mainnet operators
// should add HMAC + TLS + a reverse proxy in front. That's out
// of scope here.

import { createServer } from "node:http";
import { log } from "./logging/structured.mjs";
import {
  snapshot,
  eventsSince,
  bumpCounter,
  recordEvent,
} from "./logging/telemetry.mjs";

const MAX_BODY_BYTES = 16 * 1024; // 16 KB is plenty for a click/claim envelope

export class HttpServer {
  constructor({ cfg, provider, claimQueue, clickBatch, actionAttest, withdraw, ascendSpend, ascendRecord, ascendMint, health, bulletinGateway }) {
    this.cfg = cfg;
    this.provider = provider;
    this.claimQueue = claimQueue;
    this.clickBatch = clickBatch;
    this.actionAttest = actionAttest;
    this.withdraw = withdraw;
    this.ascendSpend = ascendSpend;
    this.ascendRecord = ascendRecord;
    this.ascendMint = ascendMint;
    this.health = health;
    this.bulletinGateway = bulletinGateway;
    this._server = null;
  }

  start() {
    this._server = createServer((req, res) => {
      this._route(req, res).catch((e) => {
        log.warn("http handler threw", { url: req.url, err: String(e?.message ?? e) });
        sendJson(res, 500, { error: "internal" });
      });
    });
    this._server.listen(this.cfg.httpPort, this.cfg.httpBind, () => {
      log.info("http listening", { bind: this.cfg.httpBind, port: this.cfg.httpPort });
    });
  }

  async stop() {
    if (!this._server) return;
    await new Promise((resolve) => this._server.close(resolve));
  }

  async _route(req, res) {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/metrics") return this._metrics(res);
    if (req.method === "GET" && path === "/health") return this._health(res);
    if (req.method === "GET" && path === "/events") return this._events(url, res);
    if (req.method === "POST" && path === "/click") return this._postClick(req, res);
    if (req.method === "POST" && path === "/action-attest") return this._postActionAttest(req, res);
    if (req.method === "POST" && path === "/withdraw") return this._postWithdraw(req, res);
    if (req.method === "POST" && path === "/ascend/spend") return this._postAscendSpend(req, res);
    if (req.method === "POST" && path === "/ascend/record") return this._postAscendRecord(req, res);
    if (req.method === "POST" && path === "/ascend/mint") return this._postAscendMint(req, res);
    if (req.method === "POST" && path === "/claim") return this._postClaim(req, res);
    if (req.method === "GET" && path.startsWith("/bulletin/")) {
      const cid = decodeURIComponent(path.slice("/bulletin/".length));
      return this._bulletin(cid, res);
    }

    sendJson(res, 404, { error: "not-found" });
  }

  _metrics(res) {
    sendJson(res, 200, snapshot());
  }

  async _health(res) {
    const snap = snapshot();
    // settlement health: mis-wired / mid-migration → relay gates settlement.
    const settlement = this.health?.status() ?? { healthy: true };
    const ok =
      snap.pine.connected &&
      snap.pine.finalizedBlock > 0 &&
      snap.pine.peers >= 2 &&
      settlement.healthy !== false;
    sendJson(res, ok ? 200 : 503, {
      ok,
      pine: snap.pine,
      signer: snap.signer,
      ready: this.provider?.ready ?? false,
      settlement, // { healthy, configOk, midMigration, reason }
    });
  }

  _events(url, res) {
    const since = url.searchParams.get("since") ?? "0";
    const events = eventsSince(since);
    sendJson(res, 200, { since, count: events.length, events });
  }

  async _postClick(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, 400, { error: body.reason });
    if (!this.clickBatch) {
      // Stage 7c can run without Stage 7d; just record + ack so
      // the SDK doesn't see errors during cold boot.
      bumpCounter("clicksReceived");
      recordEvent("click-received", { campaignId: String(body.json.campaignId ?? "") });
      return sendJson(res, 202, { accepted: true, queued: false, reason: "no-batcher" });
    }
    const result = this.clickBatch.enqueue(body.json);
    sendJson(res, result.ok ? 202 : 400, result);
  }

  async _postActionAttest(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, 400, { error: body.reason });
    if (!this.actionAttest || !this.actionAttest.enabled) {
      return sendJson(res, 501, { error: "action-attest-disabled" });
    }
    try {
      const result = await this.actionAttest.attest(body.json);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (e) {
      sendJson(res, 500, { error: "attest-failed", reason: String(e?.message ?? e) });
    }
  }

  async _postWithdraw(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, 400, { error: body.reason });
    if (!this.withdraw) return sendJson(res, 503, { error: "withdraw-unavailable" });
    try {
      const result = await this.withdraw.submit(body.json);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (e) {
      sendJson(res, 500, { error: "withdraw-failed", reason: String(e?.message ?? e) });
    }
  }

  async _postAscendSpend(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, 400, { error: body.reason });
    if (!this.ascendSpend || !this.ascendSpend.enabled) return sendJson(res, 501, { error: "ascend-spend-disabled" });
    try {
      const result = await this.ascendSpend.submit(body.json);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (e) {
      sendJson(res, 500, { error: "ascend-spend-failed", reason: String(e?.message ?? e) });
    }
  }

  async _postAscendRecord(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, 400, { error: body.reason });
    if (!this.ascendRecord || !this.ascendRecord.enabled) return sendJson(res, 501, { error: "ascend-record-disabled" });
    try {
      const result = await this.ascendRecord.submit(body.json);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (e) {
      sendJson(res, 500, { error: "ascend-record-failed", reason: String(e?.message ?? e) });
    }
  }

  async _postAscendMint(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, 400, { error: body.reason });
    if (!this.ascendMint || !this.ascendMint.enabled) return sendJson(res, 501, { error: "ascend-mint-disabled" });
    try {
      const result = await this.ascendMint.submit(body.json);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (e) {
      sendJson(res, 500, { error: "ascend-mint-failed", reason: String(e?.message ?? e) });
    }
  }

  async _postClaim(req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, 400, { error: body.reason });
    if (!this.claimQueue) {
      return sendJson(res, 503, { error: "claim-queue-unavailable" });
    }
    // Refuse claims while Settlement is mis-wired / mid-migration: settling now
    // would act on an unsafe system. The publisher retries once health recovers.
    if (this.health && this.health.healthy === false) {
      return sendJson(res, 503, { error: "settlement-unhealthy", settlement: this.health.status() });
    }
    const result = this.claimQueue.enqueue(body.json);
    sendJson(res, result.ok ? 202 : 400, result);
  }

  async _bulletin(cid, res) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(cid)) {
      return sendJson(res, 400, { error: "bad-cid" });
    }
    if (!this.bulletinGateway) {
      return sendJson(res, 501, { error: "bulletin-gateway-not-configured" });
    }
    try {
      const out = await this.bulletinGateway.fetch(cid);
      res.writeHead(200, { "Content-Type": out.contentType ?? "application/octet-stream" });
      res.end(out.body);
    } catch (e) {
      sendJson(res, 502, { error: "gateway-failed", reason: String(e?.message ?? e) });
    }
  }
}

function setCors(res) {
  // Publishers will fetch /metrics from their dashboard origin.
  // CORS-* must be open for read endpoints; writes can be tighter
  // but the SDK is third-party so we permit POST too.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return resolve({ ok: false, reason: "body-too-large" });
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve({ ok: true, json });
      } catch {
        resolve({ ok: false, reason: "bad-json" });
      }
    });
    req.on("error", () => resolve({ ok: false, reason: "read-error" }));
  });
}
