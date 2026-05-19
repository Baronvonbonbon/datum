// Table-driven test for the pure assurance-gate gradient
// (alpha-4 EIP-170 phase 8d hedge #5). Enumerates the cartesian
// product of inputs and asserts the expected accept/reject decision
// per cell.
//
// The decision rules under test (mirroring _assuranceDecision in
// DatumSettlementStorage):
//
//   1. advertiserConsented = true                                    -> accept (any level)
//   2. effLevel = max(campaignLevel, userMinAssurance)
//   3. effLevel >= 2  -> reject, reasonCode 24 (dual-sig required, not present)
//   4. effLevel == 1  -> accept iff (fromRelay || fromPublisherRelay)
//                       reject reasonCode 25 otherwise (no publisher sig path)
//   5. effLevel == 0  -> accept (any path)
//
// The test asserts these rules over the 4 x 4 x 2 x 2 x 2 = 128 input
// cells. Two oracles are used: the on-chain pure helper (via the probe)
// and a TypeScript reimplementation. They must agree on every cell.
import { expect } from "chai";
import { ethers } from "hardhat";
import { MockAssuranceProbe } from "../typechain-types";

function expectedDecision(
  campaignLevel: number,
  userMinAssurance: number,
  advertiserConsented: boolean,
  fromRelay: boolean,
  fromPublisherRelay: boolean
): { accept: boolean; reasonCode: number } {
  if (advertiserConsented) return { accept: true, reasonCode: 0 };
  const effLevel = Math.max(campaignLevel, userMinAssurance);
  if (effLevel >= 2) return { accept: false, reasonCode: 24 };
  if (effLevel === 1) {
    if (fromRelay || fromPublisherRelay) return { accept: true, reasonCode: 0 };
    return { accept: false, reasonCode: 25 };
  }
  return { accept: true, reasonCode: 0 };
}

describe("Assurance gradient pure helper (phase 8d hedge #5)", function () {
  let probe: MockAssuranceProbe;

  before(async function () {
    probe = await (await ethers.getContractFactory("MockAssuranceProbe")).deploy();
  });

  // -------- Spot checks ---------------------------------------------------
  // A handful of named cells so a failing run prints something legible
  // before the exhaustive table dump kicks in.

  it("L0 campaign + L0 user + any path -> accept", async function () {
    const r = await probe.assuranceDecision(0, 0, false, false, false);
    expect(r.accept).to.equal(true);
    expect(r.reasonCode).to.equal(0);
  });

  it("L1 campaign + L0 user + EOA path (no relay) -> reject 25", async function () {
    const r = await probe.assuranceDecision(1, 0, false, false, false);
    expect(r.accept).to.equal(false);
    expect(r.reasonCode).to.equal(25);
  });

  it("L1 campaign + L0 user + relay path -> accept", async function () {
    const r = await probe.assuranceDecision(1, 0, false, true, false);
    expect(r.accept).to.equal(true);
  });

  it("L1 campaign + L0 user + publisher-relay path -> accept", async function () {
    const r = await probe.assuranceDecision(1, 0, false, false, true);
    expect(r.accept).to.equal(true);
  });

  it("L2 campaign + L0 user + relay path -> reject 24 (dual-sig required)", async function () {
    const r = await probe.assuranceDecision(2, 0, false, true, false);
    expect(r.accept).to.equal(false);
    expect(r.reasonCode).to.equal(24);
  });

  it("L2 campaign + advertiserConsented = true -> accept", async function () {
    const r = await probe.assuranceDecision(2, 0, true, false, false);
    expect(r.accept).to.equal(true);
  });

  it("L0 campaign + L1 user + EOA path -> reject 25 (user floor overrides)", async function () {
    // B5-fix: user floor escalates above campaign level.
    const r = await probe.assuranceDecision(0, 1, false, false, false);
    expect(r.accept).to.equal(false);
    expect(r.reasonCode).to.equal(25);
  });

  it("L0 campaign + L2 user + relay path -> reject 24 (user demands dual-sig)", async function () {
    const r = await probe.assuranceDecision(0, 2, false, true, false);
    expect(r.accept).to.equal(false);
    expect(r.reasonCode).to.equal(24);
  });

  it("advertiserConsented short-circuits the gradient regardless of user floor", async function () {
    const r = await probe.assuranceDecision(2, 2, true, false, false);
    expect(r.accept).to.equal(true);
    expect(r.reasonCode).to.equal(0);
  });

  // -------- Exhaustive cartesian product ---------------------------------

  it("exhaustive: every (campaignLevel, userMin, consented, relay, pubRelay) cell matches the expected oracle", async function () {
    for (const campaignLevel of [0, 1, 2, 3]) {
      for (const userMin of [0, 1, 2, 3]) {
        for (const consented of [false, true]) {
          for (const fromRelay of [false, true]) {
            for (const fromPubRelay of [false, true]) {
              const onchain = await probe.assuranceDecision(
                campaignLevel,
                userMin,
                consented,
                fromRelay,
                fromPubRelay
              );
              const want = expectedDecision(
                campaignLevel,
                userMin,
                consented,
                fromRelay,
                fromPubRelay
              );
              const cellLabel =
                `(campaignLevel=${campaignLevel}, userMin=${userMin}, ` +
                `consented=${consented}, fromRelay=${fromRelay}, ` +
                `fromPubRelay=${fromPubRelay})`;
              expect(onchain.accept).to.equal(
                want.accept,
                `accept mismatch at ${cellLabel}`
              );
              expect(Number(onchain.reasonCode)).to.equal(
                want.reasonCode,
                `reasonCode mismatch at ${cellLabel}`
              );
            }
          }
        }
      }
    }
  });
});
