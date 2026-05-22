// /governance/activation-bonds — public observatory + action page
// for the optimistic-activation pipeline.
//
// Shows every BondOpened event in the recent 7d window with its
// challenge state. Two action paths:
//   - "Challenge" — anyone can post a matching bond to force a vote
//     on a Pending campaign during the timelock window.
//   - "Activate" — permissionless after the timelock expires and no
//     challenge was filed; pulls the campaign into Active state.
//
// Both writes require a connected wallet (NeedsExtension gate on the
// per-row buttons). Reads are public.

import { useMemo, useState } from "react";
import { id as ethersId, Interface } from "ethers";
import { useLogs } from "../../hooks/useLogs";
import { useWallet } from "../../hooks/useWallet";
import { NeedsExtension } from "../../components/NeedsExtension";
import { TelemetryStatus } from "../../components/TelemetryStatus";
import { walletConnector } from "../../lib/walletConnector";
import { recordAction } from "../../lib/recentActions";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_7D_BLOCKS = 14_400 * 7;

const TOPIC_BOND_OPENED = ethersId(
  "BondOpened(uint256,address,uint256,uint64)"
);
const BOND_IFACE = new Interface([
  "event BondOpened(uint256 indexed campaignId, address indexed creator, uint256 bond, uint64 timelockExpiry)",
  "function challenge(uint256 campaignId) payable",
  "function activate(uint256 campaignId)",
]);

type BondRow = {
  campaignId: bigint;
  creator: string;
  bond: bigint;
  timelockExpiry: bigint;
  block: number;
};

export function ActivationBonds() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
  const wallet = useWallet();

  // No activation bonds contract = nothing to render. (Should never
  // happen on Paseo since we ship it as a core contract; defensive
  // for the local devnet / pre-deploy case.)
  if (!addrs.activationBonds) {
    return (
      <div style={{ padding: 24, color: "var(--text-muted)" }}>
        ActivationBonds isn't deployed on this network.
      </div>
    );
  }

  const opts = useMemo(
    () => ({
      address: addrs.activationBonds!.toLowerCase(),
      topic0: TOPIC_BOND_OPENED,
      windowBlocks: WINDOW_7D_BLOCKS,
      historyAllowed: true,
    }),
    [addrs.activationBonds]
  );
  const { logs, ready, viaRpc, truncatedTo } = useLogs(opts);

  const rows = useMemo<BondRow[]>(() => {
    return logs
      .map((log) => {
        try {
          const d = BOND_IFACE.decodeEventLog("BondOpened", log.data, log.topics);
          return {
            campaignId: d[0] as bigint,
            creator: ("0x" + log.topics[2].slice(-40)).toLowerCase(),
            bond: d[2] as bigint,
            timelockExpiry: d[3] as bigint,
            block: Number(BigInt(log.blockNumber)),
          } as BondRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is BondRow => r !== null)
      .sort((a, b) => b.block - a.block);
  }, [logs]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <h1
          style={{
            color: "var(--text-strong)",
            fontSize: 22,
            fontWeight: 700,
            margin: 0,
          }}
        >
          Activation bonds
        </h1>
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Pending campaigns with an open creator bond. Challenge during
          the timelock window to force a vote; activate after expiry to
          pull uncontested campaigns into Active state.
        </div>
        <div style={{ marginTop: 6 }}>
          <TelemetryStatus viaRpc={viaRpc} truncatedTo={truncatedTo} hideWhileLoading />
        </div>
      </header>

      {!ready ? (
        <div style={{ color: "var(--text-muted)" }}>Syncing…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--text-muted)" }}>
          No bonds opened in the last 7 days.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((row) => (
            <BondRowView
              key={`${row.campaignId}:${row.block}`}
              row={row}
              wallet={wallet}
              activationBondsAddr={addrs.activationBonds!}
            />
          ))}
        </div>
      )}

      {!wallet.installed && (
        <NeedsExtension
          title="Wallet required for actions"
          description="Challenge and activate actions sign transactions. Install the DATUM extension and connect to use them."
        />
      )}
    </div>
  );
}

