import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { ethers } from "ethers";

interface PendingChange {
  target: string;
  data: string;
  effectiveTime: number;
  decoded?: string;
}

export function TimelockAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [delay, setDelay] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  // Propose form
  const [target, setTarget] = useState("");
  const [calldata, setCalldata] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [pendingTarget, pendingData, pendingTs, delayBlocks] = await Promise.all([
        contracts.timelock.pendingTarget().catch(() => null),
        contracts.timelock.pendingData().catch(() => null),
        contracts.timelock.pendingTimestamp().catch(() => null),
        contracts.timelock.TIMELOCK_DELAY().catch(() => null),
      ]);

      setDelay(delayBlocks !== null ? Number(delayBlocks) : null);

      const t = String(pendingTarget ?? "");
      const isNonEmpty = t && t !== ethers.ZeroAddress;
      if (isNonEmpty) {
        const data = String(pendingData ?? "0x");
        setPending({
          target: t,
          data,
          effectiveTime: Number(pendingTs ?? 0),
          decoded: tryDecodeCalldata(data),
        });
      } else {
        setPending(null);
      }
    } finally {
      setLoading(false);
    }
  }

  function tryDecodeCalldata(data: string): string {
    if (!data || data === "0x" || data.length < 10) return "";
    const selector = data.slice(0, 10);

    // Comprehensive selector map covering admin functions across all 13 contracts.
    // Each entry: { name, types (ABI types for params), paramNames (human labels) }
    const KNOWN_FUNCTIONS: Record<string, { name: string; types: string[]; paramNames: string[] }> = {
      // PauseRegistry
      "0x8456cb59": { name: "pause", types: [], paramNames: [] },
      "0x3f4ba83a": { name: "unpause", types: [], paramNames: [] },
      // Common (Ownable)
      "0xf2fde38b": { name: "transferOwnership", types: ["address"], paramNames: ["newOwner"] },
      "0x715018a6": { name: "renounceOwnership", types: [], paramNames: [] },
      // Settlement: configure(address,address,address,address,address)
      "0x760fcb3e": { name: "configure", types: ["address", "address", "address", "address", "address"], paramNames: ["budgetLedger", "paymentVault", "lifecycle", "relay", "publishers"] },
      // Settlement: setAttestationVerifier(address)
      "0x82f6f608": { name: "setAttestationVerifier", types: ["address"], paramNames: ["verifier"] },
      // Campaigns: setCampaignStatus(uint256,uint8)
      "0xe681789d": { name: "setCampaignStatus", types: ["uint256", "uint8"], paramNames: ["campaignId", "newStatus"] },
      // Campaigns: setTerminationBlock(uint256,uint256)
      "0x8fc53c7f": { name: "setTerminationBlock", types: ["uint256", "uint256"], paramNames: ["campaignId", "blockNum"] },
      // Publishers: blockAddress(address)
      "0xad2bb1b3": { name: "blockAddress", types: ["address"], paramNames: ["addr"] },
      // Publishers: unblockAddress(address)
      "0x186d9d88": { name: "unblockAddress", types: ["address"], paramNames: ["addr"] },
      // Publishers: setAllowlistEnabled(bool)
      "0xd7644ba2": { name: "setAllowlistEnabled", types: ["bool"], paramNames: ["enabled"] },
      // Publishers: setAllowedAdvertiser(address,bool)
      "0x0b6b3fe0": { name: "setAllowedAdvertiser", types: ["address", "bool"], paramNames: ["advertiser", "allowed"] },
      // Campaigns / Lifecycle: setBudgetLedger(address)
      "0x5a5dc015": { name: "setBudgetLedger", types: ["address"], paramNames: ["addr"] },
      // Campaigns / Lifecycle: setLifecycleContract(address)
      "0x76ed57bd": { name: "setLifecycleContract", types: ["address"], paramNames: ["addr"] },
      // Campaigns / Lifecycle: setGovernanceContract(address)
      "0x1129753f": { name: "setGovernanceContract", types: ["address"], paramNames: ["addr"] },
      // Campaigns / Lifecycle: setSettlementContract(address)
      "0x3719fd05": { name: "setSettlementContract", types: ["address"], paramNames: ["addr"] },
      // GovernanceV2: setSlashContract(address)
      "0x3d65d1b5": { name: "setSlashContract", types: ["address"], paramNames: ["addr"] },
      // GovernanceV2 / BudgetLedger: setLifecycle(address)
      "0x5b665683": { name: "setLifecycle", types: ["address"], paramNames: ["addr"] },
      // BudgetLedger / Lifecycle: setCampaigns(address)
      "0xa66bc4cc": { name: "setCampaigns", types: ["address"], paramNames: ["addr"] },
      // BudgetLedger / PaymentVault: setSettlement(address)
      "0x8f4e6f37": { name: "setSettlement", types: ["address"], paramNames: ["addr"] },
      // Campaigns: togglePause(uint256,bool)
      "0x3c5e7fe8": { name: "togglePause", types: ["uint256", "bool"], paramNames: ["campaignId", "pause"] },
      // Campaigns: setMetadata(uint256,bytes32)
      "0x3151609e": { name: "setMetadata", types: ["uint256", "bytes32"], paramNames: ["campaignId", "metadataHash"] },
      // Publishers: setCategories(uint256)
      "0x46fa5106": { name: "setCategories", types: ["uint256"], paramNames: ["bitmask"] },
      // Publishers: updateTakeRate(uint16)
      "0xbe56f7d6": { name: "updateTakeRate", types: ["uint16"], paramNames: ["newTakeRateBps"] },
      // Publishers: registerPublisher(uint16)
      "0x71505cb7": { name: "registerPublisher", types: ["uint16"], paramNames: ["takeRateBps"] },
      // Publishers: applyTakeRateUpdate()
      "0x561dec5e": { name: "applyTakeRateUpdate", types: [], paramNames: [] },
      // Campaigns: activateCampaign(uint256)
      "0x493f1726": { name: "activateCampaign", types: ["uint256"], paramNames: ["campaignId"] },
      // PaymentVault: withdrawProtocol(address)
      "0x0a6613d8": { name: "withdrawProtocol", types: ["address"], paramNames: ["recipient"] },
      // BudgetLedger: sweepDust(uint256)
      "0xdcc1f0cf": { name: "sweepDust", types: ["uint256"], paramNames: ["campaignId"] },
      // GovernanceSlash: sweepSlashPool(uint256)
      "0xeec464c4": { name: "sweepSlashPool", types: ["uint256"], paramNames: ["campaignId"] },
    };

    const entry = KNOWN_FUNCTIONS[selector];
    if (!entry) return `selector: ${selector}`;
    if (entry.types.length === 0) return `${entry.name}()`;

    try {
      const paramData = "0x" + data.slice(10);
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(entry.types, paramData);

      const formatted = entry.types.map((type, i) => {
        const label = entry.paramNames[i] || `param${i}`;
        const val = decoded[i];
        if (type === "address") {
          const addr = String(val);
          return `${label}: ${addr.slice(0, 6)}...${addr.slice(-4)}`;
        }
        if (type === "bool") {
          return `${label}: ${val ? "true" : "false"}`;
        }
        if (type === "bytes32") {
          const hex = String(val);
          return `${label}: ${hex.slice(0, 10)}...${hex.slice(-4)}`;
        }
        if (type === "uint256") {
          const bn = BigInt(val);
          // Heuristic: values >= 1 DOT (10^10 planck) displayed as DOT
          if (bn >= 10_000_000_000n) {
            return `${label}: ${ethers.formatUnits(bn, 10)} DOT`;
          }
          return `${label}: ${bn.toString()}`;
        }
        if (type === "uint8" || type === "uint16") {
          return `${label}: ${Number(val)}`;
        }
        return `${label}: ${String(val)}`;
      });

      return `${entry.name}(${formatted.join(", ")})`;
    } catch {
      return `${entry.name}(decode error)`;
    }
  }

  async function propose() {
    if (!signer || !ethers.isAddress(target)) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.timelock.connect(signer);
      const data = calldata || "0x";
      const tx = await c.propose(target, data);
      await tx.wait();
      setTxState("success");
      setTxMsg("Proposal submitted. Execute after the timelock delay.");
      setTarget(""); setCalldata("");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function execute() {
    if (!signer) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.timelock.connect(signer);
      const tx = await c.execute();
      await tx.wait();
      setTxState("success");
      setTxMsg("Proposal executed.");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function cancel() {
    if (!signer) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.timelock.connect(signer);
      const tx = await c.cancel();
      await tx.wait();
      setTxState("success");
      setTxMsg("Proposal cancelled.");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const ready = pending !== null && now >= pending.effectiveTime;

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Timelock</h1>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 16 }}>
        Single-slot timelock: one pending proposal at a time. Propose a call, wait for the delay, then execute.
        {delay !== null && <span style={{ color: "#555" }}> Delay: {delay.toLocaleString()} blocks.</span>}
      </p>

      <TransactionStatus state={txState} message={txMsg} />

      {/* Pending proposal */}
      {loading ? (
        <div style={{ color: "#555" }}>Loading...</div>
      ) : pending ? (
        <div style={{ background: "#0d0d18", border: `1px solid ${ready ? "#2a5a2a" : "#1a1a2e"}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 14 }}>Pending Proposal</div>
            <span style={{ fontSize: 11, color: ready ? "#60c060" : "#888", background: ready ? "#0a2a0a" : "#111", padding: "2px 8px", borderRadius: 10, border: `1px solid ${ready ? "#2a5a2a" : "#1a1a2e"}` }}>
              {ready ? "Ready to Execute" : `ETA: ${new Date(pending.effectiveTime * 1000).toLocaleString()}`}
            </span>
          </div>
          <div style={{ marginBottom: 6 }}>
            <div style={{ color: "#555", fontSize: 11 }}>Target</div>
            <div style={{ color: "#e0e0e0", fontSize: 13, fontFamily: "monospace" }}>{pending.target}</div>
          </div>
          {pending.decoded && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ color: "#555", fontSize: 11 }}>Decoded</div>
              <div style={{ color: "#888", fontSize: 12, fontFamily: "monospace" }}>{pending.decoded}</div>
            </div>
          )}
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: "#555", fontSize: 11 }}>Calldata</div>
            <div style={{ color: "#444", fontSize: 11, fontFamily: "monospace", wordBreak: "break-all" }}>
              {pending.data.length > 66 ? pending.data.slice(0, 66) + "..." : pending.data}
            </div>
          </div>
          {signer && (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={execute}
                disabled={!ready || txState === "pending"}
                style={{ padding: "5px 14px", background: ready ? "#1a1a3a" : "#111", border: `1px solid ${ready ? "#4a4a8a" : "#1a1a2e"}`, borderRadius: 4, color: ready ? "#a0a0ff" : "#444", fontSize: 12, cursor: ready ? "pointer" : "not-allowed" }}
              >
                Execute
              </button>
              <button
                onClick={cancel}
                disabled={txState === "pending"}
                style={{ padding: "5px 14px", background: "#1a0a0a", border: "1px solid #3a1a1a", borderRadius: 4, color: "#ff8080", fontSize: 12, cursor: "pointer" }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ color: "#555", fontSize: 13, marginBottom: 16, padding: "10px 14px", background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 6 }}>
          No pending proposal.
        </div>
      )}

      {/* Propose new */}
      {signer && !pending && (
        <div style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, padding: 14 }}>
          <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 14, marginBottom: 12 }}>New Proposal</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={labelStyle}>Target Contract Address</label>
              <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0x..." style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Calldata (hex)</label>
              <input value={calldata} onChange={(e) => setCalldata(e.target.value)} placeholder="0x..." style={inputStyle} />
              <div style={{ color: "#444", fontSize: 11, marginTop: 3 }}>
                Use ABI encoder or Blockscout to generate calldata for the target function.
              </div>
            </div>
            <button
              onClick={propose}
              disabled={!ethers.isAddress(target) || txState === "pending"}
              style={{ padding: "7px 16px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 4, color: "#a0a0ff", fontSize: 13, cursor: "pointer", alignSelf: "flex-start" }}
            >
              Propose
            </button>
          </div>
        </div>
      )}
      {signer && pending && (
        <div style={{ color: "#444", fontSize: 12, marginTop: 8 }}>
          Cancel the current proposal before submitting a new one.
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { color: "#888", fontSize: 12, display: "block", marginBottom: 4 };
const inputStyle: React.CSSProperties = { padding: "6px 8px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#e0e0e0", fontSize: 13, outline: "none", width: "100%", fontFamily: "monospace" };
