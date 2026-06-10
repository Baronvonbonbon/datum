// Unlock screen — shown when a vault is persisted but in-memory key
// material is gone (browser restart, auto-lock, manual lock).

import { useState } from "react";
import { BrandMark } from "../BrandMark";
import { KdfProgress } from "./KdfProgress";
import { walletClient, type WalletStatus } from "./walletClient";
import {
  screen,
  heading,
  subText,
  button,
  input,
  errorText,
} from "./styles";

export function UnlockScreen({
  onUnlocked,
  onReset,
}: {
  onUnlocked: (status: WalletStatus) => void;
  /// "Forgot password?" route — destroys the vault so the user can
  /// re-import via mnemonic. Parent navigates to OnboardingFlow.
  onReset: () => void;
}) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      const status = await walletClient.unlock(pw);
      onUnlocked(status);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Argon2 KDF is slow; collapse the generic "bad-password" string
      // into a friendlier message but leave other errors raw so we can
      // diagnose them.
      if (msg.includes("bad-password")) {
        setErr("Wrong password. Try again.");
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={screen}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--text-muted)" }}>
          <BrandMark size={18} />
        </span>
        <div style={{ ...heading, marginBottom: 0, fontSize: 16 }}>
          Unlock wallet
        </div>
      </div>
      <div style={subText}>Enter your password to unlock this wallet.</div>

      <input
        type="password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !busy && pw) submit();
        }}
        style={input}
        autoFocus
        placeholder="Password"
      />

      {err && <div style={errorText}>{err}</div>}

      {busy ? (
        <KdfProgress label="Unlocking your wallet" />
      ) : (
        <button
          style={{
            ...button("primary"),
            opacity: pw ? 1 : 0.5,
            pointerEvents: pw ? "auto" : "none",
          }}
          onClick={submit}
        >
          Unlock
        </button>
      )}

      <div style={{ marginTop: "auto", textAlign: "center" }}>
        <button
          onClick={onReset}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 11,
            cursor: "pointer",
            padding: 0,
          }}
        >
          Forgot password? Reset wallet
        </button>
      </div>
    </div>
  );
}
