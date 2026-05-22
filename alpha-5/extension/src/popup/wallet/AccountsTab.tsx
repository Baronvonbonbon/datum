// Accounts tab — list, switch, add HD, import raw key.
//
// Note: balance lookups are intentionally deferred — pine is the only
// chain access path and we want to render the list synchronously even
// before pine warms up. SendTab + the header bar pull live balances
// for the active address only.

import { useState } from "react";
import { walletClient, type AccountMeta, type WalletStatus } from "./walletClient";
import { Blockie } from "./Blockie";
import {
  card,
  button,
  input,
  mono,
  heading,
  subText,
  fieldLabel,
  errorText,
} from "./styles";

export function AccountsTab({
  status,
  onChange,
}: {
  status: WalletStatus;
  onChange: (status: WalletStatus) => void;
}) {
  const [mode, setMode] = useState<"list" | "add-hd" | "add-import">("list");

  if (mode === "add-hd") {
    return (
      <AddHdAccountForm
        onCancel={() => setMode("list")}
        onDone={(s) => {
          onChange(s);
          setMode("list");
        }}
      />
    );
  }
  if (mode === "add-import") {
    return (
      <AddImportedForm
        onCancel={() => setMode("list")}
        onDone={(s) => {
          onChange(s);
          setMode("list");
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ ...heading, fontSize: 13 }}>Accounts</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {status.accounts.map((a, i) => (
          <AccountRow
            key={a.address}
            account={a}
            index={i}
            active={i === status.activeIndex}
            onPick={async () => {
              if (i === status.activeIndex) return;
              const s = await walletClient.setActiveAccount(i);
              onChange(s);
            }}
          />
        ))}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button
          style={{ ...button("secondary"), padding: "7px 10px", fontSize: 12 }}
          onClick={() => setMode("add-hd")}
        >
          + Add account
        </button>
        <button
          style={{ ...button("secondary"), padding: "7px 10px", fontSize: 12 }}
          onClick={() => setMode("add-import")}
        >
          Import key
        </button>
      </div>

      <div style={{ ...subText, marginTop: 4, fontSize: 10 }}>
        "Add account" derives the next HD account from your seed.
        "Import key" stores a separate raw private key — back this
        one up too; it isn't in your seed phrase.
      </div>
    </div>
  );
}

function AccountRow({
  account,
  index,
  active,
  onPick,
}: {
  account: AccountMeta;
  index: number;
  active: boolean;
  onPick: () => void;
}) {
  const truncated = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;
  const labelText = account.label || `Account ${index + 1}`;
  return (
    <div
      onClick={onPick}
      style={{
        ...card,
        padding: "8px 10px",
        cursor: active ? "default" : "pointer",
        borderColor: active ? "var(--accent)" : "var(--border)",
        background: active ? "var(--bg-surface)" : "transparent",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Blockie address={account.address} size={22} />
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ color: "var(--text-strong)", fontWeight: 500, fontSize: 12 }}>
              {labelText}
            </span>
            {account.source === "imported" && (
              <span style={{ fontSize: 9, color: "var(--warn)", letterSpacing: "0.05em" }}>
                imported
              </span>
            )}
          </div>
        </div>
        <span style={{ ...mono, fontSize: 11, color: "var(--text-muted)" }}>
          {truncated}
        </span>
      </div>
    </div>
  );
}

function AddHdAccountForm({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (s: WalletStatus) => void;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      const s = await walletClient.addHdAccount(label || undefined);
      onDone(s);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...heading, fontSize: 13 }}>Add HD account</div>
      <div style={subText}>
        Derives the next index from your seed phrase. You don't need a
        new backup — your existing phrase recovers this too.
      </div>
      <div>
        <div style={fieldLabel}>Label (optional)</div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={input}
          placeholder="e.g. Savings"
          maxLength={40}
        />
      </div>
      {err && <div style={errorText}>{err}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <button style={button("secondary")} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          style={{
            ...button("primary"),
            opacity: busy ? 0.6 : 1,
            pointerEvents: busy ? "none" : "auto",
          }}
          onClick={submit}
        >
          {busy ? "Deriving..." : "Add"}
        </button>
      </div>
    </div>
  );
}

function AddImportedForm({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (s: WalletStatus) => void;
}) {
  const [pk, setPk] = useState("");
  const [pw, setPw] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    const cleaned = pk.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(cleaned)) {
      setErr("Private key must be 0x-prefixed 64 hex characters.");
      return;
    }
    if (!pw) {
      setErr("Wallet password required to re-encrypt the vault.");
      return;
    }
    setBusy(true);
    try {
      const s = await walletClient.addImportedAccount({
        privateKey: cleaned,
        password: pw,
        label: label || undefined,
      });
      onDone(s);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // bad-password surfaces from the re-encrypt step.
      if (msg.includes("bad-password")) {
        setErr("Wrong wallet password.");
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...heading, fontSize: 13 }}>Import private key</div>
      <div style={subText}>
        Adds a standalone account alongside your HD wallet. This key
        is <strong>not</strong> part of your seed phrase — back it up
        separately.
      </div>
      <div>
        <div style={fieldLabel}>Private key (0x...)</div>
        <input
          value={pk}
          onChange={(e) => setPk(e.target.value)}
          style={{ ...input, fontFamily: "var(--font-mono)", fontSize: 11 }}
          placeholder="0x..."
          spellCheck={false}
        />
      </div>
      <div>
        <div style={fieldLabel}>Wallet password (to re-encrypt vault)</div>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          style={input}
        />
      </div>
      <div>
        <div style={fieldLabel}>Label (optional)</div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={input}
          placeholder="e.g. Cold wallet"
          maxLength={40}
        />
      </div>
      {err && <div style={errorText}>{err}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <button style={button("secondary")} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          style={{
            ...button("primary"),
            opacity: busy ? 0.6 : 1,
            pointerEvents: busy ? "none" : "auto",
          }}
          onClick={submit}
        >
          {busy ? "Importing..." : "Import"}
        </button>
      </div>
    </div>
  );
}
