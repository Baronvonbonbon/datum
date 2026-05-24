import { useEffect, useMemo, useState } from "react";
import { ethers, Interface, id as ethersId } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { AdminNav } from "../../components/AdminNav";
import { TransactionStatus } from "../../components/TransactionStatus";
import { LockStateStrip, LockEntry } from "../../components/LockStateStrip";
import { useSettings } from "../../context/SettingsContext";
import { useLogs } from "../../hooks/useLogs";

const WINDOW_30D_BLOCKS = 14_400 * 30;

const TOPIC_AUTH_SET = ethersId("RelayerAuthorizationSet(address,bool)");
const IFACE = new Interface([
  "event RelayerAuthorizationSet(address indexed relayer, bool authorized)",
]);

interface AuthRow {
  relayer: string;
  authorized: boolean;
  block: number;
}

export function RelayAdmin() {
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const { settings } = useSettings();

  const relayAddr = settings.contractAddresses.relay;

  if (!relayAddr) {
    return (
      <div className="nano-fade" style={{ maxWidth: 600 }}>
        <AdminNav />
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 12 }}>
          DatumRelay
        </h1>
        <div className="nano-info">DatumRelay is not deployed on this network.</div>
      </div>
    );
  }

  return <RelayAdminInner relayAddr={relayAddr} contracts={contracts} signer={signer} address={address} confirmTx={confirmTx} push={push} />;
}

