import { Contract, JsonRpcProvider, Signer } from "ethers";
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
import { ContractAddresses } from "./types";

type Provider = JsonRpcProvider;

export function getCampaignsContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.campaigns, DatumCampaignsAbi.abi, provider);
}

export function getPublishersContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.publishers, DatumPublishersAbi.abi, provider);
}

export function getGovernanceV2Contract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.governanceV2, DatumGovernanceV2Abi.abi, provider);
}

export function getGovernanceSlashContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.governanceSlash, DatumGovernanceSlashAbi.abi, provider);
}

export function getSettlementContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.settlement, DatumSettlementAbi.abi, provider);
}

export function getRelayContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.relay, DatumRelayAbi.abi, provider);
}

export function getPauseRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.pauseRegistry, DatumPauseRegistryAbi.abi, provider);
}

export function getTimelockContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.timelock, DatumTimelockAbi.abi, provider);
}

export function getPaymentVaultContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.paymentVault, DatumPaymentVaultAbi.abi, provider);
}

export function getBudgetLedgerContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.budgetLedger, DatumBudgetLedgerAbi.abi, provider);
}

export function getLifecycleContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.lifecycle, DatumCampaignLifecycleAbi.abi, provider);
}

export function getAttestationVerifierContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.attestationVerifier, DatumAttestationVerifierAbi.abi, provider);
}

export function getTargetingRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.targetingRegistry, DatumTargetingRegistryAbi.abi, provider);
}

export function getReportsContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.reports, DatumReportsAbi.abi, provider);
}

export function getRateLimiterContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.rateLimiter, DatumSettlementRateLimiterAbi.abi, provider);
}

export function getReputationContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.reputation, DatumPublisherReputationAbi.abi, provider);
}

export function getZKVerifierContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.zkVerifier, DatumZKVerifierAbi.abi, provider);
}

export function getCampaignValidatorContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.campaignValidator, DatumCampaignValidatorAbi.abi, provider);
}

export function getClaimValidatorContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.claimValidator, DatumClaimValidatorAbi.abi, provider);
}

export function getGovernanceHelperContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.governanceHelper, DatumGovernanceHelperAbi.abi, provider);
}

// Helper: create a read-only provider for the given RPC URL
export function getProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl);
}
