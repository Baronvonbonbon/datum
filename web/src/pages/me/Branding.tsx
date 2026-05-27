// /me/branding — set your address's BrandProfile.
//
// Connected wallet only. Reads + writes DatumBrandRegistry. The page is
// the same for every role: a user setting up a personal brand, a publisher
// branding their site, or an advertiser branding their campaigns. The chip
// rendered everywhere picks up changes within 24h (TTL) or as soon as
// lastUpdateBlock advances (whichever is sooner).

import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { TransactionStatus } from "../../components/TransactionStatus";
import { BrandChip } from "../../components/BrandChip";
import { PageExplainer } from "../../components/PageExplainer";
import { StepTooltip } from "../../components/StepTooltip";
import { cidToBytes32, bytes32ToCid } from "@shared/ipfs";
import { pinBlobToIPFS, PinConfig } from "@shared/ipfsPin";

const ZERO_HASH = "0x" + "0".repeat(64);

type TxState = "idle" | "pending" | "success" | "error";

const LOGO_MAX_BYTES = 256 * 1024;     // 256 KB
const LOGO_MIN_DIM = 32;
const LOGO_MAX_DIM = 1024;
const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

export function Branding() {
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { settings } = useSettings();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const logoFileRef = useRef<HTMLInputElement>(null);
  const jsonFileRef = useRef<HTMLInputElement>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [jsonUploading, setJsonUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [logoCid, setLogoCid] = useState(""); // bytes32 hex or IPFS CID
  const [homepage, setHomepage] = useState("");
  const [brandColor, setBrandColor] = useState("#000000");
  const [profileHash, setProfileHash] = useState("");
  const [txState, setTxState] = useState<TxState>("idle");
  const [txMsg, setTxMsg] = useState("");
  const [loading, setLoading] = useState(false);

  // Load existing brand for the connected address.
  useEffect(() => {
    if (!address || !contracts.brandRegistry) return;
    setLoading(true);
    (async () => {
      try {
        const c = contracts.brandRegistry!;
        const p = await c.getBrand(address);
        setName(String(p.name));
        const lc = String(p.logoCid);
        setLogoCid(lc !== ZERO_HASH ? lc : "");
        setHomepage(String(p.homepage));
        const bc = Number(p.brandColor);
        setBrandColor(bc === 0 ? "#000000" : "#" + bc.toString(16).padStart(6, "0"));
        const ph = String(p.profileHash);
        setProfileHash(ph !== ZERO_HASH ? ph : "");
      } catch (err) {
        // not registered yet — keep defaults
      } finally {
        setLoading(false);
      }
    })();
  }, [address, contracts.brandRegistry]);

  function normalizeCid(input: string): string {
    const t = input.trim();
    if (!t) return ZERO_HASH;
    if (/^0x[0-9a-f]{64}$/i.test(t)) return t;
    // Try IPFS CID conversion (v1 raw codec)
    try { return cidToBytes32(t); } catch { /* ignore */ }
    return "";
  }

  async function handleSave() {
    if (!signer || !contracts.brandRegistry) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const logoBytes32 = normalizeCid(logoCid);
      if (logoCid && !logoBytes32) throw new Error("Invalid logo CID — must be 0x-prefixed bytes32 or a valid IPFS CIDv1.");
      const profileBytes32 = normalizeCid(profileHash);
      if (profileHash && !profileBytes32) throw new Error("Invalid profile hash — must be 0x-prefixed bytes32 or a valid IPFS CIDv1.");

      const colorNum = parseInt(brandColor.replace("#", ""), 16) || 0;
      if (colorNum > 0xffffff) throw new Error("brandColor exceeds 24 bits.");

      const c = contracts.brandRegistry.connect(signer) as typeof contracts.brandRegistry;
      const tx = await c.setBrand(name, logoBytes32, homepage, colorNum, profileBytes32);
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Brand profile updated.");
    } catch (err) {
      push(humanizeError(err), "error");
      setTxState("error");
      setTxMsg(humanizeError(err));
    }
  }

  async function handleClear() {
    if (!signer || !contracts.brandRegistry) return;
    if (!confirm("Clear your brand profile? This frees the name for re-use by another address.")) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.brandRegistry.connect(signer) as typeof contracts.brandRegistry;
      const tx = await c.clearBrand();
      await confirmTx(tx);
      setName(""); setLogoCid(""); setHomepage(""); setBrandColor("#000000"); setProfileHash("");
      setTxState("success");
      setTxMsg("Brand cleared.");
    } catch (err) {
      push(humanizeError(err), "error");
      setTxState("error");
      setTxMsg(humanizeError(err));
    }
  }

  /** Read image dimensions from a Blob via a hidden <img>. Rejects when
   *  the Blob isn't an image the browser can decode. */
  function readImageDims(blob: Blob): Promise<{ w: number; h: number }> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Not a valid image.")); };
      img.src = url;
    });
  }

  function pinConfig(): PinConfig | null {
    const provider = settings.ipfsProvider;
    const apiKey = settings.ipfsApiKey ?? "";
    const endpoint = settings.ipfsApiEndpoint ?? "";
    if (!provider) return null;
    return { provider, apiKey, endpoint };
  }

  async function handleLogoFile(file: File) {
    setUploadMsg(null);
    setLogoUploading(true);
    try {
      // Validation
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        throw new Error("Logo must be PNG, JPEG, or WEBP. SVG is rejected for safety.");
      }
      if (file.size > LOGO_MAX_BYTES) {
        throw new Error(`Logo too large: ${(file.size / 1024).toFixed(1)} KB > ${LOGO_MAX_BYTES / 1024} KB.`);
      }
      const dims = await readImageDims(file);
      if (dims.w < LOGO_MIN_DIM || dims.h < LOGO_MIN_DIM) {
        throw new Error(`Logo too small: ${dims.w}×${dims.h}. Min ${LOGO_MIN_DIM}×${LOGO_MIN_DIM}.`);
      }
      if (dims.w > LOGO_MAX_DIM || dims.h > LOGO_MAX_DIM) {
        throw new Error(`Logo too large: ${dims.w}×${dims.h}. Max ${LOGO_MAX_DIM}×${LOGO_MAX_DIM}.`);
      }
      const cfg = pinConfig();
      if (!cfg) throw new Error("Set an IPFS provider in Settings first.");
      const result = await pinBlobToIPFS(cfg, file, file.name);
      if (!result.ok || !result.cid) throw new Error(result.error ?? "Pin failed");
      // Convert the CID to bytes32 and fill the form.
      const bytes32 = cidToBytes32(result.cid);
      setLogoCid(bytes32);
      setUploadMsg(`Logo pinned: ${result.cid}`);
    } catch (err) {
      setUploadMsg(`Logo upload failed: ${(err as Error).message}`);
      push((err as Error).message, "error");
    } finally {
      setLogoUploading(false);
    }
  }

  async function handleJsonFile(file: File) {
    setUploadMsg(null);
    setJsonUploading(true);
    try {
      if (file.size > 64 * 1024) throw new Error("Profile JSON > 64 KB.");
      const text = await file.text();
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { throw new Error("Not valid JSON."); }
      if (typeof parsed !== "object" || parsed === null) throw new Error("JSON must be an object.");
      const cfg = pinConfig();
      if (!cfg) throw new Error("Set an IPFS provider in Settings first.");
      const blob = new Blob([JSON.stringify(parsed)], { type: "application/json" });
      const result = await pinBlobToIPFS(cfg, blob, "brand-profile.json");
      if (!result.ok || !result.cid) throw new Error(result.error ?? "Pin failed");
      const bytes32 = cidToBytes32(result.cid);
      setProfileHash(bytes32);
      setUploadMsg(`Profile JSON pinned: ${result.cid}`);
    } catch (err) {
      setUploadMsg(`JSON upload failed: ${(err as Error).message}`);
      push((err as Error).message, "error");
    } finally {
      setJsonUploading(false);
    }
  }

  if (!address) {
    return <div style={{ padding: 20, color: "var(--text-muted)" }}>Connect a wallet to manage your brand profile.</div>;
  }
  if (!contracts.brandRegistry) {
    return (
      <div className="nano-fade" style={{ maxWidth: 600 }}>
        <Link to="/me" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Me</Link>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Branding</h1>
        <div className="nano-info">DatumBrandRegistry is not deployed on this network.</div>
      </div>
    );
  }

  // Preview based on the form state, not the on-chain state, so the user
  // sees what they're about to commit.
  const previewColor = parseInt(brandColor.replace("#", ""), 16) || 0;

  return (
    <div className="nano-fade" style={{ maxWidth: 640 }}>
      <Link to="/me" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Me</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Branding</h1>

      <PageExplainer slug="me-branding" title="What does brand profile do?">
        <p style={{ margin: 0 }}>
          Sets the name + logo + homepage that show next to your address everywhere across the app:
          campaign detail pages, governance proposals, the ad slot rendered to users.
          Self-only writes — the connected wallet controls its own entry.
        </p>
        <p style={{ marginTop: 8, marginBottom: 0 }}>
          Verification badges are <em>read separately</em>:
          {" "}<strong>Council</strong> requires a Council propose+vote+execute against the brand curator;
          {" "}<strong>Identity</strong> reads your People Chain identity status;
          {" "}<strong>Domain</strong> is computed at view-time by fetching{" "}
          <code>https://&lt;your homepage&gt;/.well-known/datum-verify.json</code> and confirming
          it lists your address. None of this needs to happen at registration — set your brand here,
          drop the verify file on your site, and the chip updates on next view.
        </p>
      </PageExplainer>

      {/* Live preview */}
      <div className="nano-card" style={{ padding: 16, marginBottom: 20, background: "var(--bg-elev)" }}>
        <div style={{ color: "var(--accent)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>
          Preview (live, on-chain)
        </div>
        <BrandChip address={address} size="lg" verifyDomain layout="stacked" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Name */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
            Name
            <StepTooltip
              optional
              summary="Display name shown next to your address."
              details="Max 32 bytes. Soft-unique — once you claim a name, another address can't take it until you clear or change yours. Leave empty for no name (chip shows '(unregistered)')."
            />
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            className="nano-input"
            placeholder="e.g. Polkadot Network"
          />
        </div>

        {/* Logo CID */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
            Logo (IPFS CID)
            <StepTooltip
              optional
              summary="Bytes32 IPFS CIDv1 raw digest of your logo image."
              details={
                <>
                  Pin a PNG/JPG/WEBP (256×256 recommended) via your IPFS provider (Pinata / web3.storage / self-hosted),
                  then paste either the CID (<code>baf…</code>) or the 0x-prefixed bytes32 digest here.
                  SVG is not accepted (XSS risk). When empty, the chip renders a deterministic identicon.
                </>
              }
            />
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={logoCid}
              onChange={(e) => setLogoCid(e.target.value)}
              className="nano-input"
              placeholder="baf… or 0x… (bytes32)"
              style={{ fontFamily: "var(--font-mono)", fontSize: 11, flex: 1 }}
            />
            <input
              type="file"
              ref={logoFileRef}
              accept={LOGO_ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleLogoFile(f);
                if (e.target) e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => logoFileRef.current?.click()}
              className="nano-btn"
              disabled={logoUploading}
              style={{ fontSize: 11, padding: "6px 10px", whiteSpace: "nowrap" }}
            >
              {logoUploading ? "Pinning…" : "Upload"}
            </button>
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 2 }}>
            PNG/JPG/WEBP only, 32×32 to 1024×1024, ≤256 KB. Pinned via your Settings → IPFS provider.
          </div>
        </div>

        {/* Homepage */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
            Homepage
            <StepTooltip
              optional
              summary="https:// URL of your site."
              details={
                <>
                  Max 128 bytes. Must start with <code>https://</code> — http is rejected on-chain to avoid mixed-content browsing.
                  Used as the link in your chip on profile pages and as the source-of-truth for domain verification
                  (UI fetches <code>{`{homepage}/.well-known/datum-verify.json`}</code> to check it lists this address).
                </>
              }
            />
          </label>
          <input
            type="url"
            value={homepage}
            onChange={(e) => setHomepage(e.target.value)}
            maxLength={128}
            className="nano-input"
            placeholder="https://polkadot.network"
          />
        </div>

        {/* Brand color */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
            Brand color
            <StepTooltip
              optional
              summary="Accent color used for your logo border + chip outline."
              details="Single 24-bit RRGGBB color. Applied sparingly — the rest of the UI keeps its theme. Set to #000000 to use the default border."
            />
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="color"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              style={{ width: 48, height: 32, padding: 0, border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer", background: "transparent" }}
            />
            <code style={{ fontSize: 12, color: "var(--text-muted)" }}>{brandColor}{previewColor === 0 ? " (no color)" : ""}</code>
          </div>
        </div>

        {/* Profile hash (long-tail JSON) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
            Profile JSON (IPFS CID)
            <StepTooltip
              optional
              summary="Pointer to the long-tail profile JSON (description, socials, address book)."
              details={
                <>
                  Same shape as the existing publisher profileHash. Schema:
                  <code style={{ display: "block", marginTop: 4, fontSize: 10, lineHeight: 1.4 }}>
                    {`{ schemaVersion: 1, description: "…", support: {…}, socials: {…}, additionalAddresses: [{addr,label,purpose}] }`}
                  </code>
                  Pin the JSON via your IPFS provider, paste the CID here. Optional — leave empty if you only need
                  the hot fields.
                </>
              }
            />
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={profileHash}
              onChange={(e) => setProfileHash(e.target.value)}
              className="nano-input"
              placeholder="baf… or 0x… (bytes32)"
              style={{ fontFamily: "var(--font-mono)", fontSize: 11, flex: 1 }}
            />
            <input
              type="file"
              ref={jsonFileRef}
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleJsonFile(f);
                if (e.target) e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => jsonFileRef.current?.click()}
              className="nano-btn"
              disabled={jsonUploading}
              style={{ fontSize: 11, padding: "6px 10px", whiteSpace: "nowrap" }}
            >
              {jsonUploading ? "Pinning…" : "Upload JSON"}
            </button>
          </div>
        </div>

        {/* Helper: convert hex → CID for verification */}
        {logoCid.startsWith("0x") && logoCid.length === 66 && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            Logo CID (decoded): {bytes32ToCid(logoCid)}
          </div>
        )}

        {uploadMsg && (
          <div style={{ fontSize: 11, color: uploadMsg.includes("failed") ? "var(--error)" : "var(--ok)" }}>
            {uploadMsg}
          </div>
        )}

        <TransactionStatus state={txState} message={txMsg} />

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={handleSave}
            disabled={txState === "pending" || loading || !signer}
            className="nano-btn nano-btn-accent"
            style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600 }}
          >
            {txState === "pending" ? "Submitting..." : loading ? "Loading..." : "Save Brand"}
          </button>
          <button
            onClick={handleClear}
            disabled={txState === "pending" || loading || !signer}
            className="nano-btn"
            style={{ padding: "8px 16px", fontSize: 13, color: "var(--error)", border: "1px solid rgba(248,113,113,0.3)" }}
          >
            Clear Brand
          </button>
        </div>
      </div>
    </div>
  );
}
