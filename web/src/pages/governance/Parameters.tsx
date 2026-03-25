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
      const [quorum, termQuorum, baseGrace, slash] = await Promise.all([
        contracts.governanceV2.quorumWeighted().catch(() => 0n),
        contracts.governanceV2.terminationQuorum().catch(() => 0n),
        contracts.governanceV2.baseGraceBlocks().catch(() => 0),
        contracts.governanceV2.slashBps().catch(() => 0),
      ]);
      setParams({
        quorumWeighted: BigInt(quorum),
        terminationQuorum: BigInt(termQuorum),
        baseGraceBlocks: Number(baseGrace),
        slashBps: Number(slash),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <Link to="/governance" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Governance Parameters</h1>

      {loading ? (
        <div style={{ color: "#555" }}>Loading parameters...</div>
      ) : !params ? (
        <div style={{ color: "#555" }}>Could not load parameters.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Section title="Voting Thresholds">
            <Row label="Activation Quorum" value={<DOTAmount planck={params.quorumWeighted} />} hint="Conviction-weighted votes needed to activate a campaign" />
            <Row label="Termination Quorum" value={<DOTAmount planck={params.terminationQuorum} />} hint="Nay votes needed to trigger termination" />
            <Row label="Termination Grace (base)" value={formatBlockDelta(params.baseGraceBlocks)} hint="Minimum blocks between first nay and termination execution" />
            <Row label="Slash Rate" value={`${(params.slashBps / 100).toFixed(1)}%`} hint="Penalty on losing side's stake at withdrawal" />
          </Section>

          <Section title="Conviction Curve">
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#0f0f1a" }}>
                    {["Level", "Weight", "Lockup", "Max Lock (1 DOT)"].map((h) => (
                      <th key={h} style={{ padding: "6px 10px", color: "#555", textAlign: "left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {CONVICTION_WEIGHTS.map((w, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #0f0f1a" }}>
                      <td style={{ padding: "6px 10px", color: "#888" }}>{i}</td>
                      <td style={{ padding: "6px 10px", color: "#e0e0e0", fontWeight: 600 }}>{w}x</td>
                      <td style={{ padding: "6px 10px", color: "#888" }}>
                        {CONVICTION_LOCKUP_BLOCKS[i] === 0 ? "None" : formatBlockDelta(CONVICTION_LOCKUP_BLOCKS[i])}
                      </td>
                      <td style={{ padding: "6px 10px", color: "#555", fontFamily: "monospace" }}>
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
            <div style={{ color: "#666", fontSize: 12, lineHeight: 1.8 }}>
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
    <div style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, padding: 14 }}>
      <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 14, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "6px 0", borderBottom: "1px solid #0f0f1a" }}>
      <div>
        <div style={{ color: "#888", fontSize: 13 }}>{label}</div>
        {hint && <div style={{ color: "#444", fontSize: 11, marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ color: "#e0e0e0", fontSize: 13, fontWeight: 600, textAlign: "right" }}>{value}</div>
    </div>
  );
}
