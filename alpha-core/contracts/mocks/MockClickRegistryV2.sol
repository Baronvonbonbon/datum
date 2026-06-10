// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumClickRegistry.sol";
/// @dev Test-only successor exercising the predecessor-chain migration.
contract MockClickRegistryV2 is DatumClickRegistry {
    function version() public pure override returns (uint256) { return 2; }
}
