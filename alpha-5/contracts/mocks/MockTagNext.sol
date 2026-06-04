// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumTagSystem.sol";
import "../DatumTagRegistry.sol";
contract MockTagSystemNext is DatumTagSystem {
    function version() public pure override returns (uint256) { return 2; }
}
contract MockTagRegistryNext is DatumTagRegistry {
    constructor(IERC20 d) DatumTagRegistry(d) {}
    function version() public pure override returns (uint256) { return 2; }
}
