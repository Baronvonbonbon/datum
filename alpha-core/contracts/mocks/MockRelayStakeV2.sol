// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumRelayStake.sol";
/// @dev Test-only successor exercising migrate() against DatumRelayStake.
contract MockRelayStakeV2 is DatumRelayStake {
    constructor(uint256 m, uint64 d) DatumRelayStake(m, d) {}
    function version() public pure override returns (uint256) { return 2; }
}
