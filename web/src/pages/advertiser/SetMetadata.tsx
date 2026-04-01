import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { CampaignMetadata } from "@shared/types";
import { validateAndSanitize } from "@shared/contentSafety";
import { pinToIPFS } from "@shared/ipfsPin";
import { cidToBytes32 } from "@shared/ipfs";
import { humanizeError } from "@shared/errorCodes";

export function SetMetadata() {
  const { id } = useParams<{ id: string }>();
  const contracts = useContracts();
  const { signer } = useWallet();
  const { settings } = useSettings();
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [creativeText, setCreativeText] = useState("");
  const [cta, setCta] = useState("Learn More");
  const [ctaUrl, setCtaUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");

  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [pinStatus, setPinStatus] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;

    const metadata: CampaignMetadata = {
      title: title.trim(),
      description: description.trim(),
      category: category.trim(),
      creative: {
        type: "text",
        text: creativeText.trim(),
        cta: cta.trim(),
        ctaUrl: ctaUrl.trim(),
        ...(imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {}),
      },
      version: 1,
    };

    const validated = validateAndSanitize(metadata);
    if (!validated) {
      setTxMsg("Metadata failed content validation. Check for blocked phrases or invalid URLs.");
      setTxState("error");
      return;
    }

    const apiKey = settings.ipfsApiKey || settings.pinataApiKey || "";
    if (!apiKey && settings.ipfsProvider !== "custom") {
      setTxMsg(`No API key configured for IPFS pinning. Go to Settings to add your ${settings.ipfsProvider ?? "Pinata"} key.`);
      setTxState("error");
      return;
    }

    setTxState("pending");
    setPinStatus("Pinning to IPFS...");

    try {
      const pinResult = await pinToIPFS({
        provider: settings.ipfsProvider ?? "pinata",
        apiKey,
        endpoint: settings.ipfsApiEndpoint,
      }, validated);
      if (!pinResult.ok || !pinResult.cid) {
        throw new Error(pinResult.error ?? "IPFS pin failed");
      }

      setPinStatus(`Pinned: ${pinResult.cid}`);

      const metadataHash = cidToBytes32(pinResult.cid);
      const c = contracts.campaigns.connect(signer);
      const tx = await c.setMetadata(BigInt(id!), metadataHash);
      await tx.wait();

      setTxState("success");
      setTxMsg(`Metadata set on-chain. CID: ${pinResult.cid}`);
      setTimeout(() => navigate(`/advertiser/campaign/${id}`), 3000);
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  if (!signer) return <div style={{ color: "var(--text-muted)", padding: 20 }}>Connect your wallet to set metadata.</div>;

  return (
    <div className="nano-fade" style={{ maxWidth: 600 }}>
      <div style={{ marginBottom: 20 }}>
        <Link to={`/advertiser/campaign/${id}`} style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Campaign #{id}</Link>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginTop: 8 }}>Set Campaign Metadata</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Metadata is pinned to IPFS and the hash stored on-chain. Requires an IPFS pinning key in{" "}
          <Link to="/settings" style={{ color: "var(--accent)" }}>Settings</Link>.
        </p>
      </div>

      {!(settings.ipfsApiKey || settings.pinataApiKey) && settings.ipfsProvider !== "custom" && (
        <div className="nano-info nano-info--warn" style={{ marginBottom: 16 }}>
          No IPFS pinning key configured. <Link to="/settings" style={{ color: "var(--accent)" }}>Add it in Settings.</Link>
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Title" maxLen={128}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={128} required className="nano-input" placeholder="e.g. Polkadot Hub — Build the Future" />
        </Field>
        <Field label="Description" maxLen={256}>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={256} required rows={3} className="nano-input" style={{ resize: "vertical" }} placeholder="Brief description of your product or service" />
        </Field>
        <Field label="Category label" maxLen={64}>
          <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={64} required className="nano-input" placeholder="e.g. Crypto & Web3" />
        </Field>
        <Field label="Ad Text" maxLen={512}>
          <textarea value={creativeText} onChange={(e) => setCreativeText(e.target.value)} maxLength={512} required rows={4} className="nano-input" style={{ resize: "vertical" }} placeholder="The main body text of your advertisement" />
        </Field>
        <Field label="CTA Button Label" maxLen={64}>
          <input value={cta} onChange={(e) => setCta(e.target.value)} maxLength={64} required className="nano-input" />
        </Field>
        <Field label="CTA URL (HTTPS only)" maxLen={2048}>
          <input type="url" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} maxLength={2048} required className="nano-input" placeholder="https://..." />
        </Field>
        <Field label="Image URL (optional, HTTPS or IPFS gateway)">
          <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="nano-input" placeholder="https://..." />
        </Field>

        {pinStatus && <div style={{ color: "var(--ok)", fontSize: 12 }}>{pinStatus}</div>}
        <TransactionStatus state={txState} message={txMsg} />

        <button type="submit" disabled={txState === "pending" || !signer} className="nano-btn nano-btn-accent" style={{ padding: "10px 20px", fontSize: 14, fontWeight: 600 }}>
          {txState === "pending" ? "Saving..." : "Pin & Set Metadata"}
        </button>
      </form>
    </div>
  );
}

function Field({ label, maxLen, children }: { label: string; maxLen?: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ color: "var(--text)", fontSize: 13 }}>
        {label}{maxLen ? <span style={{ color: "var(--text-muted)", fontSize: 11 }}> ({maxLen} max)</span> : ""}
      </label>
      {children}
    </div>
  );
}
