// Structured logger — emits one JSON line per event.
//
// `journalctl -u datum-relay -o json` parses these cleanly; a
// downstream log aggregator (Loki, Vector, etc.) can ingest them
// without a regex stage.
//
// Levels: 0 = silent, 1 = info+warn+error (default), 2 = trace.

let _level = 1;

export function setLogLevel(level) {
  _level = Number(level) || 0;
}

function emit(level, levelName, msg, ctx) {
  if (level > _level) return;
  const line = {
    ts: new Date().toISOString(),
    level: levelName,
    msg,
    ...(ctx && typeof ctx === "object" ? ctx : {}),
  };
  // Errors go to stderr so log-shipping can route them separately.
  const stream = levelName === "error" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + "\n");
}

export const log = {
  info: (msg, ctx) => emit(1, "info", msg, ctx),
  warn: (msg, ctx) => emit(1, "warn", msg, ctx),
  error: (msg, ctx) => emit(1, "error", msg, ctx),
  trace: (msg, ctx) => emit(2, "trace", msg, ctx),
};
