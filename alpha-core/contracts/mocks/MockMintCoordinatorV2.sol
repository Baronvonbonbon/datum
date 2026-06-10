// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumMintCoordinator.sol";
contract MockMintCoordinatorV2 is DatumMintCoordinator {
    function version() public pure override returns (uint256) { return 3; }
}
