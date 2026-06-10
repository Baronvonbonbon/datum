// RecoverySection — G-8 time-locked recovery address setter
// rendered inside SettingsTab.
//
// Reads:
//   - PaymentVault.recoveryAddress(active)
//   - PaymentVault.recoveryEffectiveBlock(active)
//
// Writes:
//   - PaymentVault.setRecoveryAddress(addr) — stages new recovery,
//     starts the delay countdown.
//   - PaymentVault.cancelRecoveryAddress() — clears any pending or
//     active recovery (legitimate user reaction to an attacker
//     who compromised the hot key and tried to set their own
//     recovery).
//
// Per design doc §3.5 + the G-8 design committed in alpha-5
// commit 0a8c923. The default delay is 14_400 blocks (≈ 24h on
// Paseo at 6s).

import { useEffect, useState } from "react";
import { Interface, isAddress } from "ethers";
import { walletClient, type WalletStatus } from "./walletClient";
import {
  card,
  button,
  input,
  subText,
  fieldLabel,
  errorText,
  mono,
} from "./styles";
import addresses from "../../../deployed-addresses.json";

const PAYMENT_VAULT = (addresses as Record<string, string>).paymentVault;

const PV_IFACE = new Interface([
  "function recoveryAddress(address) view returns (address)",
  "function recoveryEffectiveBlock(address) view returns (uint64)",
  "function recoveryDelayBlocks() view returns (uint64)",
  "function setRecoveryAddress(address recovery)",
  "function cancelRecoveryAddress()",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

export function RecoverySection({ status }: { status: WalletStatus }) {
  const me = status.activeAddress;
  const [staged, setStaged] = useState<{
    recovery: string;
    effectiveBlock: bigint;
  } | null>(null);
  const [delayBlocks, setDelayBlocks] = useState<bigint | null>(null);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    (async () => {
      try {
        const [recHex, blockHex, delayHex] = await Promise.all([
          walletClient.ethCall({
            to: PAYMENT_VAULT,
            data: PV_IFACE.encodeFunctionData("recoveryAddress", [me]),
          }),
          walletClient.ethCall({
            to: PAYMENT_VAULT,
            data: PV_IFACE.encodeFunctionData("recoveryEffectiveBlock", [me]),
          }),
          walletClient.ethCall({
            to: PAYMENT_VAULT,
            data: PV_IFACE.encodeFunctionData("recoveryDelayBlocks", []),
          }),
        ]);
        if (cancelled) return;
        const [recovery] = PV_IFACE.decodeFunctionResult("recoveryAddress", recHex);
        const [effectiveBlock] = PV_IFACE.decodeFunctionResult(
          "recoveryEffectiveBlock",
          blockHex
        );
        const [delay] = PV_IFACE.decodeFunctionResult(
          "recoveryDelayBlocks",
          delayHex
        );
        setStaged({
          recovery: String(recovery).toLowerCase(),
          effectiveBlock: BigInt(effectiveBlock),
        });
        setDelayBlocks(BigInt(delay));
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me]);

  async function stage() {
    setErr(null);
    if (!isAddress(recoveryInput)) {
      setErr("Recovery address must be a valid 0x-prefixed 20-byte address.");
      return;
    }
    if (recoveryInput.toLowerCase() === me.toLowerCase()) {
      setErr("Recovery address must be different from the active account.");
      return;
    }
    setBusy(true);
    try {
      const data = PV_IFACE.encodeFunctionData("setRecoveryAddress", [
        recoveryInput,
      ]);
      await walletClient.sendContract({
        to: PAYMENT_VAULT,
        data,
        gasLimit: 100_000,
      });
      // Optimistic local update; refresh on next mount cycle.
      setStaged({
        recovery: recoveryInput.toLowerCase(),
        effectiveBlock: 0n, // we don't know the block; UI will refresh on next render
      });
      setRecoveryInput("");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setErr(null);
    setBusy(true);
    try {
      const data = PV_IFACE.encodeFunctionData("cancelRecoveryAddress", []);
      await walletClient.sendContract({
        to: PAYMENT_VAULT,
        data,
        gasLimit: 80_000,
      });
      setStaged({ recovery: ZERO, effectiveBlock: 0n });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const hasStaged = staged && staged.recovery !== ZERO && staged.recovery !== "";

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ color: "var(--text-strong)", fontSize: 12, fontWeight: 500 }}>
        Time-locked recovery address
      </div>
      <div style={{ ...subText, fontSize: 11 }}>
        Pre-register a cold wallet. After the {delayBlocks ? `${delayBlocks}-block` : "configured"} delay,
        the recovery address can pull all your PaymentVault balances
        to itself (anyone can trigger the pull on its behalf, but
        funds always go to the recovery).
      </div>

      {hasStaged ? (
        <div style={{ ...card, padding: "8px 10px", background: "var(--bg)" }}>
          <div style={fieldLabel}>Staged recovery</div>
          <div
            style={{
              ...mono,
              fontSize: 11,
              color: "var(--text-strong)",
              wordBreak: "break-all",
            }}
          >
            {staged!.recovery}
          </div>
          {staged!.effectiveBlock > 0n && (
            <div style={{ ...subText, fontSize: 10, marginTop: 4 }}>
              Active at block {staged!.effectiveBlock.toString()}
            </div>
          )}
          <button
            style={{
              ...button("danger"),
              padding: "5px 8px",
              fontSize: 11,
              marginTop: 8,
              opacity: busy ? 0.5 : 1,
              pointerEvents: busy ? "none" : "auto",
            }}
            onClick={cancel}
          >
            {busy ? "Cancelling..." : "Cancel staged recovery"}
          </button>
        </div>
      ) : (
        <div>
          <div style={fieldLabel}>Stage new recovery</div>
          <input
            value={recoveryInput}
            onChange={(e) => setRecoveryInput(e.target.value.trim())}
            placeholder="0x..."
            style={{
              ...input,
              fontFamily: "var(--font-mono, ui-monospace)",
              fontSize: 11,
            }}
            spellCheck={false}
          />
          <button
            style={{
              ...button("primary"),
              padding: "7px 10px",
              fontSize: 12,
              marginTop: 8,
              opacity: !busy && recoveryInput.length > 0 ? 1 : 0.4,
              pointerEvents: !busy && recoveryInput.length > 0 ? "auto" : "none",
            }}
            onClick={stage}
          >
            {busy ? "Staging..." : "Stage recovery address"}
          </button>
        </div>
      )}

      {err && <div style={errorText}>{err}</div>}

      <div style={{ ...subText, fontSize: 10, marginTop: 2 }}>
        Anti-attack: if a hot-key compromise stages a malicious
        recovery, you have the full delay window to cancel from this
        screen.
      </div>
    </div>
  );
}
