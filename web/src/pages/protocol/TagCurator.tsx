// /protocol/tag-curator — G-6 tag approvals + appeals observatory.
//
// Public route. Two sections:
//
//   1. File an appeal — anyone can stake `appealBond` to push a
//      previously-unapproved tag to the Council for review. Form
//      collects { tag (32-byte hex), evidence CID (32-byte hex) }
//      and POSTs via filer to the curator address.
//
//   2. Recent activity — TagApproved / TagAppealFiled /
//      TagAppealResolved events in the last 7 days, decoded into
//      readable rows.
//
// The TagCurator address is read at mount time from
// tagSystem.tagCurator(); the page falls back to an inert state
// when either contract is unavailable on the network.

import { useEffect, useMemo, useState } from "react";
import { id as ethersId, Interface } from "ethers";
import { useLogs } from "../../hooks/useLogs";
import { TelemetryStatus } from "../../components/TelemetryStatus";
import { useWallet } from "../../hooks/useWallet";
import { NeedsExtension } from "../../components/NeedsExtension";
import { walletConnector } from "../../lib/walletConnector";
import { callContract } from "../../lib/contractRead";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_7D_BLOCKS = 14_400 * 7;

const TOPIC_APPROVED = ethersId("TagApproved(bytes32)");
const TOPIC_FILED = ethersId(
  "TagAppealFiled(uint256,address,bytes32,bytes32,uint256)"
);
const TOPIC_RESOLVED = ethersId(
  "TagAppealResolved(uint256,bytes32,bool,uint256)"
);

const IFACE = new Interface([
  "event TagApproved(bytes32 indexed tag)",
  "event TagAppealFiled(uint256 indexed appealId, address indexed appellant, bytes32 indexed tag, bytes32 evidenceHash, uint256 bond)",
  "event TagAppealResolved(uint256 indexed appealId, bytes32 indexed tag, bool upheld, uint256 bondDisposition)",
  "function fileTagAppeal(bytes32 tag, bytes32 evidenceHash) payable returns (uint256)",
]);

const READ_ABI = [
  "function appealBond() view returns (uint256)",
  "function council() view returns (address)",
];

type ActivityRow =
  | { kind: "approved"; tag: string; block: number }
  | { kind: "filed"; appealId: bigint; appellant: string; tag: string; bond: bigint; block: number }
  | { kind: "resolved"; appealId: bigint; tag: string; upheld: boolean; block: number };

export function TagCurator() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
  const wallet = useWallet();

  const [curator, setCurator] = useState<string | null>(null);
  const [params, setParams] = useState<{ appealBond: bigint; council: string } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!addrs.tagSystem) throw new Error("tagSystem not deployed");
        const cur = await callContract<string>({
          address: addrs.tagSystem,
          abi: ["function tagCurator() view returns (address)"],
          method: "tagCurator",
        });
        if (cancelled) return;
        if (!cur || cur === "0x0000000000000000000000000000000000000000") {
          throw new Error("tagCurator not set on tagSystem");
        }
        setCurator(cur.toLowerCase());
        const [appealBond, council] = await Promise.all([
          callContract<bigint>({ address: cur, abi: READ_ABI, method: "appealBond" }),
          callContract<string>({ address: cur, abi: READ_ABI, method: "council" }),
        ]);
        if (!cancelled) setParams({ appealBond, council: council.toLowerCase() });
      } catch (e: any) {
        if (!cancelled) setLoadErr(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [addrs.tagSystem]);

  if (!addrs.tagSystem || loadErr) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Tag curator
        </h1>
        <div style={{ color: "var(--text-muted)", marginTop: 16, fontSize: 13, lineHeight: 1.55 }}>
          {loadErr ?? "TagSystem isn't deployed on this network yet."}
        </div>
      </div>
    );
  }

  if (!curator) {
    return <div style={{ padding: 24, color: "var(--text-muted)" }}>Resolving curator address…</div>;
  }

  return (
    <Inner
      curator={curator}
      appealBond={params?.appealBond ?? 0n}
      council={params?.council ?? ""}
      wallet={wallet}
    />
  );
}

