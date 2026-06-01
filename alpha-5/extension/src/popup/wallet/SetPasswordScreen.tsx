// Shared post-mnemonic password setup.
//
// Both flows (generate + import) land here with a validated phrase.
// User picks a password; we call createWallet or importWallet on the
// background, which:
//   1. Encrypts the vault with the password (Argon2id + AES-GCM)
//   2. Persists it to chrome.storage.local
//   3. Leaves the wallet UNLOCKED so the popup can immediately navigate
//      to the dashboard.
//
// On success the parent gets the WalletStatus and re-renders the
// gated app shell.

import { useState } from "react";
import { KdfProgress } from "./KdfProgress";
import { walletClient, type WalletStatus } from "./walletClient";
import {
  screen,
  heading,
  subText,
  button,
  input,
  errorText,
  fieldLabel,
} from "./styles";

const MIN_PASSWORD_LEN = 8;

export function SetPasswordScreen({
  source,
  phrase,
  onSuccess,
  onBack,
}: {
  source: "generate" | "import";
  /// Validated phrase from the previous step. For the "generate"
  /// path the parent forwards what GenerateMnemonic produced; for
  /// "import" it's the validated phrase from ImportWallet. We pass
  /// it through to the background so the same entropy lands in the
  /// vault.
  phrase: string;
  onSuccess: (status: WalletStatus) => void;
  onBack: () => void;
}) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [bip39Passphrase, setBip39Passphrase] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (pw.length < MIN_PASSWORD_LEN) {
      setErr(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
      return;
    }
    if (pw !== confirm) {
      setErr("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const status =
        source === "generate"
          ? await walletClient.createWallet({
              password: pw,
              bip39Passphrase: bip39Passphrase || undefined,
            })
          : await walletClient.importWallet({
              password: pw,
              phrase,
              bip39Passphrase: bip39Passphrase || undefined,
            });
      onSuccess(status);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={screen}>
      <div style={heading}>Set a password</div>
      <div style={subText}>
        Used to encrypt your wallet on this device. We can't recover
        it — only your seed phrase can rebuild the wallet.
      </div>

      <div>
        <div style={fieldLabel}>Password</div>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          style={input}
          autoFocus
        />
      </div>

      <div>
        <div style={fieldLabel}>Confirm password</div>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          style={input}
        />
      </div>

      <button
        onClick={() => setShowAdvanced((v) => !v)}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--text-muted)",
          fontSize: 11,
          cursor: "pointer",
          textAlign: "left",
          padding: 0,
        }}
      >
        {showAdvanced ? "▾ Advanced" : "▸ Advanced"}
      </button>
      {showAdvanced && (
        <div>
          <div style={fieldLabel}>BIP-39 passphrase (optional 25th word)</div>
          <input
            type="text"
            value={bip39Passphrase}
            onChange={(e) => setBip39Passphrase(e.target.value)}
            style={input}
            placeholder="Leave blank if unsure"
            spellCheck={false}
          />
          <div style={{ ...subText, marginTop: 4, fontSize: 10 }}>
            Stretches the seed with an extra secret. If set, you'll
            need both the phrase and this passphrase to recover.
          </div>
        </div>
      )}

      {err && <div style={errorText}>{err}</div>}

      {busy ? (
        <div style={{ marginTop: "auto" }}>
          <KdfProgress label={source === "generate" ? "Encrypting your new wallet" : "Encrypting your imported wallet"} />
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
          <button style={button("secondary")} onClick={onBack}>
            Back
          </button>
          <button style={button("primary")} onClick={submit}>
            {source === "generate" ? "Create wallet" : "Import wallet"}
          </button>
        </div>
      )}
    </div>
  );
}
