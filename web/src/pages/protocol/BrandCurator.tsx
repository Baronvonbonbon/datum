// /protocol/brand-curator — Council-managed brand verification + revocation.
//
// Mirrors the TagCurator pattern: render the council pointer + lock state,
// list the most recent approvals/revocations from event logs, and give the
// connected wallet (when it's the curator owner) a one-way Lock Council
// control. Approvals + revocations are emitted by the Council's
// propose+vote+execute pipeline — this page is observational + lock-only.

import { useEffect, useMemo, useState } from "react";
import { Interface, id as ethersId } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { useLogs } from "../../hooks/useLogs";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { TelemetryStatus } from "../../components/TelemetryStatus";
import { LockStateStrip, LockEntry } from "../../components/LockStateStrip";
import { BrandChip } from "../../components/BrandChip";

const WINDOW_30D = 14_400 * 30;

const TOPIC_APPROVED = ethersId("BrandApproved(address,bytes32)");
const TOPIC_REVOKED  = ethersId("BrandRevoked(address,bytes32)");
const TOPIC_RESTORED = ethersId("BrandRestored(address)");

const IFACE = new Interface([
  "event BrandApproved(address indexed addr, bytes32 reasonHash)",
  "event BrandRevoked(address indexed addr, bytes32 reasonHash)",
  "event BrandRestored(address indexed addr)",
]);

type Row =
  | { kind: "approved"; addr: string; reason: string; block: number }
  | { kind: "revoked";  addr: string; reason: string; block: number }
  | { kind: "restored"; addr: string; block: number };

