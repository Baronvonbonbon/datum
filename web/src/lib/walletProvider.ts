import { ethers, JsonRpcProvider, Signer, Wallet } from "ethers";

export type ConnectionMethod = "datum" | "injected" | "manual";

export interface WalletConnection {
  address: string;
  signer: Signer;
  method: ConnectionMethod;
}

declare global {
  interface Window {
    datum?: {
      isConnected: () => boolean;
      getAddress: () => Promise<string>;
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
      selectedAddress?: string;
    };
  }
}

export function isDatumExtensionAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.datum !== "undefined";
}

export function isInjectedProviderAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.ethereum !== "undefined";
}

export async function connectDatum(): Promise<WalletConnection> {
  if (!window.datum) throw new Error("DATUM extension not detected");
  if (!window.datum.isConnected()) throw new Error("DATUM extension is locked. Unlock it first.");
  const address = await window.datum.getAddress();
  // Wrap window.datum in an EIP-1193-compatible BrowserProvider
  const provider = new ethers.BrowserProvider(window.datum as never);
  const signer = await provider.getSigner();
  return { address, signer, method: "datum" };
}

export async function connectInjected(): Promise<WalletConnection> {
  if (!window.ethereum) throw new Error("No injected wallet detected (MetaMask, SubWallet, etc.)");
  await window.ethereum.request({ method: "eth_requestAccounts" });
  const provider = new ethers.BrowserProvider(window.ethereum as never);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  return { address, signer, method: "injected" };
}

export function connectManual(privateKey: string, rpcUrl: string): WalletConnection {
  let key = privateKey.trim();
  if (!key.startsWith("0x")) key = "0x" + key;
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(key, provider);
  return { address: wallet.address, signer: wallet, method: "manual" };
}
