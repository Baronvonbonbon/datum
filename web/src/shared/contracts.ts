// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { Contract, JsonRpcApiProvider, JsonRpcProvider, Network, Signer, keccak256, toUtf8Bytes } from "ethers";
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
import DatumCampaignCreativeAbi from "./abis/DatumCampaignCreative.json";
import DatumPowEngineAbi from "./abis/DatumPowEngine.json";
import DatumNullifierRegistryAbi from "./abis/DatumNullifierRegistry.json";
import DatumSettlementRateLimiterAbi from "./abis/DatumSettlementRateLimiter.json";
import DatumPublisherReputationAbi from "./abis/DatumPublisherReputation.json";
import DatumTagSystemAbi from "./abis/DatumTagSystem.json";
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
import DatumVestingAbi from "./abis/DatumVesting.json";
import DatumFeeShareAbi from "./abis/DatumFeeShare.json";
import DatumCouncilBlocklistCuratorAbi from "./abis/DatumCouncilBlocklistCurator.json";
import DatumBrandRegistryAbi from "./abis/DatumBrandRegistry.json";
import DatumBrandCuratorAbi from "./abis/DatumBrandCurator.json";
import DatumPeopleChainIdentityAbi from "./abis/DatumPeopleChainIdentity.json";
import DatumPeopleChainXcmBridgeAbi from "./abis/DatumPeopleChainXcmBridge.json";
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
    /** Marker so callers can detect Pine without instanceof through a closure. */
    readonly __isPine = true;
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

export function getCampaignCreativeContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.campaignCreative) return null;
  return make(addresses.campaignCreative, abi(DatumCampaignCreativeAbi), provider);
}

export function getPowEngineContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.powEngine) return null;
  return make(addresses.powEngine, abi(DatumPowEngineAbi), provider);
}

export function getNullifierRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.nullifierRegistry) return null;
  return make(addresses.nullifierRegistry, abi(DatumNullifierRegistryAbi), provider);
}

export function getSettlementRateLimiterContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.settlementRateLimiter) return null;
  return make(addresses.settlementRateLimiter, abi(DatumSettlementRateLimiterAbi), provider);
}

export function getPublisherReputationContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.publisherReputation) return null;
  return make(addresses.publisherReputation, abi(DatumPublisherReputationAbi), provider);
}

export function getTagSystemContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.tagSystem) return null;
  return make(addresses.tagSystem, abi(DatumTagSystemAbi), provider);
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

export function getBrandRegistryContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.brandRegistry) return null;
  return make(addresses.brandRegistry, abi(DatumBrandRegistryAbi), provider);
}

export function getBrandCuratorContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.brandCurator) return null;
  return make(addresses.brandCurator, abi(DatumBrandCuratorAbi), provider);
}

export function getPeopleChainIdentityContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.peopleChainIdentity) return null;
  return make(addresses.peopleChainIdentity, abi(DatumPeopleChainIdentityAbi), provider);
}

