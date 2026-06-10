// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumChallengeBonds.sol";
/// @dev Test-only successor exercising migrate() against DatumChallengeBonds.
contract MockChallengeBondsV2 is DatumChallengeBonds {
    function version() public pure override returns (uint256) { return 2; }
}
