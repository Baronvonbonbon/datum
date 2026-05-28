// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumGovernanceV2Minimal.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";

/// @title DatumGovernanceSlash
/// @notice Distributes slash pool rewards to winning-side voters.
///
///         Alpha-2: getCampaignForSettlement returns 4 values (no remainingBudget).
///         M4: sweepSlashPool() — permissionless sweep of unclaimed slash after deadline.
///         Manual owner + reentrancy guard (OZ imports removed to reduce PVM bytecode).
contract DatumGovernanceSlash {
    address public owner;
    address public pendingOwner;
    address public voting;
    address public campaigns;

    uint256 private _locked;
    uint256 public constant SWEEP_DEADLINE_BLOCKS = 5256000; // ~365 days

    mapping(uint256 => uint256) public winningWeight;
    mapping(uint256 => bool) public finalized;
    mapping(uint256 => uint256) public finalizedBlock;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => uint256) public totalClaimed;

    modifier onlyOwner() {
        require(msg.sender == owner, "E18");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 0, "E57");
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor(address _voting, address _campaigns) {
        require(_voting != address(0), "E00");
        require(_campaigns != address(0), "E00");
        owner = msg.sender;
        voting = _voting;
        campaigns = _campaigns;
    }

    receive() external payable {}

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "E00");
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "E18");
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Finalize slash using weight snapshot from resolution time (SM-5)
    function finalizeSlash(uint256 campaignId) external {
        require(!finalized[campaignId], "E59");
        require(IDatumGovernanceV2Minimal(voting).resolved(campaignId), "E60");

        // SM-5: Use weight snapshotted at resolution, not live values
        uint256 w = IDatumGovernanceV2Minimal(voting).resolvedWinningWeight(campaignId);
        require(w > 0, "E61");

        winningWeight[campaignId] = w;
        finalized[campaignId] = true;
        finalizedBlock[campaignId] = block.number;
    }

    /// @notice Winner claims proportional share of collected slash
    function claimSlashReward(uint256 campaignId) external nonReentrant {
        require(finalized[campaignId], "E54");
        require(!claimed[campaignId][msg.sender], "E55");

        (uint8 direction, uint256 lockAmount, uint8 conviction, uint256 lockedUntilBlock)
            = IDatumGovernanceV2Minimal(voting).getVote(campaignId, msg.sender);
        require(direction != 0, "E44");
        require(block.number >= lockedUntilBlock, "E45");

        (uint8 status,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        // AUDIT-014: Campaign must be terminal before slash reward can be claimed
        require(status == 3 || status == 4, "E60"); // 3=Completed, 4=Terminated
        bool winner = (status == 3 && direction == 1)
                   || (status == 4 && direction == 2);
        require(winner, "E56");

        uint256 voterWeight = lockAmount * IDatumGovernanceV2Minimal(voting).convictionWeight(conviction);
        uint256 pool = IDatumGovernanceV2Minimal(voting).slashCollected(campaignId);
        require(winningWeight[campaignId] > 0, "E61");
        uint256 share = _mulDiv(pool, voterWeight, winningWeight[campaignId]);
        require(share > 0, "E61");

        claimed[campaignId][msg.sender] = true;
        totalClaimed[campaignId] += share;

        IDatumGovernanceV2Minimal(voting).slashAction(0, campaignId, msg.sender, share);
    }

    /// @notice M4: Sweep unclaimed slash pool after deadline. Permissionless.
    ///         Sends remaining funds to protocol owner.
    function sweepSlashPool(uint256 campaignId) external nonReentrant {
        require(finalized[campaignId], "E54");
        require(block.number >= finalizedBlock[campaignId] + SWEEP_DEADLINE_BLOCKS, "E24");

        uint256 pool = IDatumGovernanceV2Minimal(voting).slashCollected(campaignId);
        uint256 remaining = pool - totalClaimed[campaignId];
        require(remaining > 0, "E61");

        totalClaimed[campaignId] += remaining;

        // Transfer remaining pool to owner (protocol treasury)
        IDatumGovernanceV2Minimal(voting).slashAction(0, campaignId, owner, remaining);
    }

    /// @notice View: claimable slash reward for a voter
    function getClaimable(uint256 campaignId, address voter) external view returns (uint256) {
        if (!finalized[campaignId]) return 0;
        if (claimed[campaignId][voter]) return 0;

        (uint8 direction, uint256 lockAmount, uint8 conviction,)
            = IDatumGovernanceV2Minimal(voting).getVote(campaignId, voter);

        (uint8 status,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        bool winner = (status == 3 && direction == 1) || (status == 4 && direction == 2);
        if (!winner || direction == 0) return 0;

        uint256 voterWeight = lockAmount * IDatumGovernanceV2Minimal(voting).convictionWeight(conviction);
        uint256 pool = IDatumGovernanceV2Minimal(voting).slashCollected(campaignId);
        if (winningWeight[campaignId] == 0) return 0;
        return _mulDiv(pool, voterWeight, winningWeight[campaignId]);
    }

    function _mulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y) / d;
    }
}
