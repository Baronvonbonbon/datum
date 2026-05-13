// Advertiser-side Bulletin Chain management page (F5).
//
// Shows the current Bulletin Chain creative reference for one campaign plus
// the renewal-related controls: expiry countdown, escrow balance, renewer
// allowlist + open-mode toggle, fund/withdraw escrow, and manual "Renew now".
//
// Lives at /advertiser/campaign/:id/bulletin and is linked from CampaignDetail.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ethers } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import {
  BulletinCodec,
  bulletinCidFromDigest,
  bulletinGatewayUrl,
  BULLETIN_RENEWAL_LEAD_BLOCKS,
} from "@shared/bulletinChain";
import {
  listInjectedExtensions,
  connectExtension,
  signerFor,
  renewOnBulletin,
} from "@shared/bulletinChainClient";
import { formatDOT, parseDOT } from "@shared/dot";

const ZERO_HASH = "0x" + "0".repeat(64);

interface BulletinSnapshot {
  cidDigest: string;
  cidCodec: number;
  bulletinBlock: number;
  bulletinIndex: number;
  expiryHubBlock: bigint;
  retentionHorizonBlock: bigint;
  version: number;
}

export function BulletinManager() {
  const { id } = useParams<{ id: string }>();
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [snapshot, setSnapshot] = useState<BulletinSnapshot | null>(null);
  const [escrow, setEscrow] = useState<bigint>(0n);
  const [openMode, setOpenMode] = useState<boolean>(false);
  const [reward, setReward] = useState<bigint>(0n);
  const [currentBlock, setCurrentBlock] = useState<bigint>(0n);
  const [busy, setBusy] = useState<string | null>(null);

  // Forms
  const [fundAmount, setFundAmount] = useState("0.1");
  const [withdrawAmount, setWithdrawAmount] = useState("0");
  const [withdrawRecipient, setWithdrawRecipient] = useState("");
  const [renewerAddr, setRenewerAddr] = useState("");

  async function refresh() {
    if (!id) return;
    try {
      const [ref, esc, open, rw, blk] = await Promise.all([
        contracts.campaigns.getBulletinCreative(BigInt(id)),
        contracts.campaigns.bulletinRenewalEscrow(BigInt(id)),
        contracts.campaigns.openBulletinRenewal(BigInt(id)),
        contracts.campaigns.bulletinRenewerReward(),
        contracts.campaigns.runner!.provider!.getBlockNumber(),
      ]);
      setSnapshot({
        cidDigest: (ref as any).cidDigest ?? (ref as any)[0],
        cidCodec: Number((ref as any).cidCodec ?? (ref as any)[1] ?? 0),
        bulletinBlock: Number((ref as any).bulletinBlock ?? (ref as any)[2] ?? 0),
        bulletinIndex: Number((ref as any).bulletinIndex ?? (ref as any)[3] ?? 0),
        expiryHubBlock: BigInt((ref as any).expiryHubBlock ?? (ref as any)[4] ?? 0n),
        retentionHorizonBlock: BigInt((ref as any).retentionHorizonBlock ?? (ref as any)[5] ?? 0n),
        version: Number((ref as any).version ?? (ref as any)[6] ?? 0),
      });
      setEscrow(BigInt(esc));
      setOpenMode(Boolean(open));
      setReward(BigInt(rw));
      setCurrentBlock(BigInt(blk));
    } catch (err) {
      push(humanizeError(err), "error");
    }
  }

  useEffect(() => { refresh(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasRef = snapshot && snapshot.cidDigest && snapshot.cidDigest !== ZERO_HASH;
  const blocksUntilExpiry = snapshot && hasRef && snapshot.expiryHubBlock > currentBlock
    ? snapshot.expiryHubBlock - currentBlock
    : 0n;
  const isExpired = snapshot && hasRef && snapshot.expiryHubBlock <= currentBlock;
  const isRenewalDue = hasRef && !isExpired && blocksUntilExpiry <= BULLETIN_RENEWAL_LEAD_BLOCKS;
  const cid = hasRef ? bulletinCidFromDigest(snapshot!.cidDigest, snapshot!.cidCodec as BulletinCodec) : "";
  const gatewayUrl = hasRef ? bulletinGatewayUrl(snapshot!.cidDigest, snapshot!.cidCodec as BulletinCodec) : null;

  async function fundEscrow() {
    if (!signer || !id) return;
    try {
      setBusy("Funding escrow...");
      const v = parseDOT(fundAmount);
      const c = contracts.campaigns.connect(signer);
      const tx = await c.fundBulletinRenewalEscrow(BigInt(id), { value: v });
      await confirmTx(tx);
      push("Escrow funded", "success");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  async function withdrawEscrow() {
    if (!signer || !id) return;
    try {
      setBusy("Withdrawing escrow...");
      const v = parseDOT(withdrawAmount);
      const recipient = (withdrawRecipient.trim() || address) as string;
      if (!ethers.isAddress(recipient)) throw new Error("Invalid recipient address");
      const c = contracts.campaigns.connect(signer);
      const tx = await c.withdrawBulletinRenewalEscrow(BigInt(id), recipient, v);
      await confirmTx(tx);
      push("Escrow withdrawn", "success");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  async function toggleOpenMode() {
    if (!signer || !id) return;
    try {
      setBusy(`${openMode ? "Disabling" : "Enabling"} open renewal...`);
      const c = contracts.campaigns.connect(signer);
      const tx = await c.setOpenBulletinRenewal(BigInt(id), !openMode);
      await confirmTx(tx);
      push(`Open renewal ${openMode ? "disabled" : "enabled"}`, "success");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  async function authorizeRenewer(approve: boolean) {
    if (!signer || !id) return;
    try {
      const addr = renewerAddr.trim();
      if (!ethers.isAddress(addr)) throw new Error("Invalid renewer address");
      setBusy(`${approve ? "Approving" : "Revoking"} renewer...`);
      const c = contracts.campaigns.connect(signer);
      const tx = await c.setApprovedBulletinRenewer(BigInt(id), addr, approve);
      await confirmTx(tx);
      push(`Renewer ${approve ? "approved" : "revoked"}`, "success");
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  async function renewNow() {
    if (!signer || !id || !snapshot) return;
    try {
      setBusy("Looking for wallet extension...");
      const exts = await listInjectedExtensions();
      if (exts.length === 0) throw new Error("No Polkadot wallet extension detected.");
      const { accounts } = await connectExtension(exts[0]);
      if (accounts.length === 0) throw new Error(`No accounts in ${exts[0]}.`);
      const account = accounts[0];

      setBusy(`Renewing on Bulletin Chain via ${account.address.slice(0, 10)}...`);
      const renewRes = await renewOnBulletin(
        snapshot.bulletinBlock,
        snapshot.bulletinIndex,
        signerFor(account),
      );
      setBusy(`Confirming on Hub (new block ${renewRes.newBulletinBlock})...`);
      const c = contracts.campaigns.connect(signer);
      const tx = await c.confirmBulletinRenewal(
        BigInt(id),
        renewRes.newBulletinBlock,
        renewRes.newBulletinIndex,
      );
      await confirmTx(tx);
      push("Bulletin creative renewed", "success");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  if (!signer) {
    return <div style={{ color: "var(--text-muted)", padding: 20 }}>Connect your wallet to manage Bulletin Chain storage.</div>;
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <div style={{ marginBottom: 20 }}>
        <Link to={`/advertiser/campaign/${id}`} style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Campaign #{id}</Link>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginTop: 8 }}>Bulletin Chain Storage</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Manage the Polkadot Bulletin Chain creative reference and renewal economics for this campaign.
        </p>
      </div>

      {!hasRef ? (
        <div className="nano-info">
          No Bulletin Chain creative set. Go to <Link to={`/advertiser/campaign/${id}/metadata`} style={{ color: "var(--accent)" }}>Set Metadata</Link> and choose Bulletin Chain as the upload provider.
        </div>
      ) : (
        <>
          <Section title="Current reference">
            <Row label="CID" value={<code style={{ fontSize: 11, wordBreak: "break-all" }}>{cid}</code>} />
            <Row label="Codec" value={snapshot!.cidCodec === BulletinCodec.Raw ? "Raw" : "DAG-PB (chunked)"} />
            <Row label="Bulletin block" value={`${snapshot!.bulletinBlock} / idx ${snapshot!.bulletinIndex}`} />
            <Row label="Version" value={snapshot!.version} />
            {gatewayUrl && (
              <Row label="Preview" value={
                <a href={gatewayUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                  Open on Paseo gateway →
                </a>
              } />
            )}
          </Section>

          <Section title="Expiry">
            {isExpired ? (
              <div className="nano-info nano-info--warn">
                Retention has lapsed. Anyone can call <code>markBulletinExpired</code> to clear the on-chain ref;
                the frontend will fall back to the legacy IPFS hash.
              </div>
            ) : isRenewalDue ? (
              <div className="nano-info nano-info--warn">
                Renewal due in {blocksUntilExpiry.toString()} blocks (~{(Number(blocksUntilExpiry) * 6 / 3600).toFixed(1)} h).
              </div>
            ) : (
              <div className="nano-info">
                {blocksUntilExpiry.toString()} blocks until expiry (~{(Number(blocksUntilExpiry) * 6 / 86400).toFixed(1)} days).
              </div>
            )}
            <button className="nano-btn nano-btn-accent" onClick={renewNow} disabled={busy !== null} style={{ marginTop: 8 }}>
              {busy ?? "Renew now"}
            </button>
          </Section>

          <Section title="Renewal escrow">
            <Row label="Current balance" value={`${formatDOT(escrow)} DOT`} />
            <Row label="Reward per renewal" value={`${formatDOT(reward)} DOT`} />
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <Field label="Fund (DOT)">
                <input className="nano-input" value={fundAmount} onChange={(e) => setFundAmount(e.target.value)} style={{ width: 100 }} />
              </Field>
              <button className="nano-btn" onClick={fundEscrow} disabled={busy !== null}>Fund</button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <Field label="Withdraw (DOT)">
                <input className="nano-input" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} style={{ width: 100 }} />
              </Field>
              <Field label="Recipient (default self)">
                <input className="nano-input" value={withdrawRecipient} onChange={(e) => setWithdrawRecipient(e.target.value)} placeholder={address ?? "0x..."} style={{ width: 240 }} />
              </Field>
              <button className="nano-btn" onClick={withdrawEscrow} disabled={busy !== null}>Withdraw</button>
            </div>
          </Section>

          <Section title="Renewer trust">
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={openMode} onChange={toggleOpenMode} disabled={busy !== null} />
                <span>Open renewal — anyone can call <code>confirmBulletinRenewal</code></span>
              </label>
              <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 4 }}>
                Open mode is maximally permissionless but exposes escrow to fraud:
                a caller can pull the renewer reward without actually renewing on
                Bulletin Chain. Recommended only with small escrow balances.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <Field label="Renewer address">
                <input className="nano-input" value={renewerAddr} onChange={(e) => setRenewerAddr(e.target.value)} placeholder="0x..." style={{ width: 320 }} />
              </Field>
              <button className="nano-btn" onClick={() => authorizeRenewer(true)} disabled={busy !== null}>Approve</button>
              <button className="nano-btn nano-btn-danger" onClick={() => authorizeRenewer(false)} disabled={busy !== null}>Revoke</button>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

// ── Small layout helpers ─────────────────────────────────────────────────────

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
      <span style={{ color: "var(--text-muted)", minWidth: 130 }}>{label}</span>
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