export function getPeopleChainXcmBridgeContract(addresses: ContractAddresses, provider: Provider | Signer) {
  if (!addresses.peopleChainXcmBridge) return null;
  return make(addresses.peopleChainXcmBridge, abi(DatumPeopleChainXcmBridgeAbi), provider);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5b: live address resolution via DatumGovernanceRouter.contractAddr().
//
// Reads each contract's current address from the on-chain registry and returns
// a merged ContractAddresses object. Slots not populated in the router (e.g.,
// fresh deployments before register() ran) fall back to the JSON addresses
// in `fallback`.
//
// The router itself is read from the JSON address — it's the trust root, so
// we never resolve its own address through itself.
// ─────────────────────────────────────────────────────────────────────────────

/// Contract names matched against router slots. Must mirror the
/// UPGRADABLE_KEYS list in alpha-4/scripts/deploy.ts.
const ROUTER_SLOT_NAMES: (keyof ContractAddresses)[] = [
  "pauseRegistry",
  "campaigns",
  "settlement",
  "publishers",
  "campaignLifecycle",
  "budgetLedger",
  "paymentVault",
  "relay",
  "zkVerifier",
  "claimValidator",
  "tokenRewardVault",
  "publisherStake",
  "challengeBonds",
  "publisherGovernance",
  "parameterGovernance",
  "council",
  "clickRegistry",
  "councilBlocklistCurator",   // registered name = "blocklistCurator" — see fallback
  "activationBonds",
  "stakeRoot",
  "stakeRootV2",
  "identityVerifier",
  "emissionEngine",
  "peopleChainIdentity",
  "peopleChainXcmBridge",
  "peopleChainBondedReporter",
  "governanceV2",
  "timelock",
  "campaignCreative",
  "powEngine",
  "nullifierRegistry",
  "settlementRateLimiter",
  "publisherReputation",
  "tagSystem",
  // Registry-only slots (not part of the upgrade ladder, but registered so the
  // webapp can resolve them from the router too — see REGISTRY_ONLY_KEYS in
  // deploy.ts / register-registry-backfill.ts). Resolution falls back to the
  // bundled address when a slot is still zero, so listing these is safe even
  // before a deploy/backfill has populated them.
  "attestationVerifier",
  "advertiserStake",
  "advertiserGovernance",
  "interestCommitments",
  "tagCurator",
  "relayStake",
  "relayGovernance",
  "wrapper",
  "mintAuthority",
  "vesting",
  "feeShare",
  "brandRegistry",
  "brandCurator",
];

/// Core slots that must always be registered on a live deploy. If the router
/// returns zero for these, it's not this deployment's router (or predates
/// register()) — surfaced via RouterHealth so the UI can warn.
const CORE_ROUTER_SLOTS: (keyof ContractAddresses)[] = ["campaigns", "settlement", "publishers"];

/// Maps a few keys whose JSON name in ContractAddresses differs from the
/// router slot name (the deploy script registers them under a shorter key).
const ROUTER_NAME_OVERRIDES: Record<string, string> = {
  councilBlocklistCurator: "blocklistCurator",
};

// ── Router health — Option B staleness/inconsistency guard ──────────────────
// Published after each resolveAddressesFromRouter pass so a banner can warn
// when the configured router looks wrong. Note: a stale-but-alive previous
// deploy can't be detected from chain alone (its contracts still answer), so
// the real safeguard is keeping the router address fresh — but an EMPTY
// registry or a DEAD resolved core contract are both reliably catchable.
export type RouterHealth = {
  /** Configured router returned zero for a core slot → wrong/old router address. */
  registryEmpty: boolean;
  /** Resolved core contract address has no bytecode → deploy wiped/replaced. */
  deadCore: boolean;
  /** Slots where the live registry differs from the bundled seed (informational —
   *  expected after a governance upgrade, or when the webapp seed is behind). */
  upgraded: { key: string; seed: string; live: string }[];
  checkedAt: number;
} | null;

let _routerHealth: RouterHealth = null;
const _routerHealthCbs = new Set<(h: RouterHealth) => void>();

function _emitRouterHealth(h: RouterHealth): void {
  _routerHealth = h;
  for (const cb of _routerHealthCbs) cb(h);
}

export function getRouterHealth(): RouterHealth {
  return _routerHealth;
}

export function subscribeRouterHealth(cb: (h: RouterHealth) => void): () => void {
  _routerHealthCbs.add(cb);
  cb(_routerHealth);
  return () => { _routerHealthCbs.delete(cb); };
}

/// Resolve the live registered address for each Upgradable contract via the
/// router. Falls back to the JSON address when the slot is empty. Errors are
/// non-fatal — any failed read keeps the JSON address.
export async function resolveAddressesFromRouter(
  fallback: ContractAddresses,
  provider: Provider,
): Promise<ContractAddresses> {
  if (!fallback.governanceRouter) return fallback;
  let router;
  try {
    router = make(fallback.governanceRouter, abi(DatumGovernanceRouterAbi), provider);
  } catch {
    return fallback;
  }
  const out: ContractAddresses = { ...fallback };
  const ZERO = "0x0000000000000000000000000000000000000000";
  const resolvedZeroCore: string[] = [];
  const upgraded: { key: string; seed: string; live: string }[] = [];
  for (const key of ROUTER_SLOT_NAMES) {
    const slotName = ROUTER_NAME_OVERRIDES[key as string] ?? (key as string);
    const slotHash = keccak256(toUtf8Bytes(slotName));
    try {
      const live: string = await router.currentAddrOf(slotHash);
      if (live && live.toLowerCase() !== ZERO) {
        const seed = (fallback as any)[key] as string | undefined;
        if (seed && seed.toLowerCase() !== live.toLowerCase()) {
          upgraded.push({ key: key as string, seed, live });
        }
        (out as any)[key] = live;
      } else if (CORE_ROUTER_SLOTS.includes(key)) {
        resolvedZeroCore.push(key as string);
      }
    } catch {
      // network or call error — keep fallback
    }
  }

  // ── Health check (Option B) ──────────────────────────────────────────────
  const registryEmpty = resolvedZeroCore.length > 0;
  let deadCore = false;
  if (!registryEmpty && out.campaigns) {
    // Single cheap liveness probe on the resolved core: no bytecode ⇒ the
    // deploy this router points at is gone.
    try {
      const code = await provider.getCode(out.campaigns);
      deadCore = !code || code === "0x";
    } catch { /* provider hiccup — don't flag */ }
  }
  _emitRouterHealth({ registryEmpty, deadCore, upgraded, checkedAt: Date.now() });
  if (registryEmpty) {
    console.warn(
      `[router] configured governanceRouter ${fallback.governanceRouter} returned no address for core slot(s) ` +
      `[${resolvedZeroCore.join(", ")}] — it may be the wrong/old router. Check networks.ts / Settings.`,
    );
  } else if (deadCore) {
    console.warn(`[router] resolved campaigns ${out.campaigns} has no bytecode — deploy may be wiped.`);
  } else if (upgraded.length) {
    console.info(`[router] ${upgraded.length} slot(s) resolved newer than the bundled seed:`, upgraded);
  }

  return out;
}
