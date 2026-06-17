// Settlement health gate — the relay must NOT submit settlements while the
// system is mis-wired or mid-migration. Submit pipelines consult `gate.healthy`
// before sending; the /health endpoint surfaces the latest state.
//
// Two signals:
//   1. validateConfiguration() == true  — Settlement's refs are all wired.
//   2. NOT mid-migration. Subtlety: `migrated == false` alone is ambiguous — a
//      freshly-deployed GENESIS contract has migrated == false forever (it was
//      never a migration TARGET). The mid-migration signal is
//      `migrationSource != 0 && migrated == false` (matches the webapp's
//      web/src/lib/migrationGuard.ts). Genesis contracts are healthy.
import { ethers } from "ethers";

const ZERO = "0x0000000000000000000000000000000000000000";
const HEALTH_ABI = [
  "function validateConfiguration() view returns (bool ok, string reason)",
  "function migrated() view returns (bool)",
  "function migrationSource() view returns (address)",
];

export async function checkSettlementHealth(reader, settlementAddr) {
  const c = new ethers.Contract(settlementAddr, HEALTH_ABI, reader);

  let configOk = true, reason = "";
  try {
    const res = await c.validateConfiguration();
    configOk = Array.isArray(res) ? Boolean(res[0]) : Boolean(res);
    reason = (Array.isArray(res) ? res[1] : "") ?? "";
  } catch { /* older ABI without validateConfiguration — skip this signal */ }

  let midMigration = false;
  try {
    const [migrated, source] = await Promise.all([c.migrated(), c.migrationSource()]);
    midMigration = source.toLowerCase() !== ZERO && migrated === false;
  } catch { /* not a Upgradable surface (reads throw) — treat as live */ }

  return { healthy: configOk && !midMigration, configOk, midMigration, reason };
}

// Periodic gate. Pipelines that mutate on-chain state MUST check `.healthy`
// before submitting. Fails closed: any read error → unhealthy → settles deferred.
export class HealthGate {
  constructor({ provider, cfg, log, intervalMs = 30_000 }) {
    this.provider = provider; this.cfg = cfg; this.log = log;
    this.intervalMs = intervalMs; this.healthy = false; this._last = null; this._timer = null;
  }
  async checkOnce() {
    try {
      const r = await checkSettlementHealth(this.provider.reader, this.cfg.addresses.settlement);
      if (this._last === null || r.healthy !== this.healthy) {
        (r.healthy ? this.log.info : this.log.warn)("settlement health", r);
      }
      this.healthy = r.healthy; this._last = r;
    } catch (e) {
      this.healthy = false;
      this.log.warn("health check failed — gating settlement", { err: String(e?.message ?? e) });
    }
    return this.healthy;
  }
  start() { this.checkOnce(); this._timer = setInterval(() => this.checkOnce(), this.intervalMs); this._timer.unref?.(); }
  stop() { if (this._timer) clearInterval(this._timer); }
  status() { return this._last ?? { healthy: this.healthy, configOk: false, midMigration: false, reason: "no-check-yet" }; }
}
