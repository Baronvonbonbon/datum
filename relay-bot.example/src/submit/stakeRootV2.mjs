// StakeRootV2 reporter cron.
//
// Every STAKE_ROOT_INTERVAL_BLOCKS the cron computes the current
// publisher-stake merkle root, picks a snapshot block in the
// valid recency window, and calls proposeRoot. Approval is
// permissionless among the bonded reporter set; approve + finalize
// happen via separate flows handled by other reporters.
//
// Root computation is the open question — alpha-5 stakes live in
// DatumPublisherStake, but the canonical leaf encoding is being
// finalized in the StakeRootV2 reporter spec. This module exposes
// a `computeRoot(snapshotBlock)` hook that the operator overrides
// to plug in the real computation. The skeleton ships a
// deterministic placeholder so the cron mechanics can be tested
// end-to-end without committing to the leaf format.
//
// Retry: on transient failure (network, nonce churn, "not active
// reporter") we back off exponentially up to 5 retries inside the
// same interval; if all retries fail the interval is dropped and
// we wait for the next tick.

import { ethers } from "ethers";
import { log } from "../logging/structured.mjs";
import {
  bumpCounter,
  recordEvent,
  recordTx,
  setLastStakeRootEpoch,
} from "../logging/telemetry.mjs";

const ABI = [
  "function proposeRoot(uint256 epoch, uint64 snapshotBlock, bytes32 root) payable",
  "function latestEpoch() view returns (uint256)",
  "function proposerBond() view returns (uint256)",
  "function SNAPSHOT_MIN_AGE() view returns (uint64)",
  "function SNAPSHOT_MAX_AGE() view returns (uint64)",
];

const MAX_RETRIES = 5;

export class StakeRootCron {
  constructor({ provider, cfg, computeRoot }) {
    this.provider = provider;
    this.cfg = cfg;
    this.computeRoot = computeRoot ?? defaultComputeRoot;
    if (!cfg.addresses.stakeRootV2) {
      log.warn("stakeRootV2 absent — cron disabled");
      this.contract = null;
    } else {
      this.contract = new ethers.Contract(
        cfg.addresses.stakeRootV2,
        ABI,
        provider.wallet
      );
    }
    this._timer = null;
    this._lastTickBlock = 0;
  }

  start() {
    if (!this.contract) return;
    // Trigger an immediate first attempt, then poll every block.
    this._timer = setInterval(() => this._tick().catch((e) =>
      log.warn("stake-root tick failed", { err: String(e?.message ?? e) })
    ), 6000);
    this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async _tick() {
    if (!this.provider.ready) return;
    const head = await this.provider.reader.getBlockNumber();
    if (head - this._lastTickBlock < this.cfg.stakeRootIntervalBlocks) return;

    try {
      await this._submitOnce(head);
      this._lastTickBlock = head;
    } catch (e) {
      // _submitOnce internally exhausts retries; if it throws here
      // the interval is effectively dropped — we'll try again
      // STAKE_ROOT_INTERVAL_BLOCKS later.
      bumpCounter("stakeRootErrors");
      log.error("stake-root: interval dropped", { err: String(e?.message ?? e) });
      this._lastTickBlock = head;
    }
  }

  async _submitOnce(head) {
    const [latestEpoch, minAge, maxAge, proposerBond] = await Promise.all([
      this.contract.latestEpoch(),
      this.contract.SNAPSHOT_MIN_AGE(),
      this.contract.SNAPSHOT_MAX_AGE(),
      this.contract.proposerBond(),
    ]);
    // Snapshot block: as fresh as the contract allows, so we have
    // the longest window of validity before the proposal expires.
    const snapshotBlock = BigInt(head) - BigInt(minAge);
    if (snapshotBlock <= 0n) throw new Error("head-too-low");
    const epoch = BigInt(latestEpoch) + 1n;

    const root = await this.computeRoot(this.provider, snapshotBlock);
    if (!root || !/^0x[0-9a-fA-F]{64}$/.test(root)) {
      throw new Error("computeRoot returned invalid root");
    }

    log.info("stake-root: proposing", {
      epoch: epoch.toString(),
      snapshotBlock: snapshotBlock.toString(),
      minAge: minAge.toString(),
      maxAge: maxAge.toString(),
      proposerBond: proposerBond.toString(),
      root,
    });

    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const tx = await this.contract.proposeRoot(epoch, snapshotBlock, root, {
          value: proposerBond,
        });
        recordTx("stake-root-propose", tx.hash, true, { epoch: epoch.toString() });
        await tx.wait(1);
        bumpCounter("stakeRootsPosted");
        setLastStakeRootEpoch(epoch.toString());
        recordEvent("stake-root-posted", { epoch: epoch.toString(), root });
        log.info("stake-root: posted", { epoch: epoch.toString(), hash: tx.hash });
        return;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message ?? e);
        // E64 means our epoch is stale — another reporter beat us.
        // No point retrying with the same epoch; bail.
        if (msg.includes("E64")) {
          log.info("stake-root: epoch already posted", { epoch: epoch.toString() });
          return;
        }
        bumpCounter("stakeRootErrors");
        const backoff = Math.min(60_000, 1000 * 2 ** attempt);
        log.warn("stake-root: retry", { attempt, backoff, err: msg.slice(0, 240) });
        await sleep(backoff);
      }
    }
    recordTx("stake-root-propose", null, false, { reason: String(lastErr?.message ?? lastErr) });
    throw lastErr;
  }
}

/**
 * Default placeholder root computer. Returns the keccak256 of
 * "snapshot-<block>" so the cron mechanics can run end-to-end on
 * a testnet without committing to the alpha-5 leaf format. The
 * call site is expected to override with a real implementation
 * before posting on a contested network.
 *
 * Real implementations:
 *   - enumerate active publishers from DatumPublisherStake events
 *   - read each publisher's balanceAt(snapshotBlock)
 *   - merkleize (address, balance) leaves with keccak256-pair
 *   - return the merkle root
 */
async function defaultComputeRoot(_provider, snapshotBlock) {
  return ethers.keccak256(ethers.toUtf8Bytes(`snapshot-${snapshotBlock}`));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
