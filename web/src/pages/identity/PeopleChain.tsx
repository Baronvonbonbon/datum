// /identity/people-chain — refresh + XCM status observatory.
//
// Two sections:
//
//   1. Bridge state — sovereign address, refresh fee, cooldown
//      blocks, default validity blocks, oracleReporter, lock flags.
//      Read on mount from PeopleChainIdentity + PeopleChainXcmBridge.
//
//   2. Recent XCM activity — last 7 days of RefreshDispatched,
//      RefreshFromCampaign, RefreshCallback, RefreshInFlight. Lets
//      operators watch a refresh flow round-trip: dispatch →
//      in-flight → callback.
//
// Per-user "request refresh" actions live on /me/identity — this
// page is the protocol-side observatory only.

import { useEffect, useMemo, useState } from "react";
import { id as ethersId, Interface } from "ethers";
import { useLogs } from "../../hooks/useLogs";
import { TelemetryStatus } from "../../components/TelemetryStatus";
import { callContract } from "../../lib/contractRead";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_7D_BLOCKS = 14_400 * 7;

const TOPIC_DISPATCHED = ethersId("RefreshDispatched(address,address,uint256)");
const TOPIC_FROM_CAMPAIGN = ethersId(
  "RefreshFromCampaign(uint256,address,address,uint256)"
);
const TOPIC_IN_FLIGHT = ethersId("RefreshInFlight(address)");
const TOPIC_CALLBACK = ethersId("RefreshCallback(address,uint8,uint64)");

const IFACE = new Interface([
  "event RefreshDispatched(address indexed user, address indexed requester, uint256 feePaid)",
  "event RefreshFromCampaign(uint256 indexed campaignId, address indexed user, address indexed requester, uint256 feePaid)",
  "event RefreshInFlight(address indexed user)",
  "event RefreshCallback(address indexed user, uint8 level, uint64 validityBlocks)",
]);

const BRIDGE_READ_ABI = [
  "function sovereign() view returns (address)",
  "function sovereignLocked() view returns (bool)",
  "function refreshFee() view returns (uint256)",
  "function refreshCooldownBlocks() view returns (uint64)",
  "function defaultValidityBlocks() view returns (uint64)",
  "function campaignsContract() view returns (address)",
];
const IDENTITY_READ_ABI = [
  "function oracleReporter() view returns (address)",
  "function defaultValidityBlocks() view returns (uint64)",
];

type Row = {
  kind: "dispatched" | "from-campaign" | "in-flight" | "callback";
  user: string;
  block: number;
  fee?: bigint;
  level?: bigint;
  campaignId?: bigint;
};

