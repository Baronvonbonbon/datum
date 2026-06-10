// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumActivationBonds.sol";
/// @dev Test-only successor exercising migrate() against DatumActivationBonds.
contract MockActivationBondsV2 is DatumActivationBonds {
    constructor(uint256 mb, uint64 tb, uint16 wb, uint16 trb, address t)
        DatumActivationBonds(mb, tb, wb, trb, t) {}
    function version() public pure override returns (uint256) { return 3; }
}
