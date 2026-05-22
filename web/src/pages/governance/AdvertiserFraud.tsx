// /governance/advertiser-fraud — public observatory + action page
// for the conviction-weighted advertiser-fraud track (CB4 mirror of
// PublisherGovernance for the advertiser direction).
//
// Two sections:
//
//  1. Active fraud proposals.
//     AdvertiserFraudProposed events in the last 7d. Each row
//     resolves the proposal state on demand (aye/nay weight,
//     resolved, upheld) via callContract and exposes Vote (aye/nay
//     with stake) + Resolve actions.
//
//  2. Council-arbitrated claims.
//     PublisherFraudClaimFiled events in the last 7d — these are the
//     publisher-side direct slashing track that bypasses conviction
//     voting and waits on the Council. Read-only view; resolution
//     happens through the Council propose/vote/execute path.
//
// Plus a "File a claim" section at the top for the Council-arbitrated
// path: a publisher stakes `publisherClaimBond` against an advertiser
// they have off-chain evidence on, and the Council reviews.
//
// When advertiserGovernance isn't deployed (current Paseo state) the
// page renders a "not available on this network" placeholder.

import { useEffect, useMemo, useState } from "react";
import { id as ethersId, Interface } from "ethers";
import { useLogs } from "../../hooks/useLogs";
import { useWallet } from "../../hooks/useWallet";
import { NeedsExtension } from "../../components/NeedsExtension";
import { TelemetryStatus } from "../../components/TelemetryStatus";
import { walletConnector } from "../../lib/walletConnector";
import { recordAction } from "../../lib/recentActions";
import { callContract } from "../../lib/contractRead";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_7D_BLOCKS = 14_400 * 7;

const TOPIC_PROPOSED = ethersId(
  "AdvertiserFraudProposed(uint256,address,address,bytes32)"
);
const TOPIC_CLAIM_FILED = ethersId(
  "PublisherFraudClaimFiled(uint256,address,address,uint256,bytes32,uint256)"
);

const ADV_GOV_IFACE = new Interface([
  "event AdvertiserFraudProposed(uint256 indexed id, address indexed advertiser, address indexed proposer, bytes32 evidenceHash)",
  "event PublisherFraudClaimFiled(uint256 indexed claimId, address indexed publisher, address indexed advertiser, uint256 campaignId, bytes32 evidenceHash, uint256 bond)",
  "function propose(address advertiser, bytes32 evidenceHash) payable returns (uint256)",
  "function vote(uint256 id, bool aye, uint8 conviction) payable",
  "function resolve(uint256 id)",
  "function filePublisherFraudClaim(address advertiser, uint256 campaignId, bytes32 evidenceHash) payable returns (uint256)",
]);

const ADV_GOV_READ_ABI = [
  "function proposeBond() view returns (uint256)",
  "function publisherClaimBond() view returns (uint256)",
  "function councilArbiter() view returns (address)",
  "function quorum() view returns (uint256)",
  "function minGraceBlocks() view returns (uint256)",
  "function proposals(uint256) view returns (address advertiser, bytes32 evidenceHash, uint256 ayeWeighted, uint256 nayWeighted, uint256 startBlock, uint256 lastNayBlock, bool resolved, bool upheld, address proposer, uint256 bondLocked)",
];

type ProposalRow = {
  id: bigint;
  advertiser: string;
  proposer: string;
  evidenceHash: string;
  block: number;
};

type ClaimRow = {
  claimId: bigint;
  publisher: string;
  advertiser: string;
  campaignId: bigint;
  evidenceHash: string;
  bond: bigint;
  block: number;
};

type ProposalState = {
  aye: bigint;
  nay: bigint;
  resolved: boolean;
  upheld: boolean;
  lastNayBlock: bigint;
};

