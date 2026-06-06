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
//   - PaymentVault.withdrawUser() — pulls pending DOT to the active
//     account. Signed + broadcast via walletClient.sendContract (the
//     active account pays gas).
//   - Gasless relay withdrawal — the user signs a DatumPaymentVault
//     WithdrawAuth (EIP-712, no gas); the relay submits
//     withdrawUserBySig on-chain, pays the gas, and takes a fee
//     (feeBps% of the balance) out of the withdrawn earnings. For an
//     account with no native balance this is the only way to pull.

import { useEffect, useState } from "react";
import { id as ethersId, Interface } from "ethers";
import { walletClient, type WalletStatus } from "./walletClient";
import { getProvider } from "@shared/contracts";
import { DEFAULT_SETTINGS } from "@shared/networks";
import type { StoredSettings } from "@shared/types";
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

// EIP-712 WithdrawAuth — must match DatumPaymentVault.WITHDRAW_AUTH_TYPEHASH
// and the relay's WITHDRAW_AUTH_TYPES byte-for-byte.
const WITHDRAW_AUTH_TYPES = {
  WithdrawAuth: [
    { name: "user", type: "address" },
    { name: "recipient", type: "address" },
    { name: "maxFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

type RelayWithdrawInfo = {
  ok: boolean;
  reason?: string;
  nonce: string;
  userBalancePlanck: string;
  feeBps: number;
  recommendedMaxFeePlanck: string;
  netPlanck: string;
  vault: string;
};

async function loadSettings(): Promise<StoredSettings> {
  const stored = await chrome.storage.local.get("settings");
  return stored.settings ?? DEFAULT_SETTINGS;
}

// The gasless relay is a publisher's relay. Its host is stored per-publisher
// under `publisherDomain:<addr>` when the user signs-for-publisher; for a
// withdrawal any configured relay works (they all submit to the same vault).
// Pick the first. Localhost is reached over http, everything else over https.
async function resolveRelayUrl(): Promise<string | null> {
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("publisherDomain:") && typeof v === "string" && v) {
      const scheme = /^(localhost|127\.0\.0\.1)/.test(v) ? "http" : "https";
      return `${scheme}://${v}`;
    }
  }
  return null;
}

// HMAC headers for the relay's controlled-exposure gate (matches ClaimQueue +
// the relay's auth.mjs: X-Datum-Sig = HMAC-SHA256(secret, `${ts}.${body}`)).
async function relayHmacHeaders(secret: string | undefined, body: string): Promise<Record<string, string>> {
  if (!secret) return {};
  const ts = Math.floor(Date.now() / 1000).toString();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${body}`));
  const sig = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { "x-datum-ts": ts, "x-datum-sig": sig };
}

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
  // Gasless relay state. `relayInfo` is the fee preview from /withdraw-info,
  // refreshed alongside the balance; null = no relay configured or it's down /
  // not upgraded (the gasless option then stays hidden).
  const [relayInfo, setRelayInfo] = useState<RelayWithdrawInfo | null>(null);
  const [relayWithdrawing, setRelayWithdrawing] = useState(false);
  // Native PAS balance of the active account (spendable holdings, separate from
  // the protocol-credited pending earnings below).
  const [walletWei, setWalletWei] = useState<bigint | null>(null);

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

        // Native PAS holdings of the active account.
        try {
          const natHex = await walletClient.getNativeBalance(me);
          if (!cancelled) setWalletWei(BigInt(natHex));
        } catch { /* keep prior value on transient RPC error */ }

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

        // Best-effort: ask a configured relay what it would charge to submit a
        // gasless withdrawal. Failures (no relay, relay down, vault not
        // upgraded) just hide the gasless option — they never surface as errors.
        try {
          const relayUrl = await resolveRelayUrl();
          if (relayUrl && me) {
            const resp = await fetch(`${relayUrl}/withdraw-info?user=${me}`, {
              signal: AbortSignal.timeout(8000),
            });
            const j = (await resp.json()) as RelayWithdrawInfo;
            if (!cancelled) setRelayInfo(j?.ok ? j : null);
          } else if (!cancelled) {
            setRelayInfo(null);
          }
        } catch {
          if (!cancelled) setRelayInfo(null);
        }
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

  // Gasless: sign a WithdrawAuth off-chain and let the relay submit it on-chain.
  // The relay pays gas and takes feeBps% (its recommendedMaxFee) out of the
  // withdrawn balance; the user receives the net and never needs native funds.
  async function withdrawViaRelay() {
    if (!me) return;
    setErr(null);
    setTxHash(null);
    setRelayWithdrawing(true);
    try {
      const settings = await loadSettings();
      const relayUrl = await resolveRelayUrl();
      if (!relayUrl) {
        throw new Error(
          "No relay configured. Sign for a publisher once (Claims tab) to register one, or use the gas-paying withdraw above."
        );
      }

      // Re-fetch on-chain bits at submit time: the nonce must be current or the
      // contract rejects the signature (E82).
      const infoResp = await fetch(`${relayUrl}/withdraw-info?user=${me}`, {
        signal: AbortSignal.timeout(10000),
      });
      const info = (await infoResp.json()) as RelayWithdrawInfo;
      if (!info?.ok) throw new Error(`relay: ${info?.reason ?? "withdraw-info failed"}`);
      const balance = BigInt(info.userBalancePlanck ?? "0");
      if (balance === 0n) throw new Error("Nothing to withdraw — your pending balance is 0.");
      const maxFee = BigInt(info.recommendedMaxFeePlanck ?? "0");

      // deadline is a block number (contract checks block.number <= deadline).
      const provider = getProvider(settings.rpcUrl);
      const [block, net] = await Promise.all([provider.getBlockNumber(), provider.getNetwork()]);
      const deadline = BigInt(block + 100); // ~10 min at 6s blocks
      const chainId = Number(net.chainId);

      const domain = {
        name: "DatumPaymentVault",
        version: "1",
        chainId,
        verifyingContract: info.vault,
      };
      const value = {
        user: me,
        recipient: me, // net lands back in the same account
        maxFee: maxFee.toString(),
        nonce: String(info.nonce),
        deadline: deadline.toString(),
      };
      const sig = await walletClient.signTypedData({ domain, types: WITHDRAW_AUTH_TYPES, value });

      const body = JSON.stringify({
        user: me,
        recipient: me,
        maxFee: maxFee.toString(),
        deadline: deadline.toString(),
        sig,
      });
      const headers = {
        "Content-Type": "application/json",
        ...(await relayHmacHeaders(settings.relayHmacSecret, body)),
      };
      const resp = await fetch(`${relayUrl}/withdraw`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(20000),
      });
      const out = await resp.json();
      if (!out?.ok) throw new Error(`relay: ${out?.reason ?? "submit failed"}`);
      setTxHash(out.hash);
      setPendingWei(0n); // optimistic — refresh overwrites on the next tick
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setRelayWithdrawing(false);
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
        <div style={fieldLabel}>Wallet balance</div>
        <div
          style={{
            ...mono,
            fontSize: 18,
            color: "var(--text-strong)",
            fontWeight: 600,
            marginTop: 2,
          }}
        >
          {walletWei === null ? "—" : `${formatDot(walletWei)} PAS`}
        </div>
        <div style={{ ...subText, fontSize: 10, marginTop: 2 }}>
          Spendable native balance of {shorten(me)}. Withdrawn earnings land here.
        </div>
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

      {/* Gasless relay withdrawal — only offered when a relay is configured,
          reachable, and running an upgraded vault (relayInfo populated). */}
      {relayInfo && pendingWei !== null && pendingWei > 0n && (
        <>
          <div style={{ ...subText, fontSize: 10, marginTop: -2 }}>
            No gas? The relay can submit for you, charging{" "}
            {(relayInfo.feeBps / 100).toFixed(relayInfo.feeBps % 100 === 0 ? 0 : 2)}% (
            {formatDot(BigInt(relayInfo.recommendedMaxFeePlanck))} DOT) from your
            earnings — you receive {formatDot(BigInt(relayInfo.netPlanck))} DOT and
            pay nothing.
          </div>
          <button
            style={{
              ...button("secondary"),
              opacity: !relayWithdrawing && !withdrawing ? 1 : 0.4,
              pointerEvents: !relayWithdrawing && !withdrawing ? "auto" : "none",
            }}
            onClick={withdrawViaRelay}
          >
            {relayWithdrawing ? "Submitting via relay…" : "Withdraw via relay (gasless)"}
          </button>
        </>
      )}

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
