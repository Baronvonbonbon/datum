// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumPeopleChainXcmBridge.sol";
contract MockPeopleChainXcmBridgeV2 is DatumPeopleChainXcmBridge {
    constructor(address x, address c) DatumPeopleChainXcmBridge(x, c) {}
    function version() public pure override returns (uint256) { return 2; }
}
