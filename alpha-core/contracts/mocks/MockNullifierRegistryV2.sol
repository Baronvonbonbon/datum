// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumNullifierRegistry.sol";
/// @dev Test-only successor exercising the predecessor-chain migration.
contract MockNullifierRegistryV2 is DatumNullifierRegistry {
    function version() public pure override returns (uint256) { return 2; }
}
