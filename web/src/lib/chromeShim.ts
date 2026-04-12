/**
 * chromeShim.ts — Minimal chrome extension API shim for running DATUM extension in-page.
 *
 * chrome.storage.local → localStorage (namespaced with "datum_ext:")
 * chrome.runtime messaging → synchronous in-page dispatch
 * chrome.alarms → setInterval / setTimeout
 */

const NS = "datum_ext:";

// ── Storage ────────────────────────────────────────────────────────────────

type StorageResult = Record<string, unknown>;
type GetKeys = string | string[] | Record<string, unknown> | null | undefined;

function readKey(k: string): unknown {
  const raw = localStorage.getItem(NS + k);
  if (raw === null) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function storageGet(keys?: GetKeys, callback?: (r: StorageResult) => void): Promise<StorageResult> {
  const result: StorageResult = {};

  if (keys == null) {
    for (let i = 0; i < localStorage.length; i++) {
      const lk = localStorage.key(i);
      if (lk?.startsWith(NS)) {
        const rk = lk.slice(NS.length);
        const v = readKey(rk);
        if (v !== undefined) result[rk] = v;
      }
    }
  } else if (typeof keys === "string") {
    const v = readKey(keys);
    if (v !== undefined) result[keys] = v;
  } else if (Array.isArray(keys)) {
    for (const k of keys) {
      const v = readKey(k);
      if (v !== undefined) result[k] = v;
    }
  } else {
    for (const [k, def] of Object.entries(keys)) {
      const v = readKey(k);
      result[k] = v !== undefined ? v : def;
    }
  }

  // Chrome's callback API is async; mirror that with a microtask.
  if (callback) Promise.resolve(result).then(callback);
  return Promise.resolve(result);
}

function storageSet(items: Record<string, unknown>, callback?: () => void): Promise<void> {
  for (const [k, v] of Object.entries(items)) {
    localStorage.setItem(NS + k, JSON.stringify(v));
  }
  if (callback) Promise.resolve().then(callback);
  return Promise.resolve();
}

function storageRemove(keys: string | string[], callback?: () => void): Promise<void> {
  const ks = Array.isArray(keys) ? keys : [keys];
  for (const k of ks) localStorage.removeItem(NS + k);
  if (callback) Promise.resolve().then(callback);
  return Promise.resolve();
}

// ── Message bus ────────────────────────────────────────────────────────────

type Sender = { id: string };
type SendResponse = (r: unknown) => void;
type MessageListener = (
  msg: Record<string, unknown>,
  sender: Sender,
  sendResponse: SendResponse,
) => boolean | undefined | void;

const messageListeners: MessageListener[] = [];
const SENDER: Sender = { id: "datum-demo" };

// Optional message logger hook — set by daemonLog integration
let _msgLogger: ((dir: "out" | "in", type: string, detail: string) => void) | null = null;
export function setShimMessageLogger(fn: typeof _msgLogger): void { _msgLogger = fn; }

function summarise(msg: Record<string, unknown>): string {
  const omit = new Set(["type", "contractAddresses", "batches", "zkProof"]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(msg)) {
    if (omit.has(k)) continue;
    if (typeof v === "object" && v !== null) continue;
    parts.push(`${k}=${String(v).slice(0, 40)}`);
  }
  return parts.join(" ");
}

function sendMessage(msg: Record<string, unknown>): Promise<unknown> {
  const msgType = String(msg.type ?? "unknown");
  _msgLogger?.("out", msgType, summarise(msg));

  return new Promise((resolve) => {
    let responded = false;
    const sendResponse = (r: unknown) => {
      if (!responded) {
        responded = true;
        const result = r as Record<string, unknown> | null | undefined;
        const detail = result
          ? Object.entries(result)
              .filter(([k]) => k !== "type")
              .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
              .join(" ")
          : "";
        _msgLogger?.("in", msgType, detail);
        resolve(r);
      }
    };

    let isAsync = false;
    for (const listener of messageListeners) {
      const ret = listener(msg, SENDER, sendResponse);
      if (ret === true) { isAsync = true; break; }
    }

    if (!isAsync && !responded) { responded = true; resolve(undefined); }
  });
}

// ── Alarms ────────────────────────────────────────────────────────────────

type AlarmListener = (alarm: { name: string }) => void;

const alarmListeners: AlarmListener[] = [];
const activeAlarms = new Map<string, ReturnType<typeof setInterval>>();

function alarmCreate(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): Promise<void> {
  if (activeAlarms.has(name)) { clearInterval(activeAlarms.get(name)!); activeAlarms.delete(name); }
  const periodMs = (info.periodInMinutes ?? 5) * 60_000;
  const fire = () => alarmListeners.forEach((l) => l({ name }));
  activeAlarms.set(name, setInterval(fire, periodMs));
  return Promise.resolve();
}

function alarmClear(name: string): Promise<void> {
  if (activeAlarms.has(name)) { clearInterval(activeAlarms.get(name)!); activeAlarms.delete(name); }
  return Promise.resolve();
}

// ── Install ────────────────────────────────────────────────────────────────

export function installChromeShim(): void {
  if ((window as any).chrome?.storage?.local?.get) return; // already installed

  (window as any).chrome = {
    storage: {
      local: { get: storageGet, set: storageSet, remove: storageRemove },
    },
    runtime: {
      id: "datum-demo",
      getURL: (path: string) => `/${path}`,
      sendMessage,
      onMessage: { addListener: (fn: MessageListener) => { messageListeners.push(fn); } },
      onInstalled: { addListener: (fn: (d: { reason: string }) => void) => { Promise.resolve().then(() => fn({ reason: "install" })); } },
      onStartup: { addListener: (fn: () => void) => { Promise.resolve().then(fn); } },
    },
    alarms: {
      create: alarmCreate,
      clear: alarmClear,
      onAlarm: { addListener: (fn: AlarmListener) => { alarmListeners.push(fn); } },
    },
    windows: { create: async () => {} },
    tabs: { create: async () => {}, query: async () => [] },
  };
}
