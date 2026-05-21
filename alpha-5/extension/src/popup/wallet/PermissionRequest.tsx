// Pending-permission approval overlay.
//
// Polls walletClient.getPendingPermission every second while the
// popup is open. When a request appears, the dApp's origin is shown
// with Approve / Deny buttons. Either choice resolves the awaiting
// Promise on the content-script side; the dApp gets either the
// address or a `User Rejected` (4001) error.
//
// Rendered above all other popup screens by App.tsx — the user can't
// browse the wallet while a request is pending. That's a deliberate
// UX: dApp connection requests are interrupting and should be
// resolved promptly.

import { useEffect, useState } from "react";
import { BrandMark } from "../BrandMark";
import { walletClient, type PendingPermission } from "./walletClient";
import { screen, heading, subText, button, card, mono } from "./styles";

const POLL_INTERVAL_MS = 1_000;

export function PermissionRequest({
  pending,
  onResolved,
}: {
  pending: PendingPermission;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function approve() {
    setBusy(true);
    try {
      await walletClient.approvePendingPermission(pending.id);
    } finally {
      // Always clear the overlay — even if the call errored, the queue
      // entry may have been resolved by the timeout. The parent
      // re-polls and reconciles.
      setBusy(false);
      onResolved();
    }
  }

  async function deny() {
    setBusy(true);
    try {
      await walletClient.denyPendingPermission(pending.id);
    } finally {
      setBusy(false);
      onResolved();
    }
  }

  const ageSec = Math.max(0, Math.floor((Date.now() - pending.createdAt) / 1000));

  return (
    <div style={screen}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--text-muted)" }}>
          <BrandMark size={18} />
        </span>
        <div style={{ ...heading, marginBottom: 0, fontSize: 15 }}>
          Connection request
        </div>
      </div>
      <div style={subText}>
        A website wants to connect to your DATUM wallet.
      </div>

      <div style={card}>
        <div
          style={{
            ...mono,
            fontSize: 12,
            color: "var(--text-strong)",
            wordBreak: "break-all",
          }}
        >
          {pending.origin}
        </div>
        <div style={{ ...subText, marginTop: 6, fontSize: 10 }}>
          Pending for {ageSec}s · auto-times-out at 60s
        </div>
      </div>

      <div style={{ ...subText, fontSize: 11 }}>
        Once approved, this origin can:
      </div>
      <ul style={{ ...subText, fontSize: 11, paddingLeft: 16, lineHeight: 1.7 }}>
        <li>See your active account address</li>
        <li>Request signatures (you'll still confirm in this popup)</li>
        <li>Make read-only chain queries via Pine</li>
      </ul>
      <div style={{ ...subText, fontSize: 10, marginTop: 2 }}>
        You can revoke access any time from Settings → Permissions.
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
        <button
          style={{ ...button("secondary"), opacity: busy ? 0.6 : 1, pointerEvents: busy ? "none" : "auto" }}
          onClick={deny}
        >
          Deny
        </button>
        <button
          style={{ ...button("primary"), opacity: busy ? 0.6 : 1, pointerEvents: busy ? "none" : "auto" }}
          onClick={approve}
        >
          {busy ? "Approving..." : "Approve"}
        </button>
      </div>
    </div>
  );
}

/// Hook the popup mounts so that whenever a pending request lands the
/// overlay supersedes the active tab. Returns the head of the queue
/// (or null) and a callback to invalidate after approve/deny so the
/// next poll fetches the new head.
export function usePendingPermission(opts: { enabled: boolean }): {
  pending: PendingPermission | null;
  refresh: () => void;
} {
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [bumper, setBumper] = useState(0);

  useEffect(() => {
    if (!opts.enabled) {
      setPending(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const next = await walletClient.getPendingPermission();
        if (!cancelled) setPending(next);
      } catch {
        // Background may be transiently unavailable; ignore + retry.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [opts.enabled, bumper]);

  return {
    pending,
    refresh: () => setBumper((n) => n + 1),
  };
}
