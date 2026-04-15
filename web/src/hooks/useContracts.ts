import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, JsonRpcProvider } from "ethers";
import { useSettings } from "../context/SettingsContext";
import { useWallet } from "../context/WalletContext";
import { NETWORK_CONFIGS } from "@shared/networks";
import {
  getCampaignsContract,
  getPublishersContract,
  getGovernanceV2Contract,
  getGovernanceSlashContract,
  getSettlementContract,
  getRelayContract,
  getPauseRegistryContract,
  getTimelockContract,
  getBudgetLedgerContract,
  getPaymentVaultContract,
  getLifecycleContract,
  getAttestationVerifierContract,
  getTargetingRegistryContract,
  getCampaignValidatorContract,
  getClaimValidatorContract,
  getGovernanceHelperContract,
  getReportsContract,
  getRateLimiterContract,
  getReputationContract,
  getTokenRewardVaultContract,
  getProvider,
  getPineProvider,
} from "@shared/contracts";

export type PineStatus = "off" | "connecting" | "connected" | "error";

export function useContracts() {
  const { settings } = useSettings();
  const { signer } = useWallet();
  const [pineProvider, setPineProvider] = useState<BrowserProvider | null>(null);
  const [pineStatus, setPineStatus] = useState<PineStatus>("off");

  // Async Pine initialization — falls back to centralized RPC while connecting
  const pineChain = settings.usePine
    ? NETWORK_CONFIGS[settings.network]?.pineChain
    : undefined;

  useEffect(() => {
    if (!pineChain) {
      setPineProvider(null);
      setPineStatus("off");
      return;
    }
    setPineStatus("connecting");
    let cancelled = false;
    getPineProvider(pineChain).then((p) => {
      if (cancelled) return;
      if (p) {
        setPineProvider(p);
        setPineStatus("connected");
      } else {
        setPineStatus("error");
      }
    });
    return () => { cancelled = true; };
  }, [pineChain]);

  return useMemo(() => {
    const provider = signer ?? pineProvider ?? getProvider(settings.rpcUrl);
    const readProvider = pineProvider ?? getProvider(settings.rpcUrl);
    const addrs = settings.contractAddresses;
    return {
      campaigns: getCampaignsContract(addrs, provider),
      publishers: getPublishersContract(addrs, provider),
      governanceV2: getGovernanceV2Contract(addrs, provider),
      governanceSlash: getGovernanceSlashContract(addrs, provider),
      settlement: getSettlementContract(addrs, provider),
      relay: getRelayContract(addrs, provider),
      pauseRegistry: getPauseRegistryContract(addrs, provider),
      timelock: getTimelockContract(addrs, provider),
      budgetLedger: getBudgetLedgerContract(addrs, provider),
      paymentVault: getPaymentVaultContract(addrs, provider),
      lifecycle: getLifecycleContract(addrs, provider),
      attestationVerifier: getAttestationVerifierContract(addrs, provider),
      targetingRegistry: getTargetingRegistryContract(addrs, provider),
      campaignValidator: getCampaignValidatorContract(addrs, provider),
      claimValidator: getClaimValidatorContract(addrs, provider),
      governanceHelper: getGovernanceHelperContract(addrs, provider),
      reports: getReportsContract(addrs, provider),
      rateLimiter: getRateLimiterContract(addrs, provider),
      reputation: getReputationContract(addrs, provider),
      tokenRewardVault: getTokenRewardVaultContract(addrs, provider),
      readProvider,
      /** True when Pine light client is active */
      usingPine: !!pineProvider,
      /** Pine connection status */
      pineStatus,
    };
  }, [settings.contractAddresses, settings.rpcUrl, signer, pineProvider, pineStatus]);
}
