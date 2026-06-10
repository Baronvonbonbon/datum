// Signing orchestrator.
//
// Thin wrapper over `walletRpc` for the three signing primitives:
//
//   signTransaction(tx)     → EIP-1559 raw tx hex
//   signTypedData(...)      → EIP-712 signature
//   personalSign(message)   → personal_sign / EIP-191 signature
//
// Every call refreshes the auto-lock idle timer so the wallet doesn't
// lock out from under an active signing flow.

import { TransactionRequest, TypedDataDomain, TypedDataField } from "ethers";
import { walletRpc } from "./transport";
import { touchActivity } from "./unlock";

/// Sign an EIP-1559 transaction with the active account's key.
/// Returns the raw signed-tx hex; caller broadcasts via pineRpc
/// `eth_sendRawTransaction`.
export async function signTransaction(tx: TransactionRequest): Promise<string> {
  touchActivity();
  // Serialize bigints / BigNumberish to JSON-safe shapes. The offscreen
  // host reconstitutes them via ethers `Transaction.from`. The walletRpc
  // message channel is JSON-based so BigInt would otherwise throw.
  const safeTx = serializeTxRequest(tx);
  return walletRpc<string>({
    type: "WALLET_SIGN_TRANSACTION",
    tx: safeTx,
  });
}

export async function signTypedData(
  domain: TypedDataDomain,
  types: Record<string, Array<TypedDataField>>,
  value: Record<string, unknown>
): Promise<string> {
  touchActivity();
  return walletRpc<string>({
    type: "WALLET_SIGN_TYPED_DATA",
    domain: serializeDomain(domain),
    types: types as unknown as Record<string, unknown>,
    value,
  });
}

export async function personalSign(message: string): Promise<string> {
  touchActivity();
  return walletRpc<string>({
    type: "WALLET_PERSONAL_SIGN",
    message,
  });
}

// ─── Serialization helpers ─────────────────────────────────────────────
// JSON.stringify dies on BigInt. We coerce to strings here and let the
// offscreen `Transaction.from` parser turn them back into bigints.

function serializeTxRequest(tx: TransactionRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tx)) {
    out[k] = serializeValue(v);
  }
  return out;
}

function serializeDomain(d: TypedDataDomain): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    out[k] = serializeValue(v);
  }
  return out;
}

function serializeValue(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(serializeValue);
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      out[k] = serializeValue(vv);
    }
    return out;
  }
  return v;
}
