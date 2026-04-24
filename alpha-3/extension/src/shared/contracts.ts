import { Contract, JsonRpcProvider, JsonRpcApiProvider, Network, Signer, InterfaceAbi } from "ethers";
import type { JsonRpcPayload, JsonRpcResult, JsonRpcError } from "ethers";
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
import DatumPublisherStakeAbi from "./abis/DatumPublisherStake.json";
import DatumChallengeBondsAbi from "./abis/DatumChallengeBonds.json";
import DatumPublisherGovernanceAbi from "./abis/DatumPublisherGovernance.json";
import DatumNullifierRegistryAbi from "./abis/DatumNullifierRegistry.json";
import DatumParameterGovernanceAbi from "./abis/DatumParameterGovernance.json";
import DatumClickRegistryAbi from "./abis/DatumClickRegistry.json";
import { ContractAddresses } from "./types";

type Provider = JsonRpcProvider | JsonRpcApiProvider;

// ABI JSON files may be either a bare array [...] or a Hardhat artifact { abi: [...] }.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function abi(imported: any): InterfaceAbi {
  return Array.isArray(imported) ? imported : imported.abi;
}

// ── Provider cache — stable instances prevent spurious poll resets ──────────

const _providerCache = new Map<string, JsonRpcProvider>();

/** Return a cached JsonRpcProvider for the given URL. */
export function getProvider(rpcUrl: string): JsonRpcProvider {
  if (!_providerCache.has(rpcUrl)) {
    _providerCache.set(rpcUrl, new JsonRpcProvider(rpcUrl));
  }
  return _providerCache.get(rpcUrl)!;
}

// ── Pine / smoldot light-client provider ─────────────────────────────────────

// Chain IDs for known Asset Hub networks (mirrors pine-rpc/eth_chainId)
const ASSET_HUB_CHAIN_IDS: Record<string, number> = {
  "paseo-asset-hub":    420420417,
  "polkadot-asset-hub": 420420416,
  "kusama-asset-hub":   420420418,
  "westend-asset-hub":  420420419,
};

interface PineRequestable {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * Create an ethers v6 JsonRpcApiProvider that delegates all RPC calls to Pine.
 *
 * staticNetwork pins the chain ID so no eth_chainId bootstrap call is needed.
 * Custom _send() routes each payload through pine.request() individually,
 * which is what smoldot expects (no JSON-RPC batch support).
 */
function createPineEthersProvider(pine: PineRequestable, chain: string): JsonRpcApiProvider {
  const chainId = BigInt(ASSET_HUB_CHAIN_IDS[chain] ?? 420420417);
  const network = new Network(chain, chainId);

  class PineEthersProvider extends JsonRpcApiProvider {
    constructor() {
      super(network, { staticNetwork: network });
      this._start();
    }

    async _send(
      payload: JsonRpcPayload | Array<JsonRpcPayload>,
    ): Promise<Array<JsonRpcResult | JsonRpcError>> {
      const payloads = Array.isArray(payload) ? payload : [payload];
      return Promise.all(
        payloads.map(async (p): Promise<JsonRpcResult | JsonRpcError> => {
          try {
            const result = await pine.request({
              method: p.method,
              params: p.params as unknown[],
            });
            return { id: p.id, result };
          } catch (err) {
            const code = (err as { code?: number })?.code ?? -32603;
            const message = err instanceof Error ? err.message : "Internal error";
            return { id: p.id, error: { code, message } };
          }
        }),
      );
    }
  }

  return new PineEthersProvider();
}

/** Singleton Pine provider — reused across requests to avoid re-syncing smoldot */
let pineProviderCache: { chain: string; promise: Promise<JsonRpcApiProvider> } | null = null;

/**
 * Get a Pine-backed JsonRpcApiProvider for the given chain.
 * Reuses the same smoldot instance if the chain hasn't changed.
 * Returns null if Pine is not available or fails to connect.
 *
 * @param onStep  Optional callback for smoldot sync progress steps.
 */
export async function getPineProvider(
  pineChain: string,
  onStep?: (step: import("pine-rpc").SyncStep) => void,
): Promise<JsonRpcApiProvider | null> {
  try {
    if (pineProviderCache && pineProviderCache.chain === pineChain) {
      return pineProviderCache.promise;
    }
    const promise = (async () => {
      const { PineProvider } = await import("pine-rpc");
      const pine = new PineProvider({ chain: pineChain as import("pine-rpc").ChainPreset });
      await pine.connect(onStep ? (step) => onStep(step) : undefined);
      return createPineEthersProvider(pine, pineChain);
    })();
    pineProviderCache = { chain: pineChain, promise };
    return await promise;
  } catch {
    pineProviderCache = null;
    return null;
  }
}

/**
 * Get a read-only provider, preferring Pine when usePine is true and the
 * network has a pineChain configured. Falls back to centralized RPC.
 */
export async function getReadProvider(
  rpcUrl: string,
  usePine: boolean,
  pineChain?: string,
  onStep?: (step: import("pine-rpc").SyncStep) => void,
): Promise<Provider> {
  if (usePine && pineChain) {
    const pine = await getPineProvider(pineChain, onStep);
    if (pine) return pine;
  }
  return getProvider(rpcUrl);
}

// ── Contract factories ────────────────────────────────────────────────────────

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

export function getPublisherStakeContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.publisherStake, abi(DatumPublisherStakeAbi), provider);
}

export function getChallengeBondsContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.challengeBonds, abi(DatumChallengeBondsAbi), provider);
}

export function getPublisherGovernanceContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.publisherGovernance, abi(DatumPublisherGovernanceAbi), provider);
}

export function getNullifierRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.nullifierRegistry, abi(DatumNullifierRegistryAbi), provider);
}

export function getParameterGovernanceContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.parameterGovernance, abi(DatumParameterGovernanceAbi), provider);
}

export function getClickRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return new Contract(addresses.clickRegistry, abi(DatumClickRegistryAbi), provider);
}
