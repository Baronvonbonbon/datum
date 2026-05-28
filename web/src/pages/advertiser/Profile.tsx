// /advertiser/profile — advertiser-side configuration mirror of /publisher/profile.
//
// Today (Paseo) there is NO on-chain "register as advertiser" step --
// DatumAdvertiserStake is deployed but not wired into Campaigns, so any EOA
// can createCampaign. This page surfaces the cosmetic / operator setup that
// DOES affect campaign behavior:
//
//   1. Brand identity (DatumBrandRegistry) -- read-only here, write on /me/branding
//   2. Advertiser relay signer (DatumCampaigns.advertiserRelaySigner mapping)
//      -- the cold-key advertiser registers a hot key for dual-sig batches
//   3. Forward-looking note: DatumAdvertiserStake is deployed but not gated yet

import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { AddressDisplay } from "../../components/AddressDisplay";
import { TransactionStatus } from "../../components/TransactionStatus";
import { StepTooltip } from "../../components/StepTooltip";

type TxState = "idle" | "pending" | "success" | "error";

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "0".repeat(64);

export function AdvertiserProfile() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  // Brand identity (read-only mirror of BrandRegistry state)
  const [brandName, setBrandName] = useState("");
  const [brandHomepage, setBrandHomepage] = useState("");
  const [brandProfileHash, setBrandProfileHash] = useState("");
  const [brandLogoCid, setBrandLogoCid] = useState("");

  // Advertiser relay signer (cold-key registers hot-key)
  const [advRelaySigner, setAdvRelaySigner] = useState<string>("");
  const [newAdvRelaySigner, setNewAdvRelaySigner] = useState("");
  const [advRelayState, setAdvRelayState] = useState<TxState>("idle");
  const [advRelayMsg, setAdvRelayMsg] = useState<string | null>(null);

  // Forward-looking: is the advertiser-stake gate active on this deploy?
  const [stakeGateWired, setStakeGateWired] = useState<boolean | null>(null);

  const [loading, setLoading] = useState(false);

  useEffect(() => { if (address) load(); }, [address, contracts.campaigns, contracts.brandRegistry]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      // Brand identity (best-effort -- contract may not be wired locally)
      if (contracts.brandRegistry) {
        try {
          const p = await contracts.brandRegistry.getBrand(address);
          setBrandName(String(p.name ?? ""));
          setBrandHomepage(String(p.homepage ?? ""));
          const lc = String(p.logoCid ?? ZERO_HASH);
          setBrandLogoCid(lc !== ZERO_HASH ? lc : "");
          const ph = String(p.profileHash ?? ZERO_HASH);
          setBrandProfileHash(ph !== ZERO_HASH ? ph : "");
        } catch { /* not registered yet */ }
      }

      // Advertiser relay signer on Campaigns
      if (contracts.campaigns) {
        try {
          const rs = await contracts.campaigns.advertiserRelaySigner(address);
          setAdvRelaySigner(rs ?? ZERO);
        } catch { /* not deployed */ }

        // Is the stake gate active? campaigns.advertiserStake() returning
        // a non-zero address means stake is required on createCampaign.
        try {
          const sa = await contracts.campaigns.advertiserStake();
          setStakeGateWired(sa && sa !== ZERO);
        } catch { setStakeGateWired(false); }
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSetAdvRelaySigner() {
    if (!signer || !contracts.campaigns) return;
    setAdvRelayState("pending");
    setAdvRelayMsg(null);
    try {
      const target = (newAdvRelaySigner || "").trim();
      const addr = target ? (ethers.isAddress(target) ? target : "") : ZERO;
      if (target && !addr) throw new Error("Invalid address");
      const c = contracts.campaigns.connect(signer);
      const tx = await c.setAdvertiserRelaySigner(addr);
      await confirmTx(tx);
      setAdvRelayState("success");
      setAdvRelayMsg(target ? "Relay signer set." : "Relay signer cleared.");
      setNewAdvRelaySigner("");
      load();
    } catch (err) {
      setAdvRelayState("error");
      push(humanizeError(err), "error");
      setAdvRelayMsg(humanizeError(err));
    }
  }

  if (!address) {
    return <div style={{ padding: 20, color: "var(--text-muted)" }}>Connect your wallet to manage your advertiser profile.</div>;
  }
  if (loading) {
    return <div className="nano-pending-text" style={{ color: "var(--text-muted)", padding: 20 }}>Loading</div>;
  }

  const hasBrand = !!(brandName || brandHomepage || brandLogoCid || brandProfileHash);
  const hasAdvRelaySigner = advRelaySigner && advRelaySigner !== ZERO;

  const steps: { done: boolean; label: string; href?: string; tag?: "required" | "recommended" | "optional" }[] = [
    { done: true,                       label: "Wallet connected",                                                tag: "required" },
    { done: stakeGateWired !== true,    label: stakeGateWired === true
                                          ? "Advertiser stake required (gate active)"
                                          : "No on-chain registration required on this deploy",                  tag: "required" },
    { done: hasBrand,                   label: "Brand identity set",  href: "/me/branding",                       tag: "recommended" },
    { done: hasAdvRelaySigner,          label: "Relay hot-key registered (operator-only)",                        tag: "optional" },
    { done: false,                      label: "Create your first campaign", href: "/advertiser/create",          tag: "required" },
  ];

  return (
    <div className="nano-fade" style={{ maxWidth: 560 }}>
      <Link to="/advertiser" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0 12px" }}>Advertiser Profile</h1>

      {/* Setup walkthrough */}
      <div className="nano-card" style={{ padding: 14, marginBottom: 16, borderColor: "var(--accent)" }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Setup walkthrough</div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
          There's no "register advertiser" contract step on this deploy — a connected wallet with
          PAS can call <code>createCampaign</code> directly. The items below are the cosmetic and
          operator-side knobs that <i>do</i> affect how your campaigns show up and get attested.
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

      {/* Brand identity */}
      <div className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          Brand Identity
          <StepTooltip
            optional
            summary="Display name, logo, homepage, and IPFS profile metadata shared across publisher + advertiser surfaces."
            details={
              <>
                Lives on <code>DatumBrandRegistry</code>, the cross-role brand store. Same record
                whether you're publishing or advertising; chips and explorer cards read from here.
                Edit on <code>/me/branding</code>.
              </>
            }
          />
        </div>
        {hasBrand ? (
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12, color: "var(--text)" }}>
            <div style={{ color: "var(--text-muted)" }}>Name</div>
            <div>{brandName || "—"}</div>
            <div style={{ color: "var(--text-muted)" }}>Homepage</div>
            <div style={{ wordBreak: "break-all" }}>{brandHomepage || "—"}</div>
            <div style={{ color: "var(--text-muted)" }}>Logo CID</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, wordBreak: "break-all" }}>{brandLogoCid || "—"}</div>
            <div style={{ color: "var(--text-muted)" }}>Profile hash</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, wordBreak: "break-all" }}>{brandProfileHash || "—"}</div>
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
            No brand registered yet — without this your campaigns render as just a hex address.
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <Link to="/me/branding" className="nano-btn nano-btn-accent" style={{ padding: "6px 14px", fontSize: 12, textDecoration: "none" }}>
            {hasBrand ? "Edit brand" : "Set up brand"}
          </Link>
        </div>
      </div>

      {/* Advertiser relay signer */}
      <div className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          Relay Signer (Hot Key)
          <StepTooltip
            optional
            summary="Per-batch hot key your relay tooling uses to cosign claim batches under dual-sig."
            details={
              <>
                The advertiser cold key (this wallet) registers a hot key that may cosign claim
                batches on its behalf for dual-sig settlement. Setting <code>0x0</code> revokes
                delegation — subsequent batches then require strict EOA cosigs from the cold key.
                The cold key is the sole authority over this slot, so a compromised hot key
                can't self-perpetuate.
              </>
            }
          />
        </div>
        {hasAdvRelaySigner ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Current</div>
            <AddressDisplay address={advRelaySigner} />
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
            Not set — dual-sig batches must be cosigned directly by this wallet.
          </div>
        )}
        {signer && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <input
                className="nano-input"
                placeholder={hasAdvRelaySigner ? "New address (or 0x0...0 to clear)" : "0x... hot key address"}
                value={newAdvRelaySigner}
                onChange={(e) => setNewAdvRelaySigner(e.target.value)}
                style={{ width: "100%", fontSize: 12 }}
              />
            </div>
            <button
              className="nano-btn nano-btn-accent"
              onClick={handleSetAdvRelaySigner}
              disabled={advRelayState === "pending" || !newAdvRelaySigner}
              style={{ padding: "6px 14px", fontSize: 12 }}
            >
              {advRelayState === "pending" ? "Setting..." : "Set Relay Signer"}
            </button>
          </div>
        )}
        {(advRelayMsg || advRelayState !== "idle") && (
          <div style={{ marginTop: 8 }}>
            <TransactionStatus state={advRelayState} message={advRelayMsg ?? undefined} />
          </div>
        )}
      </div>

      {/* Forward-looking note about advertiser stake */}
      <div className="nano-info nano-info--muted" style={{ padding: 12, fontSize: 12 }}>
        <strong>Advertiser stake:</strong>{" "}
        {stakeGateWired === true
          ? "the stake gate is active on this deploy — Campaigns requires you to be adequately staked before createCampaign succeeds."
          : "DatumAdvertiserStake is deployed but not wired into Campaigns on Paseo, so no stake is required to create campaigns. Mainnet will gate this."}
      </div>
    </div>
  );
}
