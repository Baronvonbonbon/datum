import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { AddressDisplay } from "../../components/AddressDisplay";
import { TransactionStatus } from "../../components/TransactionStatus";
import { useToast } from "../../context/ToastContext";

type TxState = "idle" | "pending" | "success" | "error";

export function PublisherProfile() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [relaySigner, setRelaySigner] = useState<string>("");
  const [profileHash, setProfileHash] = useState<string>("");
  const [newRelaySigner, setNewRelaySigner] = useState("");
  const [newProfileHash, setNewProfileHash] = useState("");
  const [loading, setLoading] = useState(false);
  const [relayState, setRelayState] = useState<TxState>("idle");
  const [profileState, setProfileState] = useState<TxState>("idle");
  const [relayMsg, setRelayMsg] = useState<string | null>(null);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  const ZERO = "0x0000000000000000000000000000000000000000";

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      const [rs, ph] = await Promise.all([
        contracts.publishers.relaySigner(address).catch(() => ZERO),
        contracts.publishers.profileHash(address).catch(() => "0x" + "0".repeat(64)),
      ]);
      setRelaySigner(rs);
      setProfileHash(ph);
    } finally {
      setLoading(false);
    }
  }

  async function handleSetRelaySigner() {
    if (!signer) return;
    setRelayState("pending");
    setRelayMsg(null);
    try {
      const pub = contracts.publishers.connect(signer);
      const tx = await pub.setRelaySigner(newRelaySigner || ZERO);
      await confirmTx(tx);
      setRelayState("success");
      setRelayMsg("Relay signer updated.");
      setNewRelaySigner("");
      load();
    } catch (err) {
      setRelayState("error");
      push(humanizeError(err), "error");
      setRelayMsg(humanizeError(err));
    }
  }

  async function handleSetProfile() {
    if (!signer) return;
    setProfileState("pending");
    setProfileMsg(null);
    try {
      const pub = contracts.publishers.connect(signer);
      const hash = newProfileHash.startsWith("0x") ? newProfileHash : "0x" + newProfileHash;
      const tx = await pub.setProfile(hash);
      await confirmTx(tx);
      setProfileState("success");
      setProfileMsg("Profile hash updated.");
      setNewProfileHash("");
      load();
    } catch (err) {
      setProfileState("error");
      push(humanizeError(err), "error");
      setProfileMsg(humanizeError(err));
    }
  }

  if (!address) {
    return <div style={{ padding: 20, color: "var(--text-muted)" }}>Connect your wallet to manage your publisher profile.</div>;
  }
  if (loading) {
    return <div className="nano-pending-text" style={{ color: "var(--text-muted)", padding: 20 }}>Loading</div>;
  }

  const hasRelaySigner = relaySigner && relaySigner !== ZERO;
  const hasProfileHash = profileHash && profileHash !== "0x" + "0".repeat(64);

  return (
    <div className="nano-fade">
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 20 }}>Publisher Profile</h1>

      {/* Relay Signer */}
      <div className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8 }}>Relay Signer (Hot Key)</div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
          Separate attestation signing key used by your relay node. Snapshotted into campaigns at creation.
          Setting this allows key separation between your hot relay key and cold wallet.
        </div>
        {hasRelaySigner ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Current</div>
            <AddressDisplay address={relaySigner} />
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>Not set — attestations verified against your wallet address.</div>
        )}
        {signer && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <input
                className="nano-input"
                placeholder={hasRelaySigner ? "New address (or 0x0...0 to clear)" : "0x... relay signer address"}
                value={newRelaySigner}
                onChange={(e) => setNewRelaySigner(e.target.value)}
                style={{ width: "100%", fontSize: 12 }}
              />
            </div>
            <button
              className="nano-btn nano-btn-accent"
              onClick={handleSetRelaySigner}
              disabled={relayState === "pending" || !newRelaySigner}
              style={{ padding: "6px 14px", fontSize: 12 }}
            >
              {relayState === "pending" ? "Setting..." : "Set Relay Signer"}
            </button>
          </div>
        )}
        {(relayMsg || relayState !== "idle") && (
          <div style={{ marginTop: 8 }}>
            <TransactionStatus state={relayState} message={relayMsg ?? undefined} />
          </div>
        )}
      </div>

      {/* Profile Hash */}
      <div className="nano-card" style={{ padding: 16 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8 }}>Profile Hash (IPFS Metadata)</div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
          IPFS CID (as bytes32) pointing to your publisher metadata: name, website, content policy.
        </div>
        {hasProfileHash ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Current</div>
            <code style={{ fontSize: 11, color: "var(--text)", wordBreak: "break-all" }}>{profileHash}</code>
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>Not set.</div>
        )}
        {signer && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <input
                className="nano-input"
                placeholder="0x... or hex IPFS CID as bytes32"
                value={newProfileHash}
                onChange={(e) => setNewProfileHash(e.target.value)}
                style={{ width: "100%", fontSize: 12 }}
              />
            </div>
            <button
              className="nano-btn nano-btn-accent"
              onClick={handleSetProfile}
              disabled={profileState === "pending" || !newProfileHash}
              style={{ padding: "6px 14px", fontSize: 12 }}
            >
              {profileState === "pending" ? "Setting..." : "Set Profile Hash"}
            </button>
          </div>
        )}
        {(profileMsg || profileState !== "idle") && (
          <div style={{ marginTop: 8 }}>
            <TransactionStatus state={profileState} message={profileMsg ?? undefined} />
          </div>
        )}
      </div>
    </div>
  );
}
