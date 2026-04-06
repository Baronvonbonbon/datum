// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IDatumTokenRewardVault.sol";

/// @title DatumTokenRewardVault
/// @notice Pull-payment vault for ERC-20 token rewards alongside DOT settlement.
///         Advertisers deposit ERC-20 tokens at campaign creation; Settlement
///         credits users on each settled claim; users withdraw via pull pattern.
///
///         Separated from DatumPaymentVault to keep ETH-native accounting isolated.
///         Only supports EVM-native ERC-20 tokens (not native Asset Hub assets).
contract DatumTokenRewardVault is IDatumTokenRewardVault, ReentrancyGuard {
    address public owner;
    address public pendingOwner;
    address public settlement;
    address public campaigns;

    // token => user => balance
    mapping(address => mapping(address => uint256)) public userTokenBalance;
    // token => campaignId => remaining budget
    mapping(address => mapping(uint256 => uint256)) public campaignTokenBudget;

    constructor(address _campaigns) {
        require(_campaigns != address(0), "E00");
        owner = msg.sender;
        campaigns = _campaigns;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setSettlement(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        settlement = addr;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "E18");
        require(newOwner != address(0), "E00");
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "E18");
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // -------------------------------------------------------------------------
    // Deposit (advertiser)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumTokenRewardVault
    function depositCampaignBudget(uint256 campaignId, address token, uint256 amount) external {
        require(token != address(0), "E00");
        require(amount > 0, "E11");

        // Verify caller is the campaign advertiser
        (bool ok, bytes memory ret) = campaigns.staticcall(
            abi.encodeWithSelector(bytes4(0x3c292eb4), campaignId)  // getCampaignAdvertiser(uint256)
        );
        require(ok && ret.length >= 32, "E01");
        address advertiser = abi.decode(ret, (address));
        require(advertiser != address(0), "E01");
        require(msg.sender == advertiser, "E18");

        // Pull tokens from advertiser (requires prior approve)
        bool transferred = IERC20(token).transferFrom(msg.sender, address(this), amount);
        require(transferred, "E02");

        campaignTokenBudget[token][campaignId] += amount;
        emit TokenBudgetDeposited(campaignId, token, amount);
    }

    // -------------------------------------------------------------------------
    // Credit (Settlement only)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumTokenRewardVault
    function creditReward(uint256 campaignId, address token, address user, uint256 amount) external {
        require(msg.sender == settlement, "E25");
        require(user != address(0), "E00");

        uint256 budget = campaignTokenBudget[token][campaignId];
        if (budget == 0) return;  // silently skip if exhausted

        uint256 credit = amount;
        if (credit > budget) {
            credit = budget;
            emit BudgetExhausted(campaignId, token);
        }

        campaignTokenBudget[token][campaignId] = budget - credit;
        userTokenBalance[token][user] += credit;
        emit TokenRewardCredited(campaignId, token, user, credit);
    }

    // -------------------------------------------------------------------------
    // Withdrawal (user pull pattern)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumTokenRewardVault
    function withdraw(address token) external nonReentrant {
        uint256 amount = userTokenBalance[token][msg.sender];
        require(amount > 0, "E03");
        userTokenBalance[token][msg.sender] = 0;

        bool transferred = IERC20(token).transfer(msg.sender, amount);
        require(transferred, "E02");
        emit TokenWithdrawal(msg.sender, token, amount);
    }

    /// @inheritdoc IDatumTokenRewardVault
    function withdrawTo(address token, address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        uint256 amount = userTokenBalance[token][msg.sender];
        require(amount > 0, "E03");
        userTokenBalance[token][msg.sender] = 0;

        bool transferred = IERC20(token).transfer(recipient, amount);
        require(transferred, "E02");
        emit TokenWithdrawal(msg.sender, token, amount);
    }

    // -------------------------------------------------------------------------
    // Reclaim expired budget (advertiser)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumTokenRewardVault
    function reclaimExpiredBudget(uint256 campaignId, address token) external nonReentrant {
        // Verify caller is the campaign advertiser
        (bool ok, bytes memory ret) = campaigns.staticcall(
            abi.encodeWithSelector(bytes4(0x3c292eb4), campaignId)  // getCampaignAdvertiser(uint256)
        );
        require(ok && ret.length >= 32, "E01");
        address advertiser = abi.decode(ret, (address));
        require(msg.sender == advertiser, "E18");

        // Verify campaign is ended (Completed=3, Terminated=4, Expired=5)
        (bool sOk, bytes memory sRet) = campaigns.staticcall(
            abi.encodeWithSelector(bytes4(0x6c19e004), campaignId)  // getCampaignStatus(uint256)
        );
        require(sOk && sRet.length >= 32, "E01");
        uint8 status = abi.decode(sRet, (uint8));
        require(status >= 3, "E22");  // must be Completed, Terminated, or Expired

        uint256 remaining = campaignTokenBudget[token][campaignId];
        require(remaining > 0, "E03");
        campaignTokenBudget[token][campaignId] = 0;

        bool transferred = IERC20(token).transfer(advertiser, remaining);
        require(transferred, "E02");
        emit TokenBudgetReclaimed(campaignId, token, advertiser, remaining);
    }

    /// @notice Reject accidental ETH deposits
    receive() external payable { revert("E03"); }
}
