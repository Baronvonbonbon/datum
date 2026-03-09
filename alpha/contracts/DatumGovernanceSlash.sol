// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./DatumGovernanceV2.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";

/// @title DatumGovernanceSlash
/// @notice Distributes slash pool rewards to winning-side voters.
///
/// After a campaign resolves (Completed or Terminated), losing-side voters get slashBps
/// deducted from their stake on withdrawal (handled in DatumGovernanceV2.withdraw()).
/// The deducted DOT accumulates in DatumGovernanceV2 as slashCollected[campaignId].
///
/// This contract lets winning-side voters claim their proportional share of that pool:
///   1. Anyone calls finalizeSlash(campaignId) to snapshot winning-side total weight
///   2. Each winner calls claimSlashReward(campaignId) to receive their share
///
/// Slash rewards are transferred from the V2 contract via slashAction callback.
contract DatumGovernanceSlash {
    address public voting;
    address public campaigns;
    address public owner;

    mapping(uint256 => uint256) public winningWeight;
    mapping(uint256 => bool) public finalized;
    mapping(uint256 => mapping(address => bool)) public claimed;

    constructor(address _voting, address _campaigns) {
        require(_voting != address(0), "E00");
        require(_campaigns != address(0), "E00");
        owner = msg.sender;
        voting = _voting;
        campaigns = _campaigns;
    }

    receive() external payable {}

    /// @notice Snapshot winning side weight after resolution
    function finalizeSlash(uint256 campaignId) external {
        require(!finalized[campaignId], "E52");
        require(DatumGovernanceV2(payable(voting)).resolved(campaignId), "E53");

        (uint8 status,,,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        uint256 w;
        if (status == 3) {
            // Completed -> aye wins
            w = DatumGovernanceV2(payable(voting)).ayeWeighted(campaignId);
        } else {
            // Terminated -> nay wins
            w = DatumGovernanceV2(payable(voting)).nayWeighted(campaignId);
        }

        winningWeight[campaignId] = w;
        finalized[campaignId] = true;
    }

    /// @notice Winner claims proportional share of collected slash
    function claimSlashReward(uint256 campaignId) external {
        require(finalized[campaignId], "E54");
        require(!claimed[campaignId][msg.sender], "E55");

        (uint8 direction, uint256 lockAmount, uint8 conviction, uint256 lockedUntilBlock)
            = DatumGovernanceV2(payable(voting)).getVote(campaignId, msg.sender);
        require(direction != 0, "E44");
        require(block.number >= lockedUntilBlock, "E45");

        // Verify on winning side
        (uint8 status,,,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        bool winner = (status == 3 && direction == 1)   // Completed -> aye wins
                   || (status == 4 && direction == 2);  // Terminated -> nay wins
        require(winner, "E56");

        uint256 voterWeight = lockAmount * (1 << conviction);
        uint256 pool = DatumGovernanceV2(payable(voting)).slashCollected(campaignId);
        require(winningWeight[campaignId] > 0, "E03");
        uint256 share = pool * voterWeight / winningWeight[campaignId];
        require(share > 0, "E03");

        claimed[campaignId][msg.sender] = true;

        // Transfer from voting contract
        DatumGovernanceV2(payable(voting)).slashAction(0, campaignId, msg.sender, share);
    }

    /// @notice View: claimable slash reward for a voter
    function getClaimable(uint256 campaignId, address voter) external view returns (uint256) {
        if (!finalized[campaignId]) return 0;
        if (claimed[campaignId][voter]) return 0;

        (uint8 direction, uint256 lockAmount, uint8 conviction,)
            = DatumGovernanceV2(payable(voting)).getVote(campaignId, voter);

        (uint8 status,,,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        bool winner = (status == 3 && direction == 1) || (status == 4 && direction == 2);
        if (!winner || direction == 0) return 0;

        uint256 voterWeight = lockAmount * (1 << conviction);
        uint256 pool = DatumGovernanceV2(payable(voting)).slashCollected(campaignId);
        if (winningWeight[campaignId] == 0) return 0;
        return pool * voterWeight / winningWeight[campaignId];
    }
}
