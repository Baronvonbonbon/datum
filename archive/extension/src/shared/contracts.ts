import { Contract, JsonRpcProvider, Signer } from "ethers";
import DatumCampaignsAbi from "./abis/DatumCampaigns.json";
import DatumPublishersAbi from "./abis/DatumPublishers.json";
import DatumGovernanceVotingAbi from "./abis/DatumGovernanceVoting.json";
import DatumGovernanceRewardsAbi from "./abis/DatumGovernanceRewards.json";
import DatumSettlementAbi from "./abis/DatumSettlement.json";
import DatumRelayAbi from "./abis/DatumRelay.json";
import { ContractAddresses } from "./types";

type Provider = JsonRpcProvider;

export function getCampaignsContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.campaigns, DatumCampaignsAbi.abi, provider);
}

export function getPublishersContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.publishers, DatumPublishersAbi.abi, provider);
}

export function getGovernanceVotingContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.governanceVoting, DatumGovernanceVotingAbi.abi, provider);
}

export function getGovernanceRewardsContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.governanceRewards, DatumGovernanceRewardsAbi.abi, provider);
}

export function getSettlementContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.settlement, DatumSettlementAbi.abi, provider);
}

export function getRelayContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.relay, DatumRelayAbi.abi, provider);
}

// Helper: create a read-only provider for the given RPC URL
export function getProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl);
}
