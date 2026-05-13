// WDATUM wrapper page — balance display, wrap / unwrap to Asset Hub.
//
// Contract: DatumWrapper.
//   wrap(amount): requires caller to have transferred canonical DATUM to the
//     wrapper address before calling. Mints WDATUM 1:1.
//   unwrap(amount, assetHubRecipient): burns WDATUM, routes canonical to the
//     32-byte Asset Hub AccountId via the precompile.
//
// WDATUM is the EVM-side ERC20 used everywhere on Hub. Decimals = 10 (matches
// canonical DATUM on Asset Hub).

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useSettings } from "../../context/SettingsContext";
import { useWallet } from "../../context/WalletContext";
import { useContracts } from "../../hooks/useContracts";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { getWrapperContract } from "@shared/contracts";
import { FeatureUnavailable } from "../../components/FeatureUnavailable";

const DATUM_DECIMALS = 10;

function format(amount: bigint): string {
  const s = ethers.formatUnits(amount, DATUM_DECIMALS);
  return s.replace(/\.?0+$/, "") || "0";
}

function parse(input: string): bigint {
  return ethers.parseUnits(input.trim(), DATUM_DECIMALS);
}

export function Wrapper() {
  const { settings } = useSettings();
  const { signer, address } = useWallet();
  const contracts = useContracts();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [wdBalance, setWdBalance] = useState<bigint>(0n);
  const [totalSupply, setTotalSupply] = useState<bigint>(0n);
  const [canonicalHeld, setCanonicalHeld] = useState<bigint>(0n);

  const [wrapAmount, setWrapAmount] = useState("");
  const [unwrapAmount, setUnwrapAmount] = useState("");
  const [unwrapRecipient, setUnwrapRecipient] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    if (!address || !settings.contractAddresses.wrapper) return;
    try {
      const wrapper = getWrapperContract(settings.contractAddresses, contracts.readProvider);
      if (!wrapper) return;
      const [bal, supply, held] = await Promise.all([
        wrapper.balanceOf(address),
        wrapper.totalSupply(),
        wrapper.canonicalHeld().catch(() => 0n),
      ]);
      setWdBalance(BigInt(bal));
      setTotalSupply(BigInt(supply));
      setCanonicalHeld(BigInt(held));
    } catch (err) {
      push(humanizeError(err), "error");
    }
  }

  useEffect(() => { refresh(); }, [address, settings.contractAddresses.wrapper]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings.contractAddresses.wrapper) {
    return (
      <div>
        <PageHeader />
        <FeatureUnavailable feature="WDATUM Wrapper" addressKey="wrapper"
          reason="DatumWrapper isn't deployed on this network yet — WDATUM is the EVM-side ERC20 wrapper for canonical DATUM on Asset Hub." />
      </div>
    );
  }

  async function doWrap() {
    if (!signer) return;
    try {
      const v = parse(wrapAmount);
      if (v <= 0n) throw new Error("Enter a positive amount");
      const wrapper = getWrapperContract(settings.contractAddresses, signer);
      if (!wrapper) return;
      setBusy("Wrapping...");
      const tx = await wrapper.wrap(v);
      await confirmTx(tx);
      push("WDATUM minted", "ok");
      setWrapAmount("");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  async function doUnwrap() {
    if (!signer) return;
    try {
      const v = parse(unwrapAmount);
      if (v <= 0n) throw new Error("Enter a positive amount");
      const recipient = unwrapRecipient.trim();
      if (!recipient.startsWith("0x") || recipient.length !== 66) {
        throw new Error("Recipient must be a 32-byte Asset Hub AccountId (0x + 64 hex chars)");
      }
      const wrapper = getWrapperContract(settings.contractAddresses, signer);
      if (!wrapper) return;
      setBusy("Unwrapping...");
      const tx = await wrapper.unwrap(v, recipient);
      await confirmTx(tx);
      push("WDATUM unwrapped to Asset Hub", "ok");
      setUnwrapAmount("");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <PageHeader />

      <Section title="Balance">
        <Row label="Your WDATUM" value={`${format(wdBalance)} WDATUM`} />
        <Row label="Total WDATUM supply" value={format(totalSupply)} />
        <Row label="Canonical DATUM in reserve" value={format(canonicalHeld)} />
      </Section>

      <Section title="Wrap canonical → WDATUM">
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8 }}>
          Transfer canonical DATUM to the wrapper address, then call <code>wrap(amount)</code>.
          The two ops should be bundled in the same transaction.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Field label="Amount (DATUM)">
            <input className="nano-input" value={wrapAmount} onChange={(e) => setWrapAmount(e.target.value)} placeholder="0.0" style={{ width: 160 }} />
          </Field>
          <button className="nano-btn nano-btn-accent" onClick={doWrap} disabled={busy !== null || !signer}>Wrap</button>
        </div>
      </Section>

      <Section title="Unwrap WDATUM → Asset Hub">
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8 }}>
          Burns WDATUM and forwards canonical to the chosen Asset Hub AccountId.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="Amount (WDATUM)">
            <input className="nano-input" value={unwrapAmount} onChange={(e) => setUnwrapAmount(e.target.value)} placeholder="0.0" style={{ width: 160 }} />
          </Field>
          <Field label="Asset Hub recipient (32-byte hex)">
            <input className="nano-input" value={unwrapRecipient} onChange={(e) => setUnwrapRecipient(e.target.value)} placeholder="0x..." style={{ width: 360 }} />
          </Field>
          <button className="nano-btn nano-btn-accent" onClick={doUnwrap} disabled={busy !== null || !signer}>Unwrap</button>
        </div>
      </Section>
    </div>
  );
}

function PageHeader() {
  return (
    <div style={{ marginBottom: 20 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>WDATUM Wrapper</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
        EVM-side ERC-20 wrapper for canonical DATUM on Polkadot Asset Hub.
        10 decimals to match the canonical asset.
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
      {label}
      {children}
    </label>
  );
}
