// /protocol/upgrades — GovernanceRouter registry observatory.
//
// Public route. Enumerates every contract registered with
// DatumGovernanceRouter (the load-bearing 36-contract upgrade
// surface). For each entry the page resolves the current address +
// version on demand and renders a row.
//
// Source of truth for the *set of names* is the ContractRegistered
// event history — the router has no enumeration getter. Each name's
// current state is then read via currentAddrOf / versionOf.
//
// Recent activity section streams ContractUpgraded events in the
// last 7d so operators can see what's been promoted recently.

import { useEffect, useMemo, useState } from "react";
import { id as ethersId, Interface } from "ethers";
import { useLogs } from "../../hooks/useLogs";
import { TelemetryStatus } from "../../components/TelemetryStatus";
import { callContract } from "../../lib/contractRead";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_7D_BLOCKS = 14_400 * 7;
const ALL_TIME_BLOCKS = 14_400 * 365; // ~1y — sufficient for any alpha-* deploy.

const TOPIC_REGISTERED = ethersId("ContractRegistered(bytes32,address)");
const TOPIC_UPGRADED = ethersId("ContractUpgraded(bytes32,address,address,uint256)");

const IFACE = new Interface([
  "event ContractRegistered(bytes32 indexed name, address indexed addr)",
  "event ContractUpgraded(bytes32 indexed name, address indexed oldAddr, address indexed newAddr, uint256 version)",
]);

const READ_ABI = [
  "function currentAddrOf(bytes32) view returns (address)",
  "function versionOf(bytes32) view returns (uint256)",
];

type Row = {
  nameRaw: string;
  label: string;
  current: string;
  version: bigint;
  registeredAt: number;
};

type UpgradeRow = {
  name: string;
  oldAddr: string;
  newAddr: string;
  version: bigint;
  block: number;
};

