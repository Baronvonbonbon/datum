import { useState } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { AdminNav } from "../../components/AdminNav";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";

export function NullifierRegistryAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  // Config display
  const [config, setConfig] = useState<{ windowBlocks: bigint; settlement: string } | null>(null);
  const [configLoading, setConfigLoading] = useState(false);

  // Nullifier lookup
  const [lookupCampaign, setLookupCampaign] = useState("");
  const [lookupNullifier, setLookupNullifier] = useState("");
  const [isUsed, setIsUsed] = useState<boolean | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  // setWindowBlocks
  const [newWindow, setNewWindow] = useState("");
  const [windowTxState, setWindowTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [windowTxMsg, setWindowTxMsg] = useState("");

  // setSettlement
  const [newSettlement, setNewSettlement] = useState("");
  const [settleTxState, setSettleTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [settleTxMsg, setSettleTxMsg] = useState("");

  async function loadConfig() {
    if (!contracts.nullifierRegistry) return;
    setConfigLoading(true);
    try {
      const [windowBlocks, settlement] = await Promise.all([
        contracts.nullifierRegistry.windowBlocks(),
        contracts.nullifierRegistry.settlement(),
      ]);
      setConfig({ windowBlocks, settlement });
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    } finally {
      setConfigLoading(false);
    }
  }

  async function handleLookup() {
    if (!contracts.nullifierRegistry) return;
    setLookupLoading(true);
    setIsUsed(null);
    try {
      const used = await contracts.nullifierRegistry.isUsed(BigInt(lookupCampaign), lookupNullifier as `0x${string}`);
      setIsUsed(used);
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    } finally {
      setLookupLoading(false);
    }
  }

  async function handleSetWindowBlocks() {
    if (!contracts.nullifierRegistry || !signer) return;
    setWindowTxState("pending");
    setWindowTxMsg("Updating window…");
    try {
      const reg = contracts.nullifierRegistry.connect(signer);
      const tx = await confirmTx(() => reg.setWindowBlocks(BigInt(newWindow)));
      if (!tx) { setWindowTxState("idle"); return; }
      await tx.wait();
      setWindowTxState("success");
      setWindowTxMsg("Window blocks updated.");
    } catch (err) {
      setWindowTxState("error");
      setWindowTxMsg(humanizeError(err));
    }
  }

  async function handleSetSettlement() {
    if (!contracts.nullifierRegistry || !signer) return;
    setSettleTxState("pending");
    setSettleTxMsg("Wiring settlement…");
    try {
      const reg = contracts.nullifierRegistry.connect(signer);
      const tx = await confirmTx(() => reg.setSettlement(newSettlement));
      if (!tx) { setSettleTxState("idle"); return; }
      await tx.wait();
      setSettleTxState("success");
      setSettleTxMsg("Settlement address set.");
    } catch (err) {
      setSettleTxState("error");
      setSettleTxMsg(humanizeError(err));
    }
  }

  return (
    <div style={{ padding: "2rem", maxWidth: 720 }}>
      <AdminNav />
      <h1 style={{ marginBottom: "0.25rem" }}>Nullifier Registry</h1>
      <p style={{ color: "#888", marginBottom: "2rem", fontSize: "0.85rem" }}>
        FP-5 — Per-user per-campaign ZK nullifier replay prevention. nullifier = Poseidon(userSecret, campaignId, windowId).
        bytes32(0) skips check (non-ZK campaigns). E73 on replay.
      </p>

      {/* Config */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Current Config</h2>
        <button onClick={loadConfig} disabled={configLoading} style={{ marginBottom: "0.5rem", fontSize: "0.8rem" }}>
          {configLoading ? "Loading…" : "Load config"}
        </button>
        {config && (
          <div style={{ background: "var(--surface)", padding: "1rem", borderRadius: 8, fontSize: "0.85rem" }}>
            <div><b>Window blocks:</b> {config.windowBlocks.toString()} (~{(Number(config.windowBlocks) * 6 / 86400).toFixed(1)}d at 6s/block)</div>
            <div><b>Settlement:</b> {config.settlement}</div>
          </div>
        )}
      </section>

      {/* Nullifier lookup */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Nullifier Lookup</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input placeholder="Campaign ID" value={lookupCampaign} onChange={e => setLookupCampaign(e.target.value)} style={{ width: 140 }} />
            <input placeholder="Nullifier (bytes32, 0x…)" value={lookupNullifier} onChange={e => setLookupNullifier(e.target.value)} style={{ flex: 1 }} />
            <button onClick={handleLookup} disabled={lookupLoading || !lookupCampaign || !lookupNullifier}>
              {lookupLoading ? "Checking…" : "Check"}
            </button>
          </div>
        </div>
        {isUsed !== null && (
          <div style={{ marginTop: "0.75rem", background: "var(--surface)", padding: "0.75rem 1rem", borderRadius: 8, fontSize: "0.85rem" }}>
            <span style={{ color: isUsed ? "var(--error)" : "var(--ok)", fontWeight: 700 }}>
              {isUsed ? "USED — replay would be rejected (E73)" : "Not used — nullifier is fresh"}
            </span>
          </div>
        )}
      </section>

      {/* setWindowBlocks */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Set Window Blocks (owner only)</h2>
        <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
          Window size determines how long a nullifier is valid. Default: 100800 blocks (~7d).
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input placeholder="Window blocks" value={newWindow} onChange={e => setNewWindow(e.target.value)} style={{ width: 180 }} />
          <button onClick={handleSetWindowBlocks} disabled={windowTxState === "pending" || !newWindow}>
            {windowTxState === "pending" ? "Updating…" : "setWindowBlocks"}
          </button>
        </div>
        <TransactionStatus state={windowTxState} message={windowTxMsg} />
      </section>

      {/* setSettlement */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Wire Settlement (owner only)</h2>
        <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
          Only the wired settlement address may call submitNullifier(). Set once at deploy.
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input placeholder="Settlement address (0x…)" value={newSettlement} onChange={e => setNewSettlement(e.target.value)} style={{ flex: 1 }} />
          <button onClick={handleSetSettlement} disabled={settleTxState === "pending" || !newSettlement}>
            {settleTxState === "pending" ? "Setting…" : "setSettlement"}
          </button>
        </div>
        <TransactionStatus state={settleTxState} message={settleTxMsg} />
      </section>
    </div>
  );
}
