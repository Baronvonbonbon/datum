declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string>,
      wasm: Uint8Array | string,
      zkey: Uint8Array | string,
    ): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>;
  };
}
