// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumGovernanceHelper.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";
import "./interfaces/ISystem.sol";

/// @title DatumGovernanceHelper
/// @notice SE-2 satellite: slash computation and dust guard extracted from GovernanceV2.
///         Eliminates ISystem import and both precompile call sites from GovernanceV2,
///         freeing ~4 KB PVM headroom.
contract DatumGovernanceHelper is IDatumGovernanceHelper {
    ISystem private constant SYSTEM = ISystem(0x0000000000000000000000000000000000000900);
    address private constant SYSTEM_ADDR = 0x0000000000000000000000000000000000000900;

    address public immutable campaigns;

    // Campaign status enum values — must match IDatumCampaigns.CampaignStatus
    uint8 private constant STATUS_COMPLETED   = 3;
    uint8 private constant STATUS_TERMINATED  = 4;

    // Vote directions
    uint8 private constant VOTE_AYE = 1;
    uint8 private constant VOTE_NAY = 2;

    constructor(address _campaigns) {
        require(_campaigns != address(0), "E00");
        campaigns = _campaigns;
    }

    /// @inheritdoc IDatumGovernanceHelper
    function computeSlash(
        uint256 campaignId,
        uint8 voteDirection,
        uint256 lockAmount,
        uint256 slashBps
    ) external view returns (uint256 slash) {
        (uint8 status,,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        bool loser = (status == STATUS_COMPLETED  && voteDirection == VOTE_NAY)
                  || (status == STATUS_TERMINATED && voteDirection == VOTE_AYE);
        if (loser) {
            slash = lockAmount * slashBps / 10000;
        }
    }

    /// @inheritdoc IDatumGovernanceHelper
    function checkMinBalance(uint256 amount) external view {
        if (SYSTEM_ADDR.code.length > 0) {
            uint256 minBal = SYSTEM.minimumBalance();
            require(amount >= minBal, "E58");
        }
    }
}