export function AdvertiserFraud() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
  const wallet = useWallet();

  if (!addrs.advertiserGovernance) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Advertiser fraud
        </h1>
        <div style={{ color: "var(--text-muted)", marginTop: 16, fontSize: 13, lineHeight: 1.55 }}>
          The advertiser-fraud track (DatumAdvertiserGovernance) isn't deployed
          on this network yet. Once the contract lands, this page will surface
          active conviction-voted proposals and Council-arbitrated claims
          targeting advertisers.
        </div>
      </div>
    );
  }

  const govAddr = addrs.advertiserGovernance.toLowerCase();

  const propOpts = useMemo(
    () => ({
      address: govAddr,
      topic0: TOPIC_PROPOSED,
      windowBlocks: WINDOW_7D_BLOCKS,
      historyAllowed: true,
    }),
    [govAddr]
  );
  const claimOpts = useMemo(
    () => ({
      address: govAddr,
      topic0: TOPIC_CLAIM_FILED,
      windowBlocks: WINDOW_7D_BLOCKS,
      historyAllowed: true,
    }),
    [govAddr]
  );
  const propLogs = useLogs(propOpts);
  const claimLogs = useLogs(claimOpts);

  const [params, setParams] = useState<{
    proposeBond: bigint;
    publisherClaimBond: bigint;
    councilArbiter: string;
    quorum: bigint;
    minGraceBlocks: bigint;
  } | null>(null);
  const [paramsErr, setParamsErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [proposeBond, publisherClaimBond, councilArbiter, quorum, grace] =
          await Promise.all([
            callContract<bigint>({ address: govAddr, abi: ADV_GOV_READ_ABI, method: "proposeBond" }),
            callContract<bigint>({ address: govAddr, abi: ADV_GOV_READ_ABI, method: "publisherClaimBond" }),
            callContract<string>({ address: govAddr, abi: ADV_GOV_READ_ABI, method: "councilArbiter" }),
            callContract<bigint>({ address: govAddr, abi: ADV_GOV_READ_ABI, method: "quorum" }),
            callContract<bigint>({ address: govAddr, abi: ADV_GOV_READ_ABI, method: "minGraceBlocks" }),
          ]);
        if (cancelled) return;
        setParams({
          proposeBond,
          publisherClaimBond,
          councilArbiter: councilArbiter.toLowerCase(),
          quorum,
          minGraceBlocks: grace,
        });
      } catch (e: any) {
        if (!cancelled) setParamsErr(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [govAddr]);

  const proposals = useMemo<ProposalRow[]>(() => {
    return propLogs.logs
      .map((log) => {
        try {
          const d = ADV_GOV_IFACE.decodeEventLog("AdvertiserFraudProposed", log.data, log.topics);
          return {
            id: d[0] as bigint,
            advertiser: ("0x" + log.topics[2].slice(-40)).toLowerCase(),
            proposer: ("0x" + log.topics[3].slice(-40)).toLowerCase(),
            evidenceHash: d[3] as string,
            block: Number(BigInt(log.blockNumber)),
          } as ProposalRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is ProposalRow => r !== null)
      .sort((a, b) => b.block - a.block);
  }, [propLogs.logs]);

  const claims = useMemo<ClaimRow[]>(() => {
    return claimLogs.logs
      .map((log) => {
        try {
          const d = ADV_GOV_IFACE.decodeEventLog(
            "PublisherFraudClaimFiled",
            log.data,
            log.topics
          );
          return {
            claimId: d[0] as bigint,
            publisher: ("0x" + log.topics[2].slice(-40)).toLowerCase(),
            advertiser: ("0x" + log.topics[3].slice(-40)).toLowerCase(),
            campaignId: d[3] as bigint,
            evidenceHash: d[4] as string,
            bond: d[5] as bigint,
            block: Number(BigInt(log.blockNumber)),
          } as ClaimRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is ClaimRow => r !== null)
      .sort((a, b) => b.block - a.block);
  }, [claimLogs.logs]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <header>
        <h1
          style={{
            color: "var(--text-strong)",
            fontSize: 22,
            fontWeight: 700,
            margin: 0,
          }}
        >
          Advertiser fraud
        </h1>
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Conviction-voted fraud proposals + Council-arbitrated claims
          targeting fraudulent advertisers. Upheld outcomes slash the
          advertiser's stake on DatumAdvertiserStake.
        </div>
        {paramsErr && (
          <div style={{ color: "var(--error)", fontSize: 11, marginTop: 6 }}>
            Params unavailable — {paramsErr}
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <TelemetryStatus
            viaRpc={propLogs.viaRpc || claimLogs.viaRpc}
            truncatedTo={propLogs.truncatedTo ?? claimLogs.truncatedTo}
            hideWhileLoading
          />
        </div>
      </header>

      <FileClaimSection
        govAddr={govAddr}
        bond={params?.publisherClaimBond ?? 0n}
        councilArbiter={params?.councilArbiter ?? ""}
        wallet={wallet}
      />

      <ProposalsSection
        govAddr={govAddr}
        proposals={proposals}
        ready={propLogs.ready}
        proposeBond={params?.proposeBond ?? 0n}
        quorum={params?.quorum ?? 0n}
        minGraceBlocks={params?.minGraceBlocks ?? 0n}
        wallet={wallet}
      />

      <ClaimsSection claims={claims} ready={claimLogs.ready} />

      {!wallet.installed && (
        <NeedsExtension
          title="Wallet required for actions"
          description="Vote, resolve, and file-claim actions sign transactions. Install the DATUM extension and connect to use them."
        />
      )}
    </div>
  );
}

// ─── File-claim (Council-arbitrated) ────────────────────────────────

function FileClaimSection({
  govAddr,
  bond,
  councilArbiter,
  wallet,
}: {
  govAddr: string;
  bond: bigint;
  councilArbiter: string;
  wallet: ReturnType<typeof useWallet>;
}) {
  const [advertiser, setAdvertiser] = useState("");
  const [campaignId, setCampaignId] = useState("0");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const arbiterMissing =
    !councilArbiter || councilArbiter === "0x0000000000000000000000000000000000000000";
  const disabled = bond === 0n || arbiterMissing;

  async function fileClaim() {
    setBusy(true);
    setErr(null);
    setTx(null);
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(advertiser)) throw new Error("Invalid advertiser address");
      if (!/^0x[0-9a-fA-F]{64}$/.test(evidence)) throw new Error("Evidence must be a 0x-prefixed 32-byte hex");
      const cid = BigInt(campaignId || "0");
      const data = ADV_GOV_IFACE.encodeFunctionData("filePublisherFraudClaim", [
        advertiser,
        cid,
        evidence,
      ]);
      const hash = await walletConnector.request<string>({
        method: "eth_sendTransaction",
        params: [
          {
            from: wallet.address!,
            to: govAddr,
            data,
            value: "0x" + bond.toString(16),
          },
        ],
      });
      setTx(hash);
      recordAction("governance", wallet.address ?? null, {
        label: `Filed claim vs ${advertiser.slice(0, 6)}…`,
        route: "/governance/advertiser-fraud",
        txHash: hash,
      });
    } catch (e: any) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          File a Council-arbitrated claim
        </h2>
        <div style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace)" }}>
          Bond {formatDot(bond)}
          {arbiterMissing ? " · arbiter unset" : ""}
        </div>
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
        Publishers with off-chain evidence of advertiser fraud stake{" "}
        {formatDot(bond)} to file. The Council reviews and resolves —
        upheld → advertiser stake slashed and bond refunded; dismissed →
        bond forwarded to advertiser as compensation.
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <input
          type="text"
          value={advertiser}
          onChange={(e) => setAdvertiser(e.target.value)}
          placeholder="Advertiser address (0x…)"
          style={fieldStyle}
        />
        <input
          type="text"
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          placeholder="Campaign id (0 = advertiser-wide)"
          style={{ ...fieldStyle, width: 240 }}
        />
        <input
          type="text"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="Evidence (0x… 32-byte CID)"
          style={fieldStyle}
        />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          disabled={!wallet.connected || disabled || busy}
          onClick={fileClaim}
          style={primaryButton(!wallet.connected || disabled || busy)}
        >
          {busy ? "Filing…" : `File claim (${formatDot(bond)})`}
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

// ─── Conviction proposals ───────────────────────────────────────────

function ProposalsSection({
  govAddr,
  proposals,
  ready,
  proposeBond,
  quorum,
  minGraceBlocks,
  wallet,
}: {
  govAddr: string;
  proposals: ProposalRow[];
  ready: boolean;
  proposeBond: bigint;
  quorum: bigint;
  minGraceBlocks: bigint;
  wallet: ReturnType<typeof useWallet>;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
          Active proposals
        </h2>
        <div style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace)" }}>
          Propose bond {formatDot(proposeBond)} · quorum {formatDot(quorum)} · grace {minGraceBlocks.toString()} blocks
        </div>
      </div>
      {!ready ? (
        <div style={{ color: "var(--text-muted)" }}>Syncing…</div>
      ) : proposals.length === 0 ? (
        <div style={{ color: "var(--text-muted)" }}>
          No fraud proposals opened in the last 7 days.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {proposals.map((p) => (
            <ProposalRowView
              key={`${p.id}:${p.block}`}
              row={p}
              govAddr={govAddr}
              minGraceBlocks={minGraceBlocks}
              quorum={quorum}
              wallet={wallet}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProposalRowView({
  row,
  govAddr,
  minGraceBlocks,
  quorum,
  wallet,
}: {
  row: ProposalRow;
  govAddr: string;
  minGraceBlocks: bigint;
  quorum: bigint;
  wallet: ReturnType<typeof useWallet>;
}) {
  const [state, setState] = useState<ProposalState | null>(null);
  const [stateErr, setStateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"aye" | "nay" | "resolve" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [stake, setStake] = useState("1");
  const [conviction, setConviction] = useState("0");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tuple = await callContract<unknown[]>({
          address: govAddr,
          abi: ADV_GOV_READ_ABI,
          method: "proposals",
          args: [row.id],
        });
        if (cancelled) return;
        setState({
          aye: BigInt((tuple[2] as bigint).toString()),
          nay: BigInt((tuple[3] as bigint).toString()),
          lastNayBlock: BigInt((tuple[5] as bigint).toString()),
          resolved: tuple[6] as boolean,
          upheld: tuple[7] as boolean,
        });
      } catch (e: any) {
        if (!cancelled) setStateErr(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [govAddr, row.id, tx]);

  async function castVote(aye: boolean) {
    setBusy(aye ? "aye" : "nay");
    setErr(null);
    setTx(null);
    try {
      const c = Number(conviction);
      if (!(c >= 0 && c <= 8)) throw new Error("Conviction must be 0–8");
      const wei = parseDot(stake);
      if (wei <= 0n) throw new Error("Stake must be > 0");
      const data = ADV_GOV_IFACE.encodeFunctionData("vote", [row.id, aye, c]);
      const hash = await walletConnector.request<string>({
        method: "eth_sendTransaction",
        params: [
          {
            from: wallet.address!,
            to: govAddr,
            data,
            value: "0x" + wei.toString(16),
          },
        ],
      });
      setTx(hash);
      recordAction("governance", wallet.address ?? null, {
        label: `Voted ${aye ? "aye" : "nay"} on adv #${row.id}`,
        route: "/governance/advertiser-fraud",
        txHash: hash,
      });
    } catch (e: any) {
      setErr(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function resolve() {
    setBusy("resolve");
    setErr(null);
    setTx(null);
    try {
      const data = ADV_GOV_IFACE.encodeFunctionData("resolve", [row.id]);
      const hash = await walletConnector.request<string>({
        method: "eth_sendTransaction",
        params: [{ from: wallet.address!, to: govAddr, data }],
      });
      setTx(hash);
      recordAction("governance", wallet.address ?? null, {
        label: `Resolved adv #${row.id}`,
        route: "/governance/advertiser-fraud",
        txHash: hash,
      });
    } catch (e: any) {
      setErr(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  const resolved = state?.resolved ?? false;
  const upheld = state?.upheld ?? false;
  const ayeWins = state ? state.aye > state.nay && state.aye >= quorum : false;
  void minGraceBlocks; // displayed in section header; resolve() reverts E51 if early.

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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div style={{ color: "var(--text-strong)", fontSize: 14, fontWeight: 600 }}>
          Proposal #{row.id.toString()} · {shorten(row.advertiser)}
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace)" }}>
          {resolved ? (upheld ? "upheld" : "dismissed") : ayeWins ? "aye-leading" : "open"} · block {row.block}
        </div>
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
        Proposer{" "}
        <span style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>{row.proposer}</span> · evidence{" "}
        <span style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>
          {row.evidenceHash.slice(0, 12)}…
        </span>
      </div>
      {stateErr ? (
        <div style={{ color: "var(--error)", fontSize: 11 }}>state unavailable — {stateErr}</div>
      ) : state ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
          aye {formatWeighted(state.aye)} · nay {formatWeighted(state.nay)}
          {state.lastNayBlock > 0n ? ` · last nay block ${state.lastNayBlock.toString()}` : ""}
        </div>
      ) : (
        <div style={{ color: "var(--text-muted)", fontSize: 11 }}>loading…</div>
      )}

      {wallet.installed && !resolved && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
          <input
            type="text"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            placeholder="Stake (DOT)"
            style={{ ...fieldStyle, width: 110 }}
            disabled={busy !== null}
          />
          <input
            type="text"
            value={conviction}
            onChange={(e) => setConviction(e.target.value)}
            placeholder="Conviction 0–8"
            style={{ ...fieldStyle, width: 130 }}
            disabled={busy !== null}
          />
          <button
            disabled={!wallet.connected || busy !== null}
            onClick={() => castVote(true)}
            style={secondaryButton(!wallet.connected || busy !== null)}
          >
            {busy === "aye" ? "Voting…" : "Aye"}
          </button>
          <button
            disabled={!wallet.connected || busy !== null}
            onClick={() => castVote(false)}
            style={secondaryButton(!wallet.connected || busy !== null)}
          >
            {busy === "nay" ? "Voting…" : "Nay"}
          </button>
          <button
            disabled={!wallet.connected || busy !== null}
            onClick={resolve}
            style={primaryButton(!wallet.connected || busy !== null)}
          >
            {busy === "resolve" ? "Resolving…" : "Resolve"}
          </button>
        </div>
      )}

      {err && <div style={{ color: "var(--error)", fontSize: 11 }}>{err}</div>}
      {tx && (
        <div style={{ color: "var(--ok)", fontSize: 11 }}>
          Submitted — <span style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>{tx.slice(0, 10)}…{tx.slice(-6)}</span>
        </div>
      )}
    </div>
  );
}

// ─── Council-arbitrated claims (read-only) ──────────────────────────

function ClaimsSection({ claims, ready }: { claims: ClaimRow[]; ready: boolean }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 style={{ color: "var(--text-strong)", fontSize: 15, fontWeight: 600, margin: 0 }}>
        Council-arbitrated claims
      </h2>
      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
        Publisher-filed fraud claims waiting on Council resolution. Read-only;
        resolution lands through the Council propose / vote / execute flow.
      </div>
      {!ready ? (
        <div style={{ color: "var(--text-muted)" }}>Syncing…</div>
      ) : claims.length === 0 ? (
        <div style={{ color: "var(--text-muted)" }}>
          No claims filed in the last 7 days.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {claims.map((c) => (
            <div
              key={`${c.claimId}:${c.block}`}
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                background: "var(--bg-surface)",
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <div style={{ color: "var(--text-strong)", fontSize: 13, fontWeight: 600 }}>
                  Claim #{c.claimId.toString()} → {shorten(c.advertiser)}
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace)" }}>
                  Bond {formatDot(c.bond)} · block {c.block}
                </div>
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                Publisher{" "}
                <span style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>{c.publisher}</span>
                {c.campaignId > 0n ? ` · campaign #${c.campaignId.toString()}` : ""} · evidence{" "}
                <span style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>
                  {c.evidenceHash.slice(0, 12)}…
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
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

function secondaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-strong)",
    fontSize: 12,
    borderRadius: "var(--radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function humanizeError(e: any): string {
  const msg = String(e?.message ?? e);
  if (e?.code === 4001) return "Rejected by user.";
  if (msg.includes("E00")) return "Zero address / hash not allowed.";
  if (msg.includes("E01")) return "Track disabled or claim not found.";
  if (msg.includes("E11")) return "Incorrect bond amount.";
  if (msg.includes("E18")) return "Caller not authorized (or filing against self).";
  if (msg.includes("E40")) return "Conviction out of range (0–8).";
  if (msg.includes("E42")) return "Already voted on this proposal.";
  if (msg.includes("E50")) return "Proposal not open.";
  if (msg.includes("E51")) return "Grace window hasn't expired.";
  return msg;
}

function parseDot(input: string): bigint {
  // Accept "1", "1.5", ".5" — convert to planck (10^10).
  const s = input.trim();
  if (!s) return 0n;
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0000000000").slice(0, 10);
  return BigInt(whole || "0") * 10n ** 10n + BigInt(fracPadded || "0");
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

function formatWeighted(w: bigint): string {
  // Conviction-weighted stake is `stake * weight`. The display unit
  // matches DOT × weight — we render as plain numeric to avoid implying
  // a literal DOT amount.
  if (w === 0n) return "0";
  if (w < 10n ** 10n) return w.toString();
  const dot = w / 10n ** 10n;
  return `${dot.toString()}·w`;
}

function shorten(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
