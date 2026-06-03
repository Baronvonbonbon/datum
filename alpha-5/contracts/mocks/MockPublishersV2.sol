// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumPublishers.sol";
/// @dev Test-only successor exercising the DatumPublishers migrate() flow.
contract MockPublishersV2 is DatumPublishers {
    constructor(uint256 d, address p) DatumPublishers(d, p) {}
    function version() public pure override returns (uint256) { return 2; }
}
