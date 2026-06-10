// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumAdvertiserStake.sol";
/// @dev Test-only successor exercising migrate() against DatumAdvertiserStake.
contract MockAdvertiserStakeV2 is DatumAdvertiserStake {
    constructor(uint256 b, uint256 p, uint256 d) DatumAdvertiserStake(b, p, d) {}
    function version() public pure override returns (uint256) { return 3; }
}
