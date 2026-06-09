// Incoming-claim queue.
//
// The publisher SDK + extension POST signed claims to the relay's
// `/claim` HTTP endpoint (Stage 7c surface). This module exposes
// the queue datastructure + a drain hook that the settlement
// submitter (Stage 7d) calls.
//
// Claims are validated up-front (signature, deadline, the
// campaign is in our relay-managed set) so the submitter never
// sees garbage. Invalid claims are dropped with a structured
// log line and a counter bump.

import { ethers } from "ethers";
import { log } from "../logging/structured.mjs";
import { bumpCounter, recordEvent } from "../logging/telemetry.mjs";

const MAX_QUEUE = 5000;

export class ClaimQueue {
  constructor(campaignPoll) {
    this.campaignPoll = campaignPoll;
    this.queue = []; // FIFO of validated SignedClaimBatch envelopes
  }

  size() {
    return this.queue.length;
  }

  /**
   * Validate + enqueue a posted claim. Caller is the HTTP
   * endpoint; we treat the input as untrusted.
   * @returns { ok: boolean, reason?: string }
   */
  enqueue(claim) {
    bumpCounter("claimsReceived");
    if (this.queue.length >= MAX_QUEUE) {
      bumpCounter("claimErrors");
      return { ok: false, reason: "queue-full" };
    }
    if (!claim || typeof claim !== "object") {
      bumpCounter("claimErrors");
      return { ok: false, reason: "malformed" };
    }
    // SLIM (#2): envelope now carries firstNonce (the replay anchor, == on-chain
    // lastNonce+1) and slim claims; the submitter forwards these to
    // DatumRelay.settleClaimsFor. See docs/relay-bot-template + OFFCHAIN-SLIM-PORTING.md.
    const required = ["user", "campaignId", "firstNonce", "claimsHash", "deadline", "userSig"];
    for (const k of required) {
      if (claim[k] === undefined) {
        bumpCounter("claimErrors");
        return { ok: false, reason: `missing:${k}` };
      }
    }
    let campaignId;
    try {
      campaignId = BigInt(claim.campaignId);
    } catch {
      bumpCounter("claimErrors");
      return { ok: false, reason: "campaignId" };
    }
    if (!this.campaignPoll.hasCampaign(campaignId)) {
      bumpCounter("claimErrors");
      return { ok: false, reason: "not-our-campaign" };
    }
    const deadline = Number(claim.deadline);
    if (!Number.isFinite(deadline) || deadline < Date.now() / 1000) {
      bumpCounter("claimErrors");
      return { ok: false, reason: "expired" };
    }
    if (!ethers.isAddress(claim.user)) {
      bumpCounter("claimErrors");
      return { ok: false, reason: "user" };
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(claim.claimsHash)) {
      bumpCounter("claimErrors");
      return { ok: false, reason: "claimsHash" };
    }

    this.queue.push({ ...claim, receivedAt: Date.now() });
    recordEvent("claim-enqueued", { campaignId: campaignId.toString(), user: claim.user });
    return { ok: true };
  }

  /**
   * Drain up to `n` claims for the settlement submitter. The
   * submitter is responsible for re-enqueueing on retry.
   */
  drain(n) {
    const out = this.queue.splice(0, n);
    if (out.length) log.trace("drained claims", { n: out.length });
    return out;
  }
}
