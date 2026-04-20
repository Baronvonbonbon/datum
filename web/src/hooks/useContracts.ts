import { useEffect, useMemo, useState } from "react";
import { JsonRpcApiProvider, JsonRpcProvider } from "ethers";
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
  getParameterGovernanceContract,
  getPublisherStakeContract,
  getChallengeBondsContract,
  getPublisherGovernanceContract,
  getNullifierRegistryContract,
  getProvider,
  getPineProvider,
  subscribePineSyncStep,
  subscribePineRpcTest,
  type SyncStep,
  type PineRpcTest,
} from "@shared/contracts";

export type PineStatus = "off" | "connecting" | "connected" | "error";
export type { SyncStep, PineRpcTest };

export function useContracts() {
  const { settings } = useSettings();
  const { signer } = useWallet();
  const [pineProvider, setPineProvider] = useState<JsonRpcApiProvider | null>(null);
  const [pineStatus, setPineStatus] = useState<PineStatus>("off");
  const [syncStep, setSyncStep] = useState<SyncStep | null>(null);
  const [pineRpcTest, setPineRpcTest] = useState<PineRpcTest>(null);

  // Subscribe to module-level sync step and RPC test (shared across all useContracts instances)
  useEffect(() => subscribePineSyncStep(setSyncStep), []);
  useEffect(() => subscribePineRpcTest(setPineRpcTest), []);

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

    async function tryConnect(attemptsLeft: number) {
      const p = await getPineProvider(pineChain!);
      if (cancelled) return;
      if (p) {
        setPineProvider(p);
        setPineStatus("connected");
      } else if (attemptsLeft > 0) {
        // smoldot first-sync can take >30s; retry up to 3× with 15s gaps
        await new Promise<void>((r) => setTimeout(r, 15_000));
        if (!cancelled) tryConnect(attemptsLeft - 1);
      } else {
        setPineStatus("error");
      }
    }

    tryConnect(3);
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
      parameterGovernance: getParameterGovernanceContract(addrs, provider),
      publisherStake: getPublisherStakeContract(addrs, provider),
      challengeBonds: getChallengeBondsContract(addrs, provider),
      publisherGovernance: getPublisherGovernanceContract(addrs, provider),
      nullifierRegistry: getNullifierRegistryContract(addrs, provider),
      readProvider,
      /** True when Pine light client is active */
      usingPine: !!pineProvider,
      /** Pine connection status */
      pineStatus,
      /** Granular sync step during connecting phase (null when connected/off) */
      syncStep,
      /** Result of the ethers↔Pine smoke test (null until attempted) */
      pineRpcTest,
    };
  }, [settings.contractAddresses, settings.rpcUrl, signer, pineProvider, pineStatus, syncStep, pineRpcTest]);
}
