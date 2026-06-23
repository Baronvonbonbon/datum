// ClickRegistry batcher.
//
// SDK calls POST /click → http.mjs hands the envelope here. We
// validate + buffer; the batcher flushes either when:
//   - the buffer reaches CLICK_BATCH_SIZE clicks, OR
//   - the oldest pending click is older than CLICK_BATCH_MAX_AGE_MS
//
// On-chain there's no batch entry point — DatumClickRegistry's
// recordClick(user, campaignId, nonce) is one-shot, gated to
// msg.sender == relay. So a "batch" here is a sequence of TXs
// issued from the same nonce-managed signer with minimal pacing.
// We pace via per-TX await to avoid tx-pool churn.

import { ethers } from "ethers";
import { log } from "../logging/structured.mjs";
import { bumpCounter, recordEvent, recordTx } from "../logging/telemetry.mjs";

const ABI = [
  "function recordClick(address user, uint256 campaignId, bytes32 impressionNonce)",
];

export class ClickBatch {
  constructor({ provider, cfg, campaignPoll }) {
    this.provider = provider;
    this.cfg = cfg;
    this.campaignPoll = campaignPoll;
    this.contract = new ethers.Contract(
      cfg.addresses.clickRegistry,
      ABI,
      provider.wallet
    );
    this.pending = []; // { user, campaignId: bigint, nonce: bytes32, receivedAt }
    this._timer = null;
    this._draining = false;
  }

  start() {
    // Wake every second to enforce the max-age flush rule.
    this._timer = setInterval(() => this._maybeFlush().catch((e) =>
      log.warn("click flush failed", { err: String(e?.message ?? e) })
    ), 1000);
    this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  /** Validate + enqueue a click. */
  enqueue(claim) {
    bumpCounter("clicksReceived");
    if (!claim || typeof claim !== "object") {
      bumpCounter("clickErrors");
      return { ok: false, reason: "malformed" };
    }
    const { publisher, campaignId, slotId, href } = claim;
    let cid;
    try {
      cid = BigInt(campaignId);
    } catch {
      bumpCounter("clickErrors");
      return { ok: false, reason: "campaignId" };
    }
    if (!this.campaignPoll.hasCampaign(cid)) {
      bumpCounter("clickErrors");
      return { ok: false, reason: "not-our-campaign" };
    }
    // Preferred path: a wallet-aware client (e.g. the Datum Tavern) supplies the
    // exact `user` and a 32-byte `nonce` so it can reference the same nonce in
    // its on-chain click claim (clickSessionHash == nonce). The nonce is echoed
    // back so the client knows what to claim against.
    let user, nonce;
    if (typeof claim.user === "string" && ethers.isAddress(claim.user)
        && typeof claim.nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(claim.nonce)) {
      user = ethers.getAddress(claim.user);
      nonce = claim.nonce;
    } else {
      // Skeleton fallback: the SDK doesn't know the user's address — hash
      // (publisher, slotId, href, ts) into the nonce and use publisher as a
      // stand-in. Production wiring joins against the impression record instead.
      nonce = ethers.keccak256(
        ethers.toUtf8Bytes(`${publisher ?? ""}:${slotId ?? ""}:${href ?? ""}:${Date.now()}`)
      );
      user = typeof publisher === "string" && ethers.isAddress(publisher)
        ? publisher
        : ethers.ZeroAddress;
    }
    this.pending.push({ user, campaignId: cid, nonce, receivedAt: Date.now() });
    recordEvent("click-queued", { campaignId: cid.toString(), user });
    // Flush eagerly: at the size threshold, OR immediately for a wallet-aware
    // click so the client can settle without waiting out the max-age timer.
    const eager = typeof claim.user === "string" && ethers.isAddress(claim.user);
    if (eager || this.pending.length >= this.cfg.clickBatchSize) {
      this._drain().catch(() => {});
    }
    return { ok: true, queued: true, user, nonce };
  }

  async _maybeFlush() {
    if (this._draining || this.pending.length === 0) return;
    if (!this.provider.ready) return;
    const oldest = this.pending[0]?.receivedAt ?? Date.now();
    const tooOld = Date.now() - oldest >= this.cfg.clickBatchMaxAgeMs;
    if (this.pending.length < this.cfg.clickBatchSize && !tooOld) return;
    await this._drain();
  }

  async _drain() {
    this._draining = true;
    try {
      const batch = this.pending.splice(0, this.cfg.clickBatchSize);
      log.info("click batch flushing", { n: batch.length });
      for (const c of batch) {
        try {
          const tx = await this.contract.recordClick(c.user, c.campaignId, c.nonce);
          recordTx("click", tx.hash, true, { campaignId: c.campaignId.toString() });
          bumpCounter("clicksSubmitted");
          await tx.wait(1);
        } catch (e) {
          const msg = String(e?.message ?? e);
          bumpCounter("clickErrors");
          recordTx("click", null, false, { reason: msg.slice(0, 200) });
          log.warn("recordClick failed", { err: msg.slice(0, 240), campaignId: c.campaignId.toString() });
          // E90 = duplicate session — don't requeue, that's terminal.
          if (!msg.includes("E90")) {
            // Requeue at the tail so we don't starve newer clicks.
            this.pending.push(c);
          }
        }
      }
    } finally {
      this._draining = false;
    }
  }

  size() {
    return this.pending.length;
  }
}
