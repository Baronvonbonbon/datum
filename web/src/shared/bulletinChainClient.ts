// PAPI client + extrinsic wrappers for the Polkadot Bulletin Chain (Phase A, F2).
//
// Browser-side; signing uses the polkadot.js extension (or any other PJS-compatible
// extension) via @polkadot-api/pjs-signer. Node-side (the renewer bot) reuses
// `connectBulletin` + `storeOnBulletin` / `renewOnBulletin` with an hdkd-derived
// signer instead — see relay-bot/ (F7).
//
// Bulletin Chain has no native token, no signed-extension fees. Auth is gated
// by the Root-issued `Authorizations` storage map keyed by account. On Paseo
// the faucet UI grants auth (https://paritytech.github.io/polkadot-bulletin-chain/);
// on mainnet OpenGov does. PoP-based auth is on the roadmap.
//
// No codegen required: we use `client.getUnsafeApi()` to call the
// `TransactionStorage` pallet's `store` and `renew` extrinsics by name. When
// `npx papi add bulletin` codegen lands, swap the unsafe API for a typed one
// at the call sites without changing this file's public surface.

import { createClient, PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  connectInjectedExtension,
  getInjectedExtensions,
  InjectedExtension,
  InjectedPolkadotAccount,
} from "polkadot-api/pjs-signer";
import { PASEO_BULLETIN_RPC, BulletinCodec, bulletinCidFromDigest } from "./bulletinChain";

// ── Client ────────────────────────────────────────────────────────────────────

/** Lazily-created Bulletin Chain client. Re-used across calls in the same
 *  browser session to avoid reconnect churn. */
let _client: ReturnType<typeof createClient> | null = null;
let _clientRpc: string | null = null;

/**
 * Connect (or re-use a connection) to the Bulletin Chain RPC.
 *
 * @param rpcUrl  Optional override; defaults to PASEO_BULLETIN_RPC.
 */
export function connectBulletin(rpcUrl: string = PASEO_BULLETIN_RPC) {
  if (_client && _clientRpc === rpcUrl) return _client;
  if (_client) _client.destroy();
  const provider = getWsProvider(rpcUrl);
  _client = createClient(provider);
  _clientRpc = rpcUrl;
  return _client;
}

/** Tear down the cached connection. Call this on app shutdown / network switch. */
export function disconnectBulletin() {
  if (_client) {
    _client.destroy();
    _client = null;
    _clientRpc = null;
  }
}

// ── Browser-side signer (polkadot.js extension) ──────────────────────────────

/** List the names of PJS-compatible extensions installed in the user's browser. */
export async function listInjectedExtensions(): Promise<string[]> {
  return getInjectedExtensions();
}

/**
 * Connect to an injected extension by name (e.g. "polkadot-js", "talisman",
 * "subwallet-js", "fearless") and return the accounts + a signer factory.
 */
export async function connectExtension(name: string): Promise<{
  extension: InjectedExtension;
  accounts: InjectedPolkadotAccount[];
}> {
  const extension = await connectInjectedExtension(name);
  const accounts = extension.getAccounts();
  return { extension, accounts };
}

/** Extract a PolkadotSigner from a PJS InjectedPolkadotAccount.
 *  The account already carries a ready-to-use signer; this is a thin alias
 *  for self-documenting call sites. */
export function signerFor(account: InjectedPolkadotAccount): PolkadotSigner {
  return account.polkadotSigner;
}

// ── Untyped Bulletin Chain pallet shapes ──────────────────────────────────────
//
// Until `npx papi add bulletin` codegen is committed, we use the untyped API.
// Shapes below match the transactionStorage pallet on Paseo Bulletin Chain.

interface BulletinUnsafeApi {
  tx: {
    TransactionStorage: {
      store: (args: { data: Uint8Array }) => {
        signAndSubmit: (signer: PolkadotSigner) => Promise<BulletinTxResult>;
      };
      renew: (args: { block: number; index: number }) => {
        signAndSubmit: (signer: PolkadotSigner) => Promise<BulletinTxResult>;
      };
    };
  };
  query: {
    TransactionStorage: {
      Authorizations: {
        getValue: (address: string) => Promise<number | undefined>;
      };
      ByteFee: { getValue: () => Promise<bigint> };
      EntryFee: { getValue: () => Promise<bigint> };
      RetentionPeriod: { getValue: () => Promise<number> };
    };
  };
}

interface BulletinTxResult {
  txHash: string;
  block: { hash: string; number: number };
  events: Array<{
    type: string;
    value: { type: string; value: any };
  }>;
  ok: boolean;
}

// ── Extrinsic wrappers ────────────────────────────────────────────────────────

/** Result of a successful `transactionStorage.store` extrinsic. */
export interface StoreResult {
  /** Bulletin Chain block where the store transaction landed. */
  bulletinBlock: number;
  /** Index of the transaction within that block. */
  bulletinIndex: number;
  /** Hex digest (0x...) extracted from the Stored event. */
  cidDigest: string;
  /** CID codec used (raw or dag-pb). */
  cidCodec: BulletinCodec;
  /** Full reconstructed CIDv1 string (for display / gateway URLs). */
  cid: string;
  /** Bulletin Chain transaction hash. */
  txHash: string;
}