function Inner({
  curator,
  appealBond,
  council,
  wallet,
}: {
  curator: string;
  appealBond: bigint;
  council: string;
  wallet: ReturnType<typeof useWallet>;
}) {
  const approvedLogs = useLogs(
    useMemo(
      () => ({ address: curator, topic0: TOPIC_APPROVED, windowBlocks: WINDOW_7D_BLOCKS, historyAllowed: true }),
      [curator]
    )
  );
  const filedLogs = useLogs(
    useMemo(
      () => ({ address: curator, topic0: TOPIC_FILED, windowBlocks: WINDOW_7D_BLOCKS, historyAllowed: true }),
      [curator]
    )
  );
  const resolvedLogs = useLogs(
    useMemo(
      () => ({ address: curator, topic0: TOPIC_RESOLVED, windowBlocks: WINDOW_7D_BLOCKS, historyAllowed: true }),
      [curator]
    )
  );

  const rows = useMemo<ActivityRow[]>(() => {
    const out: ActivityRow[] = [];
    for (const log of approvedLogs.logs) {
      out.push({
        kind: "approved",
        tag: log.topics[1] ?? "0x",
        block: Number(BigInt(log.blockNumber)),
      });
    }
    for (const log of filedLogs.logs) {
      try {
        const d = IFACE.decodeEventLog("TagAppealFiled", log.data, log.topics);
        out.push({
          kind: "filed",
          appealId: d[0] as bigint,
          appellant: ("0x" + log.topics[2].slice(-40)).toLowerCase(),
          tag: log.topics[3] ?? "0x",
          bond: d[4] as bigint,
          block: Number(BigInt(log.blockNumber)),
        });
      } catch {/* skip */}
    }
    for (const log of resolvedLogs.logs) {
      try {
        const d = IFACE.decodeEventLog("TagAppealResolved", log.data, log.topics);
        out.push({
          kind: "resolved",
          appealId: d[0] as bigint,
          tag: log.topics[2] ?? "0x",
          upheld: d[2] as boolean,
          block: Number(BigInt(log.blockNumber)),
        });
      } catch {/* skip */}
    }
    return out.sort((a, b) => b.block - a.block);
  }, [approvedLogs.logs, filedLogs.logs, resolvedLogs.logs]);

  const ready = approvedLogs.ready && filedLogs.ready && resolvedLogs.ready;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Tag curator
        </h1>
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Council-arbitrated tag whitelist. Appeals push a tag through to
          Council review; upheld appeals approve the tag and refund the bond.
          Dismissed appeals forfeit the bond to the treasury.
        </div>
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            marginTop: 6,
            fontFamily: "var(--font-mono, ui-monospace)",
          }}
        >
          Curator {shorten(curator)} · Council {shorten(council)} · Appeal bond {formatDot(appealBond)}
        </div>
        <div style={{ marginTop: 6 }}>
          <TelemetryStatus
            viaRpc={approvedLogs.viaRpc || filedLogs.viaRpc || resolvedLogs.viaRpc}
            truncatedTo={
              approvedLogs.truncatedTo ?? filedLogs.truncatedTo ?? resolvedLogs.truncatedTo
            }
            hideWhileLoading
          />
        </div>
      </header>

      <FileAppealSection curator={curator} bond={appealBond} wallet={wallet} />

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          Recent activity
        </h2>
        {!ready ? (
          <div style={{ color: "var(--text-muted)" }}>Syncing…</div>
        ) : rows.length === 0 ? (
          <div style={{ color: "var(--text-muted)" }}>No tag events in the last 7 days.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((r, i) => (
              <ActivityRowView key={i} row={r} />
            ))}
          </div>
        )}
      </section>

      {!wallet.installed && (
        <NeedsExtension
          title="Wallet required for actions"
          description="Filing a tag appeal posts the appeal bond. Install the DATUM extension and connect to use it."
        />
      )}
    </div>
  );
}

