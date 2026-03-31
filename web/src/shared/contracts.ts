// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { Contract, JsonRpcProvider, Signer } from "ethers";
import DatumCampaignsAbi from "./abis/DatumCampaigns.json";
import DatumPublishersAbi from "./abis/DatumPublishers.json";
import DatumGovernanceV2Abi from "./abis/DatumGovernanceV2.json";
import DatumGovernanceSlashAbi from "./abis/DatumGovernanceSlash.json";
import DatumSettlementAbi from "./abis/DatumSettlement.json";
import DatumRelayAbi from "./abis/DatumRelay.json";
import DatumPauseRegistryAbi from "./abis/DatumPauseRegistry.json";
import DatumTimelockAbi from "./abis/DatumTimelock.json";
import DatumBudgetLedgerAbi from "./abis/DatumBudgetLedger.json";
import DatumPaymentVaultAbi from "./abis/DatumPaymentVault.json";
import DatumCampaignLifecycleAbi from "./abis/DatumCampaignLifecycle.json";
import DatumAttestationVerifierAbi from "./abis/DatumAttestationVerifier.json";
import DatumTargetingRegistryAbi from "./abis/DatumTargetingRegistry.json";
import DatumCampaignValidatorAbi from "./abis/DatumCampaignValidator.json";
import DatumClaimValidatorAbi from "./abis/DatumClaimValidator.json";
import DatumGovernanceHelperAbi from "./abis/DatumGovernanceHelper.json";
import { ContractAddresses } from "./types";

type Provider = JsonRpcProvider;

// Returns any-typed contracts so component code doesn't need casts for dynamic ABI methods.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function make(address: string, abi: any[], provider: Provider | Signer): any {
  return new Contract(address, abi, provider) as any;
}

export function getProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl);
}

export function getCampaignsContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.campaigns, DatumCampaignsAbi.abi, provider);
}

export function getPublishersContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.publishers, DatumPublishersAbi.abi, provider);
}

export function getGovernanceV2Contract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.governanceV2, DatumGovernanceV2Abi.abi, provider);
}

export function getGovernanceSlashContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.governanceSlash, DatumGovernanceSlashAbi.abi, provider);
}

export function getSettlementContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.settlement, DatumSettlementAbi.abi, provider);
}

export function getRelayContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.relay, DatumRelayAbi.abi, provider);
}

export function getPauseRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.pauseRegistry, DatumPauseRegistryAbi.abi, provider);
}

export function getTimelockContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.timelock, DatumTimelockAbi.abi, provider);
}

export function getBudgetLedgerContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.budgetLedger, DatumBudgetLedgerAbi.abi, provider);
}

export function getPaymentVaultContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.paymentVault, DatumPaymentVaultAbi.abi, provider);
}

export function getLifecycleContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.lifecycle, DatumCampaignLifecycleAbi.abi, provider);
}

export function getAttestationVerifierContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.attestationVerifier, DatumAttestationVerifierAbi.abi, provider);
}

export function getTargetingRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.targetingRegistry, DatumTargetingRegistryAbi.abi, provider);
}

export function getCampaignValidatorContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.campaignValidator, DatumCampaignValidatorAbi.abi, provider);
}

export function getClaimValidatorContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.claimValidator, DatumClaimValidatorAbi.abi, provider);
}

export function getGovernanceHelperContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.governanceHelper, DatumGovernanceHelperAbi.abi, provider);
}
