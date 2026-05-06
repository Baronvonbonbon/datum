import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ethers, Contract } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { parseDOTSafe } from "@shared/dot";
import { getCurrencySymbol } from "@shared/networks";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { TAG_DICTIONARY, TAG_LABELS, tagHash, validateCustomTag, tagDisplayLabel, tagLabel } from "@shared/tagDictionary";
import { queryFilterAll } from "@shared/eventQuery";
import { CampaignMetadata, AdFormat, AD_FORMAT_SIZES, CreativeAsset } from "@shared/types";
import { validateAndSanitize } from "@shared/contentSafety";
import { pinToIPFS } from "@shared/ipfsPin";
import { cidToBytes32 } from "@shared/ipfs";
import { KNOWN_ASSETS, assetIdToAddress, getAssetMetadata, searchAssets, type NativeAsset } from "@shared/assetRegistry";

const ERC20_MINIMAL_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

export function CreateCampaign() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { settings } = useSettings();
  const navigate = useNavigate();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const sym = getCurrencySymbol(settings.network);

  const [isOpen, setIsOpen] = useState(true);
  const [publisher, setPublisher] = useState("");

  // View pot (CPM) — always required
  const [viewBudget, setViewBudget] = useState("1");
  const [viewDailyCap, setViewDailyCap] = useState("0.1");
  const [viewBidCpm, setViewBidCpm] = useState("0.001");

  // Click pot (CPC) — optional
  const [enableClick, setEnableClick] = useState(false);
  const [clickBudget, setClickBudget] = useState("0.5");
  const [clickDailyCap, setClickDailyCap] = useState("0.05");
  const [clickRate, setClickRate] = useState("0.001");

  // Action pot (CPA) — optional, requires verifier address
  const [enableAction, setEnableAction] = useState(false);
  const [actionBudget, setActionBudget] = useState("0.5");
  const [actionDailyCap, setActionDailyCap] = useState("0.05");
  const [actionRate, setActionRate] = useState("0.01");
  const [actionVerifier, setActionVerifier] = useState("");

  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [requireZkProof, setRequireZkProof] = useState(false);
  const [bondAmount, setBondAmount] = useState("");
  const [tokenSource, setTokenSource] = useState<"erc20" | "native">("erc20");
  const [selectedNativeAsset, setSelectedNativeAsset] = useState<NativeAsset | null>(null);
  const [customAssetId, setCustomAssetId] = useState("");
  const [rewardToken, setRewardToken] = useState("");
  const [rewardPerImpression, setRewardPerImpression] = useState("");
  const [showTags, setShowTags] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const [customTag, setCustomTag] = useState("");
  const [customTagError, setCustomTagError] = useState<string | null>(null);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [createdId, setCreatedId] = useState<number | null>(null);

  // Step 2+3: Inline metadata + token budget (wizard flow)
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDesc, setMetaDesc] = useState("");
  const [metaCategory, setMetaCategory] = useState("");
  const [metaText, setMetaText] = useState("");
  const [metaCta, setMetaCta] = useState("Learn More");
  const [metaCtaUrl, setMetaCtaUrl] = useState("");
  const [metaImageUrl, setMetaImageUrl] = useState("");
  // Per-format images: map from AdFormat → URL string
  const [formatImages, setFormatImages] = useState<Partial<Record<AdFormat, string>>>({});
  const [metaTxState, setMetaTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [metaTxMsg, setMetaTxMsg] = useState("");
  const [pinStatus, setPinStatus] = useState<string | null>(null);

  // Step 3: Token budget deposit
  const [tokenDepositAmount, setTokenDepositAmount] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("TOKEN");
  const [tokenDecimals, setTokenDecimals] = useState(18);
  const [depositTxState, setDepositTxState] = useState<"idle" | "approving" | "depositing" | "success" | "error">("idle");
  const [depositTxMsg, setDepositTxMsg] = useState("");

  // Publisher picker list
  interface PubOption { address: string; takeRateBps: number; tags: string[]; repScore: number | null; reportCount: number; }
  const [pubOptions, setPubOptions] = useState<PubOption[]>([]);
  const [pubSearch, setPubSearch] = useState("");
  const [pubListLoading, setPubListLoading] = useState(false);

  // Load publisher list when switching to targeted mode
  useEffect(() => {
    if (isOpen || !settings.contractAddresses.publishers) return;
    if (pubOptions.length > 0) return; // already loaded
    setPubListLoading(true);
    (async () => {
      try {
        const filter = contracts.publishers.filters.PublisherRegistered();
        const logs = await queryFilterAll(contracts.publishers, filter);
        const addresses = [...new Set(logs.map((l: any) => l.args?.publisher as string).filter(Boolean))];
        const ZERO = "0x0000000000000000000000000000000000000000";
        const rows = await Promise.all(addresses.map(async (addr) => {
          try {
            const data = await contracts.publishers.getPublisher(addr);
            if (!data.registered) return null;
            const blocked = await contracts.publishers.isBlocked(addr).catch(() => false);
            if (blocked) return null;
            let tags: string[] = [];
            try {
              if (contracts.campaigns) {
                const hashes: string[] = await contracts.campaigns.getPublisherTags2(addr);
                tags = hashes.map((h) => tagLabel(h) ?? h.slice(0, 8) + "…").filter(Boolean);
              }
            } catch { /* */ }
            let repScore: number | null = null;
            try {
              if (contracts.settlement) repScore = Number((await contracts.settlement.getPublisherStats(addr))[2]);
            } catch { /* */ }
            let reportCount = 0;
            try {
              if (contracts.campaigns) reportCount = Number(await contracts.campaigns.publisherReports(addr));
            } catch { /* */ }
            return { address: addr, takeRateBps: Number(data.takeRateBps ?? data[1] ?? 0), tags, repScore, reportCount };
          } catch { return null; }
        }));
        setPubOptions(rows.filter(Boolean) as PubOption[]);
      } catch { /* */ }
      setPubListLoading(false);
    })();
  }, [isOpen, settings.contractAddresses.publishers]);

  // Pre-flight checks (debounced to avoid RPC flood on keystrokes)
  const [pubCheck, setPubCheck] = useState<string | null>(null);
  const [pubChecking, setPubChecking] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkPublisher = useCallback((addr: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!addr || !ethers.isAddress(addr)) { setPubCheck(null); setPubChecking(false); return; }
    setPubChecking(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const blocked = await contracts.publishers.isBlocked(addr);
        if (blocked) { setPubCheck("This address is blocked."); setPubChecking(false); return; }
        const data = await contracts.publishers.getPublisher(addr);
        if (!data.registered) { setPubCheck("Publisher not registered."); setPubChecking(false); return; }
        setPubCheck(`Registered · Take rate: ${(Number(data.takeRateBps) / 100).toFixed(0)}%`);
      } catch {
        setPubCheck("Could not verify publisher.");
      }
      setPubChecking(false);
    }, 400);
  }, [contracts]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signer || !address) return;

    const pubAddr = isOpen ? ethers.ZeroAddress : publisher.trim();
    if (!isOpen && !ethers.isAddress(pubAddr)) {
      setTxMsg("Invalid publisher address.");
      setTxState("error");
      return;
    }

    setTxState("pending");
    setTxMsg("");
    try {
      const bondPlanck = bondAmount.trim() ? parseDOTSafe(bondAmount) : 0n;

      // Build action pot array
      const pots: { actionType: number; budgetPlanck: bigint; dailyCapPlanck: bigint; ratePlanck: bigint; actionVerifier: string }[] = [];
      const viewBudgetPlanck = parseDOTSafe(viewBudget);
      const viewDailyCapPlanck = parseDOTSafe(viewDailyCap);
      const viewBidCpmPlanck = parseDOTSafe(viewBidCpm);
      pots.push({ actionType: 0, budgetPlanck: viewBudgetPlanck, dailyCapPlanck: viewDailyCapPlanck, ratePlanck: viewBidCpmPlanck, actionVerifier: ethers.ZeroAddress });

      if (enableClick) {
        pots.push({ actionType: 1, budgetPlanck: parseDOTSafe(clickBudget), dailyCapPlanck: parseDOTSafe(clickDailyCap), ratePlanck: parseDOTSafe(clickRate), actionVerifier: ethers.ZeroAddress });
      }
      if (enableAction) {
        const verifier = actionVerifier.trim();
        if (!ethers.isAddress(verifier)) { setTxMsg("Action verifier address is invalid."); setTxState("error"); return; }
        pots.push({ actionType: 2, budgetPlanck: parseDOTSafe(actionBudget), dailyCapPlanck: parseDOTSafe(actionDailyCap), ratePlanck: parseDOTSafe(actionRate), actionVerifier: verifier });
      }

      const totalBudgetPlanck = pots.reduce((s, p) => s + p.budgetPlanck, 0n);
      const totalValue = totalBudgetPlanck + bondPlanck;

      const tagHashes = [...selectedTags].map((t) => tagHash(t));
      const rToken = rewardToken.trim() && ethers.isAddress(rewardToken.trim()) ? rewardToken.trim() : ethers.ZeroAddress;
      const rPerImp = rToken !== ethers.ZeroAddress && rewardPerImpression.trim() ? BigInt(rewardPerImpression.trim()) : 0n;
      const c = contracts.campaigns.connect(signer);
      const tx = await c.createCampaign(pubAddr, pots, tagHashes, requireZkProof, rToken, rPerImp, bondPlanck, {
        value: totalValue,
      });
      await confirmTx(tx);

      // Find campaign ID — try receipt logs first, fall back to nextCampaignId
      let newId: number | null = null;
      try {
        const receipt = await tx.wait?.(0).catch(() => null);
        for (const log of receipt?.logs ?? []) {
          try {
            const parsed = contracts.campaigns.interface.parseLog(log);
            if (parsed?.name === "CampaignCreated") {
              newId = Number(parsed.args.campaignId ?? parsed.args[0]);
              break;
            }
          } catch { /* skip */ }
        }
      } catch { /* receipt unavailable on Paseo */ }
      if (newId === null) {
        try {
          newId = Number(await contracts.campaigns.nextCampaignId()) - 1;
        } catch { /* fallback failed */ }
      }

      setCreatedId(newId);
      setTxState("success");
      setTxMsg(`Campaign #${newId ?? "?"} created!`);
      setStep(2);
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function handleMetadataSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signer || createdId === null) return;

    const perFormatImages: CreativeAsset[] = (Object.entries(formatImages) as [AdFormat, string][])
      .filter(([, url]) => url.trim())
      .map(([format, url]) => ({ format, url: url.trim() }));

    const metadata: CampaignMetadata = {
      title: metaTitle.trim(), description: metaDesc.trim(), category: metaCategory.trim(),
      creative: {
        type: "text", text: metaText.trim(), cta: metaCta.trim(), ctaUrl: metaCtaUrl.trim(),
        ...(metaImageUrl.trim() ? { imageUrl: metaImageUrl.trim() } : {}),
        ...(perFormatImages.length > 0 ? { images: perFormatImages } : {}),
      },
      version: 1,
    };

    const validated = validateAndSanitize(metadata);
    if (!validated) { setMetaTxMsg("Content validation failed."); setMetaTxState("error"); return; }

    const apiKey = settings.ipfsApiKey || settings.pinataApiKey || "";
    if (!apiKey && settings.ipfsProvider !== "custom") {
      setMetaTxMsg("No IPFS pinning key. Add one in Settings.");
      setMetaTxState("error");
      return;
    }

    setMetaTxState("pending");
    setPinStatus("Pinning to IPFS...");
    try {
      const pinResult = await pinToIPFS({ provider: settings.ipfsProvider ?? "pinata", apiKey, endpoint: settings.ipfsApiEndpoint }, validated);
      if (!pinResult.ok || !pinResult.cid) throw new Error(pinResult.error ?? "IPFS pin failed");
      setPinStatus(`Pinned: ${pinResult.cid}${pinResult.warning ? " ⚠ local-only" : ""}`);
      if (pinResult.warning) push(pinResult.warning, "warning");

      const metadataHash = cidToBytes32(pinResult.cid);
      const c = contracts.campaigns.connect(signer);
      const tx = await c.setMetadata(BigInt(createdId), metadataHash);
      await confirmTx(tx);

      setMetaTxState("success");
      setMetaTxMsg(`Metadata set! CID: ${pinResult.cid}`);

      // Go to step 3 if reward token was configured, else navigate after delay
      const rToken = rewardToken.trim() && ethers.isAddress(rewardToken.trim()) ? rewardToken.trim() : ethers.ZeroAddress;
      if (rToken !== ethers.ZeroAddress) {
        // Pre-fetch token symbol + decimals — check native asset registry first
        const known = getAssetMetadata(rToken);
        if (known) {
          setTokenSymbol(known.symbol);
          setTokenDecimals(known.decimals);
        } else {
          try {
            const erc20 = new Contract(rToken, ERC20_MINIMAL_ABI, contracts.readProvider);
            const [sym, dec] = await Promise.all([
              erc20.symbol().catch(() => "TOKEN"),
              erc20.decimals().catch(() => 18),
            ]);
            setTokenSymbol(sym);
            setTokenDecimals(Number(dec));
          } catch { /* keep defaults */ }
        }
        setTimeout(() => setStep(3), 1500);
      } else {
        setTimeout(() => navigate(`/advertiser/campaign/${createdId}`), 3000);
      }
    } catch (err) {
      push(humanizeError(err), "error");
      setMetaTxMsg(humanizeError(err));
      setMetaTxState("error");
    }
  }

  async function handleTokenDeposit(e: React.FormEvent) {
    e.preventDefault();
    if (!signer || createdId === null) return;
    const rToken = rewardToken.trim();
    const vaultAddr = settings.contractAddresses.tokenRewardVault;
    if (!ethers.isAddress(rToken) || !vaultAddr) return;

    const rawAmount = BigInt(tokenDepositAmount.trim() || "0");
    if (rawAmount === 0n) { setDepositTxMsg("Enter a deposit amount."); setDepositTxState("error"); return; }

    setDepositTxState("approving");
    setDepositTxMsg("Approving token transfer...");
    try {
      const erc20 = new Contract(rToken, ERC20_MINIMAL_ABI, signer);
      const approveTx = await erc20.approve(vaultAddr, rawAmount);
      await confirmTx(approveTx);

      setDepositTxState("depositing");
      setDepositTxMsg("Depositing token budget...");
      const vault = contracts.tokenRewardVault.connect(signer);
      const depositTx = await vault.depositCampaignBudget(BigInt(createdId), rToken, rawAmount);
      await confirmTx(depositTx);

      setDepositTxState("success");
      setDepositTxMsg(`Deposited ${tokenDepositAmount} raw ${tokenSymbol} units as campaign budget.`);
      setTimeout(() => navigate(`/advertiser/campaign/${createdId}`), 3000);
    } catch (err) {
      push(humanizeError(err), "error");
      setDepositTxMsg(humanizeError(err));
      setDepositTxState("error");
    }
  }

  if (!address) return (
    <div style={{ padding: 20, color: "var(--text-muted)" }}>Connect your wallet to create a campaign.</div>
  );

  return (
    <div className="nano-fade" style={{ maxWidth: 600 }}>
      <div style={{ marginBottom: 20 }}>
        <Link to="/advertiser" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← My Campaigns</Link>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginTop: 8 }}>Create Campaign</h1>
        {/* Wizard step indicator */}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <StepIndicator n={1} label="Campaign" active={step === 1} done={step > 1} />
          <div style={{ color: "var(--text-muted)", alignSelf: "center" }}>→</div>
          <StepIndicator n={2} label="Metadata" active={step === 2} done={step > 2 || metaTxState === "success"} />
          {(rewardToken.trim() && ethers.isAddress(rewardToken.trim())) && (
            <>
              <div style={{ color: "var(--text-muted)", alignSelf: "center" }}>→</div>
              <StepIndicator n={3} label="Token Budget" active={step === 3} done={depositTxState === "success"} />
            </>
          )}
        </div>
      </div>

      {/* Step 2: Inline metadata form */}
      {step === 2 && createdId !== null && (
        <>
          <div className="nano-info nano-info--ok" style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600 }}>Campaign #{createdId} created!</div>
            <div style={{ fontSize: 12, color: "var(--text)", marginTop: 4 }}>
              Now add metadata so governance voters can review your creative.
            </div>
          </div>

          {metaTxState === "success" ? (
            <div className="nano-info nano-info--ok" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600 }}>{metaTxMsg}</div>
              <div style={{ fontSize: 12, marginTop: 4, display: "flex", gap: 8 }}>
                <Link to={`/advertiser/campaign/${createdId}`} className="nano-btn nano-btn-accent" style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}>View Campaign</Link>
                <Link to="/advertiser" className="nano-btn" style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}>Dashboard</Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleMetadataSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {!(settings.ipfsApiKey || settings.pinataApiKey) && settings.ipfsProvider !== "custom" && (
                <div className="nano-info nano-info--warn" style={{ marginBottom: 4, fontSize: 12 }}>
                  No IPFS key configured. <Link to="/settings" style={{ color: "var(--accent)" }}>Add one in Settings</Link> or{" "}
                  <Link to={`/advertiser/campaign/${createdId}/metadata`} style={{ color: "var(--accent)" }}>set metadata later</Link>.
                </div>
              )}
              <WizardField label="Title" maxLen={128}>
                <input value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)} maxLength={128} required className="nano-input" placeholder="e.g. Polkadot Hub — Build the Future" />
              </WizardField>
              <WizardField label="Description" maxLen={256}>
                <textarea value={metaDesc} onChange={(e) => setMetaDesc(e.target.value)} maxLength={256} required rows={2} className="nano-input" style={{ resize: "vertical" }} placeholder="Brief description" />
              </WizardField>
              <WizardField label="Category" maxLen={64}>
                <input value={metaCategory} onChange={(e) => setMetaCategory(e.target.value)} maxLength={64} required className="nano-input" placeholder="e.g. Crypto & Web3" />
              </WizardField>
              <WizardField label="Ad Text" maxLen={512}>
                <textarea value={metaText} onChange={(e) => setMetaText(e.target.value)} maxLength={512} required rows={3} className="nano-input" style={{ resize: "vertical" }} placeholder="Main body text of your ad" />
              </WizardField>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <WizardField label="CTA Button" maxLen={64}>
                  <input value={metaCta} onChange={(e) => setMetaCta(e.target.value)} maxLength={64} required className="nano-input" />
                </WizardField>
                <WizardField label="CTA URL" maxLen={2048}>
                  <input type="url" value={metaCtaUrl} onChange={(e) => setMetaCtaUrl(e.target.value)} maxLength={2048} required className="nano-input" placeholder="https://..." />
                </WizardField>
              </div>
              <WizardField label="Fallback Image URL (optional)">
                <input value={metaImageUrl} onChange={(e) => setMetaImageUrl(e.target.value)} className="nano-input" placeholder="https://... or IPFS CID — used when no per-format image matches" />
              </WizardField>

              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
                  Per-format Images (optional)
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
                  Upload format-specific images to IPFS and paste their URLs here. The browser extension picks the best match for the publisher's ad slot. Images are stored in your IPFS metadata — verifiable on-chain.
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

              {pinStatus && <div style={{ color: "var(--ok)", fontSize: 12 }}>{pinStatus}</div>}
              <TransactionStatus state={metaTxState} message={metaTxMsg} />

              <div style={{ display: "flex", gap: 8 }}>
                <button type="submit" disabled={metaTxState === "pending" || !signer} className="nano-btn nano-btn-accent" style={{ padding: "10px 20px", fontSize: 14, fontWeight: 600, flex: 1 }}>
                  {metaTxState === "pending" ? "Saving..." : "Pin & Set Metadata"}
                </button>
                <Link to={`/advertiser/campaign/${createdId}`} className="nano-btn" style={{ padding: "10px 16px", fontSize: 13, textDecoration: "none" }}>
                  Skip
                </Link>
              </div>
            </form>
          )}
        </>
      )}

      {/* Step 3: Token budget deposit */}
      {step === 3 && createdId !== null && (
        <>
          <div className="nano-info nano-info--ok" style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600 }}>Metadata set for Campaign #{createdId}!</div>
            <div style={{ fontSize: 12, color: "var(--text)", marginTop: 4 }}>
              Your campaign is configured with <strong>{tokenSymbol}</strong> rewards. Deposit the token budget so users can earn rewards on each impression.
            </div>
          </div>

          {depositTxState === "success" ? (
            <div className="nano-info nano-info--ok">
              <div style={{ fontWeight: 600 }}>{depositTxMsg}</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                Redirecting to campaign...
              </div>
            </div>
          ) : (
            <form onSubmit={handleTokenDeposit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="nano-card" style={{ padding: 14 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Token</div>
                <div style={{ color: "var(--text-strong)", fontSize: 13, fontFamily: "var(--font-mono)" }}>{rewardToken.trim()}</div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
                  {tokenSymbol} · {tokenDecimals} decimals · {Number(rewardPerImpression || 0).toLocaleString()} raw units per impression
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>
                  Deposit Amount (raw {tokenSymbol} units)
                </label>
                <input
                  type="text"
                  value={tokenDepositAmount}
                  onChange={(e) => setTokenDepositAmount(e.target.value)}
                  placeholder={`e.g. ${(1000 * Math.pow(10, tokenDecimals)).toLocaleString()}`}
                  className="nano-input"
                  required
                />
                <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  Enter the amount in smallest token units (multiply by 10^{tokenDecimals} for whole tokens).
                  This flow will first approve the vault to spend your tokens, then deposit.
                </div>
              </div>

              <div style={{ background: "var(--surface2)", borderRadius: 6, padding: 10, fontSize: 11, color: "var(--text-muted)" }}>
                <strong style={{ color: "var(--text)" }}>Two-transaction flow:</strong>
                <ol style={{ margin: "4px 0 0 16px", padding: 0, lineHeight: 1.6 }}>
                  <li>Approve {tokenSymbol} transfer to the TokenRewardVault</li>
                  <li>Deposit budget into the vault for campaign #{createdId}</li>
                </ol>
              </div>

              <TransactionStatus
                state={((s: string): "idle" | "pending" | "success" | "error" => s === "approving" || s === "depositing" ? "pending" : s === "success" ? "success" : s === "error" ? "error" : "idle")(depositTxState)}
                message={depositTxMsg}
              />

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="submit"
                  disabled={depositTxState === "approving" || depositTxState === "depositing" || !signer}
                  className="nano-btn nano-btn-accent"
                  style={{ padding: "10px 20px", fontSize: 14, fontWeight: 600, flex: 1 }}
                >
                  {depositTxState === "approving" ? "Approving..." : depositTxState === "depositing" ? "Depositing..." : "Approve & Deposit"}
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/advertiser/campaign/${createdId}`)}
                  className="nano-btn"
                  style={{ padding: "10px 16px", fontSize: 13 }}
                >
                  Skip
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {step === 1 && txState !== "success" && (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Campaign type */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Campaign Type</label>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" onClick={() => setIsOpen(true)} className={isOpen ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "8px 14px", fontSize: 13 }}>
                Open (any publisher)
              </button>
              <button type="button" onClick={() => setIsOpen(false)} className={!isOpen ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "8px 14px", fontSize: 13 }}>
                Targeted (specific publisher)
              </button>
            </div>
          </div>

          {/* Publisher picker */}
          {!isOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Publisher</label>
              {pubListLoading && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading publishers...</div>}
              {!pubListLoading && pubOptions.length > 0 && (
                <>
                  <input
                    type="text"
                    value={pubSearch}
                    onChange={(e) => setPubSearch(e.target.value)}
                    placeholder="Search by address or tag..."
                    className="nano-input"
                    style={{ fontSize: 12 }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 4 }}>
                    {pubOptions
                      .filter((p) => {
                        const q = pubSearch.toLowerCase();
                        return !q || p.address.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q));
                      })
                      .map((p) => {
                        const selected = publisher === p.address;
                        return (
                          <div
                            key={p.address}
                            onClick={() => { setPublisher(p.address); checkPublisher(p.address); }}
                            style={{
                              padding: "8px 10px", borderRadius: 5, cursor: "pointer",
                              background: selected ? "var(--accent-muted, rgba(99,102,241,0.12))" : "var(--bg)",
                              border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-strong)" }}>
                                {p.address.slice(0, 8)}…{p.address.slice(-6)}
                              </span>
                              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Take: {(p.takeRateBps / 100).toFixed(0)}%</span>
                                {p.repScore !== null && (
                                  <span style={{ fontSize: 11, fontWeight: 600, color: p.repScore >= 9000 ? "var(--ok)" : p.repScore >= 7000 ? "var(--warn)" : "var(--error)" }}>
                                    Rep: {(p.repScore / 100).toFixed(1)}%
                                  </span>
                                )}
                                {p.reportCount > 0 && (
                                  <span title={`${p.reportCount} community report${p.reportCount !== 1 ? "s" : ""}`} style={{ fontSize: 10, fontWeight: 700, color: "var(--warn)" }}>⚑ {p.reportCount}</span>
                                )}
                              </div>
                            </div>
                            {p.tags.length > 0 && (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                                {p.tags.map((t, i) => <span key={i} className="nano-badge" style={{ fontSize: 10 }}>{t}</span>)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    {pubOptions.filter((p) => {
                      const q = pubSearch.toLowerCase();
                      return !q || p.address.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q));
                    }).length === 0 && (
                      <div style={{ padding: 12, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>No publishers match.</div>
                    )}
                  </div>
                </>
              )}
              {/* Fallback / manual entry */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Or enter address manually:</label>
                <input
                  type="text"
                  value={publisher}
                  onChange={(e) => { setPublisher(e.target.value); checkPublisher(e.target.value); }}
                  placeholder="0x..."
                  className="nano-input"
                  required
                />
              </div>
              {pubChecking && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Checking...</div>}
              {!pubChecking && pubCheck && (
                <div style={{ fontSize: 12, color: pubCheck.startsWith("Registered") ? "var(--ok)" : "var(--error)" }}>
                  {pubCheck}
                </div>
              )}
            </div>
          )}

          {/* View Pot (CPM) — always required */}
          <div style={{ padding: "12px 14px", background: "var(--surface2)", borderRadius: 8, border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ color: "var(--text-strong)", fontSize: 13, fontWeight: 600 }}>View Pot — CPM (required)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Budget ({sym})</label>
                <input type="number" value={viewBudget} onChange={(e) => setViewBudget(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Daily Cap ({sym})</label>
                <input type="number" value={viewDailyCap} onChange={(e) => setViewDailyCap(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Rate/1k views ({sym})</label>
                <input type="number" value={viewBidCpm} onChange={(e) => setViewBidCpm(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
              </div>
            </div>
            {Number(viewDailyCap) > Number(viewBudget) && (
              <div style={{ fontSize: 11, color: "var(--warn)" }}>Daily cap exceeds budget — contract will reject this.</div>
            )}
          </div>

          {/* Click Pot (CPC) — optional */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={enableClick} onChange={(e) => setEnableClick(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
              <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Enable Click Pot — CPC (optional)</span>
            </label>
            {enableClick && (
              <div style={{ padding: "12px 14px", background: "var(--surface2)", borderRadius: 8, border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Budget ({sym})</label>
                    <input type="number" value={clickBudget} onChange={(e) => setClickBudget(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Daily Cap ({sym})</label>
                    <input type="number" value={clickDailyCap} onChange={(e) => setClickDailyCap(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Rate/click ({sym})</label>
                    <input type="number" value={clickRate} onChange={(e) => setClickRate(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
                  </div>
                </div>
                {Number(clickDailyCap) > Number(clickBudget) && (
                  <div style={{ fontSize: 11, color: "var(--warn)" }}>Daily cap exceeds budget — contract will reject this.</div>
                )}
              </div>
            )}
          </div>

          {/* Action Pot (CPA) — optional, requires verifier address */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={enableAction} onChange={(e) => setEnableAction(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
              <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Enable Action Pot — CPA (optional)</span>
            </label>
            {enableAction && (
              <div style={{ padding: "12px 14px", background: "var(--surface2)", borderRadius: 8, border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Budget ({sym})</label>
                    <input type="number" value={actionBudget} onChange={(e) => setActionBudget(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Daily Cap ({sym})</label>
                    <input type="number" value={actionDailyCap} onChange={(e) => setActionDailyCap(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Rate/action ({sym})</label>
                    <input type="number" value={actionRate} onChange={(e) => setActionRate(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <label style={{ color: "var(--text-muted)", fontSize: 11 }}>Action Verifier Address (0x...)</label>
                  <input type="text" value={actionVerifier} onChange={(e) => setActionVerifier(e.target.value)} placeholder="0x... contract that verifies the action occurred" className="nano-input" required />
                </div>
                {Number(actionDailyCap) > Number(actionBudget) && (
                  <div style={{ fontSize: 11, color: "var(--warn)" }}>Daily cap exceeds budget — contract will reject this.</div>
                )}
              </div>
            )}
          </div>

          {/* Total budget summary */}
          <div style={{ display: "flex", justifyContent: "flex-end", fontSize: 12, color: "var(--text-muted)" }}>
            Total escrowed: <strong style={{ color: "var(--text-strong)", marginLeft: 4 }}>
              {(Number(viewBudget || 0) + (enableClick ? Number(clickBudget || 0) : 0) + (enableAction ? Number(actionBudget || 0) : 0)).toFixed(4)} {sym}
            </strong>
            {bondAmount && Number(bondAmount) > 0 && (
              <span style={{ marginLeft: 4 }}>+ {Number(bondAmount).toFixed(4)} {sym} bond</span>
            )}
          </div>

          {/* Tag-based targeting */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Targeting Tags</label>
              <button type="button" onClick={() => setShowTags(!showTags)} style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 12, cursor: "pointer", padding: 0 }}>
                {showTags ? "▼ Hide" : "▶ Configure"}
              </button>
              {selectedTags.size > 0 && (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{selectedTags.size} tag{selectedTags.size !== 1 ? "s" : ""} selected</span>
              )}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
              Publishers must declare all selected tags to serve your ad. Leave empty for maximum reach.
            </div>
            {selectedTags.size > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
                {[...selectedTags].map((tag) => (
                  <span key={tag} className="nano-badge" style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {tagDisplayLabel(tag)}
                    <button type="button" onClick={() => { const s = new Set(selectedTags); s.delete(tag); setSelectedTags(s); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}>×</button>
                  </span>
                ))}
              </div>
            )}
            {showTags && (
              <div className="nano-card" style={{ padding: 10, marginTop: 4 }}>
                <input
                  type="text"
                  value={tagSearch}
                  onChange={(e) => setTagSearch(e.target.value)}
                  placeholder="Search tags..."
                  className="nano-input"
                  style={{ marginBottom: 8, fontSize: 12 }}
                />
                <div style={{ maxHeight: 200, overflow: "auto" }}>
                  {Object.entries(TAG_DICTIONARY).map(([dimension, tags]) => {
                    const filtered = tags.filter((t) => {
                      if (!tagSearch) return true;
                      const label = (TAG_LABELS[t] ?? t).toLowerCase();
                      return label.includes(tagSearch.toLowerCase()) || t.includes(tagSearch.toLowerCase());
                    });
                    if (filtered.length === 0) return null;
                    return (
                      <div key={dimension} style={{ marginBottom: 8 }}>
                        <div style={{ color: "var(--accent)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{dimension}</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {filtered.map((tag) => {
                            const active = selectedTags.has(tag);
                            return (
                              <button key={tag} type="button" onClick={() => {
                                const s = new Set(selectedTags);
                                if (active) s.delete(tag); else if (s.size < 8) s.add(tag);
                                setSelectedTags(s);
                              }} className={active ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "3px 8px", fontSize: 11 }}>
                                {TAG_LABELS[tag] ?? tag}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Custom tag input */}
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <input
                    type="text"
                    value={customTag}
                    onChange={(e) => { setCustomTag(e.target.value); setCustomTagError(null); }}
                    placeholder="Custom: dimension:value"
                    className="nano-input"
                    style={{ flex: 1, fontSize: 11 }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const tag = validateCustomTag(customTag);
                      if (!tag) { setCustomTagError("Format: dimension:value"); return; }
                      if (selectedTags.size >= 8) { setCustomTagError("Max 8 tags"); return; }
                      const s = new Set(selectedTags);
                      s.add(tag);
                      setSelectedTags(s);
                      setCustomTag("");
                      setCustomTagError(null);
                    }}
                    className="nano-btn nano-btn-accent"
                    style={{ padding: "3px 8px", fontSize: 11, whiteSpace: "nowrap" }}
                  >
                    + Add
                  </button>
                </div>
                {customTagError && <div style={{ color: "var(--error)", fontSize: 10, marginTop: 2 }}>{customTagError}</div>}
                <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 4 }}>
                  Max 8 tags. Publishers must declare all selected tags to serve your ad.
                </div>
              </div>
            )}
          </div>

          {/* ZK proof requirement */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", background: "var(--surface2)", borderRadius: 6, border: requireZkProof ? "1px solid var(--accent)" : "1px solid transparent" }}>
            <input
              type="checkbox"
              id="requireZkProof"
              checked={requireZkProof}
              onChange={(e) => setRequireZkProof(e.target.checked)}
              style={{ marginTop: 2, cursor: "pointer", accentColor: "var(--accent)" }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <label htmlFor="requireZkProof" style={{ color: "var(--text)", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
                Require ZK proof of impression
              </label>
              <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                When enabled, impressions must include a zero-knowledge proof that the user genuinely saw the ad and the second-price clearing was computed honestly. Stronger fraud guarantee; slightly higher settlement overhead.
              </div>
            </div>
          </div>

          {/* Challenge bond (optional — FP-2) */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Challenge Bond (optional, {sym})</label>
            <input
              type="number"
              value={bondAmount}
              onChange={(e) => setBondAmount(e.target.value)}
              min="0"
              step="0.001"
              className="nano-input"
              placeholder="e.g. 1.0 — leave empty to skip"
            />
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
              Lock {sym} alongside your campaign as a fraud challenge bond. Returned automatically if the campaign ends cleanly.
              If a publisher fraud governance proposal is upheld, you receive a proportional share of the publisher's slashed stake.
              Optional — campaigns without a bond still receive base DOT settlement.
            </div>
          </div>

          {/* Token reward (optional — native Asset Hub token or ERC-20) */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Token Reward (optional)</label>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>
              Reward users with a token per impression, in addition to DOT settlement.
              You'll deposit the token budget after campaign creation.
            </div>

            {/* Source toggle */}
            <div style={{ display: "flex", gap: 8, marginBottom: 2 }}>
              <button type="button" onClick={() => { setTokenSource("native"); setRewardToken(""); setSelectedNativeAsset(null); setCustomAssetId(""); }} className={tokenSource === "native" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "6px 12px", fontSize: 12 }}>
                Asset Hub Token
              </button>
              <button type="button" onClick={() => { setTokenSource("erc20"); setSelectedNativeAsset(null); setRewardToken(""); setCustomAssetId(""); }} className={tokenSource === "erc20" ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "6px 12px", fontSize: 12 }}>
                ERC-20 Contract
              </button>
            </div>

            {tokenSource === "native" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {/* Quick-pick popular tokens */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {KNOWN_ASSETS.filter((a) => a.popular).map((a) => {
                    const active = selectedNativeAsset?.address === a.address;
                    return (
                      <button key={`${a.network}-${a.assetId}`} type="button" onClick={() => { setSelectedNativeAsset(a); setRewardToken(a.address); setCustomAssetId(""); }} className={active ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "5px 10px", fontSize: 12, fontWeight: 600 }}>
                        {a.symbol}
                      </button>
                    );
                  })}
                </div>

                {/* Search input */}
                <input
                  type="text"
                  value={customAssetId}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCustomAssetId(v);
                    // If they typed a pure number, try asset ID lookup
                    const asNum = Number(v);
                    if (v && Number.isInteger(asNum) && asNum > 0) {
                      // Match trust-backed first; if not found, default to trust-backed precompile
                      const match = KNOWN_ASSETS.find((a) => a.assetId === asNum && a.type === 'trust-backed') ?? KNOWN_ASSETS.find((a) => a.assetId === asNum);
                      if (match) { setSelectedNativeAsset(match); setRewardToken(match.address); }
                      else { setSelectedNativeAsset(null); setRewardToken(assetIdToAddress(asNum)); }
                    } else if (!v) {
                      // cleared
                      if (!selectedNativeAsset) setRewardToken("");
                    }
                  }}
                  placeholder="Search by ticker, name, or asset ID..."
                  className="nano-input"
                  style={{ fontSize: 12 }}
                />

                {/* Search results dropdown */}
                {customAssetId.trim() && (() => {
                  const results = searchAssets(customAssetId);
                  if (results.length === 0) return null;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 180, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 4 }}>
                      {results.map((a) => {
                        const active = selectedNativeAsset?.assetId === a.assetId;
                        return (
                          <div key={`${a.network}-${a.assetId}`} onClick={() => { setSelectedNativeAsset(a); setRewardToken(a.address); setCustomAssetId(""); }} style={{ padding: "6px 10px", borderRadius: 4, cursor: "pointer", background: active ? "var(--accent-muted, rgba(99,102,241,0.12))" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <span style={{ fontWeight: 600, fontSize: 12, color: "var(--text-strong)" }}>{a.symbol}</span>
                              <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 6 }}>{a.name}</span>
                              <span style={{ fontSize: 10, color: a.network === 'kusama' ? "var(--text-muted)" : "var(--text-muted)", marginLeft: 6, opacity: 0.6 }}>{a.network === 'kusama' ? 'KSM' : 'DOT'}</span>
                            </div>
                            <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>ID {a.assetId} · {a.decimals}d</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* Selected asset summary */}
                {selectedNativeAsset && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--surface2)", borderRadius: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text-strong)" }}>{selectedNativeAsset.symbol}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{selectedNativeAsset.name}</span>
                    <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto", fontFamily: "var(--font-mono)" }}>
                      {selectedNativeAsset.decimals} decimals · ID {selectedNativeAsset.assetId}
                    </span>
                    <button type="button" onClick={() => { setSelectedNativeAsset(null); setRewardToken(""); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
                  </div>
                )}

                {/* Derived address (collapsed) */}
                {rewardToken && !selectedNativeAsset && (
                  <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                    Precompile: {rewardToken}
                  </div>
                )}
              </div>
            )}

            {tokenSource === "erc20" && (
              <input
                type="text"
                value={rewardToken}
                onChange={(e) => setRewardToken(e.target.value)}
                placeholder="ERC-20 token address (0x...)"
                className="nano-input"
              />
            )}

            {rewardToken.trim() && ethers.isAddress(rewardToken.trim()) && (
              <input
                type="text"
                value={rewardPerImpression}
                onChange={(e) => setRewardPerImpression(e.target.value)}
                placeholder={`Token amount per impression (smallest unit${selectedNativeAsset ? ` — ${selectedNativeAsset.decimals} decimals for ${selectedNativeAsset.symbol}` : ""})`}
                className="nano-input"
                style={{ marginTop: 4 }}
              />
            )}
          </div>

          <TransactionStatus state={txState} message={txMsg} />

          <button type="submit" disabled={txState === "pending" || !signer} className="nano-btn nano-btn-accent" style={{ padding: "10px 20px", fontSize: 14, fontWeight: 600 }}>
            {txState === "pending" ? "Creating..." : `Create Campaign (${(Number(viewBudget || 0) + (enableClick ? Number(clickBudget || 0) : 0) + (enableAction ? Number(actionBudget || 0) : 0)).toFixed(4)} ${sym})`}
          </button>
        </form>
      )}
    </div>
  );
}

function StepIndicator({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: active || done ? 1 : 0.4 }}>
      <span style={{
        width: 22, height: 22, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: 11, fontWeight: 700,
        background: done ? "rgba(74,222,128,0.12)" : active ? "rgba(255,255,255,0.06)" : "var(--bg-raised)",
        border: `1px solid ${done ? "rgba(74,222,128,0.3)" : active ? "rgba(255,255,255,0.18)" : "var(--border)"}`,
        color: done ? "var(--ok)" : active ? "var(--accent)" : "var(--text-muted)",
      }}>
        {done ? "✓" : n}
      </span>
      <span style={{ fontSize: 12, color: active ? "var(--text-strong)" : "var(--text-muted)", fontWeight: active ? 600 : 400 }}>{label}</span>
    </div>
  );
}

function WizardField({ label, maxLen, children }: { label: string; maxLen?: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <label style={{ color: "var(--text)", fontSize: 12 }}>
        {label}{maxLen ? <span style={{ color: "var(--text-muted)", fontSize: 10 }}> ({maxLen})</span> : ""}
      </label>
      {children}
    </div>
  );
}
