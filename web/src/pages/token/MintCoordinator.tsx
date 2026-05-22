// /token/mint-coordinator — per-batch emissions log.
//
// Read-only observatory for the DATUM mint plane. Three sections:
//
//   1. Live state — EmissionEngine.currentRate / currentEpoch /
//      dailyCap / remainingEpochBudget, plus the MintCoordinator
//      flat-rate fallback (mintRatePerDot). Helpful when toggling
//      between the dynamic engine and the static rate during
//      bring-up.
//
//   2. Recent mints — last 7 days of EmissionEngine.MintComputed
//      events, decoded into per-batch rows showing
//      (dotPaid, rawMint, effectiveMint). The gap between raw and
//      effective reflects per-day cap clamping.
//
//   3. Rate timeline — MintRateUpdated + RateAdjusted events in
//      the same window, oldest at the bottom of the section, so
//      operators can see governance + dynamic adjustments
//      interleaved.

import { useEffect, useMemo, useState } from "react";
import { id as ethersId, Interface } from "ethers";
import { useLogs } from "../../hooks/useLogs";
import { callContract } from "../../lib/contractRead";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_7D_BLOCKS = 14_400 * 7;

const TOPIC_MINT_COMPUTED = ethersId("MintComputed(uint256,uint256,uint256)");
const TOPIC_RATE_ADJUSTED = ethersId(
  "RateAdjusted(uint256,uint256,uint256)"
);
const TOPIC_MINT_RATE_UPDATED = ethersId("MintRateUpdated(uint256,uint256)");

const ENGINE_IFACE = new Interface([
  "event MintComputed(uint256 dotPaid, uint256 rawMint, uint256 effectiveMint)",
  "event RateAdjusted(uint256 newRate, uint256 observedVolume, uint256 previousRate)",
]);
const COORD_IFACE = new Interface([
  "event MintRateUpdated(uint256 oldRate, uint256 newRate)",
]);

const ENGINE_READ_ABI = [
  "function currentRate() view returns (uint256)",
  "function currentEpoch() view returns (uint8)",
  "function dailyCap() view returns (uint256)",
  "function remainingEpochBudget() view returns (uint256)",
];
const COORD_READ_ABI = [
  "function mintRatePerDot() view returns (uint256)",
];

type MintRow = {
  dotPaid: bigint;
  rawMint: bigint;
  effectiveMint: bigint;
  block: number;
};

type RateRow = {
  kind: "engine-adjust" | "coord-update";
  prev: bigint;
  next: bigint;
  observed?: bigint;
  block: number;
};

export function MintCoordinatorPage() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;

  if (!addrs.mintCoordinator && !addrs.emissionEngine) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Mint coordinator
        </h1>
        <div style={{ color: "var(--text-muted)", marginTop: 16 }}>
          Neither MintCoordinator nor EmissionEngine is deployed on this
          network. The token plane lights up once these land.
        </div>
      </div>
    );
  }

  return <Inner addrs={addrs} />;
}