export function ProtocolBrandCurator() {
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { settings } = useSettings();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const curatorAddr = settings.contractAddresses.brandCurator;
  const [owner, setOwner] = useState<string | null>(null);
  const [council, setCouncil] = useState<string | null>(null);
  const [councilLocked, setCouncilLocked] = useState<boolean | null>(null);
  const [lockBusy, setLockBusy] = useState(false);

  useEffect(() => {
    if (!contracts.brandCurator) return;
    (async () => {
      try {
        const [o, c, l] = await Promise.all([
          contracts.brandCurator!.owner().catch(() => null),
          contracts.brandCurator!.council().catch(() => null),
          contracts.brandCurator!.councilLocked().catch(() => null),
        ]);
        setOwner(o ? String(o) : null);
        setCouncil(c ? String(c) : null);
        setCouncilLocked(l === null ? null : Boolean(l));
      } catch { /* leave defaults */ }
    })();
  }, [contracts.brandCurator]);

  const approvedOpts = useMemo(
    () => curatorAddr ? { address: curatorAddr.toLowerCase(), topic0: TOPIC_APPROVED, windowBlocks: WINDOW_30D, historyAllowed: true } : null,
    [curatorAddr]
  );
  const revokedOpts = useMemo(
    () => curatorAddr ? { address: curatorAddr.toLowerCase(), topic0: TOPIC_REVOKED, windowBlocks: WINDOW_30D, historyAllowed: true } : null,
    [curatorAddr]
  );
  const restoredOpts = useMemo(
    () => curatorAddr ? { address: curatorAddr.toLowerCase(), topic0: TOPIC_RESTORED, windowBlocks: WINDOW_30D, historyAllowed: true } : null,
    [curatorAddr]
  );
  const approvedLogs = useLogs(approvedOpts ?? { address: "", topic0: "", windowBlocks: 0, historyAllowed: false });
  const revokedLogs = useLogs(revokedOpts ?? { address: "", topic0: "", windowBlocks: 0, historyAllowed: false });
  const restoredLogs = useLogs(restoredOpts ?? { address: "", topic0: "", windowBlocks: 0, historyAllowed: false });

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const log of approvedLogs.logs) {
      try {
        const p = IFACE.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) continue;
        out.push({ kind: "approved", addr: String(p.args.addr), reason: String(p.args.reasonHash), block: Number(log.blockNumber ?? 0) });
      } catch {/* skip */}
    }
    for (const log of revokedLogs.logs) {
      try {
        const p = IFACE.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) continue;
        out.push({ kind: "revoked", addr: String(p.args.addr), reason: String(p.args.reasonHash), block: Number(log.blockNumber ?? 0) });
      } catch {/* skip */}
    }
    for (const log of restoredLogs.logs) {
      try {
        const p = IFACE.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) continue;
        out.push({ kind: "restored", addr: String(p.args.addr), block: Number(log.blockNumber ?? 0) });
      } catch {/* skip */}
    }
    return out.sort((a, b) => b.block - a.block);
  }, [approvedLogs.logs, revokedLogs.logs, restoredLogs.logs]);

  async function handleLockCouncil() {
    if (!signer || !contracts.brandCurator) return;
    setLockBusy(true);
    try {
      const c = contracts.brandCurator.connect(signer) as typeof contracts.brandCurator;
      const tx = await c.lockCouncil();
      await confirmTx(tx);
      setCouncilLocked(true);
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setLockBusy(false);
    }
  }

  const isOwner = address && owner && address.toLowerCase() === owner.toLowerCase();

  if (!curatorAddr) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Brand Curator
        </h1>
        <div style={{ color: "var(--text-muted)", marginTop: 16, fontSize: 13 }}>
          DatumBrandCurator is not deployed on this network.
        </div>
      </div>
    );
  }

  const locks: LockEntry[] = [
    {
      label: "Council pointer",
      description: "Freezes which Council contract this curator delegates to. After lock, even the Timelock owner cannot reroute verification authority. Owner-only, one-way.",
      contractAddr: curatorAddr,
      getter: "councilLocked",
      locker: "lockCouncil",
    },
  ];

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
        Brand Curator
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
        Council-managed verification + revocation of address brands. Mutations
        (<code>approveBrand</code>, <code>revokeBrand</code>, <code>restoreBrand</code>) happen
        through the Council's propose+vote+execute pipeline. This page is observational + lock control.
      </p>

      <LockStateStrip entries={locks} />

      <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>State</div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13, borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text-muted)" }}>Owner</span>
          <code style={{ color: "var(--text)" }}>{owner ?? "…"}</code>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13, borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text-muted)" }}>Council</span>
          <code style={{ color: "var(--text)" }}>{council ?? "…"}</code>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
          <span style={{ color: "var(--text-muted)" }}>Council pointer locked</span>
          <span style={{ color: councilLocked ? "var(--ok)" : "var(--warn)" }}>
            {councilLocked === null ? "…" : councilLocked ? "Yes (frozen)" : "No (owner can rotate)"}
          </span>
        </div>
      </div>

      {signer && isOwner && councilLocked === false && (
        <div className="nano-card" style={{ padding: 16, marginBottom: 16, border: "1px solid rgba(252,211,77,0.3)" }}>
          <div style={{ color: "var(--warn)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
            Lock council pointer (one-way)
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
            Permanently freezes the Council reference. After this, even the Timelock owner can't
            redirect verification authority to a different Council. Cypherpunk commitment.
          </div>
          <button
            className="nano-btn"
            onClick={handleLockCouncil}
            disabled={lockBusy}
            style={{ fontSize: 12, padding: "6px 14px", color: "var(--warn)", border: "1px solid rgba(252,211,77,0.3)" }}
          >
            {lockBusy ? "Locking..." : "Lock council pointer"}
          </button>
        </div>
      )}

      <div className="nano-card" style={{ padding: 16 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Recent activity (30d)</div>
        <TelemetryStatus
          viaRpc={approvedLogs.viaRpc || revokedLogs.viaRpc || restoredLogs.viaRpc}
          truncatedTo={approvedLogs.truncatedTo ?? revokedLogs.truncatedTo ?? restoredLogs.truncatedTo}
          hideWhileLoading
        />
        {rows.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>No verification events in the last 30 days.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 4 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                    color: r.kind === "approved" ? "var(--ok)" : r.kind === "revoked" ? "var(--error)" : "var(--text-muted)",
                    background: r.kind === "approved" ? "rgba(74,222,128,0.12)" : r.kind === "revoked" ? "rgba(248,113,113,0.12)" : "rgba(160,160,160,0.10)",
                    border: `1px solid ${r.kind === "approved" ? "rgba(74,222,128,0.3)" : r.kind === "revoked" ? "rgba(248,113,113,0.3)" : "var(--border)"}`,
                  }}>
                    {r.kind.toUpperCase()}
                  </span>
                  <BrandChip address={r.addr} size="sm" />
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>#{r.block}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
