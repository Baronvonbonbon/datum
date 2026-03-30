// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./interfaces/IDatumCampaignsMinimal.sol";
import "./interfaces/IDatumCampaignLifecycle.sol";
import "./interfaces/ISystem.sol";

/// @title DatumGovernanceV2
/// @notice Dynamic conviction-based governance: vote/withdraw/re-vote, campaign evaluation,
///         and symmetric slash (losing side pays configurable BPS on resolution).
///
///         Alpha-2 changes:
///           - Termination delegates to DatumCampaignLifecycle (not Campaigns directly).
///           - getCampaignForSettlement returns 4 values (no remainingBudget).
///           - Conviction scales logarithmically with lock time: each step up costs
///             disproportionately more locked time per unit of voting weight gained.
///
///         Conviction table (6s blocks, 14,400 blocks/day):
///           Low levels are cheap (casual participation), upper levels have
///           escalating lockup cost per unit of weight (true conviction).
///           0 →  1x weight,    0d lock (        0 blocks) — instant withdraw
///           1 →  2x weight,    1d lock (   14,400 blocks) — low-risk entry
///           2 →  3x weight,    3d lock (   43,200 blocks) — weekend lock
///           3 →  4x weight,    7d lock (  100,800 blocks) — one week
///           4 →  6x weight,   21d lock (  302,400 blocks) — three weeks
///           5 →  9x weight,   90d lock (1,296,000 blocks) — quarter
///           6 → 14x weight,  180d lock (2,592,000 blocks) — half year
///           7 → 18x weight,  270d lock (3,888,000 blocks) — nine months
///           8 → 21x weight,  365d lock (5,256,000 blocks) — full year
contract DatumGovernanceV2 {
    uint8 public constant MAX_CONVICTION = 8;

    ISystem private constant SYSTEM = ISystem(0x0000000000000000000000000000000000000900);
    address private constant SYSTEM_ADDR = 0x0000000000000000000000000000000000000900;

    // -------------------------------------------------------------------------
    // Conviction lookup (hardcoded — no storage arrays, saves PVM bytecode)
    // Polkadot Hub: 6-second block time, 14,400 blocks/day
    // Escalating cost: low levels cheap, high levels require true conviction
    //   0 →  1x /   0d    1 →  2x /   1d   2 →  3x /   3d
    //   3 →  4x /   7d    4 →  6x /  21d   5 →  9x /  90d
    //   6 → 14x / 180d    7 → 18x / 270d   8 → 21x / 365d
    // -------------------------------------------------------------------------

    function _weight(uint8 c) internal pure returns (uint256) {
        if (c == 0) return 1;
        if (c == 1) return 2;
        if (c == 2) return 3;
        if (c == 3) return 4;
        if (c == 4) return 6;
        if (c == 5) return 9;
        if (c == 6) return 14;
        if (c == 7) return 18;
        return 21; // c == 8
    }

    function _lockup(uint8 c) internal pure returns (uint256) {
        if (c <= 0) return 0;
        if (c == 1) return 14400;
        if (c == 2) return 43200;
        if (c == 3) return 100800;
        if (c == 4) return 302400;
        if (c == 5) return 1296000;
        if (c == 6) return 2592000;
        if (c == 7) return 3888000;
        return 5256000; // c == 8
    }

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    address public owner;
    address public campaigns;
    address public slashContract;
    IDatumCampaignLifecycle public lifecycle;
    address public pauseRegistry;

    uint256 private _locked;

    uint256 public quorumWeighted;
    uint256 public slashBps;
    uint256 public terminationQuorum;
    uint256 public baseGraceBlocks;    // minimum cooldown before termination
    uint256 public gracePerQuorum;     // additional blocks per quorum-unit of total weight
    uint256 public maxGraceBlocks;     // cap on total grace period

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    struct Vote {
        uint8 direction;          // 0=none, 1=aye, 2=nay
        uint256 lockAmount;
        uint8 conviction;         // 0-8
        uint256 lockedUntilBlock;
    }

    mapping(uint256 => uint256) public ayeWeighted;
    mapping(uint256 => uint256) public nayWeighted;
    mapping(uint256 => bool) public resolved;
    mapping(uint256 => uint256) public slashCollected;
    mapping(uint256 => mapping(address => Vote)) private _votes;
    mapping(uint256 => uint256) public firstNayBlock;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event VoteCast(uint256 indexed campaignId, address indexed voter, bool aye, uint256 amount, uint8 conviction);
    event VoteWithdrawn(uint256 indexed campaignId, address indexed voter, uint256 returned, uint256 slashed);
    event CampaignEvaluated(uint256 indexed campaignId, uint8 result);
    event ContractReferenceChanged(string name, address oldAddr, address newAddr);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        address _campaigns,
        uint256 _quorum,
        uint256 _slashBps,
        uint256 _terminationQuorum,
        uint256 _baseGrace,
        uint256 _gracePerQuorum,
        uint256 _maxGrace,
        address _pauseRegistry
    ) {
        require(_campaigns != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        require(_maxGrace >= _baseGrace, "E00");
        owner = msg.sender;
        campaigns = _campaigns;
        quorumWeighted = _quorum;
        slashBps = _slashBps;
        terminationQuorum = _terminationQuorum;
        baseGraceBlocks = _baseGrace;
        gracePerQuorum = _gracePerQuorum;
        maxGraceBlocks = _maxGrace;
        pauseRegistry = _pauseRegistry;
    }

    receive() external payable {}

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setSlashContract(address _slash) external {
        require(msg.sender == owner, "E18");
        require(slashContract == address(0), "E51");
        emit ContractReferenceChanged("slashContract", slashContract, _slash);
        slashContract = _slash;
    }

    function setLifecycle(address _lifecycle) external {
        require(msg.sender == owner, "E18");
        require(_lifecycle != address(0), "E00");
        emit ContractReferenceChanged("lifecycle", address(lifecycle), _lifecycle);
        lifecycle = IDatumCampaignLifecycle(_lifecycle);
    }

    // -------------------------------------------------------------------------
    // Voting
    // -------------------------------------------------------------------------

    function vote(uint256 campaignId, bool aye, uint8 conviction) external payable {
        (bool pOk, bytes memory pRet) = pauseRegistry.staticcall(abi.encodeWithSelector(bytes4(0x5c975abb)));
        require(pOk && pRet.length >= 32 && !abi.decode(pRet, (bool)), "P");
        require(conviction <= MAX_CONVICTION, "E40");
        require(msg.value > 0, "E41");

        Vote storage v = _votes[campaignId][msg.sender];
        require(v.direction == 0, "E42");

        (uint8 status,,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
        require(status == 0 || status == 1, "E43");

        uint256 weight = msg.value * _weight(conviction);
        uint256 lockup = _lockup(conviction);

        v.direction = aye ? 1 : 2;
        v.lockAmount = msg.value;
        v.conviction = conviction;
        v.lockedUntilBlock = block.number + lockup;

        if (aye) {
            ayeWeighted[campaignId] += weight;
        } else {
            nayWeighted[campaignId] += weight;
            if (firstNayBlock[campaignId] == 0) {
                firstNayBlock[campaignId] = block.number;
            }
        }

        emit VoteCast(campaignId, msg.sender, aye, msg.value, conviction);
    }

    // -------------------------------------------------------------------------
    // Withdrawal
    // -------------------------------------------------------------------------

    function withdraw(uint256 campaignId) external {
        require(_locked == 0, "E57");
        _locked = 1;
        Vote storage v = _votes[campaignId][msg.sender];
        require(v.direction != 0, "E44");
        require(block.number >= v.lockedUntilBlock, "E45");

        uint256 weight = v.lockAmount * _weight(v.conviction);
        uint256 slash = 0;

        if (v.direction == 1) {
            ayeWeighted[campaignId] -= weight;
        } else {
            nayWeighted[campaignId] -= weight;
        }

        if (resolved[campaignId]) {
            (uint8 status,,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);
            bool loser = (status == 3 && v.direction == 2)
                      || (status == 4 && v.direction == 1);
            if (loser) {
                slash = v.lockAmount * slashBps / 10000;
                slashCollected[campaignId] += slash;
            }
        }

        uint256 refund = v.lockAmount - slash;

        if (SYSTEM_ADDR.code.length > 0) {
            uint256 minBal = SYSTEM.minimumBalance();
            require(refund >= minBal, "E58");
        }

        v.direction = 0;
        v.lockAmount = 0;
        v.conviction = 0;
        v.lockedUntilBlock = 0;

        (bool ok,) = msg.sender.call{value: refund}("");
        require(ok, "E02");

        emit VoteWithdrawn(campaignId, msg.sender, refund, slash);
        _locked = 0;
    }

    // -------------------------------------------------------------------------
    // Evaluation
    // -------------------------------------------------------------------------

    function evaluateCampaign(uint256 campaignId) external {
        (bool pOk, bytes memory pRet) = pauseRegistry.staticcall(abi.encodeWithSelector(bytes4(0x5c975abb)));
        require(pOk && pRet.length >= 32 && !abi.decode(pRet, (bool)), "P");
        (uint8 status,,,) = IDatumCampaignsMinimal(campaigns).getCampaignForSettlement(campaignId);

        uint256 total = ayeWeighted[campaignId] + nayWeighted[campaignId];

        if (status == 0) {
            // Pending -> Active
            require(total >= quorumWeighted, "E46");
            require(ayeWeighted[campaignId] * 10000 > total * 5000, "E47");
            IDatumCampaignsMinimal(campaigns).activateCampaign(campaignId);
            emit CampaignEvaluated(campaignId, 1);
        } else if (status == 1 || status == 2) {
            // Active/Paused -> Terminated (via Lifecycle)
            require(total > 0, "E51");
            require(nayWeighted[campaignId] * 10000 >= total * 5000, "E48");
            require(nayWeighted[campaignId] >= terminationQuorum, "E52");
            // Scaled grace: higher turnout → longer cooldown (capped)
            uint256 grace = baseGraceBlocks;
            if (quorumWeighted > 0) {
                grace += total * gracePerQuorum / quorumWeighted;
            }
            if (grace > maxGraceBlocks) grace = maxGraceBlocks;
            require(firstNayBlock[campaignId] > 0 && block.number >= firstNayBlock[campaignId] + grace, "E53");
            lifecycle.terminateCampaign(campaignId);
            resolved[campaignId] = true;
            emit CampaignEvaluated(campaignId, 4);
        } else if (status == 3) {
            // Completed -> mark resolved
            require(!resolved[campaignId], "E49");
            resolved[campaignId] = true;
            emit CampaignEvaluated(campaignId, 3);
        } else if (status == 4 && !resolved[campaignId]) {
            // Terminated -> mark resolved
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
        require(_locked == 0, "E57");
        _locked = 1;
        require(msg.sender == slashContract, "E19");
        if (action == 0) {
            if (SYSTEM_ADDR.code.length > 0) {
                uint256 minBal = SYSTEM.minimumBalance();
                require(value >= minBal, "E58");
            }
            (bool ok,) = target.call{value: value}("");
            require(ok, "E02");
        }
        _locked = 0;
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

    /// @notice Returns the weight multiplier for a conviction level.
    ///         Used by GovernanceSlash to compute voter weight consistently.
    function convictionWeight(uint8 conviction) external pure returns (uint256) {
        require(conviction <= MAX_CONVICTION, "E40");
        return _weight(conviction);
    }
}
