// DatumBootstrapPool — read-only status page.
//
// The pool dispenses a small WDATUM grant to each new user on their first
// settled house-ad claim. There's no user-facing claim button: the dispense
// path is gated to Settlement and runs automatically during settlement.

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useSettings } from "../../context/SettingsContext";
import { useWallet } from "../../context/WalletContext";
import { useContracts } from "../../hooks/useContracts";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { getBootstrapPoolContract } from "@shared/contracts";
import { FeatureUnavailable } from "../../components/FeatureUnavailable";

const DECIMALS = 10;
function fmt(v: bigint): string {
  const s = ethers.formatUnits(v, DECIMALS);
  return s.replace(/\.?0+$/, "") || "0";
}

export function Bootstrap() {
  const { settings } = useSettings();
  const { address } = useWallet();
  const contracts = useContracts();
  const { push } = useToast();

  const [reserve, setReserve] = useState<bigint>(0n);
  const [remaining, setRemaining] = useState<bigint>(0n);
  const [perAddr, setPerAddr] = useState<bigint>(0n);
  const [received, setReceived] = useState<boolean>(false);

  async function refresh() {
    if (!settings.contractAddresses.bootstrapPool) return;
    try {
      const b = getBootstrapPoolContract(settings.contractAddresses, contracts.readProvider);
      if (!b) return;
      const [res, rem, per, recv] = await Promise.all([
        b.BOOTSTRAP_RESERVE(),
        b.bootstrapRemaining(),
        b.bootstrapPerAddress(),
        address ? b.hasReceivedBootstrap(address) : Promise.resolve(false),
      ]);
      setReserve(BigInt(res));
      setRemaining(BigInt(rem));
      setPerAddr(BigInt(per));
      setReceived(Boolean(recv));
    } catch (err) {
      push(humanizeError(err), "error");
    }
  }

  useEffect(() => { refresh(); }, [address, settings.contractAddresses.bootstrapPool]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings.contractAddresses.bootstrapPool) {
    return (
      <div>
        <PageHeader />
        <FeatureUnavailable feature="DatumBootstrapPool" addressKey="bootstrapPool" />
      </div>
    );
  }

  const pct = reserve === 0n ? 0 : Number(remaining * 10000n / reserve) / 100;

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <PageHeader />
      <Section title="Pool status">
        <Row label="Reserve (deploy-time cap)" value={`${fmt(reserve)} DATUM`} />
        <Row label="Remaining" value={`${fmt(remaining)} DATUM (${pct.toFixed(2)}%)`} />
        <Row label="Per-address grant" value={`${fmt(perAddr)} DATUM`} />
      </Section>

      {address && (
        <Section title="Your status">
          {received ? (
            <div className="nano-info">You've already received the bootstrap bonus.</div>
          ) : (
            <div className="nano-info">
              You're eligible. The bonus is dispensed automatically on your first settled
              claim against the protocol's reserved house-ad campaign — no manual claim needed.
            </div>
          )}
        </Section>
      )}

      <Section title="How it works">
        <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6 }}>
          Each address can receive the bonus exactly once. Dispense path is
          gated to <code>DatumSettlement</code>: when your first claim against
          the house-ad campaign settles, the pool calls{" "}
          <code>mintForBootstrap</code> on <code>DatumMintAuthority</code>,
          which mints canonical DATUM to the wrapper and routes WDATUM directly to your address.
          When the pool depletes, the dispense path silently no-ops; the
          house-ad campaign continues as a non-paying fallback.
        </p>
      </Section>
    </div>
  );
}

function PageHeader() {
  return (
    <div style={{ marginBottom: 20 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Bootstrap Pool</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
        One-time WDATUM grant to each new user on their first settled house-ad claim.
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
