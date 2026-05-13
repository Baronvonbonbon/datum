// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { Contract, JsonRpcApiProvider, JsonRpcProvider, Network, Signer } from "ethers";
import type { JsonRpcPayload, JsonRpcResult, JsonRpcError } from "ethers";
import DatumCampaignsAbi from "./abis/DatumCampaigns.json";
import DatumPublishersAbi from "./abis/DatumPublishers.json";
import DatumGovernanceV2Abi from "./abis/DatumGovernanceV2.json";
import DatumSettlementAbi from "./abis/DatumSettlement.json";
import DatumRelayAbi from "./abis/DatumRelay.json";
import DatumPauseRegistryAbi from "./abis/DatumPauseRegistry.json";
import DatumTimelockAbi from "./abis/DatumTimelock.json";
import DatumBudgetLedgerAbi from "./abis/DatumBudgetLedger.json";
import DatumPaymentVaultAbi from "./abis/DatumPaymentVault.json";
import DatumCampaignLifecycleAbi from "./abis/DatumCampaignLifecycle.json";
import DatumAttestationVerifierAbi from "./abis/DatumAttestationVerifier.json";
import DatumClaimValidatorAbi from "./abis/DatumClaimValidator.json";
import DatumTokenRewardVaultAbi from "./abis/DatumTokenRewardVault.json";
import DatumPublisherStakeAbi from "./abis/DatumPublisherStake.json";
import DatumChallengeBondsAbi from "./abis/DatumChallengeBonds.json";
import DatumPublisherGovernanceAbi from "./abis/DatumPublisherGovernance.json";
import DatumParameterGovernanceAbi from "./abis/DatumParameterGovernance.json";
import DatumClickRegistryAbi from "./abis/DatumClickRegistry.json";
import DatumGovernanceRouterAbi from "./abis/DatumGovernanceRouter.json";
import DatumCouncilAbi from "./abis/DatumCouncil.json";
import DatumZKVerifierAbi from "./abis/DatumZKVerifier.json";
import DatumWrapperAbi from "./abis/DatumWrapper.json";
import DatumMintAuthorityAbi from "./abis/DatumMintAuthority.json";
import DatumBootstrapPoolAbi from "./abis/DatumBootstrapPool.json";
import DatumVestingAbi from "./abis/DatumVesting.json";
import DatumFeeShareAbi from "./abis/DatumFeeShare.json";
import DatumCouncilBlocklistCuratorAbi from "./abis/DatumCouncilBlocklistCurator.json";
import { ContractAddresses } from "./types";

type Provider = JsonRpcProvider | JsonRpcApiProvider;

// ABI JSON files may be either a bare array [...] or a Hardhat artifact { abi: [...] }.
// Normalize so both formats work.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function abi(imported: any): any[] {
  return Array.isArray(imported) ? imported : imported.abi;
}

// Returns any-typed contracts so component code doesn't need casts for dynamic ABI methods.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function make(address: string, abiArr: any[], provider: Provider | Signer): any {
  if (!address) return null;
  return new Contract(address, abiArr, provider) as any;
}

const _providerCache = new Map<string, JsonRpcProvider>();

/** Return a cached JsonRpcProvider for the given URL.
 *  Reusing the same instance prevents useBlock from resetting its polling
 *  interval whenever useContracts recomputes due to unrelated dep changes
 *  (e.g. signer connecting/disconnecting). */
export function getProvider(rpcUrl: string): JsonRpcProvider {
  if (!_providerCache.has(rpcUrl)) {
    _providerCache.set(rpcUrl, new JsonRpcProvider(rpcUrl));
  }
  return _providerCache.get(rpcUrl)!;
}

/** Singleton Pine provider — reused across requests to avoid re-syncing smoldot */
let pineProviderCache: { chain: string; promise: Promise<JsonRpcApiProvider> } | null = null;

