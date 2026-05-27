import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useSettings } from "../../context/SettingsContext";
import { DOTAmount } from "../../components/DOTAmount";
import { CONVICTION_WEIGHTS, CONVICTION_LOCKUP_BLOCKS, formatBlockDelta } from "@shared/conviction";
import { getCurrencySymbol } from "@shared/networks";

interface GovParams {
  quorumWeighted: bigint;
  terminationQuorum: bigint;
  baseGraceBlocks: number;
  slashBps: number;
  // Optimistic-activation path (DatumActivationBonds) — coexists with the
  // legacy always-vote path. New campaigns typically use this lane.
  activationMinBond: bigint | null;
  activationTimelockBlocks: number | null;
}

export function GovernanceParameters() {
  const contracts = useContracts();
  const { settings } = useSettings();
  const sym = getCurrencySymbol(settings.network);
  const [params, setParams] = useState<GovParams | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const ab = settings.contractAddresses.activationBonds
        ? new (await import("ethers")).Contract(
            settings.contractAddresses.activationBonds,
            [
              "function minBond() view returns (uint256)",
              "function timelockBlocks() view returns (uint64)",
            ],
            contracts.readProvider,
          )
        : null;
      const [quorum, termQuorum, baseGrace, slash, minBond, tlBlocks] = await Promise.all([
        contracts.governanceV2.quorumWeighted().catch(() => 0n),
        contracts.governanceV2.terminationQuorum().catch(() => 0n),
        contracts.governanceV2.baseGraceBlocks().catch(() => 0),
        contracts.governanceV2.slashBps().catch(() => 0),
        ab ? ab.minBond().catch(() => null) : Promise.resolve(null),
        ab ? ab.timelockBlocks().catch(() => null) : Promise.resolve(null),
      ]);
      setParams({
        quorumWeighted: BigInt(quorum),
        terminationQuorum: BigInt(termQuorum),
        baseGraceBlocks: Number(baseGrace),
        slashBps: Number(slash),
        activationMinBond: minBond != null ? BigInt(minBond) : null,
        activationTimelockBlocks: tlBlocks != null ? Number(tlBlocks) : null,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 640 }}>
      <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Governance Parameters</h1>

      {loading ? (
        <div style={{ color: "var(--text-muted)" }}>Loading parameters...</div>
      ) : !params ? (
        <div style={{ color: "var(--text-muted)" }}>Could not load parameters.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Section title="Optimistic Activation (default path)">
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}>
              <code>createCampaignWithActivation</code> posts a bond that opens a challenge window.
              If no one contests during the timelock, anyone can call <code>activate()</code> to
              flip the campaign Active — no governance vote needed. A contest forces the campaign
              back into the legacy quorum lane below.
            </div>
            {params.activationMinBond != null
              ? <Row label="Minimum Bond" value={<DOTAmount planck={params.activationMinBond} />} hint="Locked by the advertiser at creation; refunded on clean activation" />
              : <Row label="Minimum Bond" value="—" hint="DatumActivationBonds not deployed on this network" />}
            {params.activationTimelockBlocks != null
              ? <Row label="Challenge Window" value={formatBlockDelta(params.activationTimelockBlocks)} hint="Blocks during which any holder can post a counter-bond to contest" />
              : <Row label="Challenge Window" value="—" />}
          </Section>

          <Section title="Always-Vote Thresholds (legacy / contested path)">
            <Row label="Activation Quorum" value={<DOTAmount planck={params.quorumWeighted} />} hint="Conviction-weighted votes needed to activate a campaign" />
            <Row label="Termination Quorum" value={<DOTAmount planck={params.terminationQuorum} />} hint="Nay votes needed to trigger termination" />
            <Row label="Termination Grace (base)" value={formatBlockDelta(params.baseGraceBlocks)} hint="Minimum blocks between first nay and termination execution" />
            <Row label="Slash Rate" value={`${(params.slashBps / 100).toFixed(1)}%`} hint="Penalty on losing side's stake at withdrawal" />
          </Section>

          <Section title="Conviction Curve">
            <div style={{ overflowX: "auto" }}>
              <table className="nano-table" style={{ width: "100%", fontSize: 12 }}>
                <thead>
                  <tr>
                    {["Level", "Weight", "Lockup", "Max Lock (1 DOT)"].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {CONVICTION_WEIGHTS.map((w, i) => (
                    <tr key={i}>
                      <td>{i}</td>
                      <td style={{ fontWeight: 600 }}>{w}x</td>
                      <td>
                        {CONVICTION_LOCKUP_BLOCKS[i] === 0 ? "None" : formatBlockDelta(CONVICTION_LOCKUP_BLOCKS[i])}
                      </td>
                      <td style={{ fontFamily: "var(--font-mono)" }}>
                        {w} {sym} effective
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Campaign Flow">
            <Row label="Pending → Active" value="Aye > 50% + quorum reached" />
            <Row label="Active → Terminated" value="Nay ≥ 50% + termination quorum + grace elapsed" />
            <Row label="Slash trigger" value="Losing side on resolved campaign" />
            <Row label="Inactivity timeout" value="30 days (432,000 blocks) without settlement" hint="permissionless expiry via CampaignLifecycle.expireInactiveCampaign()" />
          </Section>

          <Section title="Scoring Reference">
            <div style={{ color: "var(--text)", fontSize: 12, lineHeight: 1.8 }}>
              <p style={{ margin: "0 0 8px" }}>Engagement quality score (computed by extension, not on-chain):</p>
              <ul style={{ paddingLeft: 20, margin: 0 }}>
                <li>Dwell time: 35%</li>
                <li>Focus (tab active): 25%</li>
                <li>Viewability: 25%</li>
                <li>Scroll depth: 15%</li>
              </ul>
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="nano-card" style={{ padding: 14 }}>
      <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 14, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <div>
        <div style={{ color: "var(--text)", fontSize: 13 }}>{label}</div>
        {hint && <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ color: "var(--text-strong)", fontSize: 13, fontWeight: 600, textAlign: "right" }}>{value}</div>
    </div>
  );
}