export function PeopleChain() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;

  if (!addrs.peopleChainIdentity && !addrs.peopleChainXcmBridge) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          People Chain
        </h1>
        <div style={{ color: "var(--text-muted)", marginTop: 16 }}>
          Neither PeopleChainIdentity nor PeopleChainXcmBridge is deployed
          on this network.
        </div>
      </div>
    );
  }

  const [state, setState] = useState<{
    sovereign?: string;
    sovereignLocked?: boolean;
    refreshFee?: bigint;
    cooldown?: bigint;
    defaultValidity?: bigint;
    oracleReporter?: string;
    campaignsContract?: string;
  }>({});
  const [stateErr, setStateErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next: typeof state = {};
        if (addrs.peopleChainXcmBridge) {
          const [
            sovereign,
            sovereignLocked,
            refreshFee,
            cooldown,
            defaultValidity,
            campaignsContract,
          ] = await Promise.all([
            callContract<string>({ address: addrs.peopleChainXcmBridge, abi: BRIDGE_READ_ABI, method: "sovereign" }),
            callContract<boolean>({ address: addrs.peopleChainXcmBridge, abi: BRIDGE_READ_ABI, method: "sovereignLocked" }),
            callContract<bigint>({ address: addrs.peopleChainXcmBridge, abi: BRIDGE_READ_ABI, method: "refreshFee" }),
            callContract<bigint>({ address: addrs.peopleChainXcmBridge, abi: BRIDGE_READ_ABI, method: "refreshCooldownBlocks" }),
            callContract<bigint>({ address: addrs.peopleChainXcmBridge, abi: BRIDGE_READ_ABI, method: "defaultValidityBlocks" }),
            callContract<string>({ address: addrs.peopleChainXcmBridge, abi: BRIDGE_READ_ABI, method: "campaignsContract" }),
          ]);
          next.sovereign = sovereign.toLowerCase();
          next.sovereignLocked = sovereignLocked;
          next.refreshFee = refreshFee;
          next.cooldown = cooldown;
          next.defaultValidity = defaultValidity;
          next.campaignsContract = campaignsContract.toLowerCase();
        }
        if (addrs.peopleChainIdentity) {
          const reporter = await callContract<string>({
            address: addrs.peopleChainIdentity,
            abi: IDENTITY_READ_ABI,
            method: "oracleReporter",
          });
          next.oracleReporter = reporter.toLowerCase();
        }
        if (!cancelled) setState(next);
      } catch (e: any) {
        if (!cancelled) setStateErr(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [addrs.peopleChainXcmBridge, addrs.peopleChainIdentity]);

  const dispatchedOpts = useMemo(
    () =>
      addrs.peopleChainXcmBridge
        ? {
            address: addrs.peopleChainXcmBridge.toLowerCase(),
            topic0: TOPIC_DISPATCHED,
            windowBlocks: WINDOW_7D_BLOCKS,
            historyAllowed: true,
          }
        : null,
    [addrs.peopleChainXcmBridge]
  );
  const fromCampaignOpts = useMemo(
    () =>
      addrs.peopleChainXcmBridge
        ? {
            address: addrs.peopleChainXcmBridge.toLowerCase(),
            topic0: TOPIC_FROM_CAMPAIGN,
            windowBlocks: WINDOW_7D_BLOCKS,
            historyAllowed: true,
          }
        : null,
    [addrs.peopleChainXcmBridge]
  );
  const inFlightOpts = useMemo(
    () =>
      addrs.peopleChainXcmBridge
        ? {
            address: addrs.peopleChainXcmBridge.toLowerCase(),
            topic0: TOPIC_IN_FLIGHT,
            windowBlocks: WINDOW_7D_BLOCKS,
            historyAllowed: true,
          }
        : null,
    [addrs.peopleChainXcmBridge]
  );
  const callbackOpts = useMemo(
    () =>
      addrs.peopleChainXcmBridge
        ? {
            address: addrs.peopleChainXcmBridge.toLowerCase(),
            topic0: TOPIC_CALLBACK,
            windowBlocks: WINDOW_7D_BLOCKS,
            historyAllowed: true,
          }
        : null,
    [addrs.peopleChainXcmBridge]
  );

  const dispatchedLogs = useLogs(
    dispatchedOpts ?? { address: "0x0", topic0: TOPIC_DISPATCHED, windowBlocks: 0, historyAllowed: false }
  );
  const fromCampaignLogs = useLogs(
    fromCampaignOpts ?? { address: "0x0", topic0: TOPIC_FROM_CAMPAIGN, windowBlocks: 0, historyAllowed: false }
  );
  const inFlightLogs = useLogs(
    inFlightOpts ?? { address: "0x0", topic0: TOPIC_IN_FLIGHT, windowBlocks: 0, historyAllowed: false }
  );
  const callbackLogs = useLogs(
    callbackOpts ?? { address: "0x0", topic0: TOPIC_CALLBACK, windowBlocks: 0, historyAllowed: false }
  );

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (dispatchedOpts) {
      for (const log of dispatchedLogs.logs) {
        try {
          const d = IFACE.decodeEventLog("RefreshDispatched", log.data, log.topics);
          out.push({
            kind: "dispatched",
            user: ("0x" + log.topics[1].slice(-40)).toLowerCase(),
            fee: d[2] as bigint,
            block: Number(BigInt(log.blockNumber)),
          });
        } catch {/* skip */}
      }
    }
    if (fromCampaignOpts) {
      for (const log of fromCampaignLogs.logs) {
        try {
          const d = IFACE.decodeEventLog("RefreshFromCampaign", log.data, log.topics);
          out.push({
            kind: "from-campaign",
            campaignId: BigInt(log.topics[1] ?? "0x0"),
            user: ("0x" + log.topics[2].slice(-40)).toLowerCase(),
            fee: d[3] as bigint,
            block: Number(BigInt(log.blockNumber)),
          });
        } catch {/* skip */}
      }
    }
    if (inFlightOpts) {
      for (const log of inFlightLogs.logs) {
        out.push({
          kind: "in-flight",
          user: ("0x" + log.topics[1].slice(-40)).toLowerCase(),
          block: Number(BigInt(log.blockNumber)),
        });
      }
    }
    if (callbackOpts) {
      for (const log of callbackLogs.logs) {
        try {
          const d = IFACE.decodeEventLog("RefreshCallback", log.data, log.topics);
          out.push({
            kind: "callback",
            user: ("0x" + log.topics[1].slice(-40)).toLowerCase(),
            level: d[1] as bigint,
            block: Number(BigInt(log.blockNumber)),
          });
        } catch {/* skip */}
      }
    }
    return out.sort((a, b) => b.block - a.block);
  }, [
    dispatchedLogs.logs, fromCampaignLogs.logs, inFlightLogs.logs, callbackLogs.logs,
    dispatchedOpts, fromCampaignOpts, inFlightOpts, callbackOpts,
  ]);

  const ready =
    (!dispatchedOpts || dispatchedLogs.ready) &&
    (!fromCampaignOpts || fromCampaignLogs.ready) &&
    (!inFlightOpts || inFlightLogs.ready) &&
    (!callbackOpts || callbackLogs.ready);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          People Chain
        </h1>
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Trustless XCM-dispatched identity refresh + oracle-reporter
          attestation cache. User-side actions (refresh me, forget me)
          live on /me/identity.
        </div>
        <div style={{ marginTop: 6 }}>
          <TelemetryStatus
            viaRpc={
              dispatchedLogs.viaRpc ||
              fromCampaignLogs.viaRpc ||
              inFlightLogs.viaRpc ||
              callbackLogs.viaRpc
            }
            truncatedTo={
              dispatchedLogs.truncatedTo ??
              fromCampaignLogs.truncatedTo ??
              inFlightLogs.truncatedTo ??
              callbackLogs.truncatedTo
            }
            hideWhileLoading
          />
        </div>
      </header>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          Bridge state
        </h2>
        {stateErr ? (
          <div style={{ color: "var(--error)", fontSize: 11 }}>{stateErr}</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 8,
            }}
          >
            <Card
              label="Sovereign"
              value={
                state.sovereign
                  ? `${shorten(state.sovereign)}${state.sovereignLocked ? "  (locked)" : ""}`
                  : "—"
              }
            />
            <Card label="Refresh fee" value={state.refreshFee !== undefined ? formatDot(state.refreshFee) : "—"} />
            <Card
              label="Cooldown"
              value={state.cooldown !== undefined ? `${(Number(state.cooldown) / 14_400).toFixed(2)}d` : "—"}
            />
            <Card
              label="Default validity"
              value={
                state.defaultValidity !== undefined
                  ? `${(Number(state.defaultValidity) / 14_400).toFixed(1)}d`
                  : "—"
              }
            />
            <Card label="Oracle reporter" value={state.oracleReporter ? shorten(state.oracleReporter) : "—"} />
            <Card label="Campaigns" value={state.campaignsContract ? shorten(state.campaignsContract) : "—"} />
          </div>
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          Recent XCM activity (7d)
        </h2>
        {!dispatchedOpts ? (
          <div style={{ color: "var(--text-muted)" }}>XCM bridge unavailable on this network.</div>
        ) : !ready ? (
          <div style={{ color: "var(--text-muted)" }}>Syncing…</div>
        ) : rows.length === 0 ? (
          <div style={{ color: "var(--text-muted)" }}>No XCM activity in the last 7 days.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((r, i) => (
              <ActivityRow key={i} row={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
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
      <div
        style={{
          color: "var(--text-muted)",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div style={{ color: "var(--text-strong)", fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono, ui-monospace)" }}>
        {value}
      </div>
    </div>
  );
}

function ActivityRow({ row }: { row: Row }) {
  let title = "";
  let subtitle = "";
  let color = "var(--text-strong)";
  switch (row.kind) {
    case "dispatched":
      title = `Dispatched — ${shorten(row.user)}`;
      subtitle = `Fee ${row.fee !== undefined ? formatDot(row.fee) : "—"} · block ${row.block}`;
      break;
    case "from-campaign":
      title = `Campaign #${row.campaignId} dispatched — ${shorten(row.user)}`;
      subtitle = `Fee ${row.fee !== undefined ? formatDot(row.fee) : "—"} · block ${row.block}`;
      break;
    case "in-flight":
      title = `In flight — ${shorten(row.user)}`;
      subtitle = `Block ${row.block}`;
      color = "var(--warn)";
      break;
    case "callback":
      title = `Callback — ${shorten(row.user)} → tier ${row.level}`;
      subtitle = `Block ${row.block}`;
      color = "var(--ok)";
      break;
  }
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
      <div style={{ color, fontSize: 13, fontWeight: 600 }}>{title}</div>
      <div style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace)" }}>
        {subtitle}
      </div>
    </div>
  );
}

function shorten(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
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
