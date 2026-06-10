import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TYPEHASH_STRINGS } from "../src/shared/wireFormat";

// SSOT drift gate (RUNBOOK Phase 3). Reads the EIP-712 typehash STRINGS directly
// out of the deployed Solidity sources and asserts the canonical wireFormat
// module reconstructs each one byte-for-byte. If a contract typehash changes
// (e.g. the SLIM-#2 firstNonce addition) without updating wireFormat.ts, this
// fails in CI — exactly the drift that previously slipped through to the
// relay-bot / extension unnoticed.
const ROOT = resolve(__dirname, "../..");
function sol(rel: string): string {
  return readFileSync(resolve(ROOT, "alpha-core/contracts", rel), "utf-8");
}

// Pull every  "TypeName(...)"  quoted EIP-712 preimage out of a contract source.
function typehashStrings(src: string): string[] {
  const out: string[] = [];
  const re = /"((?:ClaimBatch|PublisherAttestation)\([^"]*\))"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe("wireFormat SSOT — canonical typehashes match the contracts", () => {
  it("PublisherAttestation matches DatumAttestationVerifier AND DatumRelay", () => {
    const av = typehashStrings(sol("DatumAttestationVerifier.sol")).filter((s) => s.startsWith("PublisherAttestation"));
    const relay = typehashStrings(sol("DatumRelay.sol")).filter((s) => s.startsWith("PublisherAttestation"));
    expect(av, "AttestationVerifier has a PublisherAttestation typehash").to.have.length.greaterThan(0);
    expect(relay, "Relay has a PublisherAttestation typehash").to.have.length.greaterThan(0);
    // both domains use the identical field layout
    for (const s of [...av, ...relay]) expect(s).to.equal(TYPEHASH_STRINGS.PublisherAttestation);
  });

  it("relay-path ClaimBatch matches DatumRelay.BATCH_TYPEHASH", () => {
    const relay = typehashStrings(sol("DatumRelay.sol")).filter((s) => s.startsWith("ClaimBatch"));
    expect(relay).to.include(TYPEHASH_STRINGS.RelayClaimBatch);
  });

  it("dual-sig ClaimBatch matches DatumDualSigSettlement.CLAIM_BATCH_TYPEHASH", () => {
    const ds = typehashStrings(sol("DatumDualSigSettlement.sol")).filter((s) => s.startsWith("ClaimBatch"));
    expect(ds).to.include(TYPEHASH_STRINGS.DualSigClaimBatch);
  });

  it("the two ClaimBatch variants are distinct (relay range-sig vs dual-sig content-hash)", () => {
    expect(TYPEHASH_STRINGS.RelayClaimBatch).to.not.equal(TYPEHASH_STRINGS.DualSigClaimBatch);
  });
});

// ── Off-chain consumer drift ─────────────────────────────────────────────────
// Extract every EIP-712 type def from the in-repo off-chain signers and assert
// it matches the canonical typehash. This is the gate that catches an off-chain
// consumer lagging the contracts (the relay-bot / reseed-demo / extension drift).
import { eip712TypeString, type Eip712Field } from "../src/shared/wireFormat";

function readRepo(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf-8");
}

/** Pull each `{ name: "x", type: "y" }` (order-insensitive) field out of a block. */
function extractFields(block: string): Eip712Field[] {
  const out: Eip712Field[] = [];
  const objRe = /\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(block)) !== null) {
    const name = /name\s*:\s*["']([^"']+)["']/.exec(m[1])?.[1];
    const type = /type\s*:\s*["']([^"']+)["']/.exec(m[1])?.[1];
    if (name && type) out.push({ name, type });
  }
  return out;
}

/** Reconstruct every `<TypeName>: [ … ]` EIP-712 type string in a source file. */
function consumerTypes(src: string, typeName: string): string[] {
  const re = new RegExp(typeName + "\\s*:\\s*\\[([\\s\\S]*?)\\]", "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const fields = extractFields(m[1]);
    if (fields.length) out.push(eip712TypeString(typeName, fields));
  }
  return out;
}

const CONSUMERS = [
  "docs/relay-bot-template/relay-bot.mjs",
  "alpha-core/scripts/reseed-demo.mjs",
  "web/src/lib/extensionDaemon.ts",
];

describe("wireFormat SSOT — off-chain consumers match the canonical typehashes", () => {
  for (const file of CONSUMERS) {
    it(`${file}: every PublisherAttestation/ClaimBatch type matches the canonical`, () => {
      const src = readRepo(file);
      for (const s of consumerTypes(src, "PublisherAttestation")) {
        expect(s, `${file} PublisherAttestation`).to.equal(TYPEHASH_STRINGS.PublisherAttestation);
      }
      for (const s of consumerTypes(src, "ClaimBatch")) {
        // a ClaimBatch must be one of the two known-good variants
        expect(
          [TYPEHASH_STRINGS.RelayClaimBatch, TYPEHASH_STRINGS.DualSigClaimBatch],
          `${file} ClaimBatch "${s}"`,
        ).to.include(s);
      }
    });
  }
});
