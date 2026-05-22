// AssuranceSection — userMinAssurance setter rendered inside
// SettingsTab. Reads Settlement.userMinAssurance(active); writes
// via Settlement.setUserMinAssurance(level) signed by the active
// wallet account.
//
// L0 — public claims (cheapest, most events)
// L1 — publisher-signed (default for most users)
// L2 — dual-signed (publisher + advertiser cosign)
// L3 — ZK-only (privacy-maximalist; reduces revenue)

import { useEffect, useState } from "react";
import { Interface } from "ethers";
import { walletClient, type WalletStatus } from "./walletClient";
import {
  card,
  button,
  subText,
  fieldLabel,
  errorText,
} from "./styles";
import addresses from "../../../deployed-addresses.json";

const SETTLEMENT = (addresses as Record<string, string>).settlement;

const SETTLEMENT_IFACE = new Interface([
  "function userMinAssurance(address) view returns (uint8)",
  "function setUserMinAssurance(uint8 level)",
]);

const LEVELS: Array<{ value: 0 | 1 | 2 | 3; label: string; description: string }> = [
  { value: 0, label: "L0", description: "Public — all claims" },
  { value: 1, label: "L1", description: "Publisher-signed (default)" },
  { value: 2, label: "L2", description: "Dual-signed (advertiser cosign)" },
  { value: 3, label: "L3", description: "ZK-only (privacy-max)" },
];

export function AssuranceSection({ status }: { status: WalletStatus }) {
  const me = status.activeAddress;
  const [current, setCurrent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    walletClient
      .ethCall({
        to: SETTLEMENT,
        data: SETTLEMENT_IFACE.encodeFunctionData("userMinAssurance", [me]),
      })
      .then((hex) => {
        if (cancelled) return;
        const [lvl] = SETTLEMENT_IFACE.decodeFunctionResult(
          "userMinAssurance",
          hex
        );
        setCurrent(Number(lvl));
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [me]);

  async function pick(level: 0 | 1 | 2 | 3) {
    if (level === current) return;
    setErr(null);
    setBusy(true);
    try {
      const data = SETTLEMENT_IFACE.encodeFunctionData(
        "setUserMinAssurance",
        [level]
      );
      await walletClient.sendContract({
        to: SETTLEMENT,
        data,
        gasLimit: 80_000,
      });
      setCurrent(level);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ color: "var(--text-strong)", fontSize: 12, fontWeight: 500 }}>
        AssuranceLevel
      </div>
      <div style={{ ...subText, fontSize: 11 }}>
        The minimum trust level Settlement enforces on your claims.
        Higher levels reject lower-confidence claims; cheap public
        claims still earn at L0.
      </div>

      <div>
        <div style={fieldLabel}>Current</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {LEVELS.map((lvl) => {
            const isCurrent = lvl.value === current;
            return (
              <button
                key={lvl.value}
                style={{
                  ...button(isCurrent ? "primary" : "secondary"),
                  textAlign: "left",
                  padding: "8px 10px",
                  fontSize: 12,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 1,
                  opacity: busy ? 0.6 : 1,
                  pointerEvents: busy ? "none" : "auto",
                }}
                onClick={() => pick(lvl.value)}
              >
                <span style={{ fontWeight: 600 }}>{lvl.label}</span>
                <span
                  style={{
                    fontSize: 10,
                    color: isCurrent ? "var(--bg)" : "var(--text-muted)",
                    fontWeight: 400,
                  }}
                >
                  {lvl.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {err && <div style={errorText}>{err}</div>}
    </div>
  );
}
