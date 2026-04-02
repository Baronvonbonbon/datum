import { useState, useEffect } from "react";
import { JsonRpcProvider, Contract, isAddress } from "ethers";
import { StoredSettings, NetworkName, ContractAddresses, UserPreferences } from "@shared/types";
import { NETWORK_CONFIGS, DEFAULT_SETTINGS, getCurrencySymbol } from "@shared/networks";
import { unlock, isConfigured, getSigner } from "@shared/walletManager";
import { testPinataKey } from "@shared/ipfsPin";
import DatumCampaignsAbi from "@shared/abis/DatumCampaigns.json";
import { TAG_DICTIONARY, TAG_LABELS, tagHash, ALL_TAGS, tagDisplayLabel, validateCustomTag } from "@shared/tagDictionary";
import { getTargetingRegistryContract, getProvider } from "@shared/contracts";
import { getBlockedAddresses, addBlockedAddress, removeBlockedAddress } from "@shared/phishingList";

interface InterestProfileData {
  weights: Record<string, number>;
  visitCounts: Record<string, number>;
}

export function Settings({ address }: { address: string | null }) {
  const [settings, setSettings] = useState<StoredSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetProfileConfirm, setResetProfileConfirm] = useState(false);
  const [interestProfile, setInterestProfile] = useState<InterestProfileData | null>(null);
  const [autoSubmitPassword, setAutoSubmitPassword] = useState("");
  const [autoSubmitKeySet, setAutoSubmitKeySet] = useState(false);
  const [autoSubmitError, setAutoSubmitError] = useState<string | null>(null);
  // XM-14: SW restart deauth notice
  const [autoSubmitDeauthNotice, setAutoSubmitDeauthNotice] = useState(false);
  const [rpcWarning, setRpcWarning] = useState<string | null>(null);
  const [pinataTestResult, setPinataTestResult] = useState<string | null>(null);
  // SI-1: RPC connectivity test
  const [rpcTestResult, setRpcTestResult] = useState<{ ok: boolean; blockNumber?: number; latencyMs?: number; error?: string } | null>(null);
  const [rpcTesting, setRpcTesting] = useState(false);
  // SI-2: Network/contract mismatch warning
  const [contractWarning, setContractWarning] = useState<string | null>(null);
  // SI-3: Contract address hex/checksum validation
  const [addressErrors, setAddressErrors] = useState<Record<string, string>>({});

  // User preferences
  const [prefs, setPrefs] = useState<UserPreferences>({
    blockedCampaigns: [],
    silencedCategories: [],
    blockedTags: [],
    maxAdsPerHour: 12,
    minBidCpm: "0",
  });
  const [blockTagSearch, setBlockTagSearch] = useState("");
  const [customBlockTag, setCustomBlockTag] = useState("");
  const [customBlockTagError, setCustomBlockTagError] = useState<string | null>(null);
  const [prefsSaved, setPrefsSaved] = useState(false);

  useEffect(() => {
    chrome.storage.local.get("settings", (stored) => {
      if (stored.settings) setSettings(stored.settings);
    });
    // Check auto-submit authorization via background (B1: encrypted)
    chrome.runtime.sendMessage({ type: "CHECK_AUTO_SUBMIT" }).then((resp) => {
      if (resp?.authorized) setAutoSubmitKeySet(true);
    });
    // XM-14: Check if SW restarted and deauthorized auto-submit
    chrome.storage.local.get("autoSubmitDeauthNotice").then((stored) => {
      if (stored.autoSubmitDeauthNotice) {
        setAutoSubmitDeauthNotice(true);
        chrome.storage.local.remove("autoSubmitDeauthNotice");
      }
    });
    loadInterestProfile();
    loadPreferences();
    // UP-2: Load blocked addresses
    getBlockedAddresses().then(setBlockedAddresses);
    // UB-4: Load ads-this-hour count
    chrome.runtime.sendMessage({ type: "GET_AD_RATE" }).then((resp) => {
      if (resp?.count !== undefined) setAdsThisHour(resp.count);
    });
    // UB-8: Check if phishing list is stale
    chrome.storage.local.get("phishingListStale").then((stored) => {
      setPhishingListStale(!!stored.phishingListStale);
    });
    // UB-6: Check metadata fetch failure count
    chrome.storage.local.get("metadataFetchFailures").then((stored) => {
      setMetadataFetchFailures((stored.metadataFetchFailures as number) ?? 0);
    });
  }, []);

  async function loadPreferences() {
    const response = await chrome.runtime.sendMessage({ type: "GET_USER_PREFERENCES" });
    if (response?.preferences) setPrefs(response.preferences);
  }

  async function savePreferences() {
    await chrome.runtime.sendMessage({ type: "UPDATE_USER_PREFERENCES", preferences: prefs });
    setPrefsSaved(true);
    setTimeout(() => setPrefsSaved(false), 2000);
  }

  async function loadInterestProfile() {
    const response = await chrome.runtime.sendMessage({ type: "GET_INTEREST_PROFILE" });
    if (response?.profile) {
      setInterestProfile({
        weights: response.profile.weights ?? {},
        visitCounts: response.profile.visitCounts ?? {},
      });
    }
  }

  async function resetInterestProfile() {
    await chrome.runtime.sendMessage({ type: "RESET_INTEREST_PROFILE" });
    setInterestProfile(null);
    setResetProfileConfirm(false);
  }

  // SI-1: Test RPC connectivity
  async function testRpcConnection() {
    setRpcTesting(true);
    setRpcTestResult(null);
    setContractWarning(null);
    const start = Date.now();
    try {
      const provider = new JsonRpcProvider(settings.rpcUrl);
      const block = await provider.getBlock("latest");
      const latencyMs = Date.now() - start;
      setRpcTestResult({ ok: true, blockNumber: block?.number ?? 0, latencyMs });

      // SI-2: Check if campaigns contract is deployed at configured address
      if (settings.contractAddresses.campaigns) {
        try {
          const code = await provider.getCode(settings.contractAddresses.campaigns);
          if (!code || code === "0x") {
            setContractWarning("Campaigns contract not found at configured address. Check network and contract addresses match.");
          } else {
            // Try calling nextCampaignId to verify it's the right contract
            const contract = new Contract(settings.contractAddresses.campaigns, DatumCampaignsAbi.abi, provider);
            await contract.nextCampaignId();
            setContractWarning(null);
          }
        } catch {
          setContractWarning("Contract at configured address does not respond as DatumCampaigns. Network/address mismatch?");
        }
      }
    } catch (err) {
      setRpcTestResult({ ok: false, error: String(err).slice(0, 120) });
    } finally {
      setRpcTesting(false);
    }
  }

  async function save() {
    // H4: Warn on non-HTTPS RPC URL for non-local networks
    if (settings.network !== "local" && settings.rpcUrl.startsWith("http://")) {
      setRpcWarning("Warning: Using unencrypted HTTP for a production network. Traffic is visible to intermediaries. Consider using HTTPS.");
    } else {
      setRpcWarning(null);
    }
    await chrome.storage.local.set({ settings });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    chrome.runtime.sendMessage({ type: "SETTINGS_UPDATED", settings });
  }

  function handleNetworkChange(network: NetworkName) {
    const config = NETWORK_CONFIGS[network];
    setSettings((s) => ({
      ...s,
      network,
      rpcUrl: config.rpcUrl,
      contractAddresses: config.addresses,
    }));
    setAddressErrors({}); // SI-3: Clear validation errors on network switch
  }

  function handleAddressChange(key: keyof ContractAddresses, value: string) {
    setSettings((s) => ({
      ...s,
      contractAddresses: { ...s.contractAddresses, [key]: value },
    }));
    // SI-3: Validate hex/checksum
    setAddressErrors((prev) => {
      const next = { ...prev };
      if (value && !isAddress(value)) {
        next[key] = "Invalid address — must be a valid hex or checksummed address";
      } else {
        delete next[key];
      }
      return next;
    });
  }

  async function clearQueue() {
    await chrome.runtime.sendMessage({ type: "CLEAR_QUEUE" });
    setClearConfirm(false);
  }

  async function resetChainState() {
    await chrome.runtime.sendMessage({ type: "RESET_CHAIN_STATE" });
    setResetConfirm(false);
  }

  const [profileExpanded, setProfileExpanded] = useState(false);

  // TX-6: Publisher tag management
  const [publisherTagsExpanded, setPublisherTagsExpanded] = useState(false);
  const [currentTags, setCurrentTags] = useState<Set<string>>(new Set());
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagsSaving, setTagsSaving] = useState(false);
  const [tagsResult, setTagsResult] = useState<string | null>(null);
  const [tagSearch, setTagSearch] = useState("");

  // UP-2: Address blocklist management
  const [blocklistExpanded, setBlocklistExpanded] = useState(false);
  const [blockedAddresses, setBlockedAddresses] = useState<string[]>([]);
  const [newBlockAddr, setNewBlockAddr] = useState("");
  const [blockAddrError, setBlockAddrError] = useState<string | null>(null);

  // UB-4: Ads-per-hour counter
  const [adsThisHour, setAdsThisHour] = useState<number | null>(null);
  // UB-8: Stale phishing list warning
  const [phishingListStale, setPhishingListStale] = useState(false);
  // UB-6: Metadata fetch failure notification
  const [metadataFetchFailures, setMetadataFetchFailures] = useState(0);

  // TX-6: Load publisher tags from on-chain TargetingRegistry
  async function loadPublisherTags() {
    const pubAddr = settings.publisherAddress || address;
    if (!pubAddr || !settings.contractAddresses.targetingRegistry) return;
    setTagsLoading(true);
    setTagsResult(null);
    try {
      const provider = getProvider(settings.rpcUrl);
      const contract = getTargetingRegistryContract(settings.contractAddresses, provider);
      const hashes: string[] = await contract.getTags(pubAddr);
      const matched = new Set<string>();
      for (const tag of ALL_TAGS) {
        const h = tagHash(tag);
        if (hashes.some((ch: string) => ch.toLowerCase() === h.toLowerCase())) {
          matched.add(tag);
        }
      }
      setCurrentTags(matched);
    } catch (err) {
      setTagsResult("Failed to load: " + String(err).slice(0, 80));
    } finally {
      setTagsLoading(false);
    }
  }

  // TX-6: Save tags on-chain
  async function saveTags() {
    if (!address) { setTagsResult("No wallet connected"); return; }
    setTagsSaving(true);
    setTagsResult(null);
    try {
      const signer = await getSigner(null);
      const contract = getTargetingRegistryContract(settings.contractAddresses, signer);
      const hashes = Array.from(currentTags).map(tagHash);
      const tx = await contract.setTags(hashes);
      await tx.wait();
      setTagsResult("Tags saved on-chain.");
    } catch (err) {
      setTagsResult("Error: " + String(err).slice(0, 100));
    } finally {
      setTagsSaving(false);
    }
  }

  // UP-2: Add address to blocklist
  async function handleAddBlock() {
    const addr = newBlockAddr.trim();
    if (!isAddress(addr)) { setBlockAddrError("Invalid address"); return; }
    setBlockAddrError(null);
    await addBlockedAddress(addr);
    setBlockedAddresses(await getBlockedAddresses());
    setNewBlockAddr("");
  }

  // UP-2: Remove address from blocklist
  async function handleRemoveBlock(addr: string) {
    await removeBlockedAddress(addr);
    setBlockedAddresses(await getBlockedAddresses());
  }

  function toggleBlockTag(tag: string) {
    setPrefs((p) => {
      const blocked = p.blockedTags ?? [];
      return {
        ...p,
        blockedTags: blocked.includes(tag)
          ? blocked.filter((t) => t !== tag)
          : [...blocked, tag],
      };
    });
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: "var(--accent)", fontWeight: 600 }}>Settings</span>
      </div>

      {/* UB-8: Stale phishing list warning */}
      {phishingListStale && (
        <div style={{ padding: "6px 10px", marginBottom: 10, background: "rgba(252,211,77,0.07)", border: "1px solid rgba(252,211,77,0.2)", borderRadius: "var(--radius-sm)" }}>
          <div style={{ color: "var(--warn)", fontSize: 11 }}>
            Phishing protection list is stale (&gt;24h old). Check your network connection.
          </div>
        </div>
      )}

      {/* UB-6: Metadata fetch failure warning */}
      {metadataFetchFailures >= 3 && (
        <div style={{ padding: "6px 10px", marginBottom: 10, background: "rgba(252,211,77,0.07)", border: "1px solid rgba(252,211,77,0.2)", borderRadius: "var(--radius-sm)" }}>
          <div style={{ color: "var(--warn)", fontSize: 11 }}>
            Ad metadata failed to load {metadataFetchFailures}x in a row. Check IPFS gateway settings.
          </div>
        </div>
      )}

      {/* Wallet address (read-only, selectable) */}
      {address && (
        <div style={sectionStyle}>
          <label style={labelStyle}>Your Address</label>
          <input
            type="text"
            value={address}
            readOnly
            onFocus={(e) => e.target.select()}
            style={{ ...inputStyle, fontFamily: "monospace", fontSize: 11, color: "#aaa", cursor: "text" }}
          />
        </div>
      )}

      {/* Network */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Network</label>
        <select
          value={settings.network}
          onChange={(e) => handleNetworkChange(e.target.value as NetworkName)}
          style={selectStyle}
        >
          <option value="local">Local (dev)</option>
          <option value="polkadotTestnet">Paseo</option>
          <option value="westend">Westend Asset Hub</option>
          <option value="kusama">Kusama Asset Hub</option>
          <option value="polkadotHub">Polkadot Hub</option>
        </select>
      </div>

      {/* RPC URL */}
      <div style={sectionStyle}>
        <label style={labelStyle}>RPC URL</label>
        <input
          type="text"
          value={settings.rpcUrl}
          onChange={(e) => {
            setSettings((s) => ({ ...s, rpcUrl: e.target.value }));
            setRpcWarning(null);
          }}
          style={inputStyle}
          placeholder="http://localhost:8545"
        />
        {rpcWarning && (
          <div style={{ color: "var(--warn)", fontSize: 11, marginTop: 4 }}>{rpcWarning}</div>
        )}
        {/* SI-1: RPC connectivity test */}
        <div style={{ marginTop: 4 }}>
          <button
            onClick={testRpcConnection}
            disabled={rpcTesting}
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--accent)", fontSize: 10, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}
          >
            {rpcTesting ? "Testing..." : "Test Connection"}
          </button>
          {rpcTestResult && (
            <span style={{ fontSize: 10, marginLeft: 6, color: rpcTestResult.ok ? "var(--ok)" : "var(--error)" }}>
              {rpcTestResult.ok
                ? `Connected — block #${rpcTestResult.blockNumber} (${rpcTestResult.latencyMs}ms)`
                : `Failed: ${rpcTestResult.error}`}
            </span>
          )}
        </div>
        {/* SI-2: Network/contract mismatch warning */}
        {contractWarning && (
          <div style={{ color: "var(--warn)", fontSize: 11, marginTop: 4, padding: "4px 8px", background: "rgba(252,211,77,0.07)", border: "1px solid rgba(252,211,77,0.2)", borderRadius: "var(--radius-sm)" }}>
            {contractWarning}
          </div>
        )}
      </div>

      {/* Contract addresses */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={labelStyle}>Contract Addresses</div>
          <button
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--accent)", fontSize: 10, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}
            onClick={async () => {
              try {
                const url = chrome.runtime.getURL("deployed-addresses.json");
                const resp = await fetch(url);
                if (!resp.ok) throw new Error("No deployed-addresses.json found in extension bundle");
                const addrs = await resp.json();
                // Validate network matches current setting
                if (addrs.network && addrs.network !== "hardhat" && addrs.network !== settings.network) {
                  const ok = confirm(`Deployed addresses are from "${addrs.network}" but current network is "${settings.network}". Load anyway?`);
                  if (!ok) return;
                }
                setSettings((s) => ({
                  ...s,
                  contractAddresses: {
                    campaigns: addrs.campaigns ?? "",
                    publishers: addrs.publishers ?? "",
                    governanceV2: addrs.governanceV2 ?? "",
                    governanceSlash: addrs.governanceSlash ?? "",
                    settlement: addrs.settlement ?? "",
                    relay: addrs.relay ?? "",
                    pauseRegistry: addrs.pauseRegistry ?? "",
                    timelock: addrs.timelock ?? "",
                    zkVerifier: addrs.zkVerifier ?? "",
                    paymentVault: addrs.paymentVault ?? "",
                    budgetLedger: addrs.budgetLedger ?? "",
                    lifecycle: addrs.lifecycle ?? "",
                    attestationVerifier: addrs.attestationVerifier ?? "",
                  },
                }));
                // SI-3: Clear validation errors for loaded addresses
                setAddressErrors({});
              } catch (err) {
                alert("Could not load deployed addresses. Run deploy.ts first, then rebuild the extension.");
              }
            }}
          >
            Load Deployed
          </button>
        </div>
        {(Object.keys(settings.contractAddresses) as (keyof ContractAddresses)[]).map((key) => (
          <div key={key} style={{ marginBottom: 6 }}>
            <label style={{ ...labelStyle, fontSize: 11, color: "#555", fontFamily: "monospace" }}>
              {key}
            </label>
            <input
              type="text"
              value={settings.contractAddresses[key]}
              onChange={(e) => handleAddressChange(key, e.target.value)}
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: 11, ...(addressErrors[key] ? { borderColor: "#ff8080" } : {}) }}
              placeholder="0x..."
            />
            {addressErrors[key] && (
              <div style={{ color: "var(--error)", fontSize: 10, marginTop: 2 }}>{addressErrors[key]}</div>
            )}
          </div>
        ))}
      </div>

      {/* Publisher address */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Publisher Address (override)</label>
        <input
          type="text"
          value={settings.publisherAddress}
          onChange={(e) => {
            const val = e.target.value;
            setSettings((s) => ({ ...s, publisherAddress: val }));
            setAddressErrors((prev) => {
              const next = { ...prev };
              if (val && !isAddress(val)) {
                next.publisherAddress = "Invalid address — must be a valid hex or checksummed address";
              } else {
                delete next.publisherAddress;
              }
              return next;
            });
          }}
          style={{ ...inputStyle, fontFamily: "monospace" }}
          placeholder="Leave blank to use connected wallet"
        />
        {addressErrors.publisherAddress && (
          <div style={{ color: "var(--error)", fontSize: 10, marginTop: 2 }}>{addressErrors.publisherAddress}</div>
        )}
      </div>

      {/* IPFS Gateway */}
      <div style={sectionStyle}>
        <label style={labelStyle}>IPFS Gateway</label>
        <input
          type="text"
          value={settings.ipfsGateway}
          onChange={(e) => setSettings((s) => ({ ...s, ipfsGateway: e.target.value }))}
          style={inputStyle}
          placeholder="https://dweb.link/ipfs/"
        />
      </div>

      {/* Pinata API Key (H3: IPFS pinning) */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Pinata API Key (JWT)</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="password"
            value={settings.pinataApiKey}
            onChange={(e) => {
              setSettings((s) => ({ ...s, pinataApiKey: e.target.value }));
              setPinataTestResult(null);
            }}
            style={{ ...inputStyle, flex: 1 }}
            placeholder="eyJhbGciOiJ..."
          />
          <button
            onClick={async () => {
              setPinataTestResult("Testing...");
              const result = await testPinataKey(settings.pinataApiKey);
              setPinataTestResult(result.ok ? "Valid" : result.error ?? "Failed");
            }}
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--accent)", fontSize: 10, padding: "2px 8px", cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" }}
          >
            Test
          </button>
        </div>
        {pinataTestResult && (
          <div style={{ fontSize: 10, marginTop: 3, color: pinataTestResult === "Valid" ? "var(--ok)" : pinataTestResult === "Testing..." ? "var(--text-muted)" : "var(--error)" }}>
            {pinataTestResult}
          </div>
        )}
        <div style={{ color: "rgba(255,255,255,0.2)", fontSize: 10, marginTop: 2 }}>
          Get a free key at pinata.cloud. Used to pin campaign metadata from My Ads tab.
        </div>
      </div>

      {/* Auto-submit */}
      <div style={{ ...sectionStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <label style={labelStyle}>Auto-submit claims</label>
        <input
          type="checkbox"
          checked={settings.autoSubmit}
          onChange={(e) => setSettings((s) => ({ ...s, autoSubmit: e.target.checked }))}
          style={{ width: 16, height: 16 }}
        />
      </div>

      {/* XM-14: Browser restart deauth notice */}
      {autoSubmitDeauthNotice && settings.autoSubmit && !autoSubmitKeySet && (
        <div style={{ padding: "6px 10px", marginBottom: 8, background: "rgba(252,165,165,0.08)", border: "1px solid rgba(252,165,165,0.2)", borderRadius: "var(--radius-sm)" }}>
          <div style={{ color: "var(--error)", fontSize: 11 }}>
            Auto-submit was deauthorized after browser restart. Re-enter your password below to resume.
          </div>
        </div>
      )}

      {/* WS-3: Auto-submit deauth warning */}
      {settings.autoSubmit && !autoSubmitKeySet && !autoSubmitDeauthNotice && (
        <div style={{ padding: "6px 10px", marginBottom: 8, background: "rgba(252,211,77,0.07)", border: "1px solid rgba(252,211,77,0.2)", borderRadius: "var(--radius-sm)" }}>
          <div style={{ color: "var(--warn)", fontSize: 11 }}>
            Auto-submit not authorized. Claims will queue but not auto-submit until you enter your password below.
          </div>
        </div>
      )}

      {settings.autoSubmit && (
        <div>
          <div style={sectionStyle}>
            <label style={labelStyle}>Auto-submit interval (minutes)</label>
            <input
              type="number"
              value={settings.autoSubmitIntervalMinutes}
              min={1}
              max={60}
              onChange={(e) => setSettings((s) => ({
                ...s,
                autoSubmitIntervalMinutes: Math.max(1, parseInt(e.target.value) || 10),
              }))}
              style={{ ...inputStyle, width: 80 }}
            />
          </div>
          {autoSubmitKeySet ? (
            <div style={{ ...sectionStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "var(--ok)", fontSize: 11 }}>Auto-submit authorized (this session)</span>
              <button
                onClick={async () => {
                  await chrome.runtime.sendMessage({ type: "REVOKE_AUTO_SUBMIT" });
                  setAutoSubmitKeySet(false);
                }}
                style={{ ...secondaryBtn, width: "auto", padding: "4px 8px", fontSize: 11 }}
              >
                Revoke
              </button>
            </div>
          ) : (
            <div style={sectionStyle}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>
                Enter your wallet password to authorize auto-submit. Authorization lasts until browser restart.
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="password"
                  value={autoSubmitPassword}
                  onChange={(e) => setAutoSubmitPassword(e.target.value)}
                  style={{ ...inputStyle, flex: 1 }}
                  placeholder="Wallet password"
                />
                <button
                  onClick={async () => {
                    setAutoSubmitError(null);
                    try {
                      await unlock(autoSubmitPassword); // validate password
                      await chrome.runtime.sendMessage({ type: "AUTHORIZE_AUTO_SUBMIT", password: autoSubmitPassword });
                      setAutoSubmitKeySet(true);
                      setAutoSubmitPassword("");
                    } catch {
                      setAutoSubmitError("Wrong password.");
                    }
                  }}
                  style={{ ...primaryBtn, width: "auto", padding: "6px 12px", fontSize: 11 }}
                >
                  Authorize
                </button>
              </div>
              {autoSubmitError && (
                <div style={{ color: "var(--error)", fontSize: 11, marginTop: 4 }}>{autoSubmitError}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Save */}
      <button onClick={save} style={{ ...primaryBtn, marginTop: 4, marginBottom: 16 }}>
        {saved ? "Saved" : "Save Settings"}
      </button>

      {/* Ad Preferences */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginBottom: 16 }}>
        <div style={{ ...labelStyle, fontSize: 13, color: "var(--accent)", marginBottom: 8, fontWeight: 600 }}>
          Ad Preferences
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle}>Max ads per hour</label>
          <input
            type="range"
            min={1} max={30}
            value={prefs.maxAdsPerHour}
            onChange={(e) => setPrefs((p) => ({ ...p, maxAdsPerHour: Number(e.target.value) }))}
            style={{ width: "100%" }}
          />
          <div style={{ color: "var(--text-muted)", fontSize: 11, textAlign: "center" }}>
            {adsThisHour !== null ? (
              <span>
                <span style={{ color: adsThisHour >= prefs.maxAdsPerHour ? "var(--warn)" : "var(--text)" }}>{adsThisHour}</span>
                <span> / {prefs.maxAdsPerHour} this hour</span>
              </span>
            ) : (
              `${prefs.maxAdsPerHour} / hour`
            )}
          </div>
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle}>Minimum bid CPM ({getCurrencySymbol(settings.network)})</label>
          <input
            type="text"
            value={prefs.minBidCpm === "0" ? "" : prefs.minBidCpm}
            onChange={(e) => setPrefs((p) => ({ ...p, minBidCpm: e.target.value || "0" }))}
            style={inputStyle}
            placeholder="0 (accept all)"
          />
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle}>Blocked tags ({(prefs.blockedTags ?? []).length} blocked)</label>
          <div style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 6 }}>
            Campaigns with blocked tags will not be shown. Toggle tags to block/unblock.
          </div>
          <input
            type="text"
            value={blockTagSearch}
            onChange={(e) => setBlockTagSearch(e.target.value)}
            placeholder="Search tags..."
            style={{ ...inputStyle, fontSize: 10, marginBottom: 6, padding: "3px 6px" }}
          />
          <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 4 }}>
            {Object.entries(TAG_DICTIONARY).map(([dimension, tags]) => {
              const filtered = tags.filter((t) => {
                if (!blockTagSearch) return true;
                const label = (TAG_LABELS[t] ?? t).toLowerCase();
                return label.includes(blockTagSearch.toLowerCase()) || t.includes(blockTagSearch.toLowerCase());
              });
              if (filtered.length === 0) return null;
              return (
                <div key={dimension} style={{ marginBottom: 6 }}>
                  <div style={{ color: "var(--accent)", fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{dimension}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {filtered.map((tag) => {
                      const blocked = (prefs.blockedTags ?? []).includes(tag);
                      return (
                        <button
                          key={tag}
                          onClick={() => toggleBlockTag(tag)}
                          style={{
                            background: blocked ? "rgba(252,165,165,0.08)" : "var(--bg-raised)",
                            color: blocked ? "var(--error)" : "var(--text)",
                            border: `1px solid ${blocked ? "rgba(252,165,165,0.2)" : "var(--border)"}`,
                            borderRadius: "var(--radius-sm)", padding: "1px 6px", fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                          }}
                        >
                          {blocked ? "× " : ""}{TAG_LABELS[tag] ?? tag}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Custom tag blocking */}
          <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
            <input
              type="text"
              value={customBlockTag}
              onChange={(e) => { setCustomBlockTag(e.target.value); setCustomBlockTagError(null); }}
              placeholder="Custom: dimension:value"
              style={{ ...inputStyle, flex: 1, fontSize: 9, padding: "2px 6px" }}
            />
            <button
              onClick={() => {
                const tag = validateCustomTag(customBlockTag);
                if (!tag) { setCustomBlockTagError("Format: dimension:value"); return; }
                setPrefs((p) => ({
                  ...p,
                  blockedTags: [...(p.blockedTags ?? []).filter((t) => t !== tag), tag],
                }));
                setCustomBlockTag("");
                setCustomBlockTagError(null);
              }}
              style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "2px 6px", fontSize: 9, cursor: "pointer", color: "var(--accent)", fontFamily: "inherit" }}
            >
              + Block
            </button>
          </div>
          {customBlockTagError && <div style={{ color: "var(--error)", fontSize: 9, marginTop: 2 }}>{customBlockTagError}</div>}
          {/* Show currently blocked custom tags (not in dictionary) */}
          {(prefs.blockedTags ?? []).filter((t) => !TAG_LABELS[t]).length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ color: "var(--warn)", fontSize: 9, fontWeight: 600, marginBottom: 2 }}>Custom blocked</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {(prefs.blockedTags ?? []).filter((t) => !TAG_LABELS[t]).map((tag) => (
                  <button
                    key={tag}
                    onClick={() => toggleBlockTag(tag)}
                    style={{
                      background: "rgba(252,165,165,0.08)", color: "var(--error)",
                      border: "1px solid rgba(252,165,165,0.2)",
                      borderRadius: "var(--radius-sm)", padding: "1px 6px", fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    }}
                  >
                    × {tagDisplayLabel(tag)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {prefs.blockedCampaigns.length > 0 && (
          <div style={sectionStyle}>
            <label style={labelStyle}>Blocked campaigns</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {prefs.blockedCampaigns.map((id) => (
                <span key={id} style={{
                  background: "rgba(252,165,165,0.08)", color: "var(--error)", fontSize: 10,
                  padding: "2px 6px", borderRadius: "var(--radius-sm)", border: "1px solid rgba(252,165,165,0.2)", display: "inline-flex", alignItems: "center", gap: 4,
                }}>
                  #{id}
                  <button
                    onClick={() => setPrefs((p) => ({
                      ...p,
                      blockedCampaigns: p.blockedCampaigns.filter((c) => c !== id),
                    }))}
                    style={{ background: "none", border: "none", color: "var(--error)", cursor: "pointer", fontSize: 10, padding: 0, fontFamily: "inherit" }}
                  >×</button>
                </span>
              ))}
            </div>
          </div>
        )}

        <button onClick={savePreferences} style={{ ...secondaryBtn, fontSize: 12 }}>
          {prefsSaved ? "Saved" : "Save Ad Preferences"}
        </button>

        <button
          onClick={() => {
            setPrefs({ blockedCampaigns: [], silencedCategories: [], blockedTags: [], maxAdsPerHour: 12, minBidCpm: "0" });
            chrome.runtime.sendMessage({
              type: "UPDATE_USER_PREFERENCES",
              preferences: { blockedCampaigns: [], silencedCategories: [], blockedTags: [], maxAdsPerHour: 12, minBidCpm: "0" },
            });
          }}
          style={{ ...dangerBtn, marginTop: 6, fontSize: 11, padding: "6px 12px" }}
        >
          Reset all preferences
        </button>
      </div>

      {/* Interest Profile — collapsible */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginBottom: 16 }}>
        <button
          onClick={() => setProfileExpanded(!profileExpanded)}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6, marginBottom: 8, width: "100%", fontFamily: "inherit" }}
        >
          <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{profileExpanded ? "▾" : "▸"}</span>
          <span style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>
            Your Interest Profile
          </span>
          <span style={{ color: "var(--text-muted)", fontSize: 11, marginLeft: "auto" }}>
            {interestProfile ? Object.keys(interestProfile.weights).length : 0} tags
          </span>
        </button>
        {profileExpanded && (
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 8 }}>
              This data never leaves your browser. It personalizes ad selection based on your browsing.
            </div>
            {interestProfile && Object.keys(interestProfile.weights).length > 0 ? (
              <div style={{ maxHeight: 200, overflowY: "auto" }}>
                {Object.entries(interestProfile.weights)
                  .sort(([, a], [, b]) => b - a)
                  .map(([cat, weight]) => (
                    <div key={cat} style={{ marginBottom: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text)", marginBottom: 2 }}>
                        <span>{cat}</span>
                        <span>{weight.toFixed(2)} ({interestProfile.visitCounts[cat] ?? 0} visits)</span>
                      </div>
                      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 3, height: 6 }}>
                        <div style={{
                          width: `${Math.round(weight * 100)}%`,
                          background: "var(--accent-dim)",
                          height: "100%",
                          borderRadius: 3,
                          minWidth: 2,
                        }} />
                      </div>
                    </div>
                  ))}
                {!resetProfileConfirm ? (
                  <button onClick={() => setResetProfileConfirm(true)} style={{ ...secondaryBtn, marginTop: 8, fontSize: 11 }}>
                    Reset Profile
                  </button>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ color: "var(--error)", fontSize: 11, marginBottom: 4 }}>Clear all interest data?</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={resetInterestProfile} style={{ ...dangerBtn, flex: 1, fontSize: 11, padding: "6px 8px" }}>Yes</button>
                      <button onClick={() => setResetProfileConfirm(false)} style={{ ...secondaryBtn, flex: 1, fontSize: 11, padding: "6px 8px" }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: 11, fontStyle: "italic" }}>
                No browsing data yet. Visit pages matching campaign categories to build your profile.
              </div>
            )}
          </div>
        )}
      </div>

      {/* TX-6: Publisher tag management */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginBottom: 16 }}>
        <button
          onClick={() => {
            if (!publisherTagsExpanded) loadPublisherTags();
            setPublisherTagsExpanded(!publisherTagsExpanded);
          }}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6, marginBottom: 8, width: "100%", fontFamily: "inherit" }}
        >
          <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{publisherTagsExpanded ? "▾" : "▸"}</span>
          <span style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>Publisher Tags</span>
          <span style={{ color: "var(--text-muted)", fontSize: 11, marginLeft: "auto" }}>
            {currentTags.size > 0 ? `${currentTags.size} selected` : "none"}
          </span>
        </button>
        {publisherTagsExpanded && (
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 8 }}>
              Select tags that describe your site's content. Advertisers can require tags to match their campaigns.
            </div>
            {/* Search */}
            <input
              type="text"
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
              placeholder="Search tags..."
              style={{ ...inputStyle, marginBottom: 8 }}
            />
            {tagsLoading ? (
              <div style={{ color: "var(--text-muted)", fontSize: 11 }}>Loading...</div>
            ) : (
              <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 4 }}>
                {(Object.entries(TAG_DICTIONARY) as [string, string[]][]).map(([dim, tags]) => {
                  const filtered = tags.filter((t) =>
                    !tagSearch || (TAG_LABELS[t] ?? t).toLowerCase().includes(tagSearch.toLowerCase())
                  );
                  if (filtered.length === 0) return null;
                  return (
                    <div key={dim} style={{ marginBottom: 4 }}>
                      <div style={{ color: "var(--text-muted)", fontSize: 9, textTransform: "uppercase", letterSpacing: 1, padding: "2px 4px" }}>
                        {dim}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                        {filtered.map((tag) => {
                          const selected = currentTags.has(tag);
                          return (
                            <button
                              key={tag}
                              onClick={() => setCurrentTags((prev) => {
                                const next = new Set(prev);
                                if (next.has(tag)) next.delete(tag);
                                else next.add(tag);
                                return next;
                              })}
                              style={{
                                background: selected ? "rgba(160,160,255,0.15)" : "var(--bg-raised)",
                                color: selected ? "var(--accent)" : "var(--text-muted)",
                                border: `1px solid ${selected ? "rgba(160,160,255,0.4)" : "var(--border)"}`,
                                borderRadius: "var(--radius-sm)",
                                padding: "2px 7px",
                                fontSize: 10,
                                cursor: "pointer",
                                fontFamily: "inherit",
                              }}
                            >
                              {TAG_LABELS[tag] ?? tag}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button
                onClick={saveTags}
                disabled={tagsSaving}
                style={{ ...primaryBtn, flex: 1, fontSize: 11, padding: "6px 10px" }}
              >
                {tagsSaving ? "Saving..." : "Save Tags On-Chain"}
              </button>
              <button
                onClick={loadPublisherTags}
                disabled={tagsLoading}
                style={{ ...secondaryBtn, width: "auto", padding: "6px 10px", fontSize: 11 }}
              >
                Reload
              </button>
            </div>
            {tagsResult && (
              <div style={{ fontSize: 11, marginTop: 4, color: tagsResult.startsWith("Error") || tagsResult.startsWith("Failed") ? "var(--error)" : "var(--ok)" }}>
                {tagsResult}
              </div>
            )}
          </div>
        )}
      </div>

      {/* UP-2: Local address blocklist */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginBottom: 16 }}>
        <button
          onClick={() => setBlocklistExpanded(!blocklistExpanded)}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6, marginBottom: 8, width: "100%", fontFamily: "inherit" }}
        >
          <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{blocklistExpanded ? "▾" : "▸"}</span>
          <span style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>Address Blocklist</span>
          <span style={{ color: "var(--text-muted)", fontSize: 11, marginLeft: "auto" }}>
            {blockedAddresses.length} blocked
          </span>
        </button>
        {blocklistExpanded && (
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 8 }}>
              Ads from these advertiser addresses will never be shown to you.
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <input
                type="text"
                value={newBlockAddr}
                onChange={(e) => { setNewBlockAddr(e.target.value); setBlockAddrError(null); }}
                placeholder="0x..."
                style={{ ...inputStyle, flex: 1, fontFamily: "monospace", fontSize: 11 }}
                onKeyDown={(e) => e.key === "Enter" && handleAddBlock()}
              />
              <button
                onClick={handleAddBlock}
                style={{ ...secondaryBtn, width: "auto", padding: "6px 10px", fontSize: 11 }}
              >
                Block
              </button>
            </div>
            {blockAddrError && (
              <div style={{ color: "var(--error)", fontSize: 11, marginBottom: 4 }}>{blockAddrError}</div>
            )}
            {blockedAddresses.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: 11, fontStyle: "italic" }}>No blocked addresses.</div>
            ) : (
              <div style={{ maxHeight: 160, overflowY: "auto" }}>
                {blockedAddresses.map((addr) => (
                  <div key={addr} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3, padding: "3px 6px", background: "rgba(252,165,165,0.04)", border: "1px solid rgba(252,165,165,0.1)", borderRadius: "var(--radius-sm)" }}>
                    <span style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)" }}>{addr}</span>
                    <button
                      onClick={() => handleRemoveBlock(addr)}
                      style={{ background: "none", border: "none", color: "var(--error)", cursor: "pointer", fontSize: 12, padding: "0 4px", fontFamily: "inherit" }}
                    >×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
          Danger zone
        </div>

        {!clearConfirm ? (
          <button onClick={() => setClearConfirm(true)} style={dangerBtn}>
            Clear claim queue
          </button>
        ) : (
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: "var(--error)", fontSize: 12, marginBottom: 6 }}>
              This discards all pending unsettled claims. Continue?
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={clearQueue} style={{ ...dangerBtn, flex: 1 }}>Yes, clear</button>
              <button onClick={() => setClearConfirm(false)} style={{ ...secondaryBtn, flex: 1 }}>Cancel</button>
            </div>
          </div>
        )}

        {!resetConfirm ? (
          <button onClick={() => setResetConfirm(true)} style={{ ...dangerBtn, marginTop: 8 }}>
            Reset chain state
          </button>
        ) : (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: "var(--error)", fontSize: 12, marginBottom: 6 }}>
              Wipes local nonce/hash chain. Claims will re-sync from chain. Continue?
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={resetChainState} style={{ ...dangerBtn, flex: 1 }}>Yes, reset</button>
              <button onClick={() => setResetConfirm(false)} style={{ ...secondaryBtn, flex: 1 }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const sectionStyle: React.CSSProperties = {
  marginBottom: 12,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  color: "var(--text-muted)",
  fontSize: 12,
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  background: "var(--bg-raised)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  fontFamily: "inherit",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

const primaryBtn: React.CSSProperties = {
  background: "rgba(160,160,255,0.1)",
  color: "var(--accent)",
  border: "1px solid rgba(160,160,255,0.3)",
  borderRadius: "var(--radius-sm)",
  padding: "8px 14px",
  fontSize: 13,
  cursor: "pointer",
  width: "100%",
  fontFamily: "inherit",
  fontWeight: 500,
};

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "var(--bg-raised)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
};

const dangerBtn: React.CSSProperties = {
  background: "rgba(252,165,165,0.08)",
  color: "var(--error)",
  border: "1px solid rgba(252,165,165,0.2)",
  borderRadius: "var(--radius-sm)",
  padding: "8px 14px",
  fontSize: 12,
  cursor: "pointer",
  width: "100%",
  fontFamily: "inherit",
};
