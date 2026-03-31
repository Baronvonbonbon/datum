import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { WebAppSettings, NetworkName, ContractAddresses } from "@shared/types";
import { DEFAULT_SETTINGS, NETWORK_CONFIGS } from "@shared/networks";

const STORAGE_KEY = "datum_web_settings";
// WS-2: Sensitive keys stored in sessionStorage only (not persisted across sessions)
const SESSION_KEY = "datum_session_secrets";
const SENSITIVE_FIELDS: (keyof WebAppSettings)[] = ["ipfsApiKey", "pinataApiKey"];

interface SettingsContextValue {
  settings: WebAppSettings;
  updateSettings: (patch: Partial<WebAppSettings>) => void;
  setNetwork: (network: NetworkName) => void;
  setContractAddress: (key: keyof ContractAddresses, value: string) => void;
  resetToDefaults: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function loadSessionSecrets(): Partial<WebAppSettings> {
  try {
    const s = sessionStorage.getItem(SESSION_KEY);
    return s ? JSON.parse(s) : {};
  } catch { return {}; }
}

function saveSessionSecrets(settings: WebAppSettings) {
  const secrets: Record<string, string> = {};
  for (const k of SENSITIVE_FIELDS) {
    const v = settings[k];
    if (typeof v === "string" && v) secrets[k] = v;
  }
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(secrets));
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<WebAppSettings>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const secrets = loadSessionSecrets();
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<WebAppSettings>;
        // WS-2 migration: move any plaintext API keys from localStorage to sessionStorage
        for (const k of SENSITIVE_FIELDS) {
          const v = (parsed as any)[k];
          if (typeof v === "string" && v && !secrets[k]) (secrets as any)[k] = v;
        }
        return { ...DEFAULT_SETTINGS, ...parsed, ...secrets };
      }
      return { ...DEFAULT_SETTINGS, ...secrets };
    } catch { /* ignore */ }
    return DEFAULT_SETTINGS;
  });

  useEffect(() => {
    // Strip sensitive fields from localStorage
    const safe = { ...settings };
    for (const k of SENSITIVE_FIELDS) (safe as any)[k] = "";
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
    // Store sensitive fields in sessionStorage only
    saveSessionSecrets(settings);
  }, [settings]);

  function updateSettings(patch: Partial<WebAppSettings>) {
    setSettings((s) => ({ ...s, ...patch }));
  }

  function setNetwork(network: NetworkName) {
    const config = NETWORK_CONFIGS[network];
    setSettings((s) => ({
      ...s,
      network,
      rpcUrl: config.rpcUrl,
      contractAddresses: config.addresses,
    }));
  }

  function setContractAddress(key: keyof ContractAddresses, value: string) {
    setSettings((s) => ({
      ...s,
      contractAddresses: { ...s.contractAddresses, [key]: value },
    }));
  }

  function resetToDefaults() {
    setSettings(DEFAULT_SETTINGS);
  }

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, setNetwork, setContractAddress, resetToDefaults }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
