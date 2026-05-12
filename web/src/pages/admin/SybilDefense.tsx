// /admin/sybil-defense — operational dashboard for #5 (PoW) + per-user history.
//
// Three sections:
//   1. PoW gate status: enforce flag, current curve params, hard floor.
//   2. Per-user bucket inspector: paste an address, see effective bucket + target.
//   3. Curve governance: setEnforcePow + setPowDifficultyCurve admin actions.

import { useEffect, useState } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { AdminNav } from "../../components/AdminNav";
import { humanizeError } from "@shared/errorCodes";
import { ethers } from "ethers";

export function SybilDefenseAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  // Gate status
  const [enforcePow, setEnforcePow] = useState<boolean | null>(null);
  const [baseShift, setBaseShift] = useState<number>(8);
  const [linDiv, setLinDiv] = useState<number>(60);
  const [quadDiv, setQuadDiv] = useState<number>(100);
  const [leakPerN, setLeakPerN] = useState<number>(10);

  // Inspector
  const [inspectAddr, setInspectAddr] = useState("");
  const [inspectResult, setInspectResult] = useState<{ bucket: bigint; target1: bigint; totalSettled: bigint } | null>(null);

  // Curve form
  const [newBase, setNewBase] = useState<number>(8);
  const [newLin, setNewLin] = useState<number>(60);
  const [newQuad, setNewQuad] = useState<number>(100);
  const [newLeak, setNewLeak] = useState<number>(10);
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const s: any = contracts.settlement;
      const [enf, bShift, lDiv, qDiv, leak] = await Promise.all([
        s.enforcePow(), s.powBaseShift(), s.powLinearDivisor(), s.powQuadDivisor(), s.powBucketLeakPerN(),
      ]);
      setEnforcePow(Boolean(enf));
      setBaseShift(Number(bShift));
      setLinDiv(Number(lDiv));
      setQuadDiv(Number(qDiv));
      setLeakPerN(Number(leak));
      setNewBase(Number(bShift));
      setNewLin(Number(lDiv));
      setNewQuad(Number(qDiv));
      setNewLeak(Number(leak));
    } catch (err) {
      push({ kind: "error", text: `Load failed: ${humanizeError(err)}` });
    }
  }

  async function inspect() {
    if (!ethers.isAddress(inspectAddr)) { push({ kind: "error", text: "Invalid address" }); return; }
    try {
      const s: any = contracts.settlement;
      const [bucket, target1, totalSettled] = await Promise.all([
        s.userPowBucketEffective(inspectAddr),
        s.powTargetForUser(inspectAddr, 1),
        s.userTotalSettled(inspectAddr),
      ]);
      setInspectResult({
        bucket: BigInt(bucket.toString()),
        target1: BigInt(target1.toString()),
        totalSettled: BigInt(totalSettled.toString()),
      });
    } catch (err) {
      push({ kind: "error", text: humanizeError(err) });
    }
  }

  async function toggleEnforce() {
    if (!signer) return;
    setBusy(true);
    try {
      const s: any = contracts.settlement.connect(signer);
      const tx = await s.setEnforcePow(!enforcePow);
      await confirmTx(tx);
      push({ kind: "success", text: `enforcePow set to ${!enforcePow}` });
      await load();
    } catch (err) {
      push({ kind: "error", text: humanizeError(err) });
    }
    setBusy(false);
  }

  async function applyCurve() {
    if (!signer) return;
    setBusy(true);
    try {
      const s: any = contracts.settlement.connect(signer);
      const tx = await s.setPowDifficultyCurve(newBase, newLin, newQuad, newLeak);
      await confirmTx(tx);
      push({ kind: "success", text: "Curve updated" });
      await load();
    } catch (err) {
      push({ kind: "error", text: humanizeError(err) });
    }
    setBusy(false);
  }

  /** Approximate hashes-per-impression at a given bucket level, for UI hints. */
  function hashesAtBucket(bucket: number): string {
    const linExtra = Math.floor(bucket / linDiv);
    const quadIn = Math.floor(bucket / quadDiv);
    const quadExtra = quadIn * quadIn;
    const shift = baseShift + linExtra + quadExtra;
    if (shift >= 64) return "impossible (cap)";
    const n = Math.pow(2, shift);
    if (n < 1024) return `~${Math.round(n)} hashes`;
    if (n < 1e6) return `~${Math.round(n / 1024)}k`;
    if (n < 1e9) return `~${Math.round(n / 1e6)}M`;
    if (n < 1e12) return `~${Math.round(n / 1e9)}B`;
    return `~2^${shift}`;
  }

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <AdminNav />
      <h2 style={{ marginTop: 24 }}>Sybil Defense (PoW + History)</h2>
      <p style={{ color: "var(--text-muted, #888)", fontSize: 14, lineHeight: 1.5 }}>
        Per-impression Proof-of-Work with a leaky-bucket quadratic difficulty
        curve. Difficulty rises with sustained abuse and decays linearly when
        the user backs off. All four curve parameters are governable.
      </p>

      {/* Status */}
      <section style={{ marginTop: 24, padding: 16, border: "1px solid var(--border, #333)", borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Current state</h3>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 8, fontSize: 14 }}>
          <div>enforcePow:</div>
          <div>
            <strong style={{ color: enforcePow ? "var(--ok, #4f4)" : "var(--text-muted, #888)" }}>
              {enforcePow === null ? "—" : enforcePow ? "ON" : "off"}
            </strong>
            {signer && (
              <button onClick={toggleEnforce} disabled={busy}
                style={{ marginLeft: 12, padding: "4px 10px", fontSize: 12 }}>
                {enforcePow ? "Disable" : "Enable"}
              </button>
            )}
          </div>
          <div>Base shift (bits):</div><div>{baseShift} ({hashesAtBucket(0)} at empty bucket)</div>
          <div>Linear divisor:</div><div>{linDiv} <span style={{ color: "var(--text-muted)" }}>(1 extra bit per N bucket units)</span></div>
          <div>Quadratic divisor:</div><div>{quadDiv} <span style={{ color: "var(--text-muted)" }}>(squared term denominator)</span></div>
          <div>Bucket leak rate:</div><div>1 unit per {leakPerN} blocks <span style={{ color: "var(--text-muted)" }}>(~{(leakPerN * 6 / 60).toFixed(1)} min)</span></div>
        </div>
        <div style={{ marginTop: 16, fontSize: 13 }}>
          <div>Difficulty at sample bucket levels:</div>
          <div style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 4, marginTop: 4, fontFamily: "monospace" }}>
            <div>0:</div><div>{hashesAtBucket(0)}</div>
            <div>60:</div><div>{hashesAtBucket(60)}</div>
            <div>120:</div><div>{hashesAtBucket(120)}</div>
            <div>300:</div><div>{hashesAtBucket(300)}</div>
            <div>600:</div><div>{hashesAtBucket(600)}</div>
          </div>
        </div>
      </section>

      {/* Per-user inspector */}
      <section style={{ marginTop: 24, padding: 16, border: "1px solid var(--border, #333)", borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Per-user inspector</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text" value={inspectAddr} onChange={(e) => setInspectAddr(e.target.value)}
            placeholder="0x... user address"
            style={{ flex: 1, padding: 8, fontFamily: "monospace" }}
          />
          <button onClick={inspect} style={{ padding: "8px 16px" }}>Inspect</button>
        </div>
        {inspectResult && (
          <div style={{ marginTop: 12, padding: 12, background: "rgba(255,255,255,0.03)", borderRadius: 6, fontSize: 13 }}>
            <div>Effective bucket: <strong>{inspectResult.bucket.toString()}</strong> {" "}
              <span style={{ color: "var(--text-muted)" }}>({hashesAtBucket(Number(inspectResult.bucket))} per impression)</span></div>
            <div>Lifetime settled: <strong>{inspectResult.totalSettled.toString()}</strong> events</div>
            <div>Current PoW target (eventCount=1): <span style={{ fontFamily: "monospace", fontSize: 11 }}>
              {inspectResult.target1 === ethers.MaxUint256 ? "max (PoW disabled or eventCount=0)" : "0x" + inspectResult.target1.toString(16).padStart(64, "0").slice(0, 20) + "…"}
            </span></div>
          </div>
        )}
      </section>

      {/* Curve governance */}
      {signer && (
        <section style={{ marginTop: 24, padding: 16, border: "1px solid var(--border, #333)", borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Update curve (owner-only)</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>
              <div style={{ fontSize: 12 }}>Base shift (1–32)</div>
              <input type="number" value={newBase} min={1} max={32}
                onChange={(e) => setNewBase(Number(e.target.value))}
                style={{ width: "100%", padding: 6 }} />
            </label>
            <label>
              <div style={{ fontSize: 12 }}>Linear divisor</div>
              <input type="number" value={newLin} min={1}
                onChange={(e) => setNewLin(Number(e.target.value))}
                style={{ width: "100%", padding: 6 }} />
            </label>
            <label>
              <div style={{ fontSize: 12 }}>Quadratic divisor</div>
              <input type="number" value={newQuad} min={1}
                onChange={(e) => setNewQuad(Number(e.target.value))}
                style={{ width: "100%", padding: 6 }} />
            </label>
            <label>
              <div style={{ fontSize: 12 }}>Bucket leak per N blocks</div>
              <input type="number" value={newLeak} min={1}
                onChange={(e) => setNewLeak(Number(e.target.value))}
                style={{ width: "100%", padding: 6 }} />
            </label>
          </div>
          <button onClick={applyCurve} disabled={busy}
            style={{ marginTop: 12, padding: "8px 16px", background: "var(--accent, #4cf)", color: "var(--bg, #000)", border: "none", borderRadius: 6, fontWeight: 600 }}>
            {busy ? "Updating…" : "Apply curve"}
          </button>
        </section>
      )}
    </div>
  );
}