function FileAppealSection({
  curator,
  bond,
  wallet,
}: {
  curator: string;
  bond: bigint;
  wallet: ReturnType<typeof useWallet>;
}) {
  const [tag, setTag] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  async function file() {
    setBusy(true);
    setErr(null);
    setTx(null);
    try {
      if (!/^0x[0-9a-fA-F]{64}$/.test(tag)) throw new Error("Tag must be a 0x-prefixed 32-byte hex");
      if (!/^0x[0-9a-fA-F]{64}$/.test(evidence)) throw new Error("Evidence must be a 0x-prefixed 32-byte hex");
      const data = IFACE.encodeFunctionData("fileTagAppeal", [tag, evidence]);
      const hash = await walletConnector.request<string>({
        method: "eth_sendTransaction",
        params: [
          { from: wallet.address!, to: curator, data, value: "0x" + bond.toString(16) },
        ],
      });
      setTx(hash);
    } catch (e: any) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const disabled = bond === 0n;

  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-surface)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
        File a tag appeal
      </h2>
      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
        Push an unapproved tag to the Council. Bond {formatDot(bond)} — refunded if
        upheld, forfeited if dismissed.
      </div>
      <input
        type="text"
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        placeholder="Tag (0x… 32-byte)"
        style={fieldStyle}
      />
      <input
        type="text"
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        placeholder="Evidence (0x… 32-byte CID)"
        style={fieldStyle}
      />
      <div>
        <button
          disabled={!wallet.connected || disabled || busy}
          onClick={file}
          style={primaryButton(!wallet.connected || disabled || busy)}
        >
          {busy ? "Filing…" : `File appeal (${formatDot(bond)})`}
        </button>
      </div>
      {err && <div style={{ color: "var(--error)", fontSize: 11 }}>{err}</div>}
      {tx && (
        <div style={{ color: "var(--ok)", fontSize: 11 }}>
          Submitted — <span style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>{tx.slice(0, 10)}…{tx.slice(-6)}</span>
        </div>
      )}
    </section>
  );
}

function ActivityRowView({ row }: { row: ActivityRow }) {
  let title = "";
  let subtitle = "";
  let color = "var(--text-strong)";
  if (row.kind === "approved") {
    title = `Tag approved`;
    subtitle = `${bytes32Label(row.tag)} · block ${row.block}`;
    color = "var(--ok)";
  } else if (row.kind === "filed") {
    title = `Appeal #${row.appealId} filed`;
    subtitle = `${bytes32Label(row.tag)} · ${shorten(row.appellant)} · ${formatDot(row.bond)} · block ${row.block}`;
  } else {
    title = `Appeal #${row.appealId} ${row.upheld ? "upheld" : "dismissed"}`;
    subtitle = `${bytes32Label(row.tag)} · block ${row.block}`;
    color = row.upheld ? "var(--ok)" : "var(--text-muted)";
  }
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-surface)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div style={{ color, fontSize: 13, fontWeight: 600 }}>{title}</div>
      <div style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace)" }}>
        {subtitle}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  padding: "6px 8px",
  background: "var(--bg)",
  color: "var(--text-strong)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  fontSize: 12,
  fontFamily: "var(--font-mono, ui-monospace)",
};

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    border: "1px solid var(--text-strong)",
    background: "var(--text-strong)",
    color: "var(--bg)",
    fontSize: 12,
    borderRadius: "var(--radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function humanizeError(e: any): string {
  const msg = String(e?.message ?? e);
  if (e?.code === 4001) return "Rejected by user.";
  if (msg.includes("E00")) return "Tag / evidence cannot be zero.";
  if (msg.includes("E01")) return "Appeal track disabled (bond = 0).";
  if (msg.includes("E11")) return "Incorrect bond amount.";
  if (msg.includes("E22")) return "Tag is already approved — no need to appeal.";
  return msg;
}

function bytes32Label(b32: string): string {
  if (!b32 || !b32.startsWith("0x")) return b32 ?? "";
  const hex = b32.slice(2);
  let s = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substr(i, 2), 16);
    if (byte === 0) break;
    if (byte >= 0x20 && byte < 0x7f) s += String.fromCharCode(byte);
  }
  return s || `${b32.slice(0, 10)}…`;
}

function shorten(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatDot(planck: bigint): string {
  if (planck === 0n) return "0 DOT";
  const whole = planck / 10n ** 10n;
  const frac = planck % 10n ** 10n;
  if (whole === 0n) {
    const padded = frac.toString().padStart(10, "0");
    const trimmed = padded.slice(0, 4).replace(/0+$/, "") || "0";
    return `0.${trimmed} DOT`;
  }
  const fracStr = frac.toString().padStart(10, "0").slice(0, 4).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr} DOT` : `${whole} DOT`;
}