export function Upgrades() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
  const router = addrs.governanceRouter;

  if (!router) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Upgrades
        </h1>
        <div style={{ color: "var(--text-muted)", marginTop: 16 }}>
          GovernanceRouter isn't deployed on this network.
        </div>
      </div>
    );
  }

  const registeredOpts = useMemo(
    () => ({
      address: router.toLowerCase(),
      topic0: TOPIC_REGISTERED,
      windowBlocks: ALL_TIME_BLOCKS,
      historyAllowed: true,
    }),
    [router]
  );
  const upgradedOpts = useMemo(
    () => ({
      address: router.toLowerCase(),
      topic0: TOPIC_UPGRADED,
      windowBlocks: WINDOW_7D_BLOCKS,
      historyAllowed: true,
    }),
    [router]
  );
  const regLogs = useLogs(registeredOpts);
  const upgLogs = useLogs(upgradedOpts);

  const [rows, setRows] = useState<Row[]>([]);
  const [rowsErr, setRowsErr] = useState<string | null>(null);

  useEffect(() => {
    if (!regLogs.ready) return;
    let cancelled = false;
    (async () => {
      try {
        const seen = new Set<string>();
        const names: { nameRaw: string; block: number }[] = [];
        for (const log of regLogs.logs) {
          const nameRaw = log.topics[1] ?? "0x";
          if (seen.has(nameRaw)) continue;
          seen.add(nameRaw);
          names.push({ nameRaw, block: Number(BigInt(log.blockNumber)) });
        }
        const out = await Promise.all(
          names.map(async (n) => {
            const [current, version] = await Promise.all([
              callContract<string>({ address: router, abi: READ_ABI, method: "currentAddrOf", args: [n.nameRaw] }),
              callContract<bigint>({ address: router, abi: READ_ABI, method: "versionOf", args: [n.nameRaw] }),
            ]);
            return {
              nameRaw: n.nameRaw,
              label: bytes32Label(n.nameRaw),
              current: current.toLowerCase(),
              version,
              registeredAt: n.block,
            } as Row;
          })
        );
        if (cancelled) return;
        out.sort((a, b) => a.label.localeCompare(b.label));
        setRows(out);
      } catch (e: any) {
        if (!cancelled) setRowsErr(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [regLogs.ready, regLogs.logs, router]);

  const upgradeRows = useMemo<UpgradeRow[]>(() => {
    return upgLogs.logs
      .map((log) => {
        try {
          const d = IFACE.decodeEventLog("ContractUpgraded", log.data, log.topics);
          return {
            name: bytes32Label(log.topics[1] ?? "0x"),
            oldAddr: ("0x" + log.topics[2].slice(-40)).toLowerCase(),
            newAddr: ("0x" + log.topics[3].slice(-40)).toLowerCase(),
            version: d[3] as bigint,
            block: Number(BigInt(log.blockNumber)),
          } as UpgradeRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is UpgradeRow => r !== null)
      .sort((a, b) => b.block - a.block);
  }, [upgLogs.logs]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Upgrades
        </h1>
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          GovernanceRouter registry. Every contract registered here is
          phase-gated upgradable via the current governor. Lock status
          will appear here once the per-contract <code>lock*()</code> phase
          gate fires (cypherpunk roadmap, pending OpenGov transition).
        </div>
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            marginTop: 6,
            fontFamily: "var(--font-mono, ui-monospace)",
          }}
        >
          Router {shortenAddr(router)}
        </div>
        <div style={{ marginTop: 6 }}>
          <TelemetryStatus
            viaRpc={regLogs.viaRpc || upgLogs.viaRpc}
            truncatedTo={regLogs.truncatedTo ?? upgLogs.truncatedTo}
            hideWhileLoading
          />
        </div>
      </header>

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          Registered contracts ({rows.length || "…"})
        </h2>
        {rowsErr ? (
          <div style={{ color: "var(--error)", fontSize: 11 }}>{rowsErr}</div>
        ) : !regLogs.ready ? (
          <div style={{ color: "var(--text-muted)" }}>Syncing…</div>
        ) : rows.length === 0 ? (
          <div style={{ color: "var(--text-muted)" }}>No contracts registered yet.</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(120px, 200px) 1fr minmax(60px, 100px) minmax(70px, 110px)",
              gap: 6,
              fontSize: 12,
            }}
          >
            <div style={cellHeader}>Name</div>
            <div style={cellHeader}>Current address</div>
            <div style={cellHeader}>Version</div>
            <div style={cellHeader}>Registered</div>
            {rows.map((r) => (
              <RegistryRow key={r.nameRaw} row={r} />
            ))}
          </div>
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          Recent upgrades (7d)
        </h2>
        {!upgLogs.ready ? (
          <div style={{ color: "var(--text-muted)" }}>Syncing…</div>
        ) : upgradeRows.length === 0 ? (
          <div style={{ color: "var(--text-muted)" }}>No upgrades in the last 7 days.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {upgradeRows.map((u, i) => (
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
                  {u.name} → v{u.version.toString()}
                </div>
                <div
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono, ui-monospace)",
                  }}
                >
                  {shortenAddr(u.oldAddr)} → {shortenAddr(u.newAddr)} · block {u.block}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RegistryRow({ row }: { row: Row }) {
  return (
    <>
      <div
        style={{
          color: "var(--text-strong)",
          fontWeight: 600,
          padding: "8px 10px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
        }}
      >
        {row.label}
      </div>
      <div
        style={{
          color: "var(--text-strong)",
          padding: "8px 10px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          fontFamily: "var(--font-mono, ui-monospace)",
          fontSize: 11,
        }}
      >
        {row.current}
      </div>
      <div
        style={{
          color: "var(--text-strong)",
          padding: "8px 10px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          fontFamily: "var(--font-mono, ui-monospace)",
          fontSize: 11,
        }}
      >
        v{row.version.toString()}
      </div>
      <div
        style={{
          color: "var(--text-muted)",
          padding: "8px 10px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          fontFamily: "var(--font-mono, ui-monospace)",
          fontSize: 11,
        }}
      >
        block {row.registeredAt}
      </div>
    </>
  );
}

const cellHeader: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  padding: "0 10px 4px",
};

function bytes32Label(b32: string): string {
  if (!b32 || !b32.startsWith("0x")) return b32 ?? "";
  const hex = b32.slice(2);
  let s = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substr(i, 2), 16);
    if (byte === 0) break;
    if (byte >= 0x20 && byte < 0x7f) s += String.fromCharCode(byte);
  }
  return s || `${b32.slice(0, 10)}…`;
}

function shortenAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
