// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IDatumGovernanceVoting.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";

/// @title DatumGovernanceVoting
/// @notice Conviction-based governance: voting, activation/termination, stake & slash management.
///
/// Split from DatumGovernance for PVM bytecode size limits.
/// This contract holds all staked DOT and slash funds. It handles:
///   - Vote casting (aye/nay) with conviction multipliers
///   - Campaign activation (aye threshold) and termination (nay threshold)
///   - Slash distribution to nay voters on termination
///   - Stake withdrawal and slash reward claims (DOT held here)
///
/// DatumGovernanceRewards handles aye reward distribution and claims (separate DOT pool).
contract DatumGovernanceVoting is IDatumGovernanceVoting, ReentrancyGuard {
    uint8 public constant MAX_CONVICTION = 6;

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    uint256 public activationThreshold;
    uint256 public terminationThreshold;
    uint256 public minReviewerStake;
    uint256 public baseLockupBlocks;
    uint256 public maxLockupDuration;

    // -------------------------------------------------------------------------
    // Cross-contract references
    // -------------------------------------------------------------------------

    IDatumCampaignsMinimal public campaigns;
    address public rewardsContract;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    mapping(uint256 => mapping(address => VoteRecord)) private _voteRecords;
    mapping(uint256 => CampaignVote) private _campaignVotes;
    mapping(uint256 => mapping(address => uint256)) private _nayClaimable;
    mapping(uint256 => address[]) private _nayVoters;
    mapping(uint256 => address[]) private _ayeVoters;
    mapping(address => uint256) private _voterFailedNays;
    mapping(uint256 => uint256) private _slashPool;
    mapping(uint256 => mapping(address => bool)) private _nayResolved;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        address _campaigns,
        uint256 _activationThreshold,
        uint256 _terminationThreshold,
        uint256 _minReviewerStake,
        uint256 _baseLockupBlocks,
        uint256 _maxLockupDuration
    ) {
        require(_campaigns != address(0), "Zero address");
        campaigns = IDatumCampaignsMinimal(_campaigns);
        activationThreshold = _activationThreshold;
        terminationThreshold = _terminationThreshold;
        minReviewerStake = _minReviewerStake;
        baseLockupBlocks = _baseLockupBlocks;
        maxLockupDuration = _maxLockupDuration;
    }

    // -------------------------------------------------------------------------
    // Admin — one-time setup only (Ownable removed for PVM bytecode size)
    // -------------------------------------------------------------------------

    function setRewardsContract(address _rewards) external {
        require(rewardsContract == address(0), "Already set");
        rewardsContract = _rewards;
    }

    // Pausable removed to reduce PVM bytecode. Global pause achieved via DatumCampaigns.pause()
    // which prevents activateCampaign/terminateCampaign calls, effectively freezing governance.

    // -------------------------------------------------------------------------
    // Receive DOT (slash escrow from terminateCampaign)
    // -------------------------------------------------------------------------

    receive() external payable {}

    // -------------------------------------------------------------------------
    // Voting
    // -------------------------------------------------------------------------

    function voteAye(uint256 campaignId, uint8 conviction) external payable nonReentrant {
        require(conviction <= MAX_CONVICTION, "Invalid conviction");
        require(msg.value > 0, "Must stake DOT");

        IDatumCampaignsMinimal.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(status == IDatumCampaignsMinimal.CampaignStatus.Pending, "Campaign not Pending");

        VoteRecord storage existing = _voteRecords[campaignId][msg.sender];
        require(existing.castAtBlock == 0, "Already voted");

        uint256 lockupBlocks = baseLockupBlocks * (1 << conviction);
        uint256 lockedUntil = block.number + lockupBlocks;

        _voteRecords[campaignId][msg.sender] = VoteRecord({
            voter: msg.sender,
            direction: VoteDirection.Aye,
            lockAmount: msg.value,
            conviction: conviction,
            lockedUntilBlock: lockedUntil,
            castAtBlock: block.number
        });

        CampaignVote storage cv = _campaignVotes[campaignId];
        cv.ayeTotal += msg.value * (1 << conviction);
        _ayeVoters[campaignId].push(msg.sender);

        if (msg.value >= minReviewerStake) {
            cv.uniqueReviewers++;
        }

        emit VoteCast(campaignId, msg.sender, VoteDirection.Aye, msg.value, conviction, lockedUntil);

        if (!cv.activated && cv.ayeTotal >= activationThreshold) {
            cv.activated = true;
            campaigns.activateCampaign(campaignId);
            emit CampaignActivatedByGovernance(campaignId, cv.ayeTotal);
        }
    }

    function voteNay(uint256 campaignId, uint8 conviction) external payable nonReentrant {
        require(conviction <= MAX_CONVICTION, "Invalid conviction");
        require(msg.value > 0, "Must stake DOT");

        IDatumCampaignsMinimal.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(
            status == IDatumCampaignsMinimal.CampaignStatus.Active ||
            status == IDatumCampaignsMinimal.CampaignStatus.Paused,
            "Campaign not Active or Paused"
        );

        VoteRecord storage existing = _voteRecords[campaignId][msg.sender];
        require(existing.castAtBlock == 0, "Already voted");

        // Graduated nay lockup (Issue 10): base * 2^conviction + base * 2^min(failedNays, 4), capped
        uint256 failedNays = _voterFailedNays[msg.sender];
        uint8 cappedFailed = failedNays > 4 ? 4 : uint8(failedNays);
        uint256 lockupBlocks = baseLockupBlocks * (1 << conviction) + baseLockupBlocks * (1 << cappedFailed);
        if (lockupBlocks > maxLockupDuration) lockupBlocks = maxLockupDuration;
        uint256 lockedUntil = block.number + lockupBlocks;

        _voteRecords[campaignId][msg.sender] = VoteRecord({
            voter: msg.sender,
            direction: VoteDirection.Nay,
            lockAmount: msg.value,
            conviction: conviction,
            lockedUntilBlock: lockedUntil,
            castAtBlock: block.number
        });

        CampaignVote storage cv = _campaignVotes[campaignId];
        cv.nayTotal += msg.value * (1 << conviction);
        _nayVoters[campaignId].push(msg.sender);

        emit VoteCast(campaignId, msg.sender, VoteDirection.Nay, msg.value, conviction, lockedUntil);

        if (!cv.terminated && cv.nayTotal >= terminationThreshold) {
            cv.terminated = true;
            cv.terminationBlock = block.number;

            _slashPool[campaignId] = campaigns.getCampaignRemainingBudget(campaignId);

            campaigns.terminateCampaign(campaignId);

            emit CampaignTerminatedByGovernance(campaignId, cv.nayTotal, block.number);
        }
    }

    // -------------------------------------------------------------------------
    // Rewards contract callbacks (DOT custody operations)
    // -------------------------------------------------------------------------

    modifier onlyRewards() {
        require(msg.sender == rewardsContract, "Rewards only");
        _;
    }

    /// @notice Multipurpose rewards callback — reduces PVM bytecode vs separate functions.
    /// action: 0=transferDOT, 1=consumeStake, 2=consumeNayClaimable, 3=markNayResolved, 4=setNayClaimable
    function rewardsAction(uint8 action, uint256 campaignId, address target, uint256 value)
        external onlyRewards returns (uint256)
    {
        if (action == 0) {
            // transferDOT
            (bool ok,) = target.call{value: value}("");
            require(ok, "Transfer failed");
            return 0;
        } else if (action == 1) {
            // consumeStake
            VoteRecord storage vr = _voteRecords[campaignId][target];
            uint256 amount = vr.lockAmount;
            vr.lockAmount = 0;
            return amount;
        } else if (action == 2) {
            // consumeNayClaimable
            uint256 amount = _nayClaimable[campaignId][target];
            _nayClaimable[campaignId][target] = 0;
            return amount;
        } else if (action == 3) {
            // markNayResolved
            require(!_nayResolved[campaignId][target], "Already resolved");
            _nayResolved[campaignId][target] = true;
            _voterFailedNays[target]++;
            return _voterFailedNays[target];
        } else if (action == 4) {
            // setNayClaimable
            _nayClaimable[campaignId][target] += value;
            return 0;
        }
        revert("Invalid action");
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getVoteRecord(uint256 campaignId, address voter) external view returns (VoteRecord memory) {
        return _voteRecords[campaignId][voter];
    }

    function getCampaignVote(uint256 campaignId) external view returns (CampaignVote memory) {
        return _campaignVotes[campaignId];
    }

    function nayClaimable(uint256 campaignId, address voter) external view returns (uint256) {
        return _nayClaimable[campaignId][voter];
    }

    function getAyeVoters(uint256 campaignId) external view returns (address[] memory) {
        return _ayeVoters[campaignId];
    }

    function getNayVoters(uint256 campaignId) external view returns (address[] memory) {
        return _nayVoters[campaignId];
    }

    function slashPool(uint256 campaignId) external view returns (uint256) {
        return _slashPool[campaignId];
    }
}
