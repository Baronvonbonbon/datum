// Pending Paseo dust widget for the extension popup.
//
// Surveys every PaseoSafeSender contract on the current deploy for
// pendingPaseoDust[connectedAddress] and surfaces per-contract claim
// buttons. Compact layout — fits the popup's vertical constraints.

import { useEffect, useState } from "react";
import { Contract } from "ethers";
import { getProvider } from "@shared/contracts";
import { getSigner } from "@shared/walletManager";
import { formatDOT } from "@shared/dot";
import { ContractAddresses } from "@shared/types";
import { humanizeError } from "@shared/errorCodes";

const DUST_ABI = [
  "function pendingPaseoDust(address) view returns (uint256)",
  "function claimPaseoDust()",
];

function paseoSafeSenderContracts(addrs: ContractAddresses): Array<{ label: string; addr: string }> {
  const list: Array<{ label: string; addr: string }> = [
    { label: "Campaigns",       addr: addrs.campaigns },
    { label: "BudgetLedger",    addr: addrs.budgetLedger },
    { label: "ChallengeBonds",  addr: addrs.challengeBonds },
    { label: "GovernanceV2",    addr: addrs.governanceV2 },
    { label: "PaymentVault",    addr: addrs.paymentVault },
    { label: "PublisherGov",    addr: addrs.publisherGovernance },
    { label: "PublisherStake",  addr: addrs.publisherStake },
    { label: "Router",          addr: addrs.governanceRouter },
    { label: "ParamGov",        addr: addrs.parameterGovernance },
  ];
  if (addrs.feeShare) list.push({ label: "FeeShare", addr: addrs.feeShare });
  return list.filter((e) => e.addr && e.addr !== "0x0000000000000000000000000000000000000000");
}

interface Row { label: string; addr: string; pending: bigint }

interface Props {
  address: string;
  rpcUrl: string;
  contractAddresses: ContractAddresses;
  refreshTrigger?: number;
}

export function PendingDust({ address, rpcUrl, contractAddresses, refreshTrigger }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function scan() {
    setErr(null);
    try {
      const provider = await getProvider(rpcUrl);
      const list = paseoSafeSenderContracts(contractAddresses);
      const results = await Promise.all(
        list.map(async (e) => {
          try {
            const c = new Contract(e.addr, DUST_ABI, provider);
            const p: bigint = await c.pendingPaseoDust(address);
            return { ...e, pending: BigInt(p) };
          } catch {
            return { ...e, pending: 0n };
          }
        }),
      );
      setRows(results.filter((r) => r.pending > 0n));
    } catch (e: any) {
      setErr(humanizeError(e));
    }
  }

  useEffect(() => { scan(); }, [address, refreshTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  async function claim(addr: string) {
    try {
      setBusy(addr);
      const signer = await getSigner(rpcUrl);
      const c = new Contract(addr, DUST_ABI, signer);
      const tx = await c.claimPaseoDust();
      await tx.wait();
      await scan();
    } catch (e: any) {
      setErr(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  const total = rows.reduce((acc, r) => acc + r.pending, 0n);

  if (rows.length === 0 && !err) return null;

  return (
    <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "rgba(255,255,255,0.02)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Pending Paseo dust</span>
        {total > 0n && <span style={{ color: "var(--text-strong)", fontSize: 12, fontWeight: 600 }}>{formatDOT(total)} DOT</span>}
      </div>
      {err && <div style={{ color: "var(--warn)", fontSize: 11 }}>{err}</div>}
      {rows.map((r) => (
        <div key={r.addr} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", fontSize: 11 }}>
          <span style={{ color: "var(--text)" }}>{r.label}</span>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)" }}>{formatDOT(r.pending)} DOT</span>
            <button
              onClick={() => claim(r.addr)}
              disabled={busy !== null}
              style={{ padding: "2px 8px", fontSize: 10, background: "var(--accent)", border: "none", color: "#fff", borderRadius: 3, cursor: "pointer", opacity: busy !== null ? 0.5 : 1 }}
            >
              {busy === r.addr ? "..." : "Claim"}
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
