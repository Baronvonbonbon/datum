// Send tab — native DOT (PAS on testnet) send via the offscreen
// wallet's signing path. ERC-20 + sidecar sends come in a follow-up
// once token discovery lands (see design doc §9.5).
//
// Flow:
//   1. User enters recipient + amount.
//   2. We fetch pine's current gas-price + estimateGas.
//   3. Display the total cost (amount + fee).
//   4. User confirms → walletClient.sendNative → background signs and
//      broadcasts. Returns the tx hash + nonce.

import { useState, useEffect } from "react";
import { walletClient, type WalletStatus } from "./walletClient";
import { formatDOT, weiToPlanck } from "@shared/dot";
import {
  card,
  button,
  input,
  heading,
  subText,
  fieldLabel,
  mono,
  errorText,
  okText,
} from "./styles";

// Paseo testnet chain id (per deployed-addresses).
const PASEO_CHAIN_ID = 420420417;
const NATIVE_TRANSFER_GAS = 21000;

export function SendTab({ status }: { status: WalletStatus }) {
  const [to, setTo] = useState("");
  const [amountDot, setAmountDot] = useState("");
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [gasPriceWei, setGasPriceWei] = useState<bigint | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Pull balance + gas price on mount + on account change. We tolerate
  // pine still warming up; the UI shows "—" until results arrive.
  useEffect(() => {
    if (!status.activeAddress) return;
    let cancelled = false;
    walletClient
      .getNativeBalance(status.activeAddress)
      .then((hex) => {
        if (!cancelled) setBalanceWei(BigInt(hex));
      })
      .catch(() => undefined);
    // gas price via pineRpc indirectly — we add a small helper in
    // walletClient for read-only RPC pass-throughs? For now use
    // signTransaction's defaults (caller supplies maxFeePerGas).
    // Pine returns a hardcoded gasPrice (10^12 wei/gas on Paseo).
    chrome.runtime.sendMessage(
      {
        type: "WALLET_RPC_REQUEST",
        requestId: `gas-${Date.now()}`,
        op: "getNativeBalance",
        args: { address: status.activeAddress },
      },
      () => undefined
    );
    // Direct pine call would need its own op; for stage 1c we hardcode
    // the Paseo gas price (matches pine's `eth_gasPrice` constant).
    setGasPriceWei(BigInt("0xe8d4a51000"));
    return () => {
      cancelled = true;
    };
  }, [status.activeAddress]);

  const valid = isValidAddress(to) && isPositiveAmount(amountDot);
  const valueWei = isPositiveAmount(amountDot) ? dotToWei(amountDot) : null;
  const feeWei =
    gasPriceWei !== null
      ? gasPriceWei * BigInt(NATIVE_TRANSFER_GAS)
      : null;
  const totalWei =
    valueWei !== null && feeWei !== null ? valueWei + feeWei : null;
  const insufficient =
    balanceWei !== null && totalWei !== null && totalWei > balanceWei;

  async function submit() {
    setErr(null);
    setTxHash(null);
    if (!valid || valueWei === null || gasPriceWei === null) return;
    if (insufficient) {
      setErr("Insufficient balance for amount + fee.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await walletClient.sendNative({
        to,
        valueWei: valueWei.toString(),
        chainId: PASEO_CHAIN_ID,
        gasLimit: NATIVE_TRANSFER_GAS,
        maxFeePerGas: gasPriceWei.toString(),
        maxPriorityFeePerGas: gasPriceWei.toString(),
      });
      setTxHash(result.txHash);
      setAmountDot("");
      setTo("");
      // Refresh balance after broadcast.
      try {
        const fresh = await walletClient.getNativeBalance(status.activeAddress);
        setBalanceWei(BigInt(fresh));
      } catch {
        // ignore
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...heading, fontSize: 13 }}>Send DOT</div>
      <div style={subText}>
        Native transfer on Polkadot Hub. ERC-20 + sidecar tokens coming next.
      </div>

      <div style={card}>
        <div style={fieldLabel}>From</div>
        <div style={{ ...mono, fontSize: 11, color: "var(--text-strong)" }}>
          {status.activeAddress}
        </div>
        <div style={{ ...subText, marginTop: 6 }}>
          Balance:{" "}
          <span style={{ ...mono, color: "var(--text-strong)" }}>
            {balanceWei === null
              ? "—"
              : `${formatDOT(weiToPlanck(balanceWei))} PAS`}
          </span>
        </div>
      </div>

      <div>
        <div style={fieldLabel}>Recipient</div>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value.trim())}
          style={{ ...input, fontFamily: "var(--font-mono)", fontSize: 11 }}
          placeholder="0x..."
          spellCheck={false}
        />
      </div>

      <div>
        <div style={fieldLabel}>Amount (PAS)</div>
        <input
          value={amountDot}
          onChange={(e) => setAmountDot(e.target.value)}
          style={input}
          placeholder="0.0"
          inputMode="decimal"
        />
      </div>

      {totalWei !== null && (
        <div style={{ ...subText, ...mono, fontSize: 11 }}>
          Fee: {feeWei !== null ? `${formatDOT(weiToPlanck(feeWei))} PAS` : "—"}
          {" · Total: "}
          {`${formatDOT(weiToPlanck(totalWei))} PAS`}
        </div>
      )}

      {insufficient && <div style={errorText}>Insufficient balance.</div>}
      {err && <div style={errorText}>{err}</div>}
      {txHash && (
        <div style={okText}>
          Submitted —{" "}
          <span style={mono}>
            {txHash.slice(0, 10)}…{txHash.slice(-6)}
          </span>
        </div>
      )}

      <button
        style={{
          ...button("primary"),
          opacity: valid && !submitting && !insufficient ? 1 : 0.4,
          pointerEvents:
            valid && !submitting && !insufficient ? "auto" : "none",
        }}
        onClick={submit}
      >
        {submitting ? "Sending..." : "Send"}
      </button>
    </div>
  );
}

function isValidAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function isPositiveAmount(s: string): boolean {
  const n = Number(s);
  return Number.isFinite(n) && n > 0;
}

function dotToWei(s: string): bigint {
  // Polkadot Hub native (DOT/PAS) is denominated in 10^18 wei in the
  // EVM-compatible view exposed by pallet-revive. We parse the decimal
  // string in big-int fashion to avoid IEEE-754 rounding for small
  // values like "0.001".
  const [int, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(int) * 10n ** 18n + BigInt(fracPadded || "0");
}
