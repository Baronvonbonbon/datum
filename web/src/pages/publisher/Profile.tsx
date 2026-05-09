import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useBlock } from "../../hooks/useBlock";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { AddressDisplay } from "../../components/AddressDisplay";
import { TransactionStatus } from "../../components/TransactionStatus";
import { useToast } from "../../context/ToastContext";
import { formatBlockDelta } from "@shared/conviction";

type TxState = "idle" | "pending" | "success" | "error";

export function PublisherProfile() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { blockNumber } = useBlock();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [relaySigner, setRelaySigner] = useState<string>("");
  const [profileHash, setProfileHash] = useState<string>("");
  const [sdkVersion, setSdkVersion] = useState<string>("");
  const [newRelaySigner, setNewRelaySigner] = useState("");
  const [newProfileHash, setNewProfileHash] = useState("");
  const [newSdkVersionInput, setNewSdkVersionInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [relayState, setRelayState] = useState<TxState>("idle");
  const [profileState, setProfileState] = useState<TxState>("idle");
  const [sdkState, setSdkState] = useState<TxState>("idle");
  const [relayMsg, setRelayMsg] = useState<string | null>(null);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [sdkMsg, setSdkMsg] = useState<string | null>(null);
  const [relayRotatedBlock, setRelayRotatedBlock] = useState<number>(0);
  const [relayCooldownBlocks, setRelayCooldownBlocks] = useState<number>(600);

  const ZERO = "0x0000000000000000000000000000000000000000";
  const ZERO_HASH = "0x" + "0".repeat(64);

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      const [rs, ph, sv, rotated, cooldown] = await Promise.all([
        contracts.publishers.relaySigner(address).catch(() => ZERO),
        contracts.publishers.profileHash(address).catch(() => ZERO_HASH),
        contracts.publishers.getSdkVersion(address).catch(() => ZERO_HASH),
        contracts.publishers.relaySignerRotatedBlock(address).catch(() => 0),
        contracts.publishers.RELAY_SIGNER_ROTATION_COOLDOWN().catch(() => 600),
      ]);
      setRelaySigner(rs);
      setProfileHash(ph);
      setSdkVersion(sv);
      setRelayRotatedBlock(Number(rotated));
      setRelayCooldownBlocks(Number(cooldown));
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

  async function handleSetSdkVersion() {
    if (!signer) return;
    const raw = newSdkVersionInput.trim();
    if (!raw) return;
    setSdkState("pending");
    setSdkMsg(null);
    try {
      // Accept either a 0x-prefixed bytes32 hex or a free-form version string
      // (which is keccak256-hashed client-side for ergonomic input).
      const hash = raw.startsWith("0x") && raw.length === 66
        ? raw
        : ethers.keccak256(ethers.toUtf8Bytes(raw));
      const pub = contracts.publishers.connect(signer);
      const tx = await pub.registerSdkVersion(hash);
      await confirmTx(tx);
      setSdkState("success");
      setSdkMsg("SDK version registered.");
      setNewSdkVersionInput("");
      load();
    } catch (err) {
      setSdkState("error");
      push(humanizeError(err), "error");
      setSdkMsg(humanizeError(err));
    }
  }

  // Relay-signer cooldown — block at which the next setRelaySigner becomes valid.
  const nextRelaySignerEligibleBlock = relayRotatedBlock + relayCooldownBlocks;
  const relayBlocksRemaining = blockNumber !== null && relayRotatedBlock > 0
    ? Math.max(0, nextRelaySignerEligibleBlock - blockNumber)
    : 0;
  const relayInCooldown = relayBlocksRemaining > 0;

  if (!address) {
    return <div style={{ padding: 20, color: "var(--text-muted)" }}>Connect your wallet to manage your publisher profile.</div>;
  }
  if (loading) {
    return <div className="nano-pending-text" style={{ color: "var(--text-muted)", padding: 20 }}>Loading</div>;
  }

  const hasRelaySigner = relaySigner && relaySigner !== ZERO;
  const hasProfileHash = profileHash && profileHash !== ZERO_HASH;
  const hasSdkVersion = sdkVersion && sdkVersion !== ZERO_HASH;

  return (
    <div className="nano-fade" style={{ maxWidth: 560 }}>
      <Link to="/publisher" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0 20px" }}>Publisher Profile</h1>

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
        {relayInCooldown && (
          <div className="nano-info nano-info--warn" style={{ marginBottom: 10, fontSize: 12 }}>
            Rotation cooldown active — next change allowed at block #{nextRelaySignerEligibleBlock}
            {" "}({formatBlockDelta(relayBlocksRemaining)} remaining). Prevents fast oscillation that could mask key compromise.
          </div>
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
              disabled={relayState === "pending" || !newRelaySigner || relayInCooldown}
              style={{ padding: "6px 14px", fontSize: 12 }}
            >
              {relayState === "pending" ? "Setting..." : relayInCooldown ? "Cooldown active" : "Set Relay Signer"}
            </button>
          </div>
        )}
        {(relayMsg || relayState !== "idle") && (
          <div style={{ marginTop: 8 }}>
            <TransactionStatus state={relayState} message={relayMsg ?? undefined} />
          </div>
        )}
      </div>

      {/* SDK Version */}
      <div className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8 }}>SDK Version Hash</div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
          Attest the SDK build you serve so consumers can verify your delivery hasn't been tampered with.
          Enter a version label (e.g. <code>datum-sdk@1.4.2</code>) and we'll keccak256 it for you, or paste a 0x-prefixed bytes32 directly.
        </div>
        {hasSdkVersion ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Current</div>
            <code style={{ fontSize: 11, color: "var(--text)", wordBreak: "break-all" }}>{sdkVersion}</code>
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>Not set.</div>
        )}
        {signer && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <input
                className="nano-input"
                placeholder="datum-sdk@1.4.2  or  0x... bytes32"
                value={newSdkVersionInput}
                onChange={(e) => setNewSdkVersionInput(e.target.value)}
                style={{ width: "100%", fontSize: 12 }}
              />
            </div>
            <button
              className="nano-btn nano-btn-accent"
              onClick={handleSetSdkVersion}
              disabled={sdkState === "pending" || !newSdkVersionInput.trim()}
              style={{ padding: "6px 14px", fontSize: 12 }}
            >
              {sdkState === "pending" ? "Setting..." : "Register SDK Version"}
            </button>
          </div>
        )}
        {(sdkMsg || sdkState !== "idle") && (
          <div style={{ marginTop: 8 }}>
            <TransactionStatus state={sdkState} message={sdkMsg ?? undefined} />
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
