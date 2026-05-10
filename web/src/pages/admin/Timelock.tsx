// Timelock admin — multi-proposal lifecycle.
//
// alpha-4 Timelock supports up to 10 concurrent proposals keyed by
// keccak256(target, data, salt). This page:
//   - Discovers proposals via ChangeProposed events
//   - Drives propose() through the structured timelockCatalog
//     (with a Raw-payload fallback for arbitrary calls)
//   - Shows per-proposal state and time-to-execute / time-to-expire
//   - Lets anyone execute matured proposals or owner cancel

import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { AddressDisplay } from "../../components/AddressDisplay";
import { AdminNav } from "../../components/AdminNav";
import { humanizeError } from "@shared/errorCodes";
import { queryFilterAll } from "@shared/eventQuery";
import {
  TIMELOCK_CATALOG, tlEncodeCall, tlParseArg, tlFormatArg, defaultSalt, TLSetter, TLArgKind,
} from "@shared/timelockCatalog";

interface TimelockProposal {
  id: string;
  target: string;
  data: string;
  proposedTimestamp: number;
  executableAfter: number;
  expiresAt: number;
  executed: boolean;
  cancelled: boolean;
  decoded: string;
}

type LifecycleState = "queued" | "executable" | "executed" | "cancelled" | "expired";

function lifecycleState(p: TimelockProposal, nowSec: number): LifecycleState {
  if (p.executed) return "executed";
  if (p.cancelled) return "cancelled";
  if (nowSec >= p.expiresAt) return "expired";
  if (nowSec >= p.executableAfter) return "executable";
  return "queued";
}

