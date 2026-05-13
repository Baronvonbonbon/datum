// Per-admin-page lock-state strip.
//
// Renders one row per lockable ref on the contract: current state + (when
// the connected wallet is the owner) a "Lock now" button. Used across every
// admin page that controls one or more lockX one-way switches.
//
// Each lock is described as a tuple:
//   { label, contractAddr, getter, locker, requireOwner? }
// where:
//   - `getter`   is the name of the bool view exposing the current state
//                (e.g. "plumbingLocked", "bootstrapped", "whitelistModeLocked")
//   - `locker`   is the function name to call to lock (e.g. "lockPlumbing")
//                — pass `null` to render read-only (no action button).

import { useEffect, useState } from "react";
import { Contract } from "ethers";
import { useWallet } from "../context/WalletContext";
import { useTx } from "../hooks/useTx";
import { useToast } from "../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { useContracts } from "../hooks/useContracts";

export interface LockEntry {
  /** Human label, e.g. "Plumbing refs", "Whitelist mode". */
  label: string;
  /** Contract address (zero / empty = lock entry hidden). */
  contractAddr: string;
  /** Name of the bool getter exposing the current locked state. */
  getter: string;
  /** Name of the function to call to lock; null = read-only display. */
  locker: string | null;
  /** Optional human description shown under the label. */
  description?: string;
}

interface Props {
  /** Lock entries to display. Sorted in render order. */
  entries: LockEntry[];
  /** Optional title for the strip; defaults to "Lock state". */
  title?: string;
}

const BOOL_ABI = [
  "function owner() view returns (address)",
];

export function LockStateStrip({ entries, title = "Lock state" }: Props) {
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [states, setStates] = useState<Record<string, boolean | null>>({});
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const next: Record<string, boolean | null> = {};
    const nextOwners: Record<string, string> = {};
    await Promise.all(
      entries.map(async (e) => {
        if (!e.contractAddr || e.contractAddr === "0x0000000000000000000000000000000000000000") {
          next[keyOf(e)] = null;
          return;
        }
        try {
          const abi = [`function ${e.getter}() view returns (bool)`, ...BOOL_ABI];
          const c = new Contract(e.contractAddr, abi, contracts.readProvider);
          const [val, own] = await Promise.all([
            c[e.getter]().catch(() => null),
            c.owner().catch(() => ""),
          ]);
          next[keyOf(e)] = val === null ? null : Boolean(val);
          nextOwners[keyOf(e)] = String(own ?? "").toLowerCase();
        } catch {
          next[keyOf(e)] = null;
        }
      }),
    );
    setStates(next);
    setOwners(nextOwners);
  }

  useEffect(() => {
    refresh();
  }, [JSON.stringify(entries.map(keyOf))]); // eslint-disable-line react-hooks/exhaustive-deps

  async function doLock(e: LockEntry) {
    if (!signer || !e.locker) return;
    try {
      setBusy(keyOf(e));
      const abi = [`function ${e.locker}()`];
      const c = new Contract(e.contractAddr, abi, signer);
      const tx = await c[e.locker]();
      await confirmTx(tx);
      push(`${e.label} locked`, "success");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setBusy(null);
    }
  }

  const visible = entries.filter((e) => states[keyOf(e)] !== null || !!e.contractAddr);
  if (visible.length === 0) return null;

  return (
    <div style={{
      marginBottom: 20,
      padding: 12,
      border: "1px solid var(--border)",
      borderRadius: 4,
      background: "var(--bg-elev)",
    }}>
      <h3 style={{ color: "var(--text-strong)", fontSize: 13, fontWeight: 600, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {title}
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {visible.map((e) => {
          const k = keyOf(e);
          const locked = states[k];
          const isOwner = address && owners[k] && owners[k] === address.toLowerCase();
          const canLock = !locked && e.locker && isOwner;
          return (
            <div key={k} style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>{e.label}</span>
                {e.description && (
                  <span style={{ color: "var(--text-muted)", fontSize: 11, marginLeft: 8 }}>· {e.description}</span>
                )}
              </div>
              <StatusPill locked={locked} />
              {canLock && (
                <button
                  className="nano-btn nano-btn-danger"
                  style={{ padding: "3px 10px", fontSize: 11 }}
                  onClick={() => doLock(e)}
                  disabled={busy !== null}
                >
                  {busy === k ? "Locking..." : "Lock now"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function keyOf(e: LockEntry): string {
  return `${e.contractAddr}::${e.getter}`;
}

function StatusPill({ locked }: { locked: boolean | null }) {
  if (locked === null) {
    return <span style={{ fontSize: 11, color: "var(--text-muted)", padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 2 }}>unknown</span>;
  }
  if (locked) {
    return <span style={{ fontSize: 11, color: "#fff", padding: "2px 8px", borderRadius: 2, background: "var(--accent-dim, #555)" }}>locked</span>;
  }
  return <span style={{ fontSize: 11, color: "var(--text)", padding: "2px 8px", borderRadius: 2, border: "1px solid var(--border)" }}>unlocked</span>;
}
