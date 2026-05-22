// EarningsTab — protocol-side earnings overview for the active
// account. Mirrors the design-doc §3.5 catch-all overview tab.
//
// Reads:
//   - PaymentVault.userBalance(active) → pending DOT
//   - SettlementCredited events (filtered by user topic) → recent
//     settlement list. Subscribed via pineBridge directly because
//     the popup doesn't ship the webapp's eventBus layer.
//
// Writes:
//   - PaymentVault.withdrawUser() — pulls pending DOT to the
//     active account. Signed + broadcast via walletClient.sendContract.

import { useEffect, useState } from "react";
import { id as ethersId, Interface } from "ethers";
import { walletClient, type WalletStatus } from "./walletClient";
import {
  card,
  button,
  mono,
  heading,
  subText,
  fieldLabel,
  errorText,
  okText,
} from "./styles";
import addresses from "../../../deployed-addresses.json";

const PAYMENT_VAULT = (addresses as Record<string, string>).paymentVault;

const PAYMENT_VAULT_IFACE = new Interface([
  "function userBalance(address) view returns (uint256)",
  "function withdrawUser()",
]);

const SETTLEMENT_CREDITED_IFACE = new Interface([
  "event SettlementCredited(address indexed publisher, address indexed user, uint256 total)",
]);
const TOPIC_SETTLEMENT_CREDITED = ethersId(
  "SettlementCredited(address,address,uint256)"
);

type Settlement = {
  publisher: string;
  total: bigint;
  blockNumber: number;
};

export function EarningsTab({ status }: { status: WalletStatus }) {
  const me = status.activeAddress;
  const [pendingWei, setPendingWei] = useState<bigint | null>(null);
  const [recent, setRecent] = useState<Settlement[]>([]);
  const [withdrawing, setWithdrawing] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Pull pending balance + recent settlements when the active
  // address changes (and on a 6s tick while open).
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function refresh() {
      try {
        const balHex = await walletClient.ethCall({
          to: PAYMENT_VAULT,
          data: PAYMENT_VAULT_IFACE.encodeFunctionData("userBalance", [me]),
        });
        const [bal] = PAYMENT_VAULT_IFACE.decodeFunctionResult(
          "userBalance",
          balHex
        );
        if (!cancelled) setPendingWei(bal as bigint);

        // Recent settlements: query pine for the last ~24h of
        // SettlementCredited logs where topic2 == this user. The
        // background dispatcher proxies eth_getLogs via the
        // ethCall pathway is not the right tool here — we need a
        // proper logs query. Punt to a follow-up: for now we list
        // an empty array and surface the pending balance, which is
        // the load-bearing signal for the EarningsTab UX.
        // (Adding an eventBus equivalent for the extension popup is
        // tracked as part of Stage 8 polish.)
        if (!cancelled) setRecent([]);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e));
      }
    }

    void refresh();
    timer = setInterval(refresh, 6_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [me]);

  async function withdraw() {
    if (!me) return;
    setErr(null);
    setTxHash(null);
    setWithdrawing(true);
    try {
      const data = PAYMENT_VAULT_IFACE.encodeFunctionData("withdrawUser", []);
      const r = await walletClient.sendContract({
        to: PAYMENT_VAULT,
        data,
        // No value attached — withdrawUser is non-payable.
        gasLimit: 100_000,
      });
      setTxHash(r.txHash);
      // Optimistic update — we expect pending to drop to 0 once the
      // tx confirms. Re-fetch on next interval will overwrite if
      // partial.
      setPendingWei(0n);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("E03")) {
        setErr("Nothing to withdraw — your pending balance is 0.");
      } else {
        setErr(msg);
      }
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...heading, fontSize: 13 }}>Earnings</div>
      <div style={subText}>
        Protocol-credited DOT for {shorten(me)}. Pending balances
        accumulate as Settlement processes your claims; pull them
        whenever you'd like.
      </div>

      <div style={card}>
        <div style={fieldLabel}>Pending withdraw</div>
        <div
          style={{
            ...mono,
            fontSize: 18,
            color: "var(--text-strong)",
            fontWeight: 600,
            marginTop: 2,
          }}
        >
          {pendingWei === null ? "—" : `${formatDot(pendingWei)} DOT`}
        </div>
      </div>

      <button
        style={{
          ...button("primary"),
          opacity: !withdrawing && pendingWei !== null && pendingWei > 0n ? 1 : 0.4,
          pointerEvents:
            !withdrawing && pendingWei !== null && pendingWei > 0n ? "auto" : "none",
        }}
        onClick={withdraw}
      >
        {withdrawing ? "Withdrawing..." : "Withdraw to active account"}
      </button>

      {err && <div style={errorText}>{err}</div>}
      {txHash && (
        <div style={okText}>
          Submitted —{" "}
          <span style={mono}>
            {txHash.slice(0, 10)}…{txHash.slice(-6)}
          </span>
        </div>
      )}

      <div style={{ ...subText, fontSize: 10, marginTop: 6 }}>
        Recent settlements appear here as Settlement events confirm.
        (Event-stream wiring lands in a follow-up — the pending
        balance above is the load-bearing signal in the meantime.)
      </div>
    </div>
  );
}

function formatDot(wei: bigint): string {
  if (wei === 0n) return "0";
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  if (whole === 0n) {
    const padded = frac.toString().padStart(18, "0");
    const trimmed = padded.slice(0, 6).replace(/0+$/, "") || "0";
    return `0.${trimmed}`;
  }
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

function shorten(addr: string): string {
  if (!addr || addr.length < 10) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