// Chain IDs for known Asset Hub networks (mirrors pine-rpc/eth_chainId)
const ASSET_HUB_CHAIN_IDS: Record<string, number> = {
  "paseo-asset-hub": 420420417,
  "polkadot-asset-hub": 420420416,
  "kusama-asset-hub": 420420418,
  "westend-asset-hub": 420420419,
};

/**
 * Minimal interface we need from PineProvider — avoids a static import
 * of the (dynamically loaded) pine-rpc module.
 */
interface PineRequestable {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * Create an ethers v6 JsonRpcApiProvider that delegates all RPC calls to Pine.
 *
 * Uses a closure to capture the Pine provider reference instead of a class field,
 * avoiding potential issues with TypeScript private field compilation and the
 * ethers drain queue mechanism. staticNetwork pins the chain ID so no
 * eth_chainId bootstrap call is needed.
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
            if (import.meta.env.DEV) {
              console.warn(`[Pine] ${p.method} failed:`, err);
            }
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

// ── Pine sync step state — shared across all useContracts instances ──
// Tracks which connection phase Pine is currently in.
// null = not connecting / connected / off.
// Stays at the last active step on failure so the UI can show where it stopped.

export type SyncStep = import("pine-rpc").SyncStep;

let _syncStep: SyncStep | null = null;
const _syncStepCbs = new Set<(s: SyncStep | null) => void>();

function _emitSyncStep(s: SyncStep | null): void {
  _syncStep = s;
  for (const cb of _syncStepCbs) cb(s);
}

/**
 * Subscribe to Pine sync step updates. Immediately invokes cb with the
 * current step so the subscriber is in sync without polling.
 * Returns an unsubscribe function.
 */
export function subscribePineSyncStep(cb: (s: SyncStep | null) => void): () => void {
  _syncStepCbs.add(cb);
  cb(_syncStep);
  return () => { _syncStepCbs.delete(cb); };
}

// ── Pine RPC test result — smoke-test of the ethers↔Pine bridge ──
// Set after getPineProvider resolves; shows block number or error in the UI.

export type PineRpcTest =
  | { ok: true; blockNumber: number }
  | { ok: false; error: string }
  | null;

let _pineRpcTest: PineRpcTest = null;
const _pineRpcTestCbs = new Set<(r: PineRpcTest) => void>();

function _emitPineRpcTest(r: PineRpcTest): void {
  _pineRpcTest = r;
  for (const cb of _pineRpcTestCbs) cb(r);
}

export function subscribePineRpcTest(cb: (r: PineRpcTest) => void): () => void {
  _pineRpcTestCbs.add(cb);
  cb(_pineRpcTest);
  return () => { _pineRpcTestCbs.delete(cb); };
}

/**
 * Get a Pine-backed JsonRpcApiProvider for the given chain.
 * Reuses the same smoldot instance if the chain hasn't changed.
 * Returns null if Pine is not available or fails to connect.
 */
export async function getPineProvider(pineChain: string): Promise<JsonRpcApiProvider | null> {
  try {
    if (pineProviderCache && pineProviderCache.chain === pineChain) {
      return pineProviderCache.promise;
    }
    const promise = (async () => {
      const { PineProvider } = await import("pine-rpc");
      const pine = new PineProvider({ chain: pineChain as import("pine-rpc").ChainPreset });
      await pine.connect((step) => _emitSyncStep(step));
      _emitSyncStep(null); // clear on success — provider is live
      const ethersProvider = createPineEthersProvider(pine, pineChain);
      // Smoke-test: verify the ethers wrapper can actually reach Pine.
      // Result is surfaced in the Settings UI (not just the browser console).
      ethersProvider.getBlockNumber().then(
        (n) => _emitPineRpcTest({ ok: true, blockNumber: n }),
        (err) => _emitPineRpcTest({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return ethersProvider;
    })();
    pineProviderCache = { chain: pineChain, promise };
    return await promise;
  } catch {
    // Pine unavailable — caller should fall back to centralized RPC.
    // Leave _syncStep as-is so the UI can show the step where it failed.
    pineProviderCache = null;
    return null;
  }
}

// Alpha-4: TargetingRegistry, CampaignValidator, Reports, GovernanceHelper merged into Campaigns.
// RateLimiter, Reputation, NullifierRegistry merged into Settlement.
// GovernanceSlash merged into GovernanceV2. AdminGovernance merged into GovernanceRouter.

export function getCampaignsContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.campaigns, abi(DatumCampaignsAbi), provider);
}

export function getPublishersContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.publishers, abi(DatumPublishersAbi), provider);
}