function BondRowView({
  row,
  wallet,
  activationBondsAddr,
}: {
  row: BondRow;
  wallet: ReturnType<typeof useWallet>;
  activationBondsAddr: string;
}) {
  const [busy, setBusy] = useState<"challenge" | "activate" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const timelockBlocks = row.timelockExpiry;

  async function challenge() {
    setBusy("challenge");
    setErr(null);
    setTxHash(null);
    try {
      const data = BOND_IFACE.encodeFunctionData("challenge", [row.campaignId]);
      // Challenger posts an equal bond — read row.bond as the value.
      // ethers signs an EIP-1559 with the field; we use walletConnector
      // to route through the extension's signer.
      const txParams = {
        from: wallet.address!,
        to: activationBondsAddr,
        data,
        value: "0x" + row.bond.toString(16),
      };
      const hash = await walletConnector.request<string>({
        method: "eth_sendTransaction",
        params: [txParams],
      });
      setTxHash(hash);
      recordAction("governance", wallet.address ?? null, {
        label: `Challenged campaign #${row.campaignId}`,
        route: "/governance/activation-bonds",
        txHash: hash,
      });
    } catch (e: any) {
      setErr(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function activate() {
    setBusy("activate");
    setErr(null);
    setTxHash(null);
    try {
      const data = BOND_IFACE.encodeFunctionData("activate", [row.campaignId]);
      const txParams = {
        from: wallet.address!,
        to: activationBondsAddr,
        data,
      };
      const hash = await walletConnector.request<string>({
        method: "eth_sendTransaction",
        params: [txParams],
      });
      setTxHash(hash);
      recordAction("governance", wallet.address ?? null, {
        label: `Activated campaign #${row.campaignId}`,
        route: "/governance/activation-bonds",
        txHash: hash,
      });
    } catch (e: any) {
      setErr(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-surface)",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <div style={{ color: "var(--text-strong)", fontSize: 14, fontWeight: 600 }}>
          Campaign #{row.campaignId.toString()}
        </div>
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            fontFamily: "var(--font-mono, ui-monospace)",
          }}
        >
          Bond {formatDot(row.bond)} · expires block {timelockBlocks.toString()}
        </div>
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
        Creator{" "}
        <span style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>
          {row.creator}
        </span>{" "}
        · opened at block {row.block}
      </div>

      {wallet.installed && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            disabled={!wallet.connected || busy !== null}
            onClick={challenge}
            style={{
              padding: "6px 10px",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-strong)",
              fontSize: 12,
              borderRadius: "var(--radius)",
              cursor:
                !wallet.connected || busy !== null ? "not-allowed" : "pointer",
              opacity: !wallet.connected || busy !== null ? 0.5 : 1,
            }}
          >
            {busy === "challenge" ? "Challenging…" : "Challenge"}
          </button>
          <button
            disabled={!wallet.connected || busy !== null}
            onClick={activate}
            style={{
              padding: "6px 10px",
              border: "1px solid var(--text-strong)",
              background: "var(--text-strong)",
              color: "var(--bg)",
              fontSize: 12,
              borderRadius: "var(--radius)",
              cursor:
                !wallet.connected || busy !== null ? "not-allowed" : "pointer",
              opacity: !wallet.connected || busy !== null ? 0.5 : 1,
            }}
          >
            {busy === "activate" ? "Activating…" : "Activate"}
          </button>
        </div>
      )}

      {err && (
        <div style={{ color: "var(--error)", fontSize: 11 }}>{err}</div>
      )}
      {txHash && (
        <div style={{ color: "var(--ok)", fontSize: 11 }}>
          Submitted —{" "}
          <span style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>
            {txHash.slice(0, 10)}…{txHash.slice(-6)}
          </span>
        </div>
      )}
    </div>
  );
}

function humanizeError(e: any): string {
  const msg = String(e?.message ?? e);
  // EIP-1193 error code 4001 = user rejected
  if (e?.code === 4001) return "Rejected by user.";
  if (msg.includes("E97")) return "Creator can't challenge their own campaign.";
  if (msg.includes("E96")) return "Timelock hasn't expired yet — wait or challenge instead.";
  return msg;
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
