import { BrowserProvider, Contract, JsonRpcProvider, Signer, InterfaceAbi } from "ethers";
import DatumCampaignsAbi from "./abis/DatumCampaigns.json";
import DatumPublishersAbi from "./abis/DatumPublishers.json";
import DatumGovernanceV2Abi from "./abis/DatumGovernanceV2.json";
import DatumGovernanceSlashAbi from "./abis/DatumGovernanceSlash.json";
import DatumSettlementAbi from "./abis/DatumSettlement.json";
import DatumRelayAbi from "./abis/DatumRelay.json";
import DatumPauseRegistryAbi from "./abis/DatumPauseRegistry.json";
import DatumTimelockAbi from "./abis/DatumTimelock.json";
import DatumPaymentVaultAbi from "./abis/DatumPaymentVault.json";
import DatumBudgetLedgerAbi from "./abis/DatumBudgetLedger.json";
import DatumCampaignLifecycleAbi from "./abis/DatumCampaignLifecycle.json";
import DatumAttestationVerifierAbi from "./abis/DatumAttestationVerifier.json";
import DatumTargetingRegistryAbi from "./abis/DatumTargetingRegistry.json";
import DatumZKVerifierAbi from "./abis/DatumZKVerifier.json";
import DatumCampaignValidatorAbi from "./abis/DatumCampaignValidator.json";
import DatumClaimValidatorAbi from "./abis/DatumClaimValidator.json";
import DatumGovernanceHelperAbi from "./abis/DatumGovernanceHelper.json";
import DatumReportsAbi from "./abis/DatumReports.json";
import DatumSettlementRateLimiterAbi from "./abis/DatumSettlementRateLimiter.json";
import DatumPublisherReputationAbi from "./abis/DatumPublisherReputation.json";
import DatumTokenRewardVaultAbi from "./abis/DatumTokenRewardVault.json";
import { ContractAddresses } from "./types";

type Provider = JsonRpcProvider;

// ABI JSON files may be either a bare array [...] or a Hardhat artifact { abi: [...] }.
// Normalize so both formats work across webpack (extension) and Vite (web demo).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function abi(imported: any): InterfaceAbi {
  return Array.isArray(imported) ? imported : imported.abi;
}

export function getCampaignsContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.campaigns, abi(DatumCampaignsAbi), provider);
}

export function getPublishersContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.publishers, abi(DatumPublishersAbi), provider);
}

export function getGovernanceV2Contract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.governanceV2, abi(DatumGovernanceV2Abi), provider);
}

export function getGovernanceSlashContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.governanceSlash, abi(DatumGovernanceSlashAbi), provider);
}

export function getSettlementContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.settlement, abi(DatumSettlementAbi), provider);
}

export function getRelayContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.relay, abi(DatumRelayAbi), provider);
}

export function getPauseRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.pauseRegistry, abi(DatumPauseRegistryAbi), provider);
}

export function getTimelockContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.timelock, abi(DatumTimelockAbi), provider);
}

export function getPaymentVaultContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.paymentVault, abi(DatumPaymentVaultAbi), provider);
}

export function getBudgetLedgerContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.budgetLedger, abi(DatumBudgetLedgerAbi), provider);
}

export function getLifecycleContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.lifecycle, abi(DatumCampaignLifecycleAbi), provider);
}

export function getAttestationVerifierContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.attestationVerifier, abi(DatumAttestationVerifierAbi), provider);
}

export function getTargetingRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.targetingRegistry, abi(DatumTargetingRegistryAbi), provider);
}

export function getReportsContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.reports, abi(DatumReportsAbi), provider);
}

export function getRateLimiterContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.rateLimiter, abi(DatumSettlementRateLimiterAbi), provider);
}

export function getReputationContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.reputation, abi(DatumPublisherReputationAbi), provider);
}

export function getZKVerifierContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.zkVerifier, abi(DatumZKVerifierAbi), provider);
}

export function getTokenRewardVaultContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.tokenRewardVault, abi(DatumTokenRewardVaultAbi), provider);
}

export function getCampaignValidatorContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.campaignValidator, abi(DatumCampaignValidatorAbi), provider);
}

export function getClaimValidatorContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.claimValidator, abi(DatumClaimValidatorAbi), provider);
}

export function getGovernanceHelperContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.governanceHelper, abi(DatumGovernanceHelperAbi), provider);
}

// Helper: create a read-only provider for the given RPC URL
export function getProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl);
}

/** Singleton Pine provider — reused across requests to avoid re-syncing smoldot */
let pineProviderCache: { chain: string; promise: Promise<BrowserProvider> } | null = null;

/**
 * Get a Pine-backed BrowserProvider for the given chain.
 * Reuses the same smoldot instance if the chain hasn't changed.
 */
export async function getPineProvider(pineChain: string): Promise<BrowserProvider | null> {
  try {
    if (pineProviderCache && pineProviderCache.chain === pineChain) {
      return pineProviderCache.promise;
    }
    const promise = (async () => {
      const { PineProvider } = await import("pine-rpc");
      const pine = new PineProvider({ chain: pineChain as import("pine-rpc").ChainPreset });
      await pine.connect();
      return new BrowserProvider(pine);
    })();
    pineProviderCache = { chain: pineChain, promise };
    return await promise;
  } catch {
    pineProviderCache = null;
    return null;
  }
}
