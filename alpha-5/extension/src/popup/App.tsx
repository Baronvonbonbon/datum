// Stage 1c popup shell — gated entirely on the new self-contained
// wallet's state machine. Three top-level routes:
//
//   no-vault → OnboardingFlow (generate or import)
//   locked   → UnlockScreen (password)
//   unlocked → Dashboard (Accounts / Send / Receive / Settings tabs)
//
// The previous App.tsx lives at App.legacy.tsx for reference until
// the existing claim/earnings/filters/reports tabs are migrated to
// the new wallet (Stage 1d).

import { useState, useEffect, useCallback } from "react";
import { BrandMark } from "./BrandMark";
import { OnboardingFlow } from "./wallet/OnboardingFlow";
import { UnlockScreen } from "./wallet/UnlockScreen";
import { AccountsTab } from "./wallet/AccountsTab";
import { SendTab } from "./wallet/SendTab";
import { ReceiveTab } from "./wallet/ReceiveTab";
import { SettingsTab } from "./wallet/SettingsTab";
import { EarningsTab } from "./wallet/EarningsTab";
import { TxHistoryTab } from "./wallet/TxHistoryTab";
import { PollStatusBar } from "./PollStatusBar";
import { ClaimQueue } from "./ClaimQueue";
import {
  PermissionRequest,
  usePendingPermission,
} from "./wallet/PermissionRequest";
import { walletClient, type WalletStatus } from "./wallet/walletClient";

type Tab =
  | "accounts"
  | "send"
  | "receive"
  | "claims"
  | "history"
  | "earnings"
  | "settings";

// Six-tab layout — labels stay short to fit the 360px popup at
// ~10px per label. Earnings is the protocol-side catch-all per
// design doc §3.5; Accounts / Send / Receive are the wallet
// primitives; History is the broadcast-TX log; Settings hosts
// AssuranceSection + RecoverySection alongside theme + permissions.
const TAB_LABELS: Record<Tab, string> = {
  accounts: "Accounts",
  send: "Send",
  receive: "Receive",
  claims: "Claims",
  history: "History",
  earnings: "Earnings",
  settings: "Settings",
};

export function App() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [bootErr, setBootErr] = useState<string | null>(null);

  // Pull initial status on mount + restore persisted theme.
  useEffect(() => {
    // Apply persisted theme synchronously before paint so the first
    // render uses the right tokens.
    chrome.storage.local.get("walletTheme").then((g) => {
      if (g.walletTheme === "light") {
        document.documentElement.setAttribute("data-theme", "light");
      }
    });
    walletClient
      .getStatus()
      .then(setStatus)
      .catch((err) => setBootErr(String(err?.message ?? err)));
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await walletClient.getStatus());
    } catch (err: any) {
      setBootErr(String(err?.message ?? err));
    }
  }, []);

  // Mirror the active unlocked account to the background as `connectedAddress`.
  // The legacy popup emitted WALLET_CONNECTED on unlock/create/switch; the
  // wallet-shell refactor dropped it, so connectedAddress never updated — which
  // left anything keyed on it stuck (the demo ad slot's "connect a wallet to
  // serve ads", the earnings listener, etc.). Restore it here.
  const activeAddress =
    status?.state === "unlocked" ? status.accounts[status.activeIndex]?.address ?? null : null;
  useEffect(() => {
    const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
    if (activeAddress) {
      runtime?.sendMessage?.({ type: "WALLET_CONNECTED", address: activeAddress.toLowerCase() });
    } else if (status?.state === "locked") {
      runtime?.sendMessage?.({ type: "WALLET_DISCONNECTED" });
    }
  }, [activeAddress, status?.state]);

  if (bootErr) {
    return (
      <div style={{ padding: 16, color: "var(--error)", fontSize: 12 }}>
        Wallet error: {bootErr}
      </div>
    );
  }
  if (!status) {
    return (
      <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12 }}>
        Loading…
      </div>
    );
  }

  if (status.state === "no-vault") {
    return <OnboardingFlow onSuccess={setStatus} />;
  }
  if (status.state === "locked") {
    return (
      <UnlockScreen
        onUnlocked={setStatus}
        onReset={async () => {
          // Erase the vault, return to onboarding. We don't prompt
          // here because the UnlockScreen's "Forgot password?" link
          // is itself the affordance; the parent confirms by the
          // intent.
          const next = await walletClient.resetWallet();
          setStatus(next);
        }}
      />
    );
  }

  return (
    <UnlockedShell status={status} onChange={setStatus} refresh={refresh} />
  );
}

/// Wraps the Dashboard with the pending-permission overlay so dApp
/// connection requests interrupt the active tab. Polling is gated on
/// the unlocked state — locked wallets can't grant permissions, and a
/// locked wallet auto-denies any in-flight requests (see unlock.lock).
function UnlockedShell({
  status,
  onChange,
  refresh,
}: {
  status: WalletStatus;
  onChange: (s: WalletStatus) => void;
  refresh: () => void;
}) {
  const { pending, refresh: refreshPending } = usePendingPermission({
    enabled: status.state === "unlocked",
  });

  if (pending) {
    return <PermissionRequest pending={pending} onResolved={refreshPending} />;
  }
  return <Dashboard status={status} onChange={onChange} refresh={refresh} />;
}

function Dashboard({
  status,
  onChange,
  refresh,
}: {
  status: WalletStatus;
  onChange: (s: WalletStatus) => void;
  refresh: () => void;
}) {
  const [tab, setTab] = useState<Tab>("accounts");

  // Periodically refresh so balances + auto-lock countdown stay
  // current without a manual refresh.
  useEffect(() => {
    const id = setInterval(refresh, 6_000);
    return () => clearInterval(id);
  }, [refresh]);

  const active = status.accounts[status.activeIndex];
  const truncated = active
    ? `${active.address.slice(0, 6)}…${active.address.slice(-4)}`
    : "—";

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 480 }}>
      {/* Header — brand + active account + lock button. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-surface)",
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>
          <BrandMark size={14} />
        </span>
        <span
          style={{
            color: "var(--text-strong)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: "0.06em",
          }}
        >
          DATUM
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {active?.label || `Account ${status.activeIndex + 1}`}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--text-muted)",
            background: "var(--bg)",
            padding: "2px 6px",
            borderRadius: 3,
            border: "1px solid var(--border)",
          }}
        >
          {truncated}
        </span>
      </div>

      {/* Live campaign-poll progress (Pine or RPC path) */}
      <PollStatusBar />

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-surface)",
        }}
      >
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              borderBottom:
                tab === t ? "2px solid var(--accent)" : "2px solid transparent",
              color: tab === t ? "var(--text-strong)" : "var(--text-muted)",
              fontSize: 11,
              fontWeight: 500,
              padding: "9px 0",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Tab body */}
      <div style={{ padding: "12px 14px", flex: 1 }}>
        {tab === "accounts" && (
          <AccountsTab status={status} onChange={onChange} />
        )}
        {tab === "send" && <SendTab status={status} />}
        {tab === "receive" && <ReceiveTab status={status} />}
        {tab === "claims" && <ClaimQueue address={active?.address ?? ""} onSettled={refresh} />}
        {tab === "history" && <TxHistoryTab status={status} />}
        {tab === "earnings" && <EarningsTab status={status} />}
        {tab === "settings" && (
          <SettingsTab status={status} onChange={onChange} />
        )}
      </div>
    </div>
  );
}