function RelayAdminInner({
  relayAddr,
  contracts,
  signer,
  address,
  confirmTx,
  push,
}: {
  relayAddr: string;
  contracts: ReturnType<typeof useContracts>;
  signer: ReturnType<typeof useWallet>["signer"];
  address: ReturnType<typeof useWallet>["address"];
  confirmTx: ReturnType<typeof useTx>["confirmTx"];
  push: ReturnType<typeof useToast>["push"];
}) {
  const [authorizedCount, setAuthorizedCount] = useState<number | null>(null);
  const [liveness, setLiveness] = useState<number | null>(null);
  const [openLocked, setOpenLocked] = useState<boolean | null>(null);
  const [owner, setOwner] = useState<string | null>(null);

  const [relayerInput, setRelayerInput] = useState("");
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);

  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [lockBusy, setLockBusy] = useState(false);

  const authOpts = useMemo(
    () => ({
      address: relayAddr.toLowerCase(),
      topic0: TOPIC_AUTH_SET,
      windowBlocks: WINDOW_30D_BLOCKS,
      historyAllowed: true,
    }),
    [relayAddr]
  );
  const authLogs = useLogs(authOpts);

  const recentAuth = useMemo<AuthRow[]>(() => {
    const rows: AuthRow[] = [];
    for (const lg of authLogs.logs) {
      try {
        const parsed = IFACE.parseLog({ topics: lg.topics as string[], data: lg.data });
        if (!parsed) continue;
        rows.push({
          relayer: String(parsed.args.relayer).toLowerCase(),
          authorized: Boolean(parsed.args.authorized),
          block: Number(lg.blockNumber ?? 0),
        });
      } catch {
        /* skip malformed log */
      }
    }
    return rows.sort((a, b) => b.block - a.block);
  }, [authLogs.logs]);

  const lockEntries: LockEntry[] = [
    {
      label: "Relayer open mode",
      description:
        "While unlocked, openness is owner-mutable. Locking commits the relay to its current open/closed disposition permanently.",
      contractAddr: relayAddr,
      getter: "relayerOpenLocked",
      locker: "lockRelayerOpen",
    },
    {
      label: "Plumbing refs",
      description:
        "Locks campaigns + settlement references on the relay so they can no longer be redirected.",
      contractAddr: relayAddr,
      getter: "plumbingLocked",
      locker: "lockPlumbing",
    },
  ];

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    try {
      const [count, lt, locked, o] = await Promise.all([
        contracts.relay.authorizedRelayerCount().catch(() => null),
        contracts.relay.livenessThresholdBlocks().catch(() => null),
        contracts.relay.relayerOpenLocked().catch(() => null),
        contracts.relay.owner().catch(() => null),
      ]);
      setAuthorizedCount(count === null ? null : Number(count));
      setLiveness(lt === null ? null : Number(lt));
      setOpenLocked(locked === null ? null : Boolean(locked));
      setOwner(o ? String(o) : null);
    } catch {
      /* ignore */
    }
  }

  async function checkAuthorized() {
    const a = relayerInput.trim();
    if (!ethers.isAddress(a)) {
      setAuthorized(null);
      return;
    }
    setLookupBusy(true);
    try {
      const ok = await contracts.relay.authorizedRelayers(a);
      setAuthorized(Boolean(ok));
    } catch {
      setAuthorized(null);
    } finally {
      setLookupBusy(false);
    }
  }

  async function setAuth(newAuth: boolean) {
    if (!signer) return;
    const a = relayerInput.trim();
    if (!ethers.isAddress(a)) {
      setTxState("error");
      setTxMsg("Invalid relayer address.");
      return;
    }
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.relay.connect(signer) as typeof contracts.relay;
      const tx = await c.setRelayerAuthorized(a, newAuth);
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`${newAuth ? "Authorized" : "Revoked"} ${a.slice(0, 10)}…`);
      await load();
      await checkAuthorized();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxState("error");
      setTxMsg(humanizeError(err));
    }
  }

  async function handleLockOpen() {
    if (!signer) return;
    setLockBusy(true);
    try {
      const c = contracts.relay.connect(signer) as typeof contracts.relay;
      const tx = await c.lockRelayerOpen();
      await confirmTx(tx);
      await load();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setLockBusy(false);
    }
  }

  const isOwner = address && owner && address.toLowerCase() === owner.toLowerCase();

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <AdminNav />
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
        DatumRelay
      </h1>
      <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 16 }}>
        Permissionless network relay for signed claim batches. Anyone can submit a
        batch the publisher cosigned; ownership controls the authorized-relayer
        gate which becomes load-bearing only after <code>lockRelayerOpen()</code> is called.
      </div>

      <LockStateStrip entries={lockEntries} />

      <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 12 }}>State</div>
        <Row label="Authorized relayer count" value={authorizedCount ?? "…"} />
        <Row label="Liveness threshold (blocks)" value={liveness ?? "…"} />
        <Row
          label="Open mode"
          value={
            openLocked === null
              ? "…"
              : openLocked
              ? "Locked (curated set only)"
              : "Open — anyone can relay"
          }
        />
        <Row label="Owner" value={owner ?? "…"} mono />
      </div>

      <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
          Relayer authorization
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
          Set or revoke a relayer's authorization. While open mode is unlocked
          this is advisory; once <code>lockRelayerOpen()</code> fires, only
          authorized relayers can call <code>settleClaimsFor</code>.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ flex: 1, minWidth: 240, display: "flex", flexDirection: "column", fontSize: 11, color: "var(--text-muted)" }}>
            Relayer address
            <input
              className="nano-input"
              value={relayerInput}
              onChange={(e) => {
                setRelayerInput(e.target.value);
                setAuthorized(null);
              }}
              onBlur={checkAuthorized}
              placeholder="0x..."
              style={{ fontSize: 12 }}
            />
          </label>
          <button
            className="nano-btn"
            onClick={checkAuthorized}
            disabled={lookupBusy || !relayerInput.trim()}
            style={{ fontSize: 12, padding: "6px 14px" }}
          >
            {lookupBusy ? "Checking..." : "Check"}
          </button>
        </div>
        {authorized !== null && (
          <div style={{ marginTop: 8, fontSize: 12, color: authorized ? "var(--ok)" : "var(--text-muted)" }}>
            Current: <strong>{authorized ? "Authorized" : "Not authorized"}</strong>
          </div>
        )}
        {signer && isOwner && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              className="nano-btn nano-btn-accent"
              onClick={() => setAuth(true)}
              disabled={txState === "pending" || !relayerInput.trim()}
              style={{ fontSize: 12, padding: "6px 14px" }}
            >
              {txState === "pending" ? "Submitting..." : "Authorize"}
            </button>
            <button
              className="nano-btn nano-btn-danger"
              onClick={() => setAuth(false)}
              disabled={txState === "pending" || !relayerInput.trim()}
              style={{ fontSize: 12, padding: "6px 14px" }}
            >
              Revoke
            </button>
          </div>
        )}
        {!isOwner && (
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 10, fontStyle: "italic" }}>
            Owner-only mutation; connect with the relay owner to authorize/revoke.
          </div>
        )}
        <TransactionStatus state={txState} message={txMsg} />
      </div>

      <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
          Recent authorization changes (30d)
        </div>
        {recentAuth.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No authorization events in the last 30 days.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {recentAuth.map((row) => (
              <div
                key={`${row.relayer}-${row.block}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "4px 0",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 12,
                }}
              >
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                  {row.relayer.slice(0, 10)}…{row.relayer.slice(-6)}
                </span>
                <span style={{ color: row.authorized ? "var(--ok)" : "var(--error)" }}>
                  {row.authorized ? "authorized" : "revoked"}
                </span>
                <span style={{ color: "var(--text-muted)" }}>#{row.block}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {signer && isOwner && openLocked === false && (
        <div className="nano-card" style={{ padding: 16, border: "1px solid rgba(252,211,77,0.3)" }}>
          <div style={{ color: "var(--warn)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
            Lock open mode (one-way)
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
            Calling <code>lockRelayerOpen()</code> freezes the current open/closed disposition. There is no
            unlock — every future change to the relayer set must go through <code>setRelayerAuthorized</code>.
          </div>
          <button
            className="nano-btn"
            onClick={handleLockOpen}
            disabled={lockBusy}
            style={{ fontSize: 12, padding: "6px 14px", color: "var(--warn)", border: "1px solid rgba(252,211,77,0.3)" }}
          >
            {lockBusy ? "Locking..." : "Lock open mode"}
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", padding: "4px 0", fontSize: 13, borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text-muted)", minWidth: 200 }}>{label}</span>
      <span style={{ color: "var(--text)", flex: 1, fontFamily: mono ? "var(--font-mono)" : undefined, wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}
