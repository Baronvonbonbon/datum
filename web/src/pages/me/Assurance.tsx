// /me/assurance — user-set minimum AssuranceLevel floor for incoming settlements.
//
// B5 (2026-05-12): each user can refuse low-proof settlement on their own behalf
// by setting their floor on DatumSettlement.setUserMinAssurance(level). The
// protocol's Settlement._processBatch OR-merges this with the campaign's
// AssuranceLevel and uses the higher of the two.
//
// Levels:
//   0 = Permissive  — accept any settlement (default)
//   1 = PublisherSigned — require publisher cosignature
//   2 = DualSigned — require publisher + advertiser cosignatures

import { useEffect, useState } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";

const LEVELS: Array<{ value: number; label: string; description: string }> = [
  { value: 0, label: "Permissive (default)", description: "Accept any settlement path. Maximum compatibility, minimum proof." },
  { value: 1, label: "Publisher-signed", description: "Require publisher cosignature. Settlement on campaigns that don't deliver this is rejected." },
  { value: 2, label: "Dual-signed", description: "Require publisher AND advertiser cosignatures. Highest proof; only campaigns that opt into dual-sig settle for you." },
];

export function AssurancePage() {
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const [current, setCurrent] = useState<number | null>(null);
  const [chosen, setChosen] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { load(); }, [address]);

  async function load() {
    if (!address) { setLoading(false); return; }
    try {
      const lvl: bigint = await contracts.settlement.userMinAssurance(address);
      setCurrent(Number(lvl));
      setChosen(Number(lvl));
    } catch (err) {
      push({ kind: "error", text: `Failed to read current AssuranceLevel: ${humanizeError(err)}` });
    }
    setLoading(false);
  }

  async function save() {
    if (!signer) { push({ kind: "error", text: "Connect your wallet first." }); return; }
    if (chosen === current) return;
    setSubmitting(true);
    try {
      const c = contracts.settlement.connect(signer);
      const tx = await c.setUserMinAssurance(chosen);
      await confirmTx(tx);
      push({ kind: "success", text: `AssuranceLevel set to ${LEVELS[chosen].label}` });
      await load();
    } catch (err) {
      push({ kind: "error", text: humanizeError(err) });
    }
    setSubmitting(false);
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!address) return <div style={{ padding: 24 }}>Connect a wallet to set your AssuranceLevel floor.</div>;

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>Your AssuranceLevel Floor</h2>
      <p style={{ color: "var(--text-muted, #888)", fontSize: 14, lineHeight: 1.5 }}>
        Choose the minimum cryptographic proof you require for any settlement
        addressed to your wallet. The protocol enforces whichever is higher —
        the campaign's level or yours. Real users typically leave this at
        Permissive; raise it if you only want to settle on campaigns with
        publisher (or advertiser) sign-offs.
      </p>

      <div style={{ display: "grid", gap: 12, marginTop: 24 }}>
        {LEVELS.map((l) => (
          <label key={l.value} style={{
            display: "flex", gap: 12, padding: 14,
            border: chosen === l.value ? "2px solid var(--accent, #4cf)" : "1px solid var(--border, #333)",
            borderRadius: 8, cursor: "pointer", background: current === l.value ? "rgba(76, 207, 255, 0.05)" : undefined,
          }}>
            <input
              type="radio"
              checked={chosen === l.value}
              onChange={() => setChosen(l.value)}
              style={{ marginTop: 4 }}
            />
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {l.label}
                {current === l.value && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--ok, #4f4)" }}>(current)</span>}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted, #888)" }}>{l.description}</div>
            </div>
          </label>
        ))}
      </div>

      <div style={{ marginTop: 24, display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={save}
          disabled={submitting || chosen === current}
          style={{
            padding: "10px 20px",
            background: chosen === current ? "var(--bg-muted, #222)" : "var(--accent, #4cf)",
            color: chosen === current ? "var(--text-muted, #888)" : "var(--bg, #000)",
            border: "none", borderRadius: 6,
            cursor: (submitting || chosen === current) ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {submitting ? "Saving…" : chosen === current ? "No change" : "Save floor"}
        </button>
        <span style={{ fontSize: 12, color: "var(--text-muted, #888)" }}>
          A single on-chain transaction. Self-only — no admin can change this for you.
        </span>
      </div>
    </div>
  );
}
