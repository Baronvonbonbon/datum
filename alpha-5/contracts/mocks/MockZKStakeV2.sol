// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumZKStake.sol";
/// @dev Test-only successor exercising migrate() against DatumZKStake.
contract MockZKStakeV2 is DatumZKStake {
    constructor(address t) DatumZKStake(t) {}
    function version() public pure override returns (uint256) { return 2; }
}
