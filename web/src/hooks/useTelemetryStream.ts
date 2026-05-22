// useTelemetryStream — composes useLogs over a set of (address,
// topic0) sources, formats each log via a per-source `formatter`,
// merges results, and exposes the rolling stream sorted by timestamp
// desc.
//
// Per design doc §6.2, each dashboard declares a TelemetryStream
// config and the shared template renders the result. Multiple sources
// support tiles that mix events from different contracts (e.g. the
// /governance dashboard streams vote casts + Council votes + parameter
// changes side-by-side).

import { useMemo } from "react";
import { useLogs } from "./useLogs";
import type { EthLog } from "../lib/eventBus";

export type StreamRow = {
  /// Block timestamp in unix seconds. Used for sort + display.
  ts: number;
  /// Stable category tag. Used by the optional filter chip rendered
  /// over the stream.
  type: string;
  /// Primary line — bold, full-width.
  title: string;
  /// Optional secondary line — muted.
  subtitle?: string;
  /// Optional click target — when present the row becomes a link.
  route?: string;
  /// Optional stable identifier for React keys. The hook synthesizes
  /// one from `(transactionHash, logIndex)` if absent.
  id?: string;
};

export type TelemetrySource = {
  /// Contract address to subscribe.
  address: string;
  /// Topic0 (event signature hash). Compute with ethers.id(eventSig).
  topic0: string;
  /// Synchronous formatter from the raw log to a StreamRow.
  formatter: (log: EthLog) => StreamRow;
};

export type TelemetryStreamOpts = {
  /// How far back to ask. End-user routes should keep this modest
  /// (default ~24h on Paseo = 14_400 blocks).
  windowBlocks: number;
  /// Operator routes set this true to opt into the per-query RPC
  /// fallback for history beyond pine's window.
  historyAllowed: boolean;
  sources: TelemetrySource[];
};

export type UseTelemetryStreamResult = {
  rows: StreamRow[];
  /// True once every source has bootstrapped.
  ready: boolean;
  /// Sticky — true if any source used the RPC fallback.
  viaRpc: boolean;
  /// Lowest block index across sources where the bootstrap was
  /// truncated. Rendered as a "history begins at block N" banner.
  truncatedTo?: number;
};

/// Multi-source telemetry hook. Internally allocates one
/// `useLogs(...)` per source — useLogs is the dedupe layer, so two
/// dashboards subscribing to the same source still result in one
/// eventBus channel.
///
/// Stage 3d ships the dual-source case. Higher fan-out (3+ sources)
/// will trigger React's rules-of-hooks check because the hook count
/// depends on `opts.sources.length`. To support that we'd switch to
/// a fixed maximum (say, 8 sources) and pass empty slots through.
/// For now, callers stick to ≤2 sources or supply a stable count.
export function useTelemetryStream(opts: TelemetryStreamOpts): UseTelemetryStreamResult {
  const { sources, windowBlocks, historyAllowed } = opts;

  // Allocate hooks up to a fixed max so React's rules-of-hooks
  // doesn't fire on variable source counts. Empty slots use a
  // sentinel that returns no logs. Each slot's window + history
  // flag come from the outer opts; the per-source object only
  // contributes its address + topic0 + formatter.
  const slot0 = useLogs(slotOpts(sources[0], windowBlocks, historyAllowed));
  const slot1 = useLogs(slotOpts(sources[1], windowBlocks, historyAllowed));
  const slot2 = useLogs(slotOpts(sources[2], windowBlocks, historyAllowed));
  const slot3 = useLogs(slotOpts(sources[3], windowBlocks, historyAllowed));
  const slot4 = useLogs(slotOpts(sources[4], windowBlocks, historyAllowed));
  const slot5 = useLogs(slotOpts(sources[5], windowBlocks, historyAllowed));
  const slot6 = useLogs(slotOpts(sources[6], windowBlocks, historyAllowed));
  const slot7 = useLogs(slotOpts(sources[7], windowBlocks, historyAllowed));
  const slots = [slot0, slot1, slot2, slot3, slot4, slot5, slot6, slot7];

  if (sources.length > 8) {
    // Visible at dev time so consumers know to bump the slot count.
    console.warn(
      "[useTelemetryStream] sources >8 not supported yet — extras ignored."
    );
  }

  const result = useMemo<UseTelemetryStreamResult>(() => {
    const rows: StreamRow[] = [];
    let ready = true;
    let viaRpc = false;
    let truncatedTo: number | undefined;
    for (let i = 0; i < sources.length && i < 8; i++) {
      const src = sources[i];
      const slot = slots[i];
      if (!slot.ready) ready = false;
      if (slot.viaRpc) viaRpc = true;
      if (slot.truncatedTo !== undefined) {
        truncatedTo =
          truncatedTo === undefined
            ? slot.truncatedTo
            : Math.min(truncatedTo, slot.truncatedTo);
      }
      for (const log of slot.logs) {
        try {
          const row = src.formatter(log);
          if (!row.id) row.id = `${log.transactionHash}:${log.logIndex}`;
          rows.push(row);
        } catch (err) {
          console.warn("[useTelemetryStream] formatter threw, skipping log", err);
        }
      }
    }
    rows.sort((a, b) => b.ts - a.ts);
    return { rows, ready, viaRpc, truncatedTo };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    slot0.logs, slot1.logs, slot2.logs, slot3.logs,
    slot4.logs, slot5.logs, slot6.logs, slot7.logs,
    slot0.ready, slot1.ready, slot2.ready, slot3.ready,
    slot4.ready, slot5.ready, slot6.ready, slot7.ready,
    slot0.viaRpc, slot1.viaRpc, slot2.viaRpc, slot3.viaRpc,
    slot4.viaRpc, slot5.viaRpc, slot6.viaRpc, slot7.viaRpc,
    slot0.truncatedTo, slot1.truncatedTo, slot2.truncatedTo, slot3.truncatedTo,
    slot4.truncatedTo, slot5.truncatedTo, slot6.truncatedTo, slot7.truncatedTo,
    sources,
  ]);

  return result;
}

// Sentinel address + topic. The eventBus channel for (zero, zero)
// returns no logs — no real contract emits the zero topic from the
// zero address.
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";

/// Build LogSubscriptionOpts for a slot — real source merged with
/// the outer window/history config, or a sentinel when the slot is
/// past the caller's source count.
function slotOpts(
  src: TelemetrySource | undefined,
  windowBlocks: number,
  historyAllowed: boolean
) {
  return {
    address: src?.address ?? ZERO_ADDR,
    topic0: src?.topic0 ?? ZERO_TOPIC,
    windowBlocks,
    historyAllowed,
  };
}
