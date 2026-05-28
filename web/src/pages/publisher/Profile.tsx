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
import { StepTooltip } from "../../components/StepTooltip";

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
  const [maxAssurance, setMaxAssurance] = useState<number>(0);
  const [newRelaySigner, setNewRelaySigner] = useState("");
  const [newProfileHash, setNewProfileHash] = useState("");
  const [newSdkVersionInput, setNewSdkVersionInput] = useState("");
  const [newMaxAssurance, setNewMaxAssurance] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [relayState, setRelayState] = useState<TxState>("idle");
  const [profileState, setProfileState] = useState<TxState>("idle");
  const [sdkState, setSdkState] = useState<TxState>("idle");
  const [maxAssuranceState, setMaxAssuranceState] = useState<TxState>("idle");
  const [relayMsg, setRelayMsg] = useState<string | null>(null);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [sdkMsg, setSdkMsg] = useState<string | null>(null);
  const [maxAssuranceMsg, setMaxAssuranceMsg] = useState<string | null>(null);
  const [relayRotatedBlock, setRelayRotatedBlock] = useState<number>(0);
  const [relayCooldownBlocks, setRelayCooldownBlocks] = useState<number>(600);

  const ZERO = "0x0000000000000000000000000000000000000000";
  const ZERO_HASH = "0x" + "0".repeat(64);

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      const [rs, ph, sv, rotated, cooldown, ma] = await Promise.all([
        contracts.publishers.relaySigner(address).catch(() => ZERO),
        contracts.publishers.profileHash(address).catch(() => ZERO_HASH),
        contracts.publishers.getSdkVersion(address).catch(() => ZERO_HASH),
        contracts.publishers.relaySignerRotatedBlock(address).catch(() => 0),
        contracts.publishers.RELAY_SIGNER_ROTATION_COOLDOWN().catch(() => 600),
        contracts.publishers.publisherMaxAssurance(address).catch(() => 0),
      ]);
      setRelaySigner(rs);
      setProfileHash(ph);
      setSdkVersion(sv);
      setRelayRotatedBlock(Number(rotated));
      setRelayCooldownBlocks(Number(cooldown));
      setMaxAssurance(Number(ma));
      setNewMaxAssurance(Number(ma));
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

  async function handleSetMaxAssurance() {
    if (!signer) return;
    setMaxAssuranceState("pending");
    setMaxAssuranceMsg(null);
    try {
      const pub = contracts.publishers.connect(signer);
      const tx = await pub.setPublisherMaxAssurance(newMaxAssurance);
      await confirmTx(tx);
      setMaxAssuranceState("success");
      setMaxAssuranceMsg("Max assurance updated.");
      load();
    } catch (err) {
      setMaxAssuranceState("error");
      push(humanizeError(err), "error");
      setMaxAssuranceMsg(humanizeError(err));
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

  // Compact onboarding checklist — anchors the user to the minimal setup path.
  // Profile + SDK version are "optional but recommended"; Relay signer / Max
  // assurance are operator-only knobs that 80% of publishers don't touch.
  const steps: { done: boolean; label: string; href?: string; tag?: "required" | "recommended" | "optional" }[] = [
    { done: true,            label: "Wallet connected",                                                    tag: "required" },
    { done: true,            label: "Publisher registered on-chain",       href: "/publisher/register",    tag: "required" },
    { done: hasProfileHash,  label: "Profile metadata pinned (this page)",                                 tag: "recommended" },
    { done: hasSdkVersion,   label: "SDK build attested (this page)",                                      tag: "recommended" },
    { done: hasRelaySigner,  label: "Relay signer set (operator-only)",                                    tag: "optional" },
    { done: maxAssurance > 0,label: "Max assurance level chosen",                                          tag: "optional" },
    { done: false,           label: "SDK snippet added to your site",      href: "/publisher/sdk",         tag: "required" },
  ];

  return (
    <div className="nano-fade" style={{ maxWidth: 560 }}>
      <Link to="/publisher" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0 12px" }}>Publisher Profile</h1>

      {/* Setup walkthrough */}
      <div className="nano-card" style={{ padding: 14, marginBottom: 16, borderColor: "var(--accent)" }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Setup walkthrough</div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
          Fill in the cards below in order. Required steps unlock impressions; recommended ones
          unlock visibility and trust; optional ones are for operators running a relay or fine-tuning
          which campaigns they'll serve. The last step (the SDK snippet) ships your site live.
        </div>
        <ol style={{ paddingLeft: 18, margin: 0, color: "var(--text)", fontSize: 12, lineHeight: 1.9 }}>
          {steps.map((s, i) => (
            <li key={i} style={{ color: s.done ? "var(--ok)" : "var(--text)" }}>
              <span style={{ display: "inline-block", width: 14 }}>{s.done ? "✓" : "○"}</span>
              {s.href ? <Link to={s.href} style={{ color: "inherit" }}>{s.label}</Link> : s.label}
              {s.tag && (
                <span style={{
                  marginLeft: 8, fontSize: 10, color: "var(--text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.05em",
                }}>{s.tag}</span>
              )}
            </li>
          ))}
        </ol>
      </div>

      {/* Relay Signer */}
      <div className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          Relay Signer (Hot Key)
          <StepTooltip
            optional
            summary="Separate hot key your relay node uses to sign attestations."
            details={
              <>
                Lets you keep your cold wallet offline. The relay signer is snapshotted into each campaign at
                creation, so rotating it invalidates in-flight cosignatures (intentional A1 protection).
                Rotation has a ~600-block cooldown to make key-compromise detection easier.
                Leave unset to attest with your wallet key directly.
              </>
            }
          />
        </div>
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
        <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          SDK Version Hash
          <StepTooltip
            optional
            summary="Attest which SDK build you're serving so consumers can verify integrity."
            details={
              <>
                Submit either a 0x-prefixed bytes32 or a free-form version string (e.g. <code>datum-sdk@1.4.2</code>) —
                the page keccak-hashes the string for you. Lets users + advertisers cryptographically verify the
                SDK delivered to their browser hasn't been tampered with. No on-chain enforcement; signal only.
              </>
            }
          />
        </div>
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

      {/* Max Assurance — publisher self-cap on which AssuranceLevel campaigns they'll serve */}
      <div className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          Max Assurance Level
          <StepTooltip
            optional
            summary="Cap the AssuranceLevel of campaigns you'll serve."
            details={
              <>
                Settlement rejects claims for any campaign whose level exceeds this cap. L0 = relay-only;
                L1 = publisher cosig; L2 = publisher + advertiser cosig (dual-sig); L3 = attested.
                Set to the highest tier your relay tooling supports — defending you from being forced into
                a workflow you can't actually run.
              </>
            }
          />
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
          Cap the AssuranceLevel of campaigns you're willing to serve. Settlement rejects claims for any
          campaign whose level exceeds this cap. L0 = relay-only, L1 = publisher cosig, L2 = publisher + advertiser cosig,
          L3 = attested. Set to the highest tier your relay tooling supports.
        </div>
        <div style={{ marginBottom: 10, color: "var(--text)", fontSize: 12 }}>
          Current: <strong>L{maxAssurance}</strong>
        </div>
        {signer && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <select
                className="nano-input"
                value={newMaxAssurance}
                onChange={(e) => setNewMaxAssurance(Number(e.target.value))}
                style={{ width: "100%", fontSize: 12 }}
              >
                <option value={0}>L0 — relay only</option>
                <option value={1}>L1 — publisher cosig</option>
                <option value={2}>L2 — publisher + advertiser cosig (dual-sig)</option>
                <option value={3}>L3 — attested (TEE / ZK)</option>
              </select>
            </div>
            <button
              className="nano-btn nano-btn-accent"
              onClick={handleSetMaxAssurance}
              disabled={maxAssuranceState === "pending" || newMaxAssurance === maxAssurance}
              style={{ padding: "6px 14px", fontSize: 12 }}
            >
              {maxAssuranceState === "pending" ? "Setting..." : "Set Max Assurance"}
            </button>
          </div>
        )}
        {(maxAssuranceMsg || maxAssuranceState !== "idle") && (
          <div style={{ marginTop: 8 }}>
            <TransactionStatus state={maxAssuranceState} message={maxAssuranceMsg ?? undefined} />
          </div>
        )}
      </div>

      {/* Profile Hash */}
      <div className="nano-card" style={{ padding: 16 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          Profile Hash (IPFS Metadata)
          <StepTooltip
            optional
            summary="On-chain pointer (bytes32 IPFS CID) to your publisher metadata JSON."
            details={
              <>
                Holds your display name, website, content policy, and contact info. Advertisers and governance voters
                fetch this to evaluate you. Off-chain content; on-chain commitment. Update anytime.
              </>
            }
          />
        </div>
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
