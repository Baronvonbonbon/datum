import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { WebAppSettings, NetworkName, ContractAddresses } from "@shared/types";
import { DEFAULT_SETTINGS, NETWORK_CONFIGS } from "@shared/networks";

const STORAGE_KEY = "datum_web_settings";

interface SettingsContextValue {
  settings: WebAppSettings;
  updateSettings: (patch: Partial<WebAppSettings>) => void;
  setNetwork: (network: NetworkName) => void;
  setContractAddress: (key: keyof ContractAddresses, value: string) => void;
  resetToDefaults: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<WebAppSettings>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<WebAppSettings>;
        return { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch { /* ignore */ }
    return DEFAULT_SETTINGS;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
