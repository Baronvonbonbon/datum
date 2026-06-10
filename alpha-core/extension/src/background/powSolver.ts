// #5: Caller-side wrapper around the PoW Web Worker. Solves a claim's powNonce
// before submission. Falls back to inline solving when Worker is unavailable
// (some MV3 environments restrict workers in service-worker contexts).
//
// Strategy:
//   1. Try to spawn the worker (may fail under MV3 SW).
//   2. If worker works, dispatch claim hashes and receive nonces async.
//   3. If worker doesn't work, run a small synchronous loop in the SW —
//      acceptable because the target is "easy band" for normal users
//      (~256 hashes ≈ <10ms even sync).
//
// Per #5 design: target is read from Settlement.powTargetForUser(user, eventCount)
// before each claim's solve.

import { keccak256, solidityPacked, toBeHex } from "ethers";

const MAX_ITERS_DEFAULT = 1 << 24; // 16M

/** Synchronous fallback solver. Use when Workers are unavailable or for tiny searches. */
export function solvePowSync(claimHash: string, target: bigint, maxIters = MAX_ITERS_DEFAULT): string | null {
  for (let i = 0; i < maxIters; i++) {
    const nonceHex = toBeHex(i, 32);
    const h = BigInt(keccak256(solidityPacked(["bytes32", "bytes32"], [claimHash, nonceHex])));
    if (h <= target) return nonceHex;
  }
  return null;
}

/**
 * Solve PoW for a claim. Tries the Web Worker first, falls back to sync on failure.
 * Returns the bytes32 powNonce hex string, or null if budget exhausted.
 */
export async function solvePow(claimHash: string, target: bigint, maxIters = MAX_ITERS_DEFAULT): Promise<string | null> {
  // Worker path
  try {
    if (typeof Worker !== "undefined") {
      return await solveViaWorker(claimHash, target, maxIters);
    }
  } catch {
    // fall through to sync
  }
  return solvePowSync(claimHash, target, maxIters);
}

function solveViaWorker(claimHash: string, target: bigint, maxIters: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      // The bundler emits powWorker.ts as a separate chunk via new URL(import.meta.url).
      // Webpack 5 picks this up automatically as a worker entry.
      worker = new Worker(new URL("./powWorker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      reject(err);
      return;
    }
    const timeout = setTimeout(() => {
      try { worker.postMessage({ abort: true }); } catch { /* noop */ }
      worker.terminate();
      resolve(null);
    }, 60_000); // 60s hard ceiling — anything longer is a misconfigured difficulty

    worker.onmessage = (e: MessageEvent) => {
      clearTimeout(timeout);
      worker.terminate();
      const r = e.data;
      if (r && r.powNonce) resolve(r.powNonce);
      else resolve(null);
    };
    worker.onerror = (err) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(err);
    };
    worker.postMessage({ claimHash, target: target.toString(), maxIters });
  });
}
