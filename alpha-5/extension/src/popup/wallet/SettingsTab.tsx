// Settings tab — wallet-level controls.
//
// Stage 1c surface:
//   - Lock now
//   - Auto-lock idle timeout (minutes)
//   - Theme toggle (light / dark)  — flips data-theme on <html>; the
//     popup CSS picks up the new tokens.
//   - Reset wallet — destructive; typed confirmation gate.
//
// Change-password is deferred to a follow-up — requires holding both
// the old + new password, re-encrypting the payload, and persisting
// atomically. None of the surface for the rest of stage 1 depends on
// it, so it doesn't block.

import { useState, useEffect } from "react";
import { walletClient, type WalletStatus, type OriginPermission } from "./walletClient";
import { AssuranceSection } from "./AssuranceSection";
import { RecoverySection } from "./RecoverySection";
import {
  card,
  button,
  input,
  heading,
  subText,
  fieldLabel,
  errorText,
  mono,
} from "./styles";

const THEME_STORAGE_KEY = "walletTheme";

export function SettingsTab({
  status,
  onChange,
}: {
  status: WalletStatus;
  onChange: (status: WalletStatus) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...heading, fontSize: 13 }}>Settings</div>

      <SecuritySection status={status} onChange={onChange} />
      <AssuranceSection status={status} />
      <RecoverySection status={status} />
      <PermissionsSection />
      <ThemeSection />
      <ResetSection onChange={onChange} />
    </div>
  );
}

function PermissionsSection() {
  const [perms, setPerms] = useState<OriginPermission[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    walletClient
      .listPermissions()
      .then((p) => {
        if (!cancelled) setPerms(p);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function revoke(origin: string) {
    setErr(null);
    try {
      await walletClient.revokePermission(origin);
      const next = await walletClient.listPermissions();
      setPerms(next);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ color: "var(--text-strong)", fontSize: 12, fontWeight: 500 }}>
        Connected sites
      </div>
      {perms === null ? (
        <div style={subText}>Loading…</div>
      ) : perms.length === 0 ? (
        <div style={{ ...subText, fontSize: 11 }}>
          No sites have connected. Approving a connection from a dApp
          will list it here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {perms.map((p) => (
            <div
              key={p.origin}
              style={{
                ...card,
                padding: "7px 9px",
                background: "var(--bg)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ ...mono, fontSize: 11, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {p.origin}
                </div>
                <div style={{ ...subText, fontSize: 10 }}>
                  Granted {relativeTime(p.grantedAt)}
                </div>
              </div>
              <button
                style={{
                  ...button("danger"),
                  padding: "4px 8px",
                  fontSize: 11,
                  width: "auto",
                }}
                onClick={() => revoke(p.origin)}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
      {err && <div style={errorText}>{err}</div>}
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.floor(hr / 24);
  return `${day} d ago`;
}

function SecuritySection({
  status,
  onChange,
}: {
  status: WalletStatus;
  onChange: (s: WalletStatus) => void;
}) {
  const [timeoutMin, setTimeoutMin] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Initial load — pull the persisted setting.
  useEffect(() => {
    chrome.storage.local.get("walletIdleTimeoutMin").then((g) => {
      const v = g.walletIdleTimeoutMin;
      if (typeof v === "number" && v >= 1) setTimeoutMin(v);
    });
  }, []);

  async function saveTimeout(min: number) {
    setErr(null);
    setBusy(true);
    try {
      await walletClient.setIdleTimeoutMinutes(min);
      setTimeoutMin(min);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function lockNow() {
    try {
      const s = await walletClient.lock();
      onChange(s);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ color: "var(--text-strong)", fontSize: 12, fontWeight: 500 }}>
        Security
      </div>

      <div>
        <div style={fieldLabel}>Auto-lock after (minutes idle)</div>
        <div style={{ display: "flex", gap: 6 }}>
          {[5, 15, 30, 60, 240].map((m) => (
            <button
              key={m}
              style={{
                ...button(timeoutMin === m ? "primary" : "secondary"),
                padding: "5px 8px",
                fontSize: 11,
                width: "auto",
                flex: 1,
              }}
              onClick={() => saveTimeout(m)}
              disabled={busy}
            >
              {m < 60 ? `${m}m` : `${m / 60}h`}
            </button>
          ))}
        </div>
        <div style={{ ...subText, marginTop: 6, fontSize: 10 }}>
          Wallet locks automatically after this idle time. Browser
          restart also locks.
        </div>
      </div>

      {err && <div style={errorText}>{err}</div>}

      <button
        style={{ ...button("secondary"), padding: "8px 10px", fontSize: 12 }}
        onClick={lockNow}
      >
        Lock now
      </button>
    </div>
  );
}

function ThemeSection() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const cur =
      document.documentElement.getAttribute("data-theme") === "light"
        ? "light"
        : "dark";
    return cur;
  });

  // Restore from storage on first mount.
  useEffect(() => {
    chrome.storage.local.get(THEME_STORAGE_KEY).then((g) => {
      const stored = g[THEME_STORAGE_KEY];
      if (stored === "light" || stored === "dark") {
        applyTheme(stored);
        setTheme(stored);
      }
    });
  }, []);

  function applyTheme(t: "dark" | "light") {
    if (t === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function toggle(t: "dark" | "light") {
    applyTheme(t);
    setTheme(t);
    chrome.storage.local.set({ [THEME_STORAGE_KEY]: t });
  }

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ color: "var(--text-strong)", fontSize: 12, fontWeight: 500 }}>
        Theme
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          style={{
            ...button(theme === "dark" ? "primary" : "secondary"),
            padding: "6px 10px",
            fontSize: 12,
          }}
          onClick={() => toggle("dark")}
        >
          Dark
        </button>
        <button
          style={{
            ...button(theme === "light" ? "primary" : "secondary"),
            padding: "6px 10px",
            fontSize: 12,
          }}
          onClick={() => toggle("light")}
        >
          Light
        </button>
      </div>
      <div style={{ ...subText, fontSize: 10 }}>
        Light mode is alpha. Some screens may still need tuning;
        the design doc tracks remaining theme work.
      </div>
    </div>
  );
}

function ResetSection({
  onChange,
}: {
  onChange: (s: WalletStatus) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reset() {
    setErr(null);
    setBusy(true);
    try {
      const s = await walletClient.resetWallet();
      onChange(s);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        ...card,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        borderColor: "var(--error)",
      }}
    >
      <div style={{ color: "var(--error)", fontSize: 12, fontWeight: 500 }}>
        Danger zone
      </div>
      <div style={{ ...subText, fontSize: 11 }}>
        Resets the wallet: deletes all account metadata + the encrypted
        seed. You can recover only via your backed-up phrase.
      </div>
      {!confirming ? (
        <button
          style={button("danger")}
          onClick={() => setConfirming(true)}
        >
          Reset wallet
        </button>
      ) : (
        <>
          <div style={{ ...subText, fontSize: 11 }}>
            Type <strong>ERASE WALLET</strong> below to confirm:
          </div>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            style={input}
            placeholder="ERASE WALLET"
            autoFocus
          />
          {err && <div style={errorText}>{err}</div>}
          <div style={{ display: "flex", gap: 6 }}>
            <button
              style={button("secondary")}
              onClick={() => {
                setConfirming(false);
                setTyped("");
                setErr(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              style={{
                ...button("danger"),
                opacity: typed === "ERASE WALLET" && !busy ? 1 : 0.4,
                pointerEvents:
                  typed === "ERASE WALLET" && !busy ? "auto" : "none",
              }}
              onClick={reset}
            >
              {busy ? "Erasing..." : "Erase wallet"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
