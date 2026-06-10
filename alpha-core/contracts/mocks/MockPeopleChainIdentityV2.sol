// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumPeopleChainIdentity.sol";
contract MockPeopleChainIdentityV2 is DatumPeopleChainIdentity {
    function version() public pure override returns (uint256) { return 2; }
}
