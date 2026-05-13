// DatumMintAuthority admin status page.
//
// The MintAuthority bridges EVM-side contracts to the canonical DATUM asset
// on Polkadot Asset Hub. Every settlement, bootstrap, and vesting mint flows
// through here. Caps total emissions at MINTABLE_CAP (95M DATUM).
//
// Owner-only function: transferIssuerTo (the §5.5 sunset path). The wiring
// setters (setWrapper / setSettlement / setBootstrapPool / setVesting) are
// lock-once-on-first-set — once wired they're frozen.

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useSettings } from "../../context/SettingsContext";
import { useWallet } from "../../context/WalletContext";
import { useContracts } from "../../hooks/useContracts";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { getMintAuthorityContract } from "@shared/contracts";
import { FeatureUnavailable } from "../../components/FeatureUnavailable";

const DECIMALS = 10;
function fmt(v: bigint): string {
  const s = ethers.formatUnits(v, DECIMALS);
  return s.replace(/\.?0+$/, "") || "0";
}

export function MintAuthorityAdmin() {
  const { settings } = useSettings();
  const { signer, address } = useWallet();
  const contracts = useContracts();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [owner, setOwner] = useState<string>("");
  const [cap, setCap] = useState<bigint>(0n);
  const [minted, setMinted] = useState<bigint>(0n);
  const [wrapperAddr, setWrapperAddr] = useState<string>("");
  const [settlementAddr, setSettlementAddr] = useState<string>("");
  const [bootstrapAddr, setBootstrapAddr] = useState<string>("");
  const [vestingAddr, setVestingAddr] = useState<string>("");
  const [canonicalAssetId, setCanonicalAssetId] = useState<bigint>(0n);

  const [newIssuer, setNewIssuer] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    if (!settings.contractAddresses.mintAuthority) return;
    try {
      const m = getMintAuthorityContract(settings.contractAddresses, contracts.readProvider);
      if (!m) return;
      const [own, c, mint, w, s, b, v, aid] = await Promise.all([
        m.owner(),
        m.MINTABLE_CAP(),
        m.totalMinted(),
        m.wrapper(),
        m.settlement(),
        m.bootstrapPool(),
        m.vesting(),
        m.canonicalAssetId(),
      ]);
      setOwner(String(own));
      setCap(BigInt(c));
      setMinted(BigInt(mint));
      setWrapperAddr(String(w));
      setSettlementAddr(String(s));
      setBootstrapAddr(String(b));
      setVestingAddr(String(v));
      setCanonicalAssetId(BigInt(aid));
    } catch (err) {
      push(humanizeError(err), "error");
    }
  }

  useEffect(() => { refresh(); }, [settings.contractAddresses.mintAuthority]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings.contractAddresses.mintAuthority) {
    return (
      <div>
        <PageHeader />
        <FeatureUnavailable feature="DatumMintAuthority" addressKey="mintAuthority" />
      </div>
    );
  }

  const isOwner = address && owner && address.toLowerCase() === owner.toLowerCase();
  const remaining = cap > minted ? cap - minted : 0n;
  const pctMinted = cap === 0n ? 0 : Number(minted * 10000n / cap) / 100;
  const ZERO = "0x0000000000000000000000000000000000000000";

  async function doTransferIssuer() {
    if (!signer) return;
    try {
      if (!ethers.isAddress(newIssuer)) throw new Error("Invalid address");
      const m = getMintAuthorityContract(settings.contractAddresses, signer)!;
      setBusy("Transferring issuer rights...");
      const tx = await m.transferIssuerTo(newIssuer);
      await confirmTx(tx);
      push("Issuer transferred", "ok");
      setNewIssuer("");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <PageHeader />

      <Section title="Emission cap">
        <Row label="MINTABLE_CAP" value={`${fmt(cap)} DATUM`} />
        <Row label="Total minted" value={`${fmt(minted)} DATUM (${pctMinted.toFixed(4)}%)`} />
        <Row label="Remaining mintable" value={`${fmt(remaining)} DATUM`} />
      </Section>

      <Section title="Wiring (lock-once)">
        <Row label="Wrapper" value={<code style={{ fontSize: 11 }}>{wrapperAddr}</code>} />
        <Row label="Settlement" value={<code style={{ fontSize: 11 }}>{settlementAddr}</code>} />
        <Row label="Bootstrap Pool" value={<code style={{ fontSize: 11 }}>{bootstrapAddr}</code>} />
        <Row label="Vesting" value={<code style={{ fontSize: 11 }}>{vestingAddr}</code>} />
        <Row label="Canonical asset id" value={String(canonicalAssetId)} />
        {(wrapperAddr === ZERO || settlementAddr === ZERO) && (
          <div className="nano-info nano-info--warn" style={{ marginTop: 8 }}>
            Some wiring fields are still unset. They lock on first non-zero
            write, so make sure the right address goes in first time.
          </div>
        )}
      </Section>

      <Section title="Ownership">
        <Row label="Owner" value={<code style={{ fontSize: 11 }}>{owner}</code>} />
        <Row label="You are" value={isOwner ? "the owner" : "not the owner"} />
      </Section>

      {isOwner && (
        <Section title="Sunset — transfer issuer rights">
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8 }}>
            Transfers canonical-asset issuer rights to a new authority on
            Asset Hub. Per §5.5 of the tokenomics spec: at parachain launch
            this hands off to the parachain's native issuance pallet.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <Field label="New issuer address">
              <input className="nano-input" value={newIssuer} onChange={(e) => setNewIssuer(e.target.value)} placeholder="0x..." style={{ width: 360 }} />
            </Field>
            <button className="nano-btn nano-btn-danger" onClick={doTransferIssuer} disabled={busy !== null}>
              Transfer
            </button>
          </div>
        </Section>
      )}
    </div>
  );
}

function PageHeader() {
  return (
    <div style={{ marginBottom: 20 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Mint Authority</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
        Bridges EVM-side mints to canonical DATUM on Asset Hub. Hard cap = 95M DATUM.
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
