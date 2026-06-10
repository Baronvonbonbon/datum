import { ethers } from "hardhat";

/// Helper: deploy a MockOpenGovRouter (phase=2 by default) and wire it
/// to the given Upgradable contract via setRouter(mock). Use in tests
/// that fire any `whenOpenGovPhase`-guarded function — without this,
/// the F-004-fixed modifier reverts `router-unset`.
///
/// Returns the mock router so tests can also call `setPhase` to flip
/// to an earlier phase for negative-path testing.
export async function wireOpenGovRouter(contract: any): Promise<any> {
  const MockFactory = await ethers.getContractFactory("MockOpenGovRouter");
  const router = await MockFactory.deploy();
  await contract.setRouter(await router.getAddress());
  return router;
}
