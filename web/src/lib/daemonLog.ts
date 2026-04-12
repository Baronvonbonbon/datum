/**
 * daemonLog.ts — In-page activity log for the DATUM demo daemon.
 *
 * Intercepts console.log/warn/error calls tagged with [datum or [DATUM and
 * all chrome.runtime.sendMessage traffic (injected by chromeShim).
 * Components subscribe via subscribeDaemonLog() to get a live-updating feed.
 */

export type LogLevel = "log" | "warn" | "error" | "msg-out" | "msg-in";

export interface LogEntry {
  id: number;
  ts: number;        // Date.now()
  level: LogLevel;
  text: string;
}

const MAX_ENTRIES = 600;
let _seq = 0;
const _entries: LogEntry[] = [];
const _listeners = new Set<(entries: LogEntry[]) => void>();

export function _emit(level: LogLevel, text: string): void {
  _entries.push({ id: _seq++, ts: Date.now(), level, text });
  if (_entries.length > MAX_ENTRIES) _entries.shift();
  const snap = [..._entries];
  _listeners.forEach((l) => l(snap));
}

/** Subscribe to log updates. Returns an unsubscribe function. */
export function subscribeDaemonLog(fn: (entries: LogEntry[]) => void): () => void {
  _listeners.add(fn);
  fn([..._entries]); // immediate snapshot
  return () => _listeners.delete(fn);
}

/** Returns current entries (snapshot). */
export function getDaemonLogEntries(): LogEntry[] {
  return [..._entries];
}

export function clearDaemonLog(): void {
  _entries.length = 0;
  _seq = 0;
  const snap: LogEntry[] = [];
  _listeners.forEach((l) => l(snap));
}

/** Intercepts console.log/warn/error — call once before daemon starts. */
export function installConsoleCapture(): void {
  if ((window as any).__daemonLogInstalled) return;
  (window as any).__daemonLogInstalled = true;

  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const intercept =
    (level: "log" | "warn" | "error") =>
    (...args: unknown[]) => {
      orig[level](...args);
      const text = args
        .map((a) =>
          a instanceof Error
            ? a.message
            : typeof a === "object" && a !== null
            ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
            : String(a),
        )
        .join(" ");
      if (/\[datum|\[DATUM/i.test(text)) {
        _emit(level, text);
      }
    };

  console.log = intercept("log");
  console.warn = intercept("warn");
  console.error = intercept("error");
}
