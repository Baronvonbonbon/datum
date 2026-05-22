// Watches DatumPeopleChainIdentity for IdentityRefreshRequested
// events. When this relay-bot is configured as the oracle
// reporter, the identity-oracle submitter (Stage 7d sibling) acts
// on each request — fetching the latest People-Chain attestation
// (over XCM in real deploys, or via the bonded reporter on
// testnet) and calling submitAttestation back on the cache.
//
// This module is a pure event watcher. The submit side is
// deferred to submit/identityOracle.mjs.

import { ethers } from "ethers";
import { log } from "../logging/structured.mjs";
import { recordEvent } from "../logging/telemetry.mjs";

const POLL_INTERVAL_MS = 6000;

const IDENTITY_ABI = [
  "event IdentityRefreshRequested(address indexed user, address indexed requester)",
];

export class IdentityRequestPoll {
  constructor(provider, cfg, onRequest) {
    this.provider = provider;
    this.cfg = cfg;
    this.onRequest = onRequest;
    this._cursor = 0;
    this._timer = null;
    if (!cfg.addresses.peopleChainIdentity) {
      log.warn("identityRequests: peopleChainIdentity absent, watcher disabled");
      this.contract = null;
    } else {
      this.contract = new ethers.Contract(
        cfg.addresses.peopleChainIdentity,
        IDENTITY_ABI,
        provider.reader
      );
    }
  }

  async start() {
    if (!this.contract) return;
    this._cursor = await this.provider.reader.getBlockNumber();
    log.info("identity refresh poll started", { from: this._cursor });
    this._timer = setInterval(() => this._tick().catch((e) =>
      log.warn("identity poll tick failed", { err: String(e?.message ?? e) })
    ), POLL_INTERVAL_MS);
    this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async _tick() {
    const head = await this.provider.reader.getBlockNumber();
    if (head <= this._cursor) return;
    const from = this._cursor + 1;
    const to = head;
    const events = await this.contract.queryFilter(
      this.contract.filters.IdentityRefreshRequested(),
      from,
      to
    );
    for (const ev of events) {
      const user = String(ev.args[0]);
      const requester = String(ev.args[1]);
      recordEvent("identity-refresh-requested", {
        user,
        requester,
        block: ev.blockNumber,
      });
      log.info("identity refresh requested", { user, requester, block: ev.blockNumber });
      try {
        await this.onRequest?.({ user, requester, block: ev.blockNumber });
      } catch (e) {
        log.warn("onRequest threw", { err: String(e?.message ?? e), user });
      }
    }
    this._cursor = head;
  }
}
