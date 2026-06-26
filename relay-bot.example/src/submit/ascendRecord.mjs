// Ascend run-record submitter (leaderboard + bones).
//
// When an Ascend run ends, the player signs an EIP-712 `Record(player,depth,
// won,nonce,deadline)` on the AscendLedger domain; this relay submits
// AscendLedger.recordBySig (paying gas). Address from cfg.ascendLedger or
// ASCEND_LEDGER_ADDRESS.

import { ethers } from "ethers";
import { log } from "../logging/structured.mjs";
import { bumpCounter, recordEvent } from "../logging/telemetry.mjs";

const ABI = ["function recordBySig(address player, uint16 depth, bool won, uint256 deadline, bytes sig)"];

export class AscendRecord {
  constructor({ provider, cfg }) {
    this.provider = provider;
    const addr = cfg.ascendLedger || process.env.ASCEND_LEDGER_ADDRESS;
    this.enabled = !!addr && ethers.isAddress(addr);
    this.contract = this.enabled ? new ethers.Contract(addr, ABI, provider.wallet) : null;
  }

  async submit(body) {
    if (!this.enabled) return { ok: false, reason: "ascend-ledger-unconfigured" };
    bumpCounter("ascendRecordsReceived");
    const { player, depth, won, deadline, sig } = body || {};
    if (!ethers.isAddress(player)) return { ok: false, reason: "invalid-player" };
    if (!Number.isInteger(depth) || depth < 0 || depth > 65535) return { ok: false, reason: "invalid-depth" };
    if (typeof won !== "boolean") return { ok: false, reason: "invalid-won" };
    if (typeof sig !== "string" || sig.length < 130) return { ok: false, reason: "invalid-sig" };

    const tx = await this.contract.recordBySig(player, depth, won, deadline, sig);
    await tx.wait(1);
    bumpCounter("ascendRecordsSubmitted");
    recordEvent("ascend-record", { player, depth, won });
    log.info("ascend run recorded", { player: player.slice(0, 10), depth, won, tx: tx.hash });
    return { ok: true, txHash: tx.hash };
  }
}
