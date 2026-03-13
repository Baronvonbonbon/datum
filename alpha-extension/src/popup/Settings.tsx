import { useState, useEffect } from "react";
import { JsonRpcProvider, Contract } from "ethers";
import { StoredSettings, NetworkName, ContractAddresses, UserPreferences, CATEGORY_NAMES, buildCategoryHierarchy, CategoryGroup } from "@shared/types";
import { NETWORK_CONFIGS, DEFAULT_SETTINGS } from "@shared/networks";
import { unlock, isConfigured } from "@shared/walletManager";
import { testPinataKey } from "@shared/ipfsPin";
import DatumCampaignsAbi from "@shared/abis/DatumCampaigns.json";

interface InterestProfileData {
  weights: Record<string, number>;
  visitCounts: Record<string, number>;
}

export function Settings() {
  const [settings, setSettings] = useState<StoredSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetProfileConfirm, setResetProfileConfirm] = useState(false);
  const [interestProfile, setInterestProfile] = useState<InterestProfileData | null>(null);
  const [autoSubmitPassword, setAutoSubmitPassword] = useState("");
  const [autoSubmitKeySet, setAutoSubmitKeySet] = useState(false);
  const [autoSubmitError, setAutoSubmitError] = useState<string | null>(null);
  const [rpcWarning, setRpcWarning] = useState<string | null>(null);
  const [pinataTestResult, setPinataTestResult] = useState<string | null>(null);
  // SI-1: RPC connectivity test
  const [rpcTestResult, setRpcTestResult] = useState<{ ok: boolean; blockNumber?: number; latencyMs?: number; error?: string } | null>(null);
  const [rpcTesting, setRpcTesting] = useState(false);
  // SI-2: Network/contract mismatch warning
  const [contractWarning, setContractWarning] = useState<string | null>(null);

  // User preferences
  const [prefs, setPrefs] = useState<UserPreferences>({
    blockedCampaigns: [],
    silencedCategories: [],
    maxAdsPerHour: 12,
    minBidCpm: "0",
  });
  const [prefsSaved, setPrefsSaved] = useState(false);

  useEffect(() => {
    chrome.storage.local.get("settings", (stored) => {
      if (stored.settings) setSettings(stored.settings);
    });
    // Check auto-submit authorization via background (B1: encrypted)
    chrome.runtime.sendMessage({ type: "CHECK_AUTO_SUBMIT" }).then((resp) => {
      if (resp?.authorized) setAutoSubmitKeySet(true);
    });
    loadInterestProfile();
    loadPreferences();
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
  }

  function handleAddressChange(key: keyof ContractAddresses, value: string) {
    setSettings((s) => ({
      ...s,
      contractAddresses: { ...s.contractAddresses, [key]: value },
    }));
  }

  async function clearQueue() {
    await chrome.runtime.sendMessage({ type: "CLEAR_QUEUE" });
    setClearConfirm(false);
  }

  async function resetChainState() {
    await chrome.runtime.sendMessage({ type: "RESET_CHAIN_STATE" });
    setResetConfirm(false);
  }

  // Category hierarchy for collapsible silencing
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [profileExpanded, setProfileExpanded] = useState(false);
  const categoryHierarchy = buildCategoryHierarchy();

  function toggleGroup(id: number) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function isGroupSilenced(group: CategoryGroup): "all" | "some" | "none" {
    const names = [group.name, ...group.children.map((c) => c.name)];
    const silenced = names.filter((n) => prefs.silencedCategories.includes(n));
    if (silenced.length === 0) return "none";
    if (silenced.length === names.length) return "all";
    return "some";
  }

  function toggleGroupSilence(group: CategoryGroup) {
    const names = [group.name, ...group.children.map((c) => c.name)];
    const state = isGroupSilenced(group);
    setPrefs((p) => ({
      ...p,
      silencedCategories: state === "all"
        ? p.silencedCategories.filter((c) => !names.includes(c))
        : [...p.silencedCategories.filter((c) => !names.includes(c)), ...names],
    }));
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>Settings</span>
      </div>

      {/* Network */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Network</label>
        <select
          value={settings.network}
          onChange={(e) => handleNetworkChange(e.target.value as NetworkName)}
          style={selectStyle}
        >
          <option value="local">Local (dev)</option>
          <option value="paseo">Paseo Asset Hub</option>
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
          <div style={{ color: "#ffb060", fontSize: 11, marginTop: 4 }}>{rpcWarning}</div>
        )}
        {/* SI-1: RPC connectivity test */}
        <div style={{ marginTop: 4 }}>
          <button
            onClick={testRpcConnection}
            disabled={rpcTesting}
            style={{ background: "none", border: "1px solid #2a2a4a", borderRadius: 3, color: "#a0a0ff", fontSize: 10, padding: "2px 8px", cursor: "pointer" }}
          >
            {rpcTesting ? "Testing..." : "Test Connection"}
          </button>
          {rpcTestResult && (
            <span style={{ fontSize: 10, marginLeft: 6, color: rpcTestResult.ok ? "#60c060" : "#ff8080" }}>
              {rpcTestResult.ok
                ? `Connected — block #${rpcTestResult.blockNumber} (${rpcTestResult.latencyMs}ms)`
                : `Failed: ${rpcTestResult.error}`}
            </span>
          )}
        </div>
        {/* SI-2: Network/contract mismatch warning */}
        {contractWarning && (
          <div style={{ color: "#ff9040", fontSize: 11, marginTop: 4, padding: "4px 8px", background: "#1a1a0a", borderRadius: 3 }}>
            {contractWarning}
          </div>
        )}
      </div>

      {/* Contract addresses */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={labelStyle}>Contract Addresses</div>
          <button
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
                  },
                }));
              } catch (err) {
                alert("Could not load deployed addresses. Run deploy.ts first, then rebuild the extension.");
              }
            }}
            style={{ background: "none", border: "1px solid #2a2a4a", borderRadius: 3, color: "#a0a0ff", fontSize: 10, padding: "2px 8px", cursor: "pointer" }}
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
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: 11 }}
              placeholder="0x..."
            />
          </div>
        ))}
      </div>

      {/* Publisher address */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Publisher Address (override)</label>
        <input
          type="text"
          value={settings.publisherAddress}
          onChange={(e) => setSettings((s) => ({ ...s, publisherAddress: e.target.value }))}
          style={{ ...inputStyle, fontFamily: "monospace" }}
          placeholder="Leave blank to use connected wallet"
        />
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
            style={{ background: "none", border: "1px solid #2a2a4a", borderRadius: 3, color: "#a0a0ff", fontSize: 10, padding: "2px 8px", cursor: "pointer", whiteSpace: "nowrap" }}
          >
            Test
          </button>
        </div>
        {pinataTestResult && (
          <div style={{ fontSize: 10, marginTop: 3, color: pinataTestResult === "Valid" ? "#60c060" : pinataTestResult === "Testing..." ? "#888" : "#ff8080" }}>
            {pinataTestResult}
          </div>
        )}
        <div style={{ color: "#555", fontSize: 10, marginTop: 2 }}>
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

      {/* WS-3: Auto-submit deauth warning */}
      {settings.autoSubmit && !autoSubmitKeySet && (
        <div style={{ padding: "6px 10px", marginBottom: 8, background: "#2a1a0a", border: "1px solid #4a2a0a", borderRadius: 4 }}>
          <div style={{ color: "#ff9040", fontSize: 11 }}>
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
              <span style={{ color: "#60c060", fontSize: 11 }}>Auto-submit authorized (this session)</span>
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
              <div style={{ color: "#888", fontSize: 11, marginBottom: 4 }}>
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
                      const wallet = await unlock(autoSubmitPassword);
                      await chrome.runtime.sendMessage({ type: "AUTHORIZE_AUTO_SUBMIT", privateKey: wallet.privateKey });
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
                <div style={{ color: "#ff8080", fontSize: 11, marginTop: 4 }}>{autoSubmitError}</div>
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
      <div style={{ borderTop: "1px solid #2a2a2a", paddingTop: 12, marginBottom: 16 }}>
        <div style={{ ...labelStyle, fontSize: 13, color: "#a0a0ff", marginBottom: 8, fontWeight: 600 }}>
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
          <div style={{ color: "#888", fontSize: 11, textAlign: "center" }}>{prefs.maxAdsPerHour} / hour</div>
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle}>Minimum bid CPM (DOT)</label>
          <input
            type="text"
            value={prefs.minBidCpm === "0" ? "" : prefs.minBidCpm}
            onChange={(e) => setPrefs((p) => ({ ...p, minBidCpm: e.target.value || "0" }))}
            style={inputStyle}
            placeholder="0 (accept all)"
          />
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle}>Silenced categories ({prefs.silencedCategories.length} silenced)</label>
          <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid #2a2a4a", borderRadius: 4, padding: 4 }}>
            {categoryHierarchy.map((group) => {
              const groupState = isGroupSilenced(group);
              const isOpen = expandedGroups.has(group.id);
              return (
                <div key={group.id} style={{ marginBottom: 2 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    {group.children.length > 0 && (
                      <button
                        onClick={() => toggleGroup(group.id)}
                        style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 10, padding: "0 2px", width: 14 }}
                      >{isOpen ? "v" : ">"}</button>
                    )}
                    {group.children.length === 0 && <span style={{ width: 14 }} />}
                    <button
                      onClick={() => toggleGroupSilence(group)}
                      style={{
                        background: groupState === "all" ? "#2a0a0a" : groupState === "some" ? "#1a0a1a" : "#1a1a2e",
                        color: groupState === "all" ? "#ff8080" : groupState === "some" ? "#c080c0" : "#aaa",
                        border: `1px solid ${groupState !== "none" ? "#4a1a1a" : "#2a2a4a"}`,
                        borderRadius: 3, padding: "1px 6px", fontSize: 10, cursor: "pointer", flex: 1, textAlign: "left",
                      }}
                    >
                      {groupState === "all" ? "x " : groupState === "some" ? "- " : ""}{group.name}
                    </button>
                  </div>
                  {isOpen && group.children.length > 0 && (
                    <div style={{ marginLeft: 18, marginTop: 2 }}>
                      {group.children.map((child) => {
                        const silenced = prefs.silencedCategories.includes(child.name);
                        return (
                          <button
                            key={child.id}
                            onClick={() => {
                              setPrefs((p) => ({
                                ...p,
                                silencedCategories: silenced
                                  ? p.silencedCategories.filter((c) => c !== child.name)
                                  : [...p.silencedCategories, child.name],
                              }));
                            }}
                            style={{
                              display: "block", width: "100%", textAlign: "left", marginBottom: 1,
                              background: silenced ? "#2a0a0a" : "#111122",
                              color: silenced ? "#ff8080" : "#888",
                              border: `1px solid ${silenced ? "#4a1a1a" : "#1a1a2e"}`,
                              borderRadius: 2, padding: "1px 6px", fontSize: 9, cursor: "pointer",
                            }}
                          >
                            {silenced ? "x " : ""}{child.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {prefs.blockedCampaigns.length > 0 && (
          <div style={sectionStyle}>
            <label style={labelStyle}>Blocked campaigns</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {prefs.blockedCampaigns.map((id) => (
                <span key={id} style={{
                  background: "#2a0a0a", color: "#ff8080", fontSize: 10,
                  padding: "2px 6px", borderRadius: 3, display: "inline-flex", alignItems: "center", gap: 4,
                }}>
                  #{id}
                  <button
                    onClick={() => setPrefs((p) => ({
                      ...p,
                      blockedCampaigns: p.blockedCampaigns.filter((c) => c !== id),
                    }))}
                    style={{ background: "none", border: "none", color: "#ff8080", cursor: "pointer", fontSize: 10, padding: 0 }}
                  >x</button>
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
            setPrefs({ blockedCampaigns: [], silencedCategories: [], maxAdsPerHour: 12, minBidCpm: "0" });
            chrome.runtime.sendMessage({
              type: "UPDATE_USER_PREFERENCES",
              preferences: { blockedCampaigns: [], silencedCategories: [], maxAdsPerHour: 12, minBidCpm: "0" },
            });
          }}
          style={{ ...dangerBtn, marginTop: 6, fontSize: 11, padding: "6px 12px" }}
        >
          Reset all preferences
        </button>
      </div>

      {/* Interest Profile — collapsible */}
      <div style={{ borderTop: "1px solid #2a2a2a", paddingTop: 12, marginBottom: 16 }}>
        <button
          onClick={() => setProfileExpanded(!profileExpanded)}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6, marginBottom: 8, width: "100%" }}
        >
          <span style={{ color: "#666", fontSize: 10 }}>{profileExpanded ? "v" : ">"}</span>
          <span style={{ fontSize: 13, color: "#a0a0ff", fontWeight: 600 }}>
            Your Interest Profile
          </span>
          <span style={{ color: "#555", fontSize: 11, marginLeft: "auto" }}>
            {interestProfile ? Object.keys(interestProfile.weights).length : 0} categories
          </span>
        </button>
        {profileExpanded && (
          <div>
            <div style={{ color: "#666", fontSize: 11, marginBottom: 8 }}>
              This data never leaves your browser. It personalizes ad selection based on your browsing.
            </div>
            {interestProfile && Object.keys(interestProfile.weights).length > 0 ? (
              <div style={{ maxHeight: 200, overflowY: "auto" }}>
                {Object.entries(interestProfile.weights)
                  .sort(([, a], [, b]) => b - a)
                  .map(([cat, weight]) => (
                    <div key={cat} style={{ marginBottom: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aaa", marginBottom: 2 }}>
                        <span>{cat}</span>
                        <span>{weight.toFixed(2)} ({interestProfile.visitCounts[cat] ?? 0} visits)</span>
                      </div>
                      <div style={{ background: "#1a1a2e", borderRadius: 3, height: 8 }}>
                        <div style={{
                          width: `${Math.round(weight * 100)}%`,
                          background: "#4a4a8a",
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
                    <div style={{ color: "#ff8080", fontSize: 11, marginBottom: 4 }}>Clear all interest data?</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={resetInterestProfile} style={{ ...dangerBtn, flex: 1, fontSize: 11, padding: "6px 8px" }}>Yes</button>
                      <button onClick={() => setResetProfileConfirm(false)} style={{ ...secondaryBtn, flex: 1, fontSize: 11, padding: "6px 8px" }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: "#555", fontSize: 11, fontStyle: "italic" }}>
                No browsing data yet. Visit pages matching campaign categories to build your profile.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div style={{ borderTop: "1px solid #2a2a2a", paddingTop: 12 }}>
        <div style={{ color: "#555", fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
          Danger zone
        </div>

        {!clearConfirm ? (
          <button onClick={() => setClearConfirm(true)} style={dangerBtn}>
            Clear claim queue
          </button>
        ) : (
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: "#ff8080", fontSize: 12, marginBottom: 6 }}>
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
            <div style={{ color: "#ff8080", fontSize: 12, marginBottom: 6 }}>
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
  color: "#888",
  fontSize: 12,
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  background: "#1a1a2e",
  border: "1px solid #2a2a4a",
  borderRadius: 4,
  color: "#e0e0e0",
  fontSize: 12,
  outline: "none",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

const primaryBtn: React.CSSProperties = {
  background: "#2a2a5a",
  color: "#a0a0ff",
  border: "1px solid #4a4a8a",
  borderRadius: 6,
  padding: "10px 16px",
  fontSize: 13,
  cursor: "pointer",
  width: "100%",
};

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#1a1a1a",
  color: "#666",
  border: "1px solid #333",
};

const dangerBtn: React.CSSProperties = {
  background: "#2a0a0a",
  color: "#ff8080",
  border: "1px solid #4a1a1a",
  borderRadius: 6,
  padding: "8px 16px",
  fontSize: 12,
  cursor: "pointer",
  width: "100%",
};
