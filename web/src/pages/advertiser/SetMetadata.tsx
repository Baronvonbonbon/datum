import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { CampaignMetadata, AdFormat, AD_FORMAT_SIZES, CreativeAsset } from "@shared/types";
import { validateAndSanitize } from "@shared/contentSafety";
import { pinToIPFS } from "@shared/ipfsPin";
import { cidToBytes32 } from "@shared/ipfs";
import { BulletinCodec } from "@shared/bulletinChain";
import {
  listInjectedExtensions,
  connectExtension,
  signerFor,
  storeOnBulletin,
  getAuthorization,
} from "@shared/bulletinChainClient";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";

// Default regulatory retention horizon: ~1 year of Hub blocks (6s blocks).
// Used by the Bulletin Chain path when the advertiser doesn't override it.
const DEFAULT_RETENTION_HORIZON_BLOCKS = 5_256_000n;

export function SetMetadata() {
  const { id } = useParams<{ id: string }>();
  const contracts = useContracts();
  const { signer } = useWallet();
  const { settings } = useSettings();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [creativeText, setCreativeText] = useState("");
  const [cta, setCta] = useState("Learn More");
  const [ctaUrl, setCtaUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [formatImages, setFormatImages] = useState<Partial<Record<AdFormat, string>>>({});
  const [videoUrl, setVideoUrl] = useState("");

  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [pinStatus, setPinStatus] = useState<string | null>(null);

  function buildMetadata(): CampaignMetadata | null {
    const perFormatImages: CreativeAsset[] = (Object.entries(formatImages) as [AdFormat, string][])
      .filter(([, url]) => url.trim())
      .map(([format, url]) => ({ format, url: url.trim() }));

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
        ...(perFormatImages.length > 0 ? { images: perFormatImages } : {}),
        ...(videoUrl.trim() ? { videoUrl: videoUrl.trim() } : {}),
      },
      version: 1,
    };

    const validated = validateAndSanitize(metadata);
    if (!validated) {
      setTxMsg("Metadata failed content validation. Check for blocked phrases or invalid URLs.");
      setTxState("error");
      return null;
    }
    return validated;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;

    const validated = buildMetadata();
    if (!validated) return;

    if (settings.ipfsProvider === "bulletin") {
      await handleSubmitBulletin(validated);
    } else {
      await handleSubmitIpfs(validated);
    }
  }

  async function handleSubmitIpfs(validated: CampaignMetadata) {
    const apiKey = settings.ipfsApiKey || settings.pinataApiKey || "";
    const noKeyRequired = settings.ipfsProvider === "custom" || settings.ipfsProvider === "selfhosted";
    if (!apiKey && !noKeyRequired) {
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

      setPinStatus(`Pinned: ${pinResult.cid}${pinResult.warning ? " ⚠ local-only" : ""}`);
      if (pinResult.warning) push(pinResult.warning, "warn");

      const metadataHash = cidToBytes32(pinResult.cid);
      const c = contracts.campaigns.connect(signer!);
      const tx = await c.setMetadata(BigInt(id!), metadataHash);
      await confirmTx(tx);

      setTxState("success");
      setTxMsg(`Metadata set on-chain. CID: ${pinResult.cid}`);
      setTimeout(() => navigate(`/advertiser/campaign/${id}`), 3000);
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function handleSubmitBulletin(validated: CampaignMetadata) {
    setTxState("pending");

    try {
      // 1. Locate a polkadot.js-compatible wallet extension.
      setPinStatus("Looking for wallet extension...");
      const exts = await listInjectedExtensions();
      if (exts.length === 0) {
        throw new Error(
          "No Polkadot wallet extension detected. Install polkadot{.js}, Talisman, SubWallet, or Fearless and reload.",
        );
      }

      setPinStatus(`Connecting to ${exts[0]}...`);
      const { accounts } = await connectExtension(exts[0]);
      if (accounts.length === 0) {
        throw new Error(`No accounts available in ${exts[0]}. Open the extension and create / unlock an account.`);
      }
      // Phase A: use the first available account. F5 will add account selection UI.
      const account = accounts[0];

      // 2. Verify the account has Bulletin Chain authorization.
      setPinStatus(`Checking Bulletin Chain authorization for ${account.address.slice(0, 10)}...`);
      const auth = await getAuthorization(account.address);
      if (!auth.authorized) {
        throw new Error(
          `${account.address.slice(0, 10)}... is not authorized on Bulletin Chain. Visit the faucet (https://paritytech.github.io/polkadot-bulletin-chain/) to grant authorization first.`,
        );
      }

      // 3. Submit transactionStorage.store with the JSON-serialized metadata.
      const data = new TextEncoder().encode(JSON.stringify(validated));
      setPinStatus(`Uploading ${data.byteLength} bytes to Bulletin Chain...`);
      const storeRes = await storeOnBulletin(data, signerFor(account));
      setPinStatus(`Stored: ${storeRes.cid} (block ${storeRes.bulletinBlock}, idx ${storeRes.bulletinIndex})`);

      // 4. Record the reference on Hub.
      const c = contracts.campaigns.connect(signer!);
      const horizonBlock = BigInt(await contracts.campaigns.runner!.provider!.getBlockNumber())
        + DEFAULT_RETENTION_HORIZON_BLOCKS;
      const tx = await c.setBulletinCreative(
        BigInt(id!),
        storeRes.cidDigest,
        storeRes.cidCodec,
        storeRes.bulletinBlock,
        storeRes.bulletinIndex,
        horizonBlock,
      );
      await confirmTx(tx);

      setTxState("success");
      setTxMsg(`Bulletin Chain creative set on Hub. CID: ${storeRes.cid}`);
      setTimeout(() => navigate(`/advertiser/campaign/${id}`), 3000);
    } catch (err) {
      push(humanizeError(err), "error");
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
          {settings.ipfsProvider === "bulletin"
            ? "Creative will be uploaded to the Polkadot Bulletin Chain. Requires a Bulletin-authorized account in your wallet extension."
            : <>Metadata is pinned to IPFS and the hash stored on-chain. Requires an IPFS pinning key in <Link to="/settings" style={{ color: "var(--accent)" }}>Settings</Link>.</>
          }
        </p>
      </div>

      {settings.ipfsProvider === "bulletin" && (
        <div className="nano-info" style={{ marginBottom: 16 }}>
          Bulletin Chain selected. Authorize your wallet address at the{" "}
          <a href="https://paritytech.github.io/polkadot-bulletin-chain/" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Paseo faucet</a>
          {" "}before uploading.
        </div>
      )}

      {settings.ipfsProvider !== "bulletin" && !(settings.ipfsApiKey || settings.pinataApiKey) && settings.ipfsProvider !== "custom" && settings.ipfsProvider !== "selfhosted" && (
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
        <Field label="Fallback Image URL (optional, HTTPS or IPFS)">
          <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="nano-input" placeholder="https://... or IPFS CID — used when no per-format image matches" />
        </Field>

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>Per-format Images (optional)</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
            Upload format-specific images to IPFS and paste their URLs here. The extension picks the best match for the publisher's ad slot.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(Object.entries(AD_FORMAT_SIZES) as [AdFormat, { w: number; h: number }][]).map(([fmt, size]) => (
              <div key={fmt}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{fmt}</span>
                  <span style={{ color: "var(--text-faint)", marginLeft: 4 }}>{size.w}×{size.h}</span>
                </div>
                <input
                  value={formatImages[fmt] ?? ""}
                  onChange={(e) => setFormatImages((prev) => ({ ...prev, [fmt]: e.target.value }))}
                  className="nano-input"
                  placeholder="https://... or IPFS CID"
                  style={{ fontSize: 11 }}
                />
              </div>
            ))}
          </div>
        </div>

        <Field label="Video URL (optional, HTTPS or IPFS)">
          <input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} className="nano-input" placeholder="https://... or IPFS CID — plays muted, click to unmute" />
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
