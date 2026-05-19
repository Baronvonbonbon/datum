import { ethers } from "hardhat";

/**
 * Phase 8d-3+ Settlement now routes its inner pipeline (`_processBatch`)
 * to DatumSettlementLogicB via DELEGATECALL. Every test that deploys
 * DatumSettlement must wire LogicA + LogicB or the settle paths revert
 * with E00 ("logic not wired").
 *
 * Use this helper immediately after `settlement = await Factory.deploy(...)`
 * to keep the wiring boilerplate out of individual test files.
 */
export async function wireSettlementLogic(
  // The minimal shape we need from the deployed Settlement: any object
  // with `setLogic(addressA, addressB)` from the contract ABI. Typed loose
  // on purpose so this helper works with both DatumSettlement and
  // Hardhat's ethers Contract wrapper.
  settlement: { setLogic: (a: string, b: string) => Promise<unknown> }
): Promise<{ logicA: string; logicB: string }> {
  const LogicAFactory = await ethers.getContractFactory("DatumSettlementLogicA");
  const LogicBFactory = await ethers.getContractFactory("DatumSettlementLogicB");
  const logicA = await LogicAFactory.deploy();
  const logicB = await LogicBFactory.deploy();
  const a = await logicA.getAddress();
  const b = await logicB.getAddress();
  await settlement.setLogic(a, b);
  return { logicA: a, logicB: b };
}
