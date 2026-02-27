// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IDatumGovernanceRewards.sol";
import "./interfaces/IDatumGovernanceVoting.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";

/// @title DatumGovernanceRewards
/// @notice Aye reward credits, slash distribution, claims, and stake withdrawal.
///
/// Split from DatumGovernance for PVM bytecode size limits.
///
/// Aye distribution model (MVP): caller supplies per-voter amounts computed off-chain
/// (via creditAyeReward). This eliminates the on-chain voter-loop, cutting ~4 KB.
/// Slash distribution remains on-chain (distributeSlashRewards) since it must call
/// voting.rewardsAction per nay voter to write claimable state.
contract DatumGovernanceRewards is IDatumGovernanceRewards {
    IDatumGovernanceVoting public voting;
    IDatumCampaignsMinimal public campaigns;
    address public owner;

    mapping(uint256 => mapping(address => uint256)) private _ayeClaimable;

    constructor(address _voting, address _campaigns) {
        require(_voting != address(0), "E00");
        require(_campaigns != address(0), "E00");
        voting = IDatumGovernanceVoting(_voting);
        campaigns = IDatumCampaignsMinimal(_campaigns);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "E18");
        _;
    }

    receive() external payable {}

    // -------------------------------------------------------------------------
    // Aye reward crediting (off-chain computed, owner-called)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumGovernanceRewards
    /// @dev Owner computes each voter's proportional share off-chain and calls this
    ///      once per eligible voter with msg.value = share amount.
    function creditAyeReward(uint256 campaignId, address voter) external payable onlyOwner {
        IDatumCampaignsMinimal.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(
            status == IDatumCampaignsMinimal.CampaignStatus.Completed ||
            status == IDatumCampaignsMinimal.CampaignStatus.Terminated,
            "E04"
        );
        require(msg.value > 0, "E11");
        _ayeClaimable[campaignId][voter] += msg.value;
    }

    // -------------------------------------------------------------------------
    // Slash reward distribution (on-chain: must write nayClaimable in Voting)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumGovernanceRewards
    function distributeSlashRewards(uint256 campaignId) external {
        IDatumGovernanceVoting.CampaignVote memory cv = voting.getCampaignVote(campaignId);
        require(cv.terminated, "E05");
        uint256 slashAmount = voting.slashPool(campaignId);
        if (slashAmount == 0) return;

        address[] memory voters = voting.getNayVoters(campaignId);
        uint256 n = voters.length;
        if (n == 0) return;

        uint256 totalWeight;
        for (uint256 i; i < n; ++i) {
            IDatumGovernanceVoting.VoteRecord memory vr = voting.getVoteRecord(campaignId, voters[i]);
            totalWeight += vr.lockAmount << vr.conviction;
        }
        if (totalWeight == 0) return;

        for (uint256 i; i < n; ++i) {
            IDatumGovernanceVoting.VoteRecord memory vr = voting.getVoteRecord(campaignId, voters[i]);
            uint256 w = vr.lockAmount << vr.conviction;
            if (w == 0) continue;
            uint256 share = (slashAmount * w) / totalWeight;
            if (share > 0) voting.rewardsAction(4, campaignId, voters[i], share);
        }
    }

    // -------------------------------------------------------------------------
    // Claims & stake
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumGovernanceRewards
    function claimSlashReward(uint256 campaignId) external {
        IDatumGovernanceVoting.VoteRecord memory vr = voting.getVoteRecord(campaignId, msg.sender);
        require(vr.direction == IDatumGovernanceVoting.VoteDirection.Nay, "E06");
        require(block.number >= vr.lockedUntilBlock, "E07");
        uint256 amount = voting.rewardsAction(2, campaignId, msg.sender, 0);
        require(amount > 0, "E03");
        emit SlashRewardClaimed(campaignId, msg.sender, amount);
        voting.rewardsAction(0, campaignId, msg.sender, amount);
    }

    /// @inheritdoc IDatumGovernanceRewards
    function withdrawStake(uint256 campaignId) external {
        IDatumGovernanceVoting.VoteRecord memory vr = voting.getVoteRecord(campaignId, msg.sender);
        require(vr.castAtBlock != 0, "E01");
        require(vr.lockAmount > 0, "E08");
        require(block.number >= vr.lockedUntilBlock, "E07");
        uint256 amount = voting.rewardsAction(1, campaignId, msg.sender, 0);
        require(amount > 0, "E03");
        emit StakeWithdrawn(campaignId, msg.sender, amount);
        voting.rewardsAction(0, campaignId, msg.sender, amount);
    }

    /// @inheritdoc IDatumGovernanceRewards
    /// @dev Routes transfer through voting.rewardsAction(0,...) to avoid resolc codegen bug
    ///      with multiple functions containing transfer(). DOT is forwarded to voting contract
    ///      first, then voting transfers to the claimer.
    function claimAyeReward(uint256 campaignId) external {
        uint256 claimable = _ayeClaimable[campaignId][msg.sender];
        require(claimable > 0, "E03");
        IDatumGovernanceVoting.VoteRecord memory vr = voting.getVoteRecord(campaignId, msg.sender);
        require(vr.direction == IDatumGovernanceVoting.VoteDirection.Aye, "E09");
        require(block.number >= vr.lockedUntilBlock, "E07");
        _ayeClaimable[campaignId][msg.sender] = 0;
        emit AyeRewardClaimed(campaignId, msg.sender, claimable);
        // Forward DOT to voting contract via call, then have voting transfer to claimer
        (bool ok,) = payable(address(voting)).call{value: claimable}("");
        require(ok, "E02");
        voting.rewardsAction(0, campaignId, msg.sender, claimable);
    }

    /// @inheritdoc IDatumGovernanceRewards
    function resolveFailedNay(uint256 campaignId) external {
        IDatumGovernanceVoting.VoteRecord memory vr = voting.getVoteRecord(campaignId, msg.sender);
        require(vr.castAtBlock != 0, "E01");
        require(vr.direction == IDatumGovernanceVoting.VoteDirection.Nay, "E06");
        IDatumCampaignsMinimal.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(status == IDatumCampaignsMinimal.CampaignStatus.Completed, "E10");
        uint256 totalFailed = voting.rewardsAction(3, campaignId, msg.sender, 0);
        emit FailedNayResolved(campaignId, msg.sender, totalFailed);
    }

    function ayeClaimable(uint256 campaignId, address voter) external view returns (uint256) {
        return _ayeClaimable[campaignId][voter];
    }
}