function fmtRelative(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function decodeCall(data: string): string {
  if (!data || data === "0x" || data.length < 10) return "";
  const selector = data.slice(0, 10);
  for (const setter of TIMELOCK_CATALOG) {
    const iface = new ethers.Interface([setter.abi]);
    const f = iface.getFunction(setter.fnName);
    if (f && f.selector === selector) {
      try {
        const parsed = iface.decodeFunctionData(setter.fnName, data);
        const parts = setter.args.map((a, i) => {
          const v = parsed[i];
          return `${a.name}: ${tlFormatArg(a.kind, typeof v === "bigint" ? v : v)}`;
        });
        return `${setter.contractLabel}.${setter.fnName}(${parts.join(", ")})`;
      } catch {
        return `${setter.contractLabel}.${setter.fnName}(decode error)`;
      }
    }
  }
  return `selector: ${selector}`;
}

export function TimelockAdmin() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { settings } = useSettings();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [proposals, setProposals] = useState<TimelockProposal[]>([]);
  const [delaySec, setDelaySec] = useState<number>(172800);
  const [timeoutSec, setTimeoutSec] = useState<number>(604800);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [maxConcurrent, setMaxConcurrent] = useState<number>(10);
  const [tlOwner, setTlOwner] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [nowSec, setNowSec] = useState<number>(Math.floor(Date.now() / 1000));

  // Propose form
  const [proposeMode, setProposeMode] = useState<"catalog" | "raw">("catalog");
  const [setterIdx, setSetterIdx] = useState(0);
  const [argInputs, setArgInputs] = useState<string[]>([]);
  const [currentValues, setCurrentValues] = useState<(bigint | boolean | string | null)[]>([]);
  const [rawTarget, setRawTarget] = useState("");
  const [rawCalldata, setRawCalldata] = useState("");
  const [salt, setSalt] = useState(defaultSalt());

  const isOwner = address && tlOwner ? address.toLowerCase() === tlOwner.toLowerCase() : false;

  // Refresh wall-clock every 15s for live countdowns
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 15000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    if (!contracts.timelock) return;
    setLoading(true);
    try {
      const [delay, timeout, pc, maxCC, owner] = await Promise.all([
        contracts.timelock.TIMELOCK_DELAY().catch(() => 172800n),
        contracts.timelock.PROPOSAL_TIMEOUT().catch(() => 604800n),
        contracts.timelock.pendingCount().catch(() => 0n),
        contracts.timelock.MAX_CONCURRENT().catch(() => 10n),
        contracts.timelock.owner().catch(() => ""),
      ]);
      setDelaySec(Number(delay));
      setTimeoutSec(Number(timeout));
      setPendingCount(Number(pc));
      setMaxConcurrent(Number(maxCC));
      setTlOwner(String(owner));

      // Discover proposals via ChangeProposed events
      const filter = contracts.timelock.filters.ChangeProposed();
      const logs = await queryFilterAll(contracts.timelock, filter);
      const ids = Array.from(new Set(logs.map((l: any) => String(l.args?.proposalId ?? l.args?.[0]))));
      const items: TimelockProposal[] = [];
      for (const id of ids) {
        try {
          const p = await contracts.timelock.proposals(id);
          const ts = Number(p.timestamp ?? p[2] ?? 0);
          if (ts === 0) continue;
          const target = String(p.target ?? p[0] ?? "");
          const data = String(p.data ?? p[1] ?? "0x");
          items.push({
            id,
            target,
            data,
            proposedTimestamp: ts,
            executableAfter: ts + Number(delay),
            expiresAt: ts + Number(delay) + Number(timeout),
            executed: Boolean(p.executed ?? p[3] ?? false),
            cancelled: Boolean(p.cancelled ?? p[4] ?? false),
            decoded: decodeCall(data),
          });
        } catch { /* skip */ }
      }
      // newest first
      items.sort((a, b) => b.proposedTimestamp - a.proposedTimestamp);
      setProposals(items);
    } finally {
      setLoading(false);
    }
  }, [contracts.timelock]);

  useEffect(() => { load(); }, [load]);

  // Reset arg inputs + fetch current values when the selected catalog entry changes
  useEffect(() => {
    const setter = TIMELOCK_CATALOG[setterIdx];
    if (!setter) return;
    setArgInputs(new Array(setter.args.length).fill(""));
    setCurrentValues(new Array(setter.args.length).fill(null));

    let cancelled = false;
    (async () => {
      const targetContract = (contracts as Record<string, any>)[setter.contractKey];
      if (!targetContract) return;
      const vals = await Promise.all(setter.currentGetters.map(async (g) => {
        if (!g) return null;
        try {
          const v = await targetContract[g]();
          if (typeof v === "boolean") return v;
          if (typeof v === "bigint") return v;
          if (typeof v === "string") return v;
          return BigInt(v);
        } catch { return null; }
      }));
      if (!cancelled) setCurrentValues(vals);
    })();
    return () => { cancelled = true; };
  }, [setterIdx, contracts]);

  // ── Actions ───────────────────────────────────────────────────────────

  async function handlePropose(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;
    setTxState("pending"); setTxMsg("");
    try {
      let target: string;
      let data: string;
      if (proposeMode === "catalog") {
        const setter = TIMELOCK_CATALOG[setterIdx];
        if (!setter) throw new Error("Pick a parameter first.");
        const targetAddr = settings.contractAddresses[setter.contractKey as keyof typeof settings.contractAddresses];
        if (!targetAddr) throw new Error(`No address configured for ${setter.contractLabel}.`);
        const parsedArgs = setter.args.map((a, i) => tlParseArg(a.kind, argInputs[i] ?? ""));
        data = tlEncodeCall(setter, parsedArgs);
        target = targetAddr as string;
      } else {
        target = rawTarget.trim();
        if (!ethers.isAddress(target)) throw new Error("Invalid target address.");
        data = rawCalldata.trim().startsWith("0x") ? rawCalldata.trim() : "0x";
      }
      const tx = await contracts.timelock.connect(signer).propose(target, data, salt);
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Proposal queued. Execute after the timelock delay.");
      setSalt(defaultSalt());
      setRawTarget(""); setRawCalldata("");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function handleExecute(id: string) {
    if (!signer) return;
    setBusyId(id);
    setTxState("pending"); setTxMsg("");
    try {
      const tx = await contracts.timelock.connect(signer).execute(id);
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Proposal executed.");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(id: string) {
    if (!signer) return;
    setBusyId(id);
    setTxState("pending"); setTxMsg("");
    try {
      const tx = await contracts.timelock.connect(signer).cancel(id);
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Proposal cancelled.");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 920 }}>
      <AdminNav />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0" }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Timelock</h1>
        <button onClick={() => load()} disabled={loading} className="nano-btn" style={{ fontSize: 12 }}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Configuration banner */}
      <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, fontSize: 12, color: "var(--text-muted)" }}>
          <div>Delay: <strong style={{ color: "var(--text)" }}>{fmtRelative(delaySec)}</strong></div>
          <div>Execution window: <strong style={{ color: "var(--text)" }}>{fmtRelative(timeoutSec)}</strong></div>
          <div>Pending: <strong style={{ color: "var(--text)" }}>{pendingCount} / {maxConcurrent}</strong></div>
          {tlOwner && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              Owner: <AddressDisplay address={tlOwner} chars={6} style={{ fontSize: 12 }} />
              {isOwner && <span className="nano-badge" style={{ color: "var(--ok)", fontSize: 10 }}>you</span>}
            </div>
          )}
        </div>
      </div>

      {/* Propose form */}
      {signer && isOwner && (
        <div className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
            <div style={{ color: "var(--accent)", fontWeight: 600 }}>Queue Proposal</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={() => setProposeMode("catalog")}
                className={proposeMode === "catalog" ? "nano-btn nano-btn-accent" : "nano-btn"}
                style={{ padding: "4px 10px", fontSize: 11 }}
              >
                Catalog
              </button>
              <button
                type="button"
                onClick={() => setProposeMode("raw")}
                className={proposeMode === "raw" ? "nano-btn nano-btn-accent" : "nano-btn"}
                style={{ padding: "4px 10px", fontSize: 11 }}
              >
                Raw payload
              </button>
            </div>
          </div>

          <form onSubmit={handlePropose} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {proposeMode === "catalog" ? (
              <CatalogForm
                setterIdx={setterIdx}
                setSetterIdx={setSetterIdx}
                argInputs={argInputs}
                setArgInputs={setArgInputs}
                currentValues={currentValues}
              />
            ) : (
              <>
                <div>
                  <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>Target</label>
                  <input
                    type="text"
                    value={rawTarget}
                    onChange={(e) => setRawTarget(e.target.value)}
                    placeholder="0x..."
                    className="nano-input"
                    required
                  />
                </div>
                <div>
                  <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>Calldata</label>
                  <input
                    type="text"
                    value={rawCalldata}
                    onChange={(e) => setRawCalldata(e.target.value)}
                    placeholder="0x..."
                    className="nano-input"
                    required
                  />
                </div>
              </>
            )}

            <div>
              <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>
                Salt <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: 11 }}>(differentiates duplicate proposals)</span>
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  value={salt}
                  onChange={(e) => setSalt(e.target.value)}
                  className="nano-input"
                  style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11 }}
                  required
                />
                <button type="button" onClick={() => setSalt(defaultSalt())} className="nano-btn" style={{ fontSize: 11, padding: "4px 10px" }}>
                  ↻ random
                </button>
              </div>
            </div>

            <TransactionStatus state={txState} message={txMsg} />
            <button
              type="submit"
              disabled={txState === "pending" || pendingCount >= maxConcurrent}
              className="nano-btn nano-btn-accent"
              style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600 }}
            >
              {pendingCount >= maxConcurrent
                ? "Slot limit reached"
                : txState === "pending" ? "Submitting…" : "Queue Proposal"}
            </button>
          </form>
        </div>
      )}
      {signer && !isOwner && tlOwner && (
        <div className="nano-info nano-info--warn" style={{ marginBottom: 12, fontSize: 12 }}>
          You are not the Timelock owner. Only the owner ({tlOwner.slice(0, 8)}…) can queue proposals. Anyone can execute matured proposals.
        </div>
      )}

      {/* Proposal list */}
      {loading ? (
        <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Discovering proposals via events</div>
      ) : proposals.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: 20, textAlign: "center" }}>
          No timelock proposals yet.
        </div>
      ) : (
        proposals.map((p) => {
          const state = lifecycleState(p, nowSec);
          const stateColor = state === "executable" ? "var(--ok)"
            : state === "queued" ? "var(--accent)"
            : state === "expired" ? "var(--warn)"
            : state === "executed" ? "var(--text-muted)"
            : "var(--text-muted)";
          const secsToExec = p.executableAfter - nowSec;
          const secsToExpire = p.expiresAt - nowSec;
          return (
            <div key={p.id} className="nano-card" style={{ padding: 14, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                <div>
                  <code style={{ fontSize: 11, color: "var(--accent)" }}>{p.id.slice(0, 10)}…{p.id.slice(-6)}</code>
                  <span style={{ marginLeft: 8, color: stateColor, fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>{state}</span>
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  {state === "queued" && <>Executable in <strong style={{ color: "var(--text)" }}>{fmtRelative(secsToExec)}</strong></>}
                  {state === "executable" && <>Window expires in <strong style={{ color: "var(--warn)" }}>{fmtRelative(secsToExpire)}</strong></>}
                  {state === "expired" && <>Expired {fmtRelative(-secsToExpire)} ago</>}
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 6, fontFamily: "var(--font-mono)", wordBreak: "break-word" }}>
                {p.decoded}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 8 }}>
                target {p.target}
              </div>
              {signer && (state === "executable" || (isOwner && state === "queued")) && (
                <div style={{ display: "flex", gap: 8 }}>
                  {state === "executable" && (
                    <button
                      onClick={() => handleExecute(p.id)}
                      disabled={busyId === p.id}
                      className="nano-btn nano-btn-ok"
                      style={{ padding: "5px 12px", fontSize: 12 }}
                    >
                      {busyId === p.id ? "Executing…" : "Execute"}
                    </button>
                  )}
                  {isOwner && (state === "queued" || state === "executable") && (
                    <button
                      onClick={() => handleCancel(p.id)}
                      disabled={busyId === p.id}
                      className="nano-btn"
                      style={{ padding: "5px 12px", fontSize: 12, color: "var(--error)", border: "1px solid rgba(248,113,113,0.3)" }}
                    >
                      {busyId === p.id ? "Cancelling…" : "Cancel"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      <div style={{ marginTop: 16 }}>
        <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 12, textDecoration: "none" }}>← Governance</Link>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Catalog form — split out for readability
// ─────────────────────────────────────────────────────────────────────────

interface CatalogFormProps {
  setterIdx: number;
  setSetterIdx: (n: number) => void;
  argInputs: string[];
  setArgInputs: (fn: (prev: string[]) => string[]) => void;
  currentValues: (bigint | boolean | string | null)[];
}

function CatalogForm({ setterIdx, setSetterIdx, argInputs, setArgInputs, currentValues }: CatalogFormProps) {
  const setter = TIMELOCK_CATALOG[setterIdx];

  return (
    <>
      <div>
        <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>
          Operation
        </label>
        <select
          value={setterIdx}
          onChange={(e) => setSetterIdx(Number(e.target.value))}
          className="nano-select"
          style={{ width: "100%", fontSize: 12, padding: "6px 8px" }}
        >
          {TIMELOCK_CATALOG.map((s, i) => (
            <option key={`${s.contractKey}:${s.fnName}`} value={i}>
              {s.contractLabel} · {s.fnName}
            </option>
          ))}
        </select>
        {setter && (
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
            {setter.description}
          </div>
        )}
      </div>

      {setter?.args.map((arg, i) => (
        <ArgInput
          key={arg.name}
          arg={arg}
          value={argInputs[i] ?? ""}
          current={currentValues[i] ?? null}
          onChange={(v) => setArgInputs((prev) => prev.map((p, j) => j === i ? v : p))}
        />
      ))}
    </>
  );
}

function ArgInput({ arg, value, current, onChange }: {
  arg: { name: string; kind: TLArgKind; description: string; enumLabels?: string[] };
  value: string;
  current: bigint | boolean | string | null;
  onChange: (v: string) => void;
}) {
  const isEnum = arg.kind === "uint8-enum" && arg.enumLabels && arg.enumLabels.length > 0;
  const isBool = arg.kind === "bool";

  let currentDisplay: string | null = null;
  if (current !== null) {
    if (typeof current === "boolean") currentDisplay = current ? "true" : "false";
    else if (typeof current === "string") currentDisplay = current;
    else currentDisplay = tlFormatArg(arg.kind, current);
  }

  return (
    <div>
      <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>
        {arg.name}{" "}
        <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: 11 }}>
          ({arg.kind})
        </span>
      </label>
      {isEnum ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="nano-select"
          style={{ width: "100%", fontSize: 12, padding: "6px 8px" }}
          required
        >
          <option value="">— select —</option>
          {arg.enumLabels!.map((lbl, i) => (
            <option key={i} value={i}>{i} · {lbl}</option>
          ))}
        </select>
      ) : isBool ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="nano-select"
          style={{ width: "100%", fontSize: 12, padding: "6px 8px" }}
          required
        >
          <option value="">— select —</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          type="text"
          inputMode={arg.kind.startsWith("uint") ? "numeric" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={arg.kind === "address" ? "0x..." : arg.kind === "bytes32" ? "0x... (32 bytes)" : "value"}
          className="nano-input"
          style={arg.kind === "address" || arg.kind === "bytes32" ? { fontFamily: "var(--font-mono)", fontSize: 11 } : undefined}
          required
        />
      )}
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
        {arg.description}
        {currentDisplay !== null && (
          <span style={{ marginLeft: 8 }}>
            · <strong style={{ color: "var(--text)" }}>Current: {currentDisplay}</strong>
          </span>
        )}
      </div>
    </div>
  );
}
