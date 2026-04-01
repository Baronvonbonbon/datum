import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { DOTAmount } from "../../components/DOTAmount";
import { AddressDisplay } from "../../components/AddressDisplay";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";

export function ProtocolFeesAdmin() {
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { confirmTx } = useTx();

  const [protocolBalance, setProtocolBalance] = useState<bigint | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [sweepCampaignId, setSweepCampaignId] = useState("");
  const [dustCampaignId, setDustCampaignId] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [bal, ownerAddr] = await Promise.all([
        contracts.paymentVault.protocolBalance().catch(() => null),
        contracts.paymentVault.owner().catch(() => null),
      ]);
      setProtocolBalance(bal !== null ? BigInt(bal) : null);
      setOwner(ownerAddr ? String(ownerAddr) : null);
    } finally {
      setLoading(false);
    }
  }

  async function withdrawProtocol() {
    if (!signer) return;
    setActiveAction("protocol");
    setTxState("pending");
    setTxMsg("");
    try {
      const vault = contracts.paymentVault.connect(signer);
      const tx = await vault.withdrawProtocol();
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Protocol fee withdrawal successful.");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setActiveAction(null);
    }
  }

  async function sweepSlashPool() {
    if (!signer || !sweepCampaignId) return;
    setActiveAction("slash");
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.governanceSlash.connect(signer);
      const tx = await c.sweepSlashPool(BigInt(sweepCampaignId));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Slash pool swept for campaign #${sweepCampaignId}.`);
      setSweepCampaignId("");
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setActiveAction(null);
    }
  }

  async function sweepDust() {
    if (!signer || !dustCampaignId) return;
    setActiveAction("dust");
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.budgetLedger.connect(signer);
      const tx = await c.sweepDust(BigInt(dustCampaignId));
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Dust swept for campaign #${dustCampaignId}.`);
      setDustCampaignId("");
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setActiveAction(null);
    }
  }

  const isOwner = address && owner && address.toLowerCase() === owner.toLowerCase();

  return (
    <div className="nano-fade" style={{ maxWidth: 560 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Protocol Fees</h1>
      <p style={{ color: "var(--text)", fontSize: 13, marginBottom: 16 }}>
        Protocol earns 25% of the user share on every settled claim. Slash pool accumulates penalties from losing governance voters.
      </p>

      {loading ? (
        <div style={{ color: "var(--text-muted)" }}>Loading...</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Protocol balance */}
          <div className="nano-card" style={{ padding: 16 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 4 }}>Protocol Fee Balance (PaymentVault)</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text-strong)", marginBottom: 10 }}>
              {protocolBalance !== null ? <DOTAmount planck={protocolBalance} /> : "—"}
            </div>
            {signer && isOwner && protocolBalance !== null && protocolBalance > 0n && (
              <button
                onClick={withdrawProtocol}
                disabled={activeAction === "protocol"}
                className="nano-btn nano-btn-accent"
                style={{ padding: "7px 16px", fontSize: 13 }}
              >
                {activeAction === "protocol" ? "Withdrawing..." : "Withdraw to Owner"}
              </button>
            )}
            {!isOwner && signer && (
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Only the contract owner can withdraw.</div>
            )}
          </div>

          {/* Slash pool sweep */}
          <div className="nano-card" style={{ padding: 16 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 4 }}>Sweep Slash Pool (GovernanceSlash)</div>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
              Per-campaign slash penalties from losing voters. Sweep sends remaining slash funds to owner after the deadline.
            </div>
            {signer && (
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="number" min="0" value={sweepCampaignId}
                  onChange={(e) => setSweepCampaignId(e.target.value)}
                  placeholder="Campaign ID"
                  className="nano-input"
                  style={{ width: 120 }}
                />
                <button
                  onClick={sweepSlashPool}
                  disabled={!sweepCampaignId || activeAction === "slash"}
                  className="nano-btn nano-btn-accent"
                  style={{ padding: "6px 14px", fontSize: 13, whiteSpace: "nowrap" }}
                >
                  {activeAction === "slash" ? "Sweeping..." : "Sweep"}
                </button>
              </div>
            )}
          </div>

          {/* Dust sweep */}
          <div className="nano-card" style={{ padding: 16 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 4 }}>Sweep Budget Dust (BudgetLedger)</div>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
              Permissionless — recovers sub-planck rounding dust from completed/terminated campaigns.
            </div>
            {signer && (
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="number" min="0" value={dustCampaignId}
                  onChange={(e) => setDustCampaignId(e.target.value)}
                  placeholder="Campaign ID"
                  className="nano-input"
                  style={{ width: 120 }}
                />
                <button
                  onClick={sweepDust}
                  disabled={!dustCampaignId || activeAction === "dust"}
                  className="nano-btn nano-btn-accent"
                  style={{ padding: "6px 14px", fontSize: 13, whiteSpace: "nowrap" }}
                >
                  {activeAction === "dust" ? "Sweeping..." : "Sweep Dust"}
                </button>
              </div>
            )}
          </div>

          {/* Revenue formula */}
          <div className="nano-card" style={{ padding: 14 }}>
            <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Revenue Split</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Publisher take rate</span><span style={{ color: "var(--text-strong)" }}>30–80% (per-publisher)</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>User share (of remainder)</span><span style={{ color: "var(--text-strong)" }}>75%</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Protocol share (of remainder)</span><span style={{ color: "var(--text-strong)" }}>25%</span>
              </div>
            </div>
            <div style={{ marginTop: 10, padding: "8px 10px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>
              totalPayment = (clearingCpm × impressions) / 1000<br />
              publisher = total × takeRateBps / 10000<br />
              remainder = total − publisher<br />
              user = remainder × 75 / 100<br />
              protocol = remainder × 25 / 100
            </div>
          </div>

          {owner && (
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
              Contract owner: <AddressDisplay address={owner} chars={8} style={{ display: "inline", fontSize: 12 }} />
            </div>
          )}

          <TransactionStatus state={txState} message={txMsg} />
        </div>
      )}
    </div>
  );
}