function Inner({ addrs }: { addrs: (typeof NETWORK_CONFIGS)["polkadotTestnet"]["addresses"] }) {
  const [state, setState] = useState<{
    currentRate?: bigint;
    epoch?: bigint;
    dailyCap?: bigint;
    remaining?: bigint;
    flatRate?: bigint;
  }>({});
  const [stateErr, setStateErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next: typeof state = {};
        if (addrs.emissionEngine) {
          const [rate, epoch, cap, remaining] = await Promise.all([
            callContract<bigint>({ address: addrs.emissionEngine, abi: ENGINE_READ_ABI, method: "currentRate" }),
            callContract<bigint>({ address: addrs.emissionEngine, abi: ENGINE_READ_ABI, method: "currentEpoch" }),
            callContract<bigint>({ address: addrs.emissionEngine, abi: ENGINE_READ_ABI, method: "dailyCap" }),
            callContract<bigint>({ address: addrs.emissionEngine, abi: ENGINE_READ_ABI, method: "remainingEpochBudget" }),
          ]);
          next.currentRate = rate;
          next.epoch = epoch;
          next.dailyCap = cap;
          next.remaining = remaining;
        }
        if (addrs.mintCoordinator) {
          next.flatRate = await callContract<bigint>({
            address: addrs.mintCoordinator,
            abi: COORD_READ_ABI,
            method: "mintRatePerDot",
          });
        }
        if (!cancelled) setState(next);
      } catch (e: any) {
        if (!cancelled) setStateErr(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [addrs.emissionEngine, addrs.mintCoordinator]);

  const mintOpts = useMemo(
    () =>
      addrs.emissionEngine
        ? {
            address: addrs.emissionEngine.toLowerCase(),
            topic0: TOPIC_MINT_COMPUTED,
            windowBlocks: WINDOW_7D_BLOCKS,
            historyAllowed: true,
          }
        : null,
    [addrs.emissionEngine]
  );
  const adjustOpts = useMemo(
    () =>
      addrs.emissionEngine
        ? {
            address: addrs.emissionEngine.toLowerCase(),
            topic0: TOPIC_RATE_ADJUSTED,
            windowBlocks: WINDOW_7D_BLOCKS,
            historyAllowed: true,
          }
        : null,
    [addrs.emissionEngine]
  );
  const coordOpts = useMemo(
    () =>
      addrs.mintCoordinator
        ? {
            address: addrs.mintCoordinator.toLowerCase(),
            topic0: TOPIC_MINT_RATE_UPDATED,
            windowBlocks: WINDOW_7D_BLOCKS,
            historyAllowed: true,
          }
        : null,
    [addrs.mintCoordinator]
  );

  const mintLogs = useLogs(
    mintOpts ?? { address: "0x0", topic0: TOPIC_MINT_COMPUTED, windowBlocks: 0, historyAllowed: false }
  );
  const adjustLogs = useLogs(
    adjustOpts ?? { address: "0x0", topic0: TOPIC_RATE_ADJUSTED, windowBlocks: 0, historyAllowed: false }
  );
  const coordLogs = useLogs(
    coordOpts ?? { address: "0x0", topic0: TOPIC_MINT_RATE_UPDATED, windowBlocks: 0, historyAllowed: false }
  );

  const mints = useMemo<MintRow[]>(() => {
    if (!mintOpts) return [];
    return mintLogs.logs
      .map((log) => {
        try {
          const d = ENGINE_IFACE.decodeEventLog("MintComputed", log.data, log.topics);
          return {
            dotPaid: d[0] as bigint,
            rawMint: d[1] as bigint,
            effectiveMint: d[2] as bigint,
            block: Number(BigInt(log.blockNumber)),
          } as MintRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is MintRow => r !== null)
      .sort((a, b) => b.block - a.block);
  }, [mintLogs.logs, mintOpts]);

  const rateRows = useMemo<RateRow[]>(() => {
    const rows: RateRow[] = [];
    if (adjustOpts) {
      for (const log of adjustLogs.logs) {
        try {
          const d = ENGINE_IFACE.decodeEventLog("RateAdjusted", log.data, log.topics);
          rows.push({
            kind: "engine-adjust",
            next: d[0] as bigint,
            observed: d[1] as bigint,
            prev: d[2] as bigint,
            block: Number(BigInt(log.blockNumber)),
          });
        } catch {/* skip */}
      }
    }
    if (coordOpts) {
      for (const log of coordLogs.logs) {
        try {
          const d = COORD_IFACE.decodeEventLog("MintRateUpdated", log.data, log.topics);
          rows.push({
            kind: "coord-update",
            prev: d[0] as bigint,
            next: d[1] as bigint,
            block: Number(BigInt(log.blockNumber)),
          });
        } catch {/* skip */}
      }
    }
    return rows.sort((a, b) => b.block - a.block);
  }, [adjustLogs.logs, coordLogs.logs, adjustOpts, coordOpts]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Mint coordinator
        </h1>
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Per-batch DATUM mint accounting. EmissionEngine.MintComputed
          fires on every settlement that earns DATUM. Effective mint may
          fall below raw mint when the per-day cap clamps.
        </div>
      </header>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          Live state
        </h2>
        {stateErr ? (
          <div style={{ color: "var(--error)", fontSize: 11 }}>{stateErr}</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 8,
            }}
          >
            <StateCard label="Engine rate" value={state.currentRate !== undefined ? `${state.currentRate / 10n ** 10n}` : "—"} unit="DATUM/DOT" />
            <StateCard label="Epoch" value={state.epoch !== undefined ? `#${state.epoch}` : "—"} />
            <StateCard label="Daily cap" value={state.dailyCap !== undefined ? formatDatum(state.dailyCap) : "—"} />
            <StateCard label="Remaining epoch" value={state.remaining !== undefined ? formatDatum(state.remaining) : "—"} />
            <StateCard label="Coord flat-rate" value={state.flatRate !== undefined ? `${state.flatRate / 10n ** 10n}` : "—"} unit="DATUM/DOT" />
          </div>
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          Recent mints (7d)
        </h2>
        {!mintOpts ? (
          <div style={{ color: "var(--text-muted)" }}>EmissionEngine unavailable on this network.</div>
        ) : !mintLogs.ready ? (
          <div style={{ color: "var(--text-muted)" }}>Syncing…</div>
        ) : mints.length === 0 ? (
          <div style={{ color: "var(--text-muted)" }}>No mints in the last 7 days.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {mints.slice(0, 50).map((m, i) => (
              <div
                key={i}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  background: "var(--bg-surface)",
                  padding: "10px 12px",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: 12,
                }}
              >
                <div style={{ color: "var(--text-strong)" }}>
                  {formatDatum(m.effectiveMint)} {m.effectiveMint < m.rawMint && (
                    <span style={{ color: "var(--warn)", fontSize: 10, marginLeft: 6 }}>
                      capped from {formatDatum(m.rawMint)}
                    </span>
                  )}
                </div>
                <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono, ui-monospace)" }}>
                  {formatDot(m.dotPaid)} · block {m.block}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          Rate timeline (7d)
        </h2>
        {rateRows.length === 0 ? (
          <div style={{ color: "var(--text-muted)" }}>No rate changes in the last 7 days.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rateRows.map((r, i) => (
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
                  fontSize: 12,
                }}
              >
                <div style={{ color: "var(--text-strong)", fontWeight: 600 }}>
                  {r.kind === "engine-adjust" ? "Engine adjusted" : "Coord set"} {(r.prev / 10n ** 10n).toString()} → {(r.next / 10n ** 10n).toString()} DATUM/DOT
                </div>
                <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono, ui-monospace)" }}>
                  {r.observed !== undefined ? `observed volume ${formatDot(r.observed)} · ` : ""}block {r.block}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StateCard({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div
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
      <div style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600 }}>
        {value}{unit && <span style={{ color: "var(--text-muted)", fontSize: 11, marginLeft: 4 }}>{unit}</span>}
      </div>
    </div>
  );
}

function formatDatum(planck: bigint): string {
  if (planck === 0n) return "0 DATUM";
  const whole = planck / 10n ** 10n;
  const frac = planck % 10n ** 10n;
  if (whole === 0n) {
    const padded = frac.toString().padStart(10, "0");
    const trimmed = padded.slice(0, 4).replace(/0+$/, "") || "0";
    return `0.${trimmed} DATUM`;
  }
  const fracStr = frac.toString().padStart(10, "0").slice(0, 4).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr} DATUM` : `${whole} DATUM`;
}

function formatDot(planck: bigint): string {
  if (planck === 0n) return "0 DOT";
  const whole = planck / 10n ** 10n;
  const frac = planck % 10n ** 10n;
  if (whole === 0n) {
    const padded = frac.toString().padStart(10, "0");
    const trimmed = padded.slice(0, 4).replace(/0+$/, "") || "0";
    return `0.${trimmed} DOT`;
  }
  const fracStr = frac.toString().padStart(10, "0").slice(0, 4).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr} DOT` : `${whole} DOT`;
}
