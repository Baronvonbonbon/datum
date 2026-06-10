// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumCampaignAllowlist.sol";
contract MockCampaignAllowlistV2 is DatumCampaignAllowlist {
    function version() public pure override returns (uint256) { return 2; }
}
