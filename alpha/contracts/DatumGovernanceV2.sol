// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IDatumCampaignsMinimal.sol";
import "./interfaces/ISystem.sol";

/// @title DatumGovernanceV2
/// @notice Dynamic conviction-based governance: vote/withdraw/re-vote, campaign evaluation,
///         and symmetric slash (losing side pays configurable BPS on resolution).
///
/// Replaces DatumGovernanceVoting (V1 threshold model) with a majority+quorum model:
///   - Pending -> Active: aye > 50% AND total weighted >= quorum
///   - Active/Paused -> Terminated: nay >= 50%
///   - Completed/Terminated -> resolved (enables slash deductions)
///
/// Voters can withdraw after conviction lockup expires and re-vote in any direction.
/// Slash is deducted inline on withdrawal (losing side). Winners claim via DatumGovernanceSlash.
///
/// Defense-in-depth: no pauseRegistry — activateCampaign/terminateCampaign are paused at
/// the Campaigns level. Sub-threshold votes are harmless.
contract DatumGovernanceV2 {
    uint8 public constant MAX_CONVICTION = 6;

    // Polkadot Hub system precompile
    ISystem private constant SYSTEM = ISystem(0x0000000000000000000000000000000000000900);
    address private constant SYSTEM_ADDR = 0x0000000000000000000000000000000000000900;

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    address public owner;
    address public campaigns;
    address public slashContract;      // set once

    uint256 public quorumWeighted;     // total weighted minimum (e.g. 100 DOT)
    uint256 public slashBps;           // slash percentage in basis points
    uint256 public baseLockupBlocks;
    uint256 public maxLockupBlocks;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    struct Vote {
        uint8 direction;          // 0=none, 1=aye, 2=nay
        uint256 lockAmount;       // raw planck staked
        uint8 conviction;         // 0-6
        uint256 lockedUntilBlock;
    }

    mapping(uint256 => uint256) public ayeWeighted;
    mapping(uint256 => uint256) public nayWeighted;
    mapping(uint256 => bool) public resolved;
    mapping(uint256 => uint256) public slashCollected;
    mapping(uint256 => mapping(address => Vote)) private _votes;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event VoteCast(uint256 indexed campaignId, address indexed voter, bool aye, uint256 amount, uint8 conviction);
    event VoteWithdrawn(uint256 indexed campaignId, address indexed voter, uint256 returned, uint256 slashed);
    event CampaignEvaluated(uint256 indexed campaignId, uint8 result);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        address _campaigns,
        uint256 _quorum,
        uint256 _slashBps,
        uint256 _baseLockup,
        uint256 _maxLockup
    ) {
        require(_campaigns != address(0), "E00");
        owner = msg.sender;
        campaigns = _campaigns;
        quorumWeighted = _quorum;
        slashBps = _slashBps;
        baseLockupBlocks = _baseLockup;
        maxLockupBlocks = _maxLockup;
    }

    receive() external payable {}

    // -------------------------------------------------------------------------
    // Voting
    // -------------------------------------------------------------------------

    function vote(uint256 campaignId, bool aye, uint8 conviction) external payable {
        require(conviction <= MAX_CONVICTION, "E40");
        require(msg.value > 0, "E41");

        Vote storage v = _votes[campaignId][msg.sender];
        require(v.direction == 0, "E42");

        // Campaign must be Pending (0) or Active (1)
        (uint8 status,,,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        require(status == 0 || status == 1, "E43");

        uint256 weight = msg.value * (1 << conviction);
        uint256 lockup = baseLockupBlocks * (1 << conviction);
        if (lockup > maxLockupBlocks) lockup = maxLockupBlocks;

        v.direction = aye ? 1 : 2;
        v.lockAmount = msg.value;
        v.conviction = conviction;
        v.lockedUntilBlock = block.number + lockup;

        if (aye) {
            ayeWeighted[campaignId] += weight;
        } else {
            nayWeighted[campaignId] += weight;
        }

        emit VoteCast(campaignId, msg.sender, aye, msg.value, conviction);
    }

    // -------------------------------------------------------------------------
    // Withdrawal
    // -------------------------------------------------------------------------

    function withdraw(uint256 campaignId) external {
        Vote storage v = _votes[campaignId][msg.sender];
        require(v.direction != 0, "E44");
        require(block.number >= v.lockedUntilBlock, "E45");

        uint256 weight = v.lockAmount * (1 << v.conviction);
        uint256 slash = 0;

        // Deduct from totals
        if (v.direction == 1) {
            ayeWeighted[campaignId] -= weight;
        } else {
            nayWeighted[campaignId] -= weight;
        }

        // Apply slash if resolved and on losing side
        if (resolved[campaignId]) {
            (uint8 status,,,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
            // Completed (3) -> nay loses; Terminated (4) -> aye loses
            bool loser = (status == 3 && v.direction == 2)
                      || (status == 4 && v.direction == 1);
            if (loser) {
                slash = v.lockAmount * slashBps / 10000;
                slashCollected[campaignId] += slash;
            }
        }

        uint256 refund = v.lockAmount - slash;

        // Dust prevention: reject refunds below existential deposit
        if (SYSTEM_ADDR.code.length > 0) {
            uint256 minBal = SYSTEM.minimumBalance();
            require(refund >= minBal, "E58");
        }

        // Zero vote (allows re-voting)
        v.direction = 0;
        v.lockAmount = 0;
        v.conviction = 0;
        v.lockedUntilBlock = 0;

        // Transfer
        (bool ok,) = msg.sender.call{value: refund}("");
        require(ok, "E02");

        emit VoteWithdrawn(campaignId, msg.sender, refund, slash);
    }

    // -------------------------------------------------------------------------
    // Evaluation
    // -------------------------------------------------------------------------

    function evaluateCampaign(uint256 campaignId) external {
        (uint8 status,,,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);

        uint256 total = ayeWeighted[campaignId] + nayWeighted[campaignId];

        if (status == 0) {
            // Pending -> Active: need aye majority + quorum
            require(total >= quorumWeighted, "E46");
            require(ayeWeighted[campaignId] * 10000 > total * 5000, "E47");
            IDatumCampaignsMinimal(campaigns).activateCampaign(campaignId);
            emit CampaignEvaluated(campaignId, 1);
        } else if (status == 1 || status == 2) {
            // Active/Paused -> Terminated: nay has majority (>=50%)
            require(total > 0, "E51");
            require(nayWeighted[campaignId] * 10000 >= total * 5000, "E48");
            IDatumCampaignsMinimal(campaigns).terminateCampaign(campaignId);
            resolved[campaignId] = true;
            emit CampaignEvaluated(campaignId, 4);
        } else if (status == 3) {
            // Completed -> mark resolved (for slash)
            require(!resolved[campaignId], "E49");
            resolved[campaignId] = true;
            emit CampaignEvaluated(campaignId, 3);
        } else if (status == 4 && !resolved[campaignId]) {
            // Terminated (already) -> mark resolved
            resolved[campaignId] = true;
            emit CampaignEvaluated(campaignId, 4);
        } else {
            revert("E50");
        }
    }

    // -------------------------------------------------------------------------
    // Slash contract callback
    // -------------------------------------------------------------------------

    function slashAction(uint8 action, uint256 /*campaignId*/, address target, uint256 value) external {
        require(msg.sender == slashContract, "E19");
        if (action == 0) {
            // Dust prevention: reject payouts below existential deposit
            if (SYSTEM_ADDR.code.length > 0) {
                uint256 minBal = SYSTEM.minimumBalance();
                require(value >= minBal, "E58");
            }
            (bool ok,) = target.call{value: value}("");
            require(ok, "E02");
        }
        // action 1+ reserved
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setSlashContract(address _slash) external {
        require(msg.sender == owner, "E18");
        require(slashContract == address(0), "E51");
        slashContract = _slash;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getVote(uint256 campaignId, address voter) external view returns (
        uint8 direction, uint256 lockAmount, uint8 conviction, uint256 lockedUntilBlock
    ) {
        Vote storage v = _votes[campaignId][voter];
        return (v.direction, v.lockAmount, v.conviction, v.lockedUntilBlock);
    }
}