/**
 * Submit a `transactionStorage.store(data)` extrinsic and extract the
 * resulting `(block, index, contentHash)` triple from the `Stored` event.
 *
 * @param data    Raw bytes to store (≤ ~8 MiB per Paseo limits).
 * @param signer  PolkadotSigner with valid Bulletin Chain authorization.
 * @returns       StoreResult — the triple that should be pushed to
 *                `DatumCampaigns.setBulletinCreative` on Hub.
 */
export async function storeOnBulletin(
  data: Uint8Array,
  signer: PolkadotSigner,
  rpcUrl?: string,
): Promise<StoreResult> {
  const client = connectBulletin(rpcUrl);
  const api = client.getUnsafeApi() as unknown as BulletinUnsafeApi;

  const result = await api.tx.TransactionStorage
    .store({ data })
    .signAndSubmit(signer);

  if (!result.ok) {
    throw new Error("Bulletin Chain store extrinsic reverted");
  }

  // Find the Stored event in the result.
  const stored = result.events.find(
    (e) => e.type === "TransactionStorage" && e.value?.type === "Stored",
  );
  if (!stored) {
    throw new Error("transactionStorage.Stored event not found in receipt");
  }

  // The Stored event carries `{ index, contentHash, ... }`. The block is the
  // result.block.number. Default config is Blake2b-256 raw — codec = 0.
  const ev = stored.value.value;
  const index: number = ev.index ?? ev.transactionIndex ?? 0;
  const contentHash: string = normalizeHash(ev.contentHash ?? ev.hash);
  const codec = BulletinCodec.Raw; // Default config; chunked uploads use DagPb (F3 may override)

  return {
    bulletinBlock: result.block.number,
    bulletinIndex: index,
    cidDigest: contentHash,
    cidCodec: codec,
    cid: bulletinCidFromDigest(contentHash, codec),
    txHash: result.txHash,
  };
}

/** Result of a successful `transactionStorage.renew` extrinsic. */
export interface RenewResult {
  /** New Bulletin Chain block number for the renewed entry. */
  newBulletinBlock: number;
  /** New index within that block. */
  newBulletinIndex: number;
  /** Bulletin Chain transaction hash. */
  txHash: string;
}

/**
 * Submit `transactionStorage.renew(block, index)` and extract the new
 * `(block, index)` pair from the Renewed event.
 *
 * NOTE: each renewal generates a NEW (block, index). The caller must update
 * any cached references (and push the new values to Hub via
 * `DatumCampaigns.confirmBulletinRenewal`). Using the old pair again will fail.
 */
export async function renewOnBulletin(
  oldBlock: number,
  oldIndex: number,
  signer: PolkadotSigner,
  rpcUrl?: string,
): Promise<RenewResult> {
  const client = connectBulletin(rpcUrl);
  const api = client.getUnsafeApi() as unknown as BulletinUnsafeApi;

  const result = await api.tx.TransactionStorage
    .renew({ block: oldBlock, index: oldIndex })
    .signAndSubmit(signer);

  if (!result.ok) {
    throw new Error("Bulletin Chain renew extrinsic reverted");
  }

  const renewed = result.events.find(
    (e) => e.type === "TransactionStorage" && e.value?.type === "Renewed",
  );
  if (!renewed) {
    throw new Error("transactionStorage.Renewed event not found in receipt");
  }

  const ev = renewed.value.value;
  const newIndex: number = ev.index ?? ev.transactionIndex ?? 0;

  return {
    newBulletinBlock: result.block.number,
    newBulletinIndex: newIndex,
    txHash: result.txHash,
  };
}

// ── Authorization view ────────────────────────────────────────────────────────

/** Lightweight view of an account's storage authorization on Bulletin Chain. */
export interface AuthorizationInfo {
  /** True if the account has any current authorization. */
  authorized: boolean;
  /** Bulletin Chain block number at which the authorization expires.
   *  Undefined when the account has no authorization. */
  expirationBlock?: number;
}

/**
 * Check whether an account is currently authorized to store on Bulletin Chain.
 * Off-chain UIs use this to gate the upload flow ("authorize via faucet first").
 */
export async function getAuthorization(
  address: string,
  rpcUrl?: string,
): Promise<AuthorizationInfo> {
  const client = connectBulletin(rpcUrl);
  const api = client.getUnsafeApi() as unknown as BulletinUnsafeApi;
  try {
    const expiration = await api.query.TransactionStorage.Authorizations.getValue(address);
    if (expiration === undefined || expiration === null) {
      return { authorized: false };
    }
    return { authorized: true, expirationBlock: Number(expiration) };
  } catch {
    return { authorized: false };
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function normalizeHash(input: unknown): string {
  if (typeof input === "string") {
    return input.startsWith("0x") ? input : "0x" + input;
  }
  if (input instanceof Uint8Array) {
    let s = "0x";
    for (let i = 0; i < input.length; i++) s += input[i].toString(16).padStart(2, "0");
    return s;
  }
  // PAPI Binary type carries asHex()
  if (input && typeof input === "object" && "asHex" in input && typeof (input as any).asHex === "function") {
    return (input as any).asHex();
  }
  throw new Error("Unexpected contentHash shape from Bulletin Chain");
}
