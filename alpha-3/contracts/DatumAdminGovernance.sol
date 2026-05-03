// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./interfaces/IGovernanceRouter.sol";

/// @title DatumAdminGovernance
/// @notice Phase 0 governance: team multisig (owner) directly approves or
///         rejects campaigns with no on-chain voting delay.
///
///         In production the owner should be a Gnosis Safe multisig.
///         Deploy, then call router.setGovernor(Admin, address(this))
///         (via Timelock or directly during initial setup).
///
///         Transition to Phase 1 (Council):
///           owner → calls router.setGovernor(Council, councilAddr)
///           (The owner of the Router is the Timelock, so this goes through a 48h queue.)
contract DatumAdminGovernance {
    address public owner;
    address public pendingOwner;
    IGovernanceRouter public router;

    event CampaignActivated(uint256 indexed campaignId);
    event CampaignTerminated(uint256 indexed campaignId);
    event CampaignDemoted(uint256 indexed campaignId);

    modifier onlyOwner() {
        require(msg.sender == owner, "E18");
        _;
    }

    constructor(address _router) {
        require(_router != address(0), "E00");
        owner = msg.sender;
        router = IGovernanceRouter(_router);
    }

    // -------------------------------------------------------------------------
    // Governance actions (called by owner — team multisig)
    // -------------------------------------------------------------------------

    /// @notice Approve a Pending campaign for activation.
    function activateCampaign(uint256 campaignId) external onlyOwner {
        router.activateCampaign(campaignId);
        emit CampaignActivated(campaignId);
    }

    /// @notice Terminate a campaign (10% slash to Router, 90% refund to advertiser).
    function terminateCampaign(uint256 campaignId) external onlyOwner {
        router.terminateCampaign(campaignId);
        emit CampaignTerminated(campaignId);
    }

    /// @notice Demote an Active/Paused campaign back to Pending for re-evaluation.
    function demoteCampaign(uint256 campaignId) external onlyOwner {
        router.demoteCampaign(campaignId);
        emit CampaignDemoted(campaignId);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setRouter(address _router) external onlyOwner {
        require(_router != address(0), "E00");
        router = IGovernanceRouter(_router);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "E00");
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "E18");
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