export function getGovernanceV2Contract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.governanceV2, abi(DatumGovernanceV2Abi), provider);
}

export function getSettlementContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.settlement, abi(DatumSettlementAbi), provider);
}

export function getRelayContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.relay, abi(DatumRelayAbi), provider);
}

export function getPauseRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.pauseRegistry, abi(DatumPauseRegistryAbi), provider);
}

export function getTimelockContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.timelock, abi(DatumTimelockAbi), provider);
}

export function getBudgetLedgerContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.budgetLedger, abi(DatumBudgetLedgerAbi), provider);
}

export function getPaymentVaultContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.paymentVault, abi(DatumPaymentVaultAbi), provider);
}

export function getLifecycleContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.lifecycle, abi(DatumCampaignLifecycleAbi), provider);
}

export function getAttestationVerifierContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.attestationVerifier, abi(DatumAttestationVerifierAbi), provider);
}

export function getClaimValidatorContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.claimValidator, abi(DatumClaimValidatorAbi), provider);
}

export function getTokenRewardVaultContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.tokenRewardVault, abi(DatumTokenRewardVaultAbi), provider);
}

export function getPublisherStakeContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.publisherStake, abi(DatumPublisherStakeAbi), provider);
}

export function getChallengeBondsContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.challengeBonds, abi(DatumChallengeBondsAbi), provider);
}

export function getPublisherGovernanceContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.publisherGovernance, abi(DatumPublisherGovernanceAbi), provider);
}

export function getParameterGovernanceContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.parameterGovernance, abi(DatumParameterGovernanceAbi), provider);
}

export function getClickRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.clickRegistry, abi(DatumClickRegistryAbi), provider);
}

export function getGovernanceRouterContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.governanceRouter, abi(DatumGovernanceRouterAbi), provider);
}

export function getCouncilContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.council, abi(DatumCouncilAbi), provider);
}

export function getZKVerifierContract(addresses: ContractAddresses, provider: Provider | Signer) {
  return make(addresses.zkVerifier, abi(DatumZKVerifierAbi), provider);
}

// ── Optional contracts (token system + curator) ───────────────────────────────
//
// Each returns null when the address is unset on this deployment. Call sites
// surface a "feature unavailable on this network" notice rather than
// constructing against the zero address.

export function getWrapperContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.wrapper) return null;
  return make(addresses.wrapper, abi(DatumWrapperAbi), provider);
}

export function getMintAuthorityContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.mintAuthority) return null;
  return make(addresses.mintAuthority, abi(DatumMintAuthorityAbi), provider);
}

export function getBootstrapPoolContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.bootstrapPool) return null;
  return make(addresses.bootstrapPool, abi(DatumBootstrapPoolAbi), provider);
}

export function getVestingContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.vesting) return null;
  return make(addresses.vesting, abi(DatumVestingAbi), provider);
}

export function getFeeShareContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.feeShare) return null;
  return make(addresses.feeShare, abi(DatumFeeShareAbi), provider);
}

export function getCouncilBlocklistCuratorContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.councilBlocklistCurator) return null;
  return make(addresses.councilBlocklistCurator, abi(DatumCouncilBlocklistCuratorAbi), provider);
}
