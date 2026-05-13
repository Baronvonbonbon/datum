// User-facing dust claim page.
//
// PaseoSafeSender contracts queue trailing planck dust (sub-10^6 remainders)
// into `pendingPaseoDust[recipient]` whenever a payout would otherwise be
// rejected by Paseo's eth-rpc denomination-rounding bug. This page surveys
// every PaseoSafeSender contract on the current deploy for the connected
// address's pending dust and lets the user pull each balance.

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useSettings } from "../../context/SettingsContext";
import { useWallet } from "../../context/WalletContext";
import { useContracts } from "../../hooks/useContracts";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { formatDOT } from "@shared/dot";
import { ContractAddresses } from "@shared/types";

// All PaseoSafeSender inheritors on alpha-4. Each is queried for
// pendingPaseoDust(connectedAddress).
function paseoSafeSenderContracts(addrs: ContractAddresses): Array<{ label: string; addr: string }> {
  const list: Array<{ label: string; addr: string }> = [
    { label: "BudgetLedger",          addr: addrs.budgetLedger },
    { label: "ChallengeBonds",        addr: addrs.challengeBonds },
    { label: "GovernanceV2",          addr: addrs.governanceV2 },
    { label: "PaymentVault",          addr: addrs.paymentVault },
    { label: "PublisherGovernance",   addr: addrs.publisherGovernance },
    { label: "PublisherStake",        addr: addrs.publisherStake },
    { label: "GovernanceRouter",      addr: addrs.governanceRouter },
    { label: "ParameterGovernance",   addr: addrs.parameterGovernance },
    { label: "Campaigns",             addr: addrs.campaigns },
  ];
  if (addrs.feeShare) list.push({ label: "FeeShare", addr: addrs.feeShare });
  return list.filter((e) => e.addr && e.addr !== "0x0000000000000000000000000000000000000000");
}

const DUST_ABI = [
  "function pendingPaseoDust(address) view returns (uint256)",
  "function claimPaseoDust()",
  "function claimPaseoDustTo(address)",
];

interface DustRow {
  label: string;
  addr: string;
  pending: bigint;
}

export function Dust() {
  const { settings } = useSettings();
  const { signer, address } = useWallet();
  const contracts = useContracts();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [rows, setRows] = useState<DustRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function scan() {
    if (!address) return;
    setScanning(true);
    try {
      const list = paseoSafeSenderContracts(settings.contractAddresses);
      const results = await Promise.all(
        list.map(async (e) => {
          try {
            const c = new ethers.Contract(e.addr, DUST_ABI, contracts.readProvider);
            const p: bigint = await c.pendingPaseoDust(address);
            return { ...e, pending: BigInt(p) };
          } catch {
            return { ...e, pending: 0n };
          }
        }),
      );
      setRows(results);
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => { scan(); }, [address, settings.contractAddresses]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalDust = rows.reduce((acc, r) => acc + r.pending, 0n);
  const dustyRows = rows.filter((r) => r.pending > 0n);

  async function claim(addr: string, toRecipient: boolean) {
    if (!signer) return;
    try {
      const c = new ethers.Contract(addr, DUST_ABI, signer);
      let tx;
      if (toRecipient) {
        const r = recipient.trim();
        if (!ethers.isAddress(r)) throw new Error("Invalid recipient address");
        setBusy(`Claiming to ${r.slice(0, 10)}...`);
        tx = await c.claimPaseoDustTo(r);
      } else {
        setBusy("Claiming dust...");
        tx = await c.claimPaseoDust();
      }
      await confirmTx(tx);
      push("Dust claimed", "ok");
      await scan();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  if (!address) {
    return <div style={{ color: "var(--text-muted)", padding: 20 }}>Connect your wallet to view pending dust.</div>;
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Pending dust</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Trailing DOT planck that Paseo's eth-rpc rounding bug rejected on a payout.
          Each contract holds it queued under your address until you pull it.
        </p>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Total queued</div>
          <div style={{ color: "var(--text-strong)", fontSize: 18, fontWeight: 600 }}>{formatDOT(totalDust)} DOT</div>
        </div>
        <button className="nano-btn" onClick={scan} disabled={scanning}>{scanning ? "Scanning..." : "Re-scan"}</button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
          Send dust to (optional — default self)
          <input className="nano-input" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder={address} />
        </label>
      </div>

      {dustyRows.length === 0 ? (
        <div className="nano-info">No pending dust across the {rows.length} surveyed contracts.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {dustyRows.map((r) => (
            <div key={r.addr} style={{ display: "flex", gap: 12, padding: 12, background: "var(--bg-elev)", borderRadius: 4, border: "1px solid var(--border)", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: "var(--text-strong)", fontWeight: 600 }}>{r.label}</div>
                <code style={{ color: "var(--text-muted)", fontSize: 11 }}>{r.addr}</code>
                <div style={{ color: "var(--text)", fontSize: 13, marginTop: 4 }}>{formatDOT(r.pending)} DOT</div>
              </div>
              <button className="nano-btn nano-btn-accent" onClick={() => claim(r.addr, false)} disabled={busy !== null || !signer}>
                Claim to self
              </button>
              <button className="nano-btn" onClick={() => claim(r.addr, true)} disabled={busy !== null || !signer || !recipient.trim()}>
                Claim to recipient
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
