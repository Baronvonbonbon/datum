// TelemetryStatus — shared partial-window indicator block.
//
// Wraps the "⚠ via RPC fallback" + "History begins at block N"
// pair so every dashboard / sub-page that reads `useLogs` can
// render the same hints in the same place without copy/pasting
// the inline styles.
//
// Use as:
//   const { ready, viaRpc, truncatedTo } = useLogs(opts);
//   …
//   <TelemetryStatus viaRpc={viaRpc} truncatedTo={truncatedTo} ready={ready} />

export type TelemetryStatusProps = {
  /// True once the first log emission has arrived. While false the
  /// indicator renders a quiet "Syncing…" line; consumers that
  /// already render their own "Syncing…" placeholder can pass
  /// `hideWhileLoading` so we don't double up.
  ready?: boolean;
  /// useLogs.viaRpc — true if any batch was served by the RPC
  /// fallback rather than pine.
  viaRpc?: boolean;
  /// useLogs.truncatedTo — when defined, history is unavailable
  /// before this block.
  truncatedTo?: number;
  /// Set to true when the caller renders its own loading state.
  hideWhileLoading?: boolean;
};

export function TelemetryStatus({
  ready,
  viaRpc,
  truncatedTo,
  hideWhileLoading,
}: TelemetryStatusProps) {
  if (ready === false && !hideWhileLoading) {
    return (
      <div
        style={{
          color: "var(--text-muted)",
          fontSize: 11,
          fontStyle: "italic",
        }}
      >
        Syncing…
      </div>
    );
  }

  if (!viaRpc && truncatedTo === undefined) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        fontSize: 11,
      }}
    >
      {viaRpc && (
        <div
          style={{
            color: "var(--warn)",
            fontStyle: "italic",
          }}
        >
          ⚠ Older entries fetched via RPC fallback.
        </div>
      )}
      {truncatedTo !== undefined && (
        <div style={{ color: "var(--text-muted)" }}>
          History begins at block {truncatedTo}.
        </div>
      )}
    </div>
  );
}
