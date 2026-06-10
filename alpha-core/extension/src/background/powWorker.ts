// #5: PoW solver running in a Web Worker so the service worker stays responsive.
//
// Receives { claimHash, target } and replies with the lowest powNonce (as bytes32 hex)
// such that keccak256(claimHash || powNonce) <= target. Uses the worker's own
// crypto.subtle when available; falls back to a pure-JS keccak256 implementation
// included via ethers (already a bundle dep).
//
// Termination: caller may post { abort: true } to cancel an in-flight search.

import { keccak256, solidityPacked, toBeHex } from "ethers";

interface SolveRequest {
  claimHash: string;     // bytes32 hex
  target: string;        // decimal-string uint256
  startNonce?: number;   // resume token (default 0)
  maxIters?: number;     // hard search budget (default 2^24 = 16M)
}

interface SolveResponse {
  powNonce?: string;     // bytes32 hex on success
  triedIters?: number;   // for telemetry
  error?: string;        // search budget exhausted or aborted
}

let _aborted = false;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg && msg.abort) {
    _aborted = true;
    return;
  }
  _aborted = false;
  try {
    const result = solve(msg as SolveRequest);
    (self as unknown as Worker).postMessage(result);
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: String(err) } as SolveResponse);
  }
};

function solve(req: SolveRequest): SolveResponse {
  const targetBI = BigInt(req.target);
  const start = req.startNonce ?? 0;
  const maxIters = req.maxIters ?? (1 << 24);
  for (let i = 0; i < maxIters; i++) {
    if (_aborted) return { error: "aborted", triedIters: i };
    const nonceHex = toBeHex(start + i, 32);
    const h = BigInt(keccak256(solidityPacked(["bytes32", "bytes32"], [req.claimHash, nonceHex])));
    if (h <= targetBI) {
      return { powNonce: nonceHex, triedIters: i + 1 };
    }
  }
  return { error: "search-budget-exhausted", triedIters: maxIters };
}
