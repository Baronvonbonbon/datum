// Polls DatumCampaigns for the relay-managed campaign set.
//
// The relay needs to know which campaigns it is the relay-signer
// for so it can:
//   - drop incoming claims for campaigns it doesn't relay
//   - prefer matching settlement bundles by publisher
//   - surface the active set on /metrics
//
// We don't enumerate every campaign — instead we react to the
// CampaignCreated and CampaignRelaySignerSet events scoped to
// our signer address and maintain a Set<bigint> of active ids.

import { ethers } from "ethers";
import { log } from "../logging/structured.mjs";
import { recordEvent } from "../logging/telemetry.mjs";

const POLL_INTERVAL_MS = 6000; // one block on Asset Hub

const CAMPAIGNS_ABI = [
  "event CampaignCreated(uint256 indexed id, address indexed advertiser, address indexed publisher)",
  "event CampaignRelaySignerSet(uint256 indexed id, address indexed signer)",
  "function getCampaign(uint256 id) view returns (address advertiser, address publisher, uint8 status)",
];

export class CampaignPoll {
  constructor(provider, cfg) {
    this.provider = provider;
    this.cfg = cfg;
    this.contract = new ethers.Contract(
      cfg.addresses.campaigns,
      CAMPAIGNS_ABI,
      provider.reader
    );
    this.active = new Set(); // campaign ids the relay manages
    this._cursor = 0;
    this._timer = null;
  }

  async start() {
    // Anchor cursor to the current finalized head so backfill
    // doesn't replay the full history on a cold start.
    this._cursor = await this.provider.reader.getBlockNumber();
    log.info("campaign poll started", { from: this._cursor });
    this._timer = setInterval(() => this._tick().catch((e) =>
      log.warn("campaign poll tick failed", { err: String(e?.message ?? e) })
    ), POLL_INTERVAL_MS);
    this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  hasCampaign(id) {
    return this.active.has(BigInt(id));
  }

  snapshot() {
    return { active: [...this.active].map((id) => id.toString()), cursor: this._cursor };
  }

  async _tick() {
    const head = await this.provider.reader.getBlockNumber();
    if (head <= this._cursor) return;
    const from = this._cursor + 1;
    const to = head;
    const signer = (await this.provider.wallet.getAddress()).toLowerCase();

    const filterRelay = this.contract.filters.CampaignRelaySignerSet(null, signer);
    const filterCreated = this.contract.filters.CampaignCreated();
    const [relayLogs, createdLogs] = await Promise.all([
      this.contract.queryFilter(filterRelay, from, to),
      this.contract.queryFilter(filterCreated, from, to),
    ]);

    for (const ev of relayLogs) {
      const id = BigInt(ev.args[0]);
      this.active.add(id);
      recordEvent("campaign-relay-set", { campaignId: id.toString(), block: ev.blockNumber });
      log.info("campaign assigned to relay", { campaignId: id.toString() });
    }
    // CampaignCreated alone doesn't imply relay — the publisher
    // sets a relay signer separately. We still record the event
    // for /metrics, but don't add to the active set.
    for (const ev of createdLogs) {
      const id = BigInt(ev.args[0]);
      recordEvent("campaign-created", { campaignId: id.toString(), block: ev.blockNumber });
    }

    this._cursor = head;
  }
}
