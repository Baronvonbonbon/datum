// /governance/fraud-claims — Council-arbitrated advertiser fraud claims (#3).
//
// Three views in one:
//   1. File a new claim (advertiser-facing): pick publisher, optional campaignId,
//      enter IPFS CID of evidence, stake the bond.
//   2. Browse claims (public): list of all claims with status and evidence link.
//   3. Resolve (Council-facing): if you're a Council member, propose upheld/dismissed
//      via the Council propose+vote+execute flow.

import { useEffect, useState } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { AddressDisplay } from "../../components/AddressDisplay";
import { humanizeError } from "@shared/errorCodes";
import { formatDOT } from "@shared/dot";
import { ethers } from "ethers";

interface ClaimView {
  id: bigint;
  advertiser: string;
  publisher: string;
  campaignId: bigint;
  evidenceHash: string;
  bond: bigint;
  resolved: boolean;
  upheld: boolean;
  createdBlock: bigint;
}

export function AdvertiserFraudClaimsPage() {
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [claims, setClaims] = useState<ClaimView[]>([]);
  const [advBond, setAdvBond] = useState<bigint>(0n);
  const [councilArbiter, setCouncilArbiter] = useState<string>("");
  const [loading, setLoading] = useState(true);

  // File-claim form
  const [filePublisher, setFilePublisher] = useState("");
  const [fileCampaignId, setFileCampaignId] = useState("0");
  const [fileEvidence, setFileEvidence] = useState("");
  const [filing, setFiling] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const gov: any = contracts.publisherGovernance;
      const [bond, arbiter, nextId] = await Promise.all([
        gov.advertiserClaimBond(),
        gov.councilArbiter(),
        gov.nextAdvertiserClaimId(),
      ]);
      setAdvBond(BigInt(bond.toString()));
      setCouncilArbiter(arbiter.toLowerCase());

      const list: ClaimView[] = [];
      for (let i = 1n; i < BigInt(nextId.toString()); i++) {
        try {
          const c = await gov.advertiserClaims(i);
          // Public mapping getter returns a tuple, not the named struct.
          list.push({
            id: i,
            advertiser: c[0],
            publisher: c[1],
            campaignId: BigInt(c[2].toString()),
            evidenceHash: c[3],
            bond: BigInt(c[4].toString()),
            resolved: c[5],
            upheld: c[6],
            createdBlock: BigInt(c[7].toString()),
          });
        } catch { /* skip */ }
      }
      // Newest first
      list.reverse();
      setClaims(list);
    } catch (err) {
      push({ kind: "error", text: `Load failed: ${humanizeError(err)}` });
    }
    setLoading(false);
  }

  async function fileClaim() {
    if (!signer) { push({ kind: "error", text: "Connect your wallet" }); return; }
    if (advBond === 0n) { push({ kind: "error", text: "Advertiser claim track is disabled (bond=0)" }); return; }
    if (!ethers.isAddress(filePublisher)) { push({ kind: "error", text: "Invalid publisher address" }); return; }
    if (!fileEvidence.startsWith("0x") || fileEvidence.length !== 66) {
      push({ kind: "error", text: "Evidence must be a 0x-prefixed 32-byte hash (IPFS CID-as-bytes32)" });
      return;
    }
    setFiling(true);
    try {
      const gov: any = contracts.publisherGovernance.connect(signer);
      const tx = await gov.fileAdvertiserFraudClaim(filePublisher, BigInt(fileCampaignId || "0"), fileEvidence, { value: advBond });
      await confirmTx(tx);
      push({ kind: "success", text: `Fraud claim filed against ${filePublisher.slice(0, 8)}…` });
      setFilePublisher(""); setFileCampaignId("0"); setFileEvidence("");
      await load();
    } catch (err) {
      push({ kind: "error", text: humanizeError(err) });
    }
    setFiling(false);
  }

  function statusLabel(c: ClaimView): { text: string; color: string } {
    if (!c.resolved) return { text: "Open", color: "#fc4" };
    if (c.upheld) return { text: "Upheld", color: "#f44" };
    return { text: "Dismissed", color: "#888" };
  }

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <h2 style={{ marginTop: 0 }}>Advertiser Fraud Claims</h2>
      <p style={{ color: "var(--text-muted, #888)", fontSize: 14, lineHeight: 1.5 }}>
        Advertisers can stake a bond to file a fraud claim against a publisher,
        backed by off-chain evidence (IPFS CID). The DatumCouncil reviews the
        evidence and resolves the claim. Upheld → publisher stake slashed,
        advertiser bond refunded. Dismissed → bond forwarded to publisher as
        compensation (anti-griefing).
      </p>

      {/* Configuration banner */}
      <div style={{
        marginTop: 16, padding: 12, background: "rgba(255,255,255,0.03)",
        border: "1px solid var(--border, #333)", borderRadius: 6, fontSize: 13,
      }}>
        <div>Bond required: <strong>{formatDOT(advBond)} DOT</strong>{advBond === 0n && <span style={{ color: "var(--error, #f44)", marginLeft: 8 }}>(track disabled)</span>}</div>
        <div>Council arbiter: {councilArbiter === ethers.ZeroAddress
          ? <span style={{ color: "var(--error, #f44)" }}>not wired</span>
          : <AddressDisplay address={councilArbiter} short />}</div>
      </div>

      {/* File a new claim */}
      <section style={{ marginTop: 24, padding: 16, border: "1px solid var(--border, #333)", borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>File a claim</h3>
        <div style={{ display: "grid", gap: 12 }}>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Publisher address</div>
            <input
              type="text" value={filePublisher} onChange={(e) => setFilePublisher(e.target.value)}
              placeholder="0x..."
              style={{ width: "100%", padding: 8, fontFamily: "monospace" }}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Campaign id (0 = publisher-wide)</div>
            <input
              type="text" value={fileCampaignId} onChange={(e) => setFileCampaignId(e.target.value)}
              style={{ width: 200, padding: 8 }}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Evidence (IPFS CID as bytes32 hex)</div>
            <input
              type="text" value={fileEvidence} onChange={(e) => setFileEvidence(e.target.value)}
              placeholder="0x...64 hex chars..."
              style={{ width: "100%", padding: 8, fontFamily: "monospace" }}
            />
            <div style={{ fontSize: 11, color: "var(--text-muted, #888)", marginTop: 2 }}>
              Pin your analytics report to IPFS, then convert the CID to a 32-byte hex.
            </div>
          </label>
          <button
            onClick={fileClaim}
            disabled={filing || advBond === 0n}
            style={{
              padding: "10px 20px",
              background: advBond === 0n ? "var(--bg-muted, #222)" : "var(--accent, #4cf)",
              color: advBond === 0n ? "var(--text-muted, #888)" : "var(--bg, #000)",
              border: "none", borderRadius: 6, cursor: filing ? "wait" : "pointer", fontWeight: 600,
              alignSelf: "start",
            }}
          >
            {filing ? "Filing…" : `File claim (${formatDOT(advBond)} DOT bond)`}
          </button>
        </div>
      </section>

      {/* Claim list */}
      <section style={{ marginTop: 24 }}>
        <h3>All claims</h3>
        {loading ? <div>Loading…</div> : claims.length === 0 ? <div style={{ color: "var(--text-muted)" }}>No claims yet.</div> : (
          <div style={{ display: "grid", gap: 10 }}>
            {claims.map((c) => {
              const s = statusLabel(c);
              return (
                <div key={c.id.toString()} style={{
                  padding: 14, border: "1px solid var(--border, #333)", borderRadius: 6,
                  display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 16, alignItems: "center",
                }}>
                  <div style={{ fontFamily: "monospace", color: "var(--text-muted)" }}>#{c.id.toString()}</div>
                  <div>
                    <div style={{ fontSize: 13 }}>
                      <span style={{ color: "var(--text-muted)" }}>vs. publisher</span>{" "}
                      <AddressDisplay address={c.publisher} short />
                      {c.campaignId > 0n && <span style={{ marginLeft: 8 }}>campaign #{c.campaignId.toString()}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                      filed by <AddressDisplay address={c.advertiser} short /> · bond {formatDOT(c.bond)} DOT · evidence{" "}
                      <span style={{ fontFamily: "monospace" }}>{c.evidenceHash.slice(0, 12)}…</span>
                    </div>
                  </div>
                  <div style={{
                    padding: "4px 10px", fontSize: 12, fontWeight: 600,
                    color: s.color, border: `1px solid ${s.color}`, borderRadius: 4,
                  }}>{s.text}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
