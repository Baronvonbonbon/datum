// /identity/zk — identity ZK proof tooling observatory.
//
// The DatumIdentityVerifier is a Groth16 verifier for the identity
// ZK circuit (separate from the impression ZK in DatumZKVerifier).
// Operators read the verifying-key hash + recent VerifyingKeySet
// events to confirm the on-chain VK matches off-chain artifacts.
//
// This page is read-only. Actual proof generation lives in the
// extension (it holds the witness for the user's identity); the
// webapp surface is just the verifier-side state + history.

import { useEffect, useMemo, useState } from "react";
import { id as ethersId, Interface } from "ethers";
import { useLogs } from "../../hooks/useLogs";
import { TelemetryStatus } from "../../components/TelemetryStatus";
import { callContract } from "../../lib/contractRead";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_ALL = 14_400 * 365;

const TOPIC_VK_SET = ethersId("VerifyingKeySet(bytes32)");

const VERIFIER_IFACE = new Interface([
  "event VerifyingKeySet(bytes32 indexed vkHash)",
]);

const READ_ABI = [
  "function getVK() view returns (tuple(uint256[2] alpha, uint256[2][2] beta, uint256[2][2] gamma, uint256[2][2] delta, uint256[2][] ic))",
];

type SetEvent = { vkHash: string; block: number };

export function IdentityZk() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
  const verifier = addrs.identityVerifier;

  if (!verifier) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Identity ZK
        </h1>
        <div style={{ color: "var(--text-muted)", marginTop: 16 }}>
          DatumIdentityVerifier isn't deployed on this network.
        </div>
      </div>
    );
  }

  const [vkErr, setVkErr] = useState<string | null>(null);
  const [hasVk, setHasVk] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await callContract({ address: verifier, abi: READ_ABI, method: "getVK" });
        if (!cancelled) setHasVk(true);
      } catch (e: any) {
        if (!cancelled) {
          // Most verifiers revert `vk-not-set` until the deploy script
          // calls setVerifyingKey. Treat any revert as "not yet set."
          setHasVk(false);
          const msg = String(e?.message ?? e);
          if (!msg.toLowerCase().includes("revert")) setVkErr(msg);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [verifier]);

  const opts = useMemo(
    () => ({
      address: verifier.toLowerCase(),
      topic0: TOPIC_VK_SET,
      windowBlocks: WINDOW_ALL,
      historyAllowed: true,
    }),
    [verifier]
  );
  const logs = useLogs(opts);

  const events = useMemo<SetEvent[]>(() => {
    return logs.logs
      .map((log) => {
        try {
          VERIFIER_IFACE.decodeEventLog("VerifyingKeySet", log.data, log.topics);
          return {
            vkHash: log.topics[1] ?? "0x",
            block: Number(BigInt(log.blockNumber)),
          };
        } catch {
          return null;
        }
      })
      .filter((r): r is SetEvent => r !== null)
      .sort((a, b) => b.block - a.block);
  }, [logs.logs]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Identity ZK
        </h1>
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Groth16 verifier for the identity circuit. Proof generation
          lives in the DATUM extension (it holds the witness); this
          page surfaces the on-chain verifier state and key history.
        </div>
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            marginTop: 6,
            fontFamily: "var(--font-mono, ui-monospace)",
          }}
        >
          Verifier {verifier.toLowerCase()}
        </div>
        <div style={{ marginTop: 6 }}>
          <TelemetryStatus viaRpc={logs.viaRpc} truncatedTo={logs.truncatedTo} hideWhileLoading />
        </div>
      </header>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          Verifying key
        </h2>
        {vkErr ? (
          <div style={{ color: "var(--error)", fontSize: 11 }}>{vkErr}</div>
        ) : hasVk === null ? (
          <div style={{ color: "var(--text-muted)" }}>Checking…</div>
        ) : hasVk ? (
          <div
            style={{
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              background: "var(--bg-surface)",
              color: "var(--ok)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            ✓ Verifying key set
          </div>
        ) : (
          <div
            style={{
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              background: "var(--bg-surface)",
              color: "var(--warn)",
              fontSize: 13,
            }}
          >
            ⚠ Verifying key not set — deploy script's setVK step hasn't
            run yet. ZK proofs will revert until this is fixed.
          </div>
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          VK history
        </h2>
        {!logs.ready ? (
          <div style={{ color: "var(--text-muted)" }}>Syncing…</div>
        ) : events.length === 0 ? (
          <div style={{ color: "var(--text-muted)" }}>
            No VerifyingKeySet events on record.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {events.map((e, i) => (
              <div
                key={i}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  background: "var(--bg-surface)",
                  padding: "10px 12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <div style={{ color: "var(--text-strong)", fontSize: 13, fontWeight: 600 }}>
                  VK set at block {e.block}{i === 0 ? "  (current)" : ""}
                </div>
                <div
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono, ui-monospace)",
                  }}
                >
                  hash {e.vkHash}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
