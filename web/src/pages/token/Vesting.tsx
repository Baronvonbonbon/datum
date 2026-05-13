// DatumVesting page — read schedule, surface the permissionless release call.
//
// Per-deployment single-beneficiary linear vesting with a 1-year cliff. Anyone
// can call release(); the beneficiary just receives WDATUM. Beneficiary can
// extendVesting(newEndTime) — slow-only.

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useSettings } from "../../context/SettingsContext";
import { useWallet } from "../../context/WalletContext";
import { useContracts } from "../../hooks/useContracts";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { getVestingContract } from "@shared/contracts";
import { FeatureUnavailable } from "../../components/FeatureUnavailable";

const DECIMALS = 10;
function fmt(v: bigint): string {
  const s = ethers.formatUnits(v, DECIMALS);
  return s.replace(/\.?0+$/, "") || "0";
}

export function Vesting() {
  const { settings } = useSettings();
  const { signer, address } = useWallet();
  const contracts = useContracts();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [beneficiary, setBeneficiary] = useState<string>("");
  const [startTime, setStartTime] = useState<bigint>(0n);
  const [endTime, setEndTime] = useState<bigint>(0n);
  const [vested, setVested] = useState<bigint>(0n);
  const [released, setReleased] = useState<bigint>(0n);
  const [totalAllocation, setTotalAllocation] = useState<bigint>(0n);
  const [cliffDuration, setCliffDuration] = useState<bigint>(0n);
  const [newEnd, setNewEnd] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    if (!settings.contractAddresses.vesting) return;
    try {
      const v = getVestingContract(settings.contractAddresses, contracts.readProvider);
      if (!v) return;
      const [bn, st, et, vst, rel, total, cliff] = await Promise.all([
        v.beneficiary(),
        v.startTime(),
        v.endTime(),
        v.vestedAmount(),
        v.released(),
        v.TOTAL_ALLOCATION(),
        v.CLIFF_DURATION(),
      ]);
      setBeneficiary(String(bn));
      setStartTime(BigInt(st));
      setEndTime(BigInt(et));
      setVested(BigInt(vst));
      setReleased(BigInt(rel));
      setTotalAllocation(BigInt(total));
      setCliffDuration(BigInt(cliff));
    } catch (err) {
      push(humanizeError(err), "error");
    }
  }

  useEffect(() => { refresh(); }, [settings.contractAddresses.vesting]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings.contractAddresses.vesting) {
    return (
      <div>
        <PageHeader />
        <FeatureUnavailable feature="DatumVesting" addressKey="vesting" />
      </div>
    );
  }

  const isBeneficiary = address && beneficiary && address.toLowerCase() === beneficiary.toLowerCase();
  const claimable = vested > released ? vested - released : 0n;
  const cliffEnd = startTime + cliffDuration;
  const beforeCliff = BigInt(Math.floor(Date.now() / 1000)) < cliffEnd;

  async function doRelease() {
    if (!signer) return;
    try {
      const v = getVestingContract(settings.contractAddresses, signer)!;
      setBusy("Releasing...");
      const tx = await v.release();
      await confirmTx(tx);
      push("Vested DATUM released", "success");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  async function doExtend() {
    if (!signer) return;
    try {
      const t = BigInt(newEnd.trim());
      if (t <= endTime) throw new Error("New end time must be greater than current");
      const v = getVestingContract(settings.contractAddresses, signer)!;
      setBusy("Extending vesting...");
      const tx = await v.extendVesting(t);
      await confirmTx(tx);
      push("Vesting extended", "success");
      setNewEnd("");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <PageHeader />

      <Section title="Schedule">
        <Row label="Beneficiary" value={<code style={{ fontSize: 12 }}>{beneficiary}</code>} />
        <Row label="Total allocation" value={`${fmt(totalAllocation)} DATUM`} />
        <Row label="Start (unix)" value={`${startTime} (${new Date(Number(startTime) * 1000).toISOString()})`} />
        <Row label="Cliff ends (unix)" value={`${cliffEnd} (${new Date(Number(cliffEnd) * 1000).toISOString()})`} />
        <Row label="End (unix)" value={`${endTime} (${new Date(Number(endTime) * 1000).toISOString()})`} />
      </Section>

      <Section title="Status">
        {beforeCliff && (
          <div className="nano-info nano-info--warn" style={{ marginBottom: 8 }}>
            Before cliff — no DATUM has vested yet.
          </div>
        )}
        <Row label="Vested to date" value={`${fmt(vested)} DATUM`} />
        <Row label="Released" value={`${fmt(released)} DATUM`} />
        <Row label="Claimable now" value={`${fmt(claimable)} DATUM`} />
      </Section>

      <Section title="Release">
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8 }}>
          Permissionless — anyone can trigger the release; DATUM always goes to the beneficiary.
        </p>
        <button className="nano-btn nano-btn-accent" onClick={doRelease} disabled={busy !== null || claimable === 0n || !signer}>
          Release {fmt(claimable)} DATUM
        </button>
      </Section>

      {isBeneficiary && (
        <Section title="Extend vesting (slow only)">
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8 }}>
            Only you (the beneficiary) can extend. Cannot accelerate.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <Field label="New end time (unix seconds)">
              <input className="nano-input" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} placeholder={String(endTime)} style={{ width: 220 }} />
            </Field>
            <button className="nano-btn" onClick={doExtend} disabled={busy !== null}>Extend</button>
          </div>
        </Section>
      )}
    </div>
  );
}

function PageHeader() {
  return (
    <div style={{ marginBottom: 20 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Vesting</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
        Single-beneficiary linear vesting with a 1-year cliff. No revoke, no clawback.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24, padding: 16, background: "var(--bg-elev)", borderRadius: 4, border: "1px solid var(--border)" }}>
      <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, marginBottom: 12 }}>{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "4px 0", fontSize: 13 }}>
      <span style={{ color: "var(--text-muted)", minWidth: 200 }}>{label}</span>
      <span style={{ color: "var(--text)", flex: 1 }}>{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
      {label}
      {children}
    </label>
  );
}
