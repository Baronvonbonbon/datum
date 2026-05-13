// Governance phase ladder UI.
//
// DatumGovernanceRouter is the stable-address proxy that sits between
// Campaigns/Lifecycle and the active governor. The router has three phases:
//   0 = Admin    — DatumAdminGovernance (Phase 0 inlined into Router)
//   1 = Council  — DatumCouncil (N-of-M trusted member voting)
//   2 = OpenGov  — DatumGovernanceV2 (conviction-weighted open governance)
//
// Phase transitions are two-step (A10):
//   1. Owner (Timelock) calls setGovernor(phase, newGovernor) — stages pending.
//   2. newGovernor calls acceptGovernor() from its own context — finalizes.
//
// This page surfaces the current phase + governor + pendingGovernor and gives
// the owner a UI to stage transitions. Acceptance is handled by the incoming
// governor itself (contract account); a "Trigger accept" helper is provided
// for the rare case where the new governor is an EOA.

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useSettings } from "../../context/SettingsContext";
import { useWallet } from "../../context/WalletContext";
import { useContracts } from "../../hooks/useContracts";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { getGovernanceRouterContract } from "@shared/contracts";

const PHASES = ["Admin", "Council", "OpenGov"] as const;
const ZERO = "0x0000000000000000000000000000000000000000";

export function PhaseLadder() {
  const { settings } = useSettings();
  const { signer, address } = useWallet();
  const contracts = useContracts();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [phase, setPhase] = useState<number | null>(null);
  const [governor, setGovernor] = useState<string>("");
  const [pendingGovernor, setPendingGovernor] = useState<string>("");
  const [pendingPhase, setPendingPhase] = useState<number | null>(null);
  const [owner, setOwner] = useState<string>("");

  const [stagePhase, setStagePhase] = useState<string>("1");
  const [stageAddr, setStageAddr] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const router = getGovernanceRouterContract(settings.contractAddresses, contracts.readProvider);
    if (!router) return;
    try {
      const [ph, gov, pg, pp, own] = await Promise.all([
        router.phase(),
        router.governor(),
        router.pendingGovernor(),
        router.pendingPhase(),
        router.owner(),
      ]);
      setPhase(Number(ph));
      setGovernor(String(gov));
      setPendingGovernor(String(pg));
      setPendingPhase(Number(pp));
      setOwner(String(own));
    } catch (err) {
      push(humanizeError(err), "error");
    }
  }

  useEffect(() => { refresh(); }, [settings.contractAddresses.governanceRouter]); // eslint-disable-line react-hooks/exhaustive-deps

  const isOwner = address && owner && address.toLowerCase() === owner.toLowerCase();
  const isPendingGovernor = address && pendingGovernor && address.toLowerCase() === pendingGovernor.toLowerCase();
  const hasPending = pendingGovernor && pendingGovernor !== ZERO;

  async function stageTransition() {
    if (!signer) return;
    try {
      const addr = stageAddr.trim();
      if (!ethers.isAddress(addr)) throw new Error("Invalid address");
      const ph = Number(stagePhase);
      if (![0, 1, 2].includes(ph)) throw new Error("Phase must be 0, 1, or 2");
      const router = getGovernanceRouterContract(settings.contractAddresses, signer)!;
      setBusy("Staging transition...");
      const tx = await router.setGovernor(ph, addr);
      await confirmTx(tx);
      push("Transition staged — new governor must call acceptGovernor", "success");
      setStageAddr("");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  async function acceptTransition() {
    if (!signer) return;
    try {
      const router = getGovernanceRouterContract(settings.contractAddresses, signer)!;
      setBusy("Accepting...");
      const tx = await router.acceptGovernor();
      await confirmTx(tx);
      push("Governor handoff complete", "success");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Governance Phase Ladder</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Router phase + governor identity + transition tooling. Two-step
          accept handoff (A10) is enforced.
        </p>
      </div>

      <Section title="Current state">
        <Row label="Phase"
          value={phase === null ? "—" : `${phase} (${PHASES[phase] ?? "?"})`} />
        <Row label="Governor" value={<code style={{ fontSize: 11 }}>{governor || "—"}</code>} />
        <Row label="Router owner" value={<code style={{ fontSize: 11 }}>{owner || "—"}</code>} />
      </Section>

      {hasPending && (
        <Section title="Pending transition">
          <Row label="Pending phase"
            value={pendingPhase === null ? "—" : `${pendingPhase} (${PHASES[pendingPhase] ?? "?"})`} />
          <Row label="Pending governor" value={<code style={{ fontSize: 11 }}>{pendingGovernor}</code>} />
          <div className="nano-info" style={{ marginTop: 8 }}>
            Waiting on the new governor to call <code>acceptGovernor()</code> from its own context.
            {isPendingGovernor && " (That's you.)"}
          </div>
          {isPendingGovernor && (
            <button className="nano-btn nano-btn-accent" style={{ marginTop: 8 }} onClick={acceptTransition} disabled={busy !== null}>
              Accept governor role
            </button>
          )}
        </Section>
      )}

      {isOwner && (
        <Section title="Stage a transition (router owner only)">
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8 }}>
            Stages a new pending governor. The target must subsequently call
            <code> acceptGovernor()</code> from its own context to complete the handoff.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label="Target phase">
              <select className="nano-input" value={stagePhase} onChange={(e) => setStagePhase(e.target.value)} style={{ width: 150 }}>
                {PHASES.map((p, i) => <option key={i} value={i}>{i} — {p}</option>)}
              </select>
            </Field>
            <Field label="Pending governor address">
              <input className="nano-input" value={stageAddr} onChange={(e) => setStageAddr(e.target.value)} placeholder="0x..." style={{ width: 360 }} />
            </Field>
            <button className="nano-btn nano-btn-danger" onClick={stageTransition} disabled={busy !== null}>
              Stage
            </button>
          </div>
        </Section>
      )}

      <Section title="Phase ladder reference">
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7 }}>
          <div><strong style={{ color: "var(--text)" }}>0 — Admin</strong>: founder multisig direct approval via DatumAdminGovernance (inlined into Router).</div>
          <div><strong style={{ color: "var(--text)" }}>1 — Council</strong>: DatumCouncil N-of-M trusted-member voting. Threshold + veto window + execution delay.</div>
          <div><strong style={{ color: "var(--text)" }}>2 — OpenGov</strong>: DatumGovernanceV2 conviction-weighted open voting. Anyone with locked DOT can vote.</div>
        </div>
      </Section>
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
      <span style={{ color: "var(--text-muted)", minWidth: 160 }}>{label}</span>
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
