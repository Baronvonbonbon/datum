// FeeShare staking page. Stake WDATUM, earn DOT from protocol fees.
//
// Contract: DatumFeeShare. Stakers deposit WDATUM; the DatumPaymentVault's
// accumulated protocol fees route here via sweep() and fold into accDotPerShare.
// Rewards are settled lazy on stake / unstake / claim.

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useSettings } from "../../context/SettingsContext";
import { useWallet } from "../../context/WalletContext";
import { useContracts } from "../../hooks/useContracts";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { getFeeShareContract, getWrapperContract } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { FeatureUnavailable } from "../../components/FeatureUnavailable";

const DATUM_DECIMALS = 10;
function fmtW(v: bigint): string {
  const s = ethers.formatUnits(v, DATUM_DECIMALS);
  return s.replace(/\.?0+$/, "") || "0";
}

export function FeeShare() {
  const { settings } = useSettings();
  const { signer, address } = useWallet();
  const contracts = useContracts();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [wdBalance, setWdBalance] = useState<bigint>(0n);
  const [staked, setStaked] = useState<bigint>(0n);
  const [totalStaked, setTotalStaked] = useState<bigint>(0n);
  const [pending, setPending] = useState<bigint>(0n);
  const [bootstrapped, setBootstrapped] = useState<boolean>(false);

  const [stakeAmount, setStakeAmount] = useState("");
  const [unstakeAmount, setUnstakeAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    if (!address || !settings.contractAddresses.feeShare) return;
    try {
      const fs = getFeeShareContract(settings.contractAddresses, contracts.readProvider);
      const wrapper = getWrapperContract(settings.contractAddresses, contracts.readProvider);
      if (!fs) return;
      const [bal, mine, total, pend, boot] = await Promise.all([
        wrapper ? wrapper.balanceOf(address) : 0n,
        fs.stakedBy(address),
        fs.totalStaked(),
        fs.pendingOf(address),
        fs.bootstrapped().catch(() => false),
      ]);
      setWdBalance(BigInt(bal));
      setStaked(BigInt(mine));
      setTotalStaked(BigInt(total));
      setPending(BigInt(pend));
      setBootstrapped(Boolean(boot));
    } catch (err) {
      push(humanizeError(err), "error");
    }
  }

  useEffect(() => { refresh(); }, [address, settings.contractAddresses.feeShare]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings.contractAddresses.feeShare) {
    return (
      <div>
        <PageHeader />
        <FeatureUnavailable feature="DatumFeeShare" addressKey="feeShare"
          reason="FeeShare isn't deployed on this network yet — once live, this is where you stake WDATUM to earn a pro-rata share of protocol fees in DOT." />
      </div>
    );
  }

  async function doStake() {
    if (!signer) return;
    try {
      const v = ethers.parseUnits(stakeAmount.trim(), DATUM_DECIMALS);
      if (v <= 0n) throw new Error("Enter a positive amount");

      const fsAddr = settings.contractAddresses.feeShare!;
      // 1. Approve WDATUM for the FeeShare contract.
      const wrapper = getWrapperContract(settings.contractAddresses, signer);
      if (!wrapper) throw new Error("Wrapper unavailable on this network");
      setBusy("Approving WDATUM...");
      const allowance: bigint = BigInt(await wrapper.allowance(address!, fsAddr));
      if (allowance < v) {
        const ap = await wrapper.approve(fsAddr, v);
        await confirmTx(ap);
      }

      // 2. Stake.
      const fs = getFeeShareContract(settings.contractAddresses, signer)!;
      setBusy("Staking...");
      const tx = await fs.stake(v);
      await confirmTx(tx);
      push("Staked", "ok");
      setStakeAmount("");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  async function doUnstake() {
    if (!signer) return;
    try {
      const v = ethers.parseUnits(unstakeAmount.trim(), DATUM_DECIMALS);
      if (v <= 0n) throw new Error("Enter a positive amount");
      const fs = getFeeShareContract(settings.contractAddresses, signer)!;
      setBusy("Unstaking...");
      const tx = await fs.unstake(v);
      await confirmTx(tx);
      push("Unstaked + pending DOT claimed", "ok");
      setUnstakeAmount("");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  async function doClaim() {
    if (!signer) return;
    try {
      const fs = getFeeShareContract(settings.contractAddresses, signer)!;
      setBusy("Claiming...");
      const tx = await fs.claim();
      await confirmTx(tx);
      push("Pending DOT paid out", "ok");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  async function doSweep() {
    if (!signer) return;
    try {
      const fs = getFeeShareContract(settings.contractAddresses, signer)!;
      setBusy("Sweeping fees from PaymentVault...");
      const tx = await fs.sweep();
      await confirmTx(tx);
      push("Fees folded into accumulator", "ok");
      await refresh();
    } catch (err) {
      push(humanizeError(err), "error");
    } finally { setBusy(null); }
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 720 }}>
      <PageHeader />

      {!bootstrapped && (
        <div className="nano-info nano-info--warn" style={{ marginBottom: 16 }}>
          FeeShare hasn't been bootstrapped yet. Until the protocol's
          one-time bootstrap stake is locked under address(0), orphan-DOT
          attacks are theoretically open. Stake conservatively.
        </div>
      )}

      <Section title="Your stake">
        <Row label="WDATUM balance" value={fmtW(wdBalance)} />
        <Row label="Staked" value={fmtW(staked)} />
        <Row label="Pending DOT" value={`${formatDOT(pending)} DOT`} />
      </Section>

      <Section title="Pool">
        <Row label="Total staked" value={fmtW(totalStaked)} />
        <Row label="Your share" value={totalStaked === 0n ? "—" : `${Number(staked * 10000n / totalStaked) / 100}%`} />
      </Section>

      <Section title="Stake">
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Field label="Amount (WDATUM)">
            <input className="nano-input" value={stakeAmount} onChange={(e) => setStakeAmount(e.target.value)} placeholder="0.0" style={{ width: 160 }} />
          </Field>
          <button className="nano-btn nano-btn-accent" onClick={doStake} disabled={busy !== null || !signer}>Stake</button>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 6 }}>
          Approves WDATUM allowance to the FeeShare contract, then stakes.
        </p>
      </Section>

      <Section title="Unstake">
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Field label="Amount (WDATUM)">
            <input className="nano-input" value={unstakeAmount} onChange={(e) => setUnstakeAmount(e.target.value)} placeholder="0.0" style={{ width: 160 }} />
          </Field>
          <button className="nano-btn" onClick={doUnstake} disabled={busy !== null || !signer}>Unstake</button>
          <button className="nano-btn" onClick={doClaim} disabled={busy !== null || !signer}>Claim only</button>
          <button className="nano-btn" onClick={doSweep} disabled={busy !== null || !signer} title="Pull accumulated fees from PaymentVault">Sweep</button>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 6 }}>
          No lockup. Unstake settles your pending DOT in the same transaction.
        </p>
      </Section>
    </div>
  );
}

function PageHeader() {
  return (
    <div style={{ marginBottom: 20 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>FeeShare staking</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
        Stake WDATUM to earn a pro-rata share of protocol fees in DOT.
        Same-block flash-stake protection: userDebt is snapshot at deposit time.
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
