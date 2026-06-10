// OffscreenSigner — an ethers Signer backed by the offscreen wallet (via walletClient),
// not the legacy in-popup key. The wallet-shell architecture keeps the private key in
// the offscreen document, so the popup must ask the offscreen to sign/broadcast rather
// than holding a Wallet itself. This is a drop-in replacement for the old
// walletManager.getSigner() (whose getUnlockedWallet() is always empty now), so claim
// submission + the "Sign for Publisher" EIP-712 path work again.
//
// - signTypedData / signMessage / signTransaction → forwarded to the offscreen signer
// - sendTransaction → offscreen `sendContract` (it fills nonce/gas, signs, broadcasts
//   via pine); callers that poll Paseo by nonce (waitForTxPaseo) ignore the response
//   beyond its hash, so a lightweight TransactionResponse is sufficient.

import {
  AbstractSigner,
  TransactionResponse,
  hexlify,
  resolveAddress,
  type Provider,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import { walletClient } from "../popup/wallet/walletClient";

export class OffscreenSigner extends AbstractSigner {
  /** Active account address (synchronous — callers read signer.address). */
  readonly address: string;

  constructor(address: string, provider: Provider | null = null) {
    super(provider ?? undefined);
    this.address = address;
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  connect(provider: Provider | null): OffscreenSigner {
    return new OffscreenSigner(this.address, provider);
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    return walletClient.personalSign(typeof message === "string" ? message : hexlify(message));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, any>): Promise<string> {
    return walletClient.signTypedData({ domain, types, value });
  }

  async signTransaction(tx: TransactionRequest): Promise<string> {
    return walletClient.signTransaction(tx);
  }

  async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    const to = tx.to ? await resolveAddress(tx.to, this.provider ?? undefined) : undefined;
    const data = (tx.data as string) ?? "0x";
    const valueWei = tx.value != null ? BigInt(tx.value).toString() : "0";
    const gasLimit = tx.gasLimit != null ? Number(BigInt(tx.gasLimit)) : undefined;

    const res = await walletClient.sendContract({ to: to ?? "", data, valueWei, gasLimit });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = res as any;
    const hash: string = r.txHash ?? r.hash;

    // Prefer the real response if the node returns it; Paseo's eth_getTransaction
    // often lags/returns null, so fall back to a minimal response carrying the hash.
    if (this.provider) {
      try {
        const real = await this.provider.getTransaction(hash);
        if (real) return real;
      } catch { /* fall through to synthetic */ }
    }
    // Minimal response — callers using waitForTxPaseo only read `.hash`.
    return new TransactionResponse(
      {
        hash,
        blockNumber: null,
        blockHash: null,
        index: 0,
        type: 2,
        to: to ?? null,
        from: this.address,
        nonce: typeof r.nonce === "number" ? r.nonce : 0,
        gasLimit: BigInt(gasLimit ?? 0),
        gasPrice: null,
        maxPriorityFeePerGas: null,
        maxFeePerGas: null,
        maxFeePerBlobGas: null,
        data,
        value: BigInt(valueWei),
        chainId: 420420417n,
        signature: null,
        accessList: null,
        blobVersionedHashes: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      this.provider!,
    );
  }
}
