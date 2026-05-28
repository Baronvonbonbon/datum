// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumCampaigns.sol";

/// @title MockCampaignLifecycle
/// @notice Test-only mock for DatumCampaignLifecycle used in governance unit tests.
///         Implements demoteCampaign and terminateCampaign against the IDatumCampaigns interface.
contract MockCampaignLifecycle {
    IDatumCampaigns public campaigns;
    address public governanceContract;

    event CampaignDemoted(uint256 indexed campaignId);
    event CampaignTerminated(uint256 indexed campaignId, uint256 terminationBlock);

    constructor(address _campaigns) {
        campaigns = IDatumCampaigns(_campaigns);
    }

    function setGovernanceContract(address addr) external {
        governanceContract = addr;
    }

    function demoteCampaign(uint256 campaignId) external {
        require(msg.sender == governanceContract, "E19");
        campaigns.setPendingExpiryBlock(campaignId, type(uint256).max);
        campaigns.setCampaignStatus(campaignId, IDatumCampaigns.CampaignStatus.Pending);
        emit CampaignDemoted(campaignId);
    }

    function terminateCampaign(uint256 campaignId) external {
        require(msg.sender == governanceContract, "E19");
        campaigns.setTerminationBlock(campaignId, block.number);
        campaigns.setCampaignStatus(campaignId, IDatumCampaigns.CampaignStatus.Terminated);
        emit CampaignTerminated(campaignId, block.number);
    }
}
