import { useMemo } from "react";
import { JsonRpcProvider } from "ethers";
import { useSettings } from "../context/SettingsContext";
import { useWallet } from "../context/WalletContext";
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
  getProvider,
} from "@shared/contracts";

export function useContracts() {
  const { settings } = useSettings();
  const { signer } = useWallet();

  return useMemo(() => {
    const provider: JsonRpcProvider | ReturnType<typeof Object> = signer ?? getProvider(settings.rpcUrl);
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
      // Read-only provider for cases that don't need a signer
      readProvider: getProvider(settings.rpcUrl),
    };
  }, [settings.contractAddresses, settings.rpcUrl, signer]);
}
