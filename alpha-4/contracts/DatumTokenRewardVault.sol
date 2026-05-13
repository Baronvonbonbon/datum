// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumOwnable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IDatumTokenRewardVault.sol";
import "./interfaces/IDatumCampaigns.sol";

/// @title DatumTokenRewardVault
/// @notice Pull-payment vault for ERC-20 token rewards alongside DOT settlement.
///         Advertisers deposit ERC-20 tokens at campaign creation; Settlement
///         credits users on each settled claim; users withdraw via pull pattern.
///
///         Separated from DatumPaymentVault to keep ETH-native accounting isolated.
///         Only supports EVM-native ERC-20 tokens (not native Asset Hub assets).
contract DatumTokenRewardVault is IDatumTokenRewardVault, ReentrancyGuard, DatumOwnable {
    using SafeERC20 for IERC20;
    address public settlement;
    IDatumCampaigns public campaigns;

    // token => user => balance
    mapping(address => mapping(address => uint256)) public userTokenBalance;
    // token => campaignId => remaining budget
    mapping(address => mapping(uint256 => uint256)) public campaignTokenBudget;

    constructor(address _campaigns) {
        require(_campaigns != address(0), "E00");
        campaigns = IDatumCampaigns(_campaigns);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @dev Cypherpunk lock-once: settlement is the only address that may
    ///      credit token rewards. Hot-swap = drain advertiser deposits.
    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(settlement == address(0), "already set");
        settlement = addr;
    }

    // -------------------------------------------------------------------------
    // Deposit (advertiser)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumTokenRewardVault
    function depositCampaignBudget(uint256 campaignId, address token, uint256 amount) external {
        require(token != address(0), "E00");
        require(amount > 0, "E11");

        // Verify caller is the campaign advertiser
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        require(advertiser != address(0), "E01");
        require(msg.sender == advertiser, "E18");

        // Pull tokens from advertiser (requires prior approve)
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

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
        if (budget == 0) {
            emit RewardCreditSkipped(campaignId, token, user); // AUDIT-019
            return;
        }

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

        IERC20(token).safeTransfer(msg.sender, amount);
        emit TokenWithdrawal(msg.sender, token, amount);
    }

    /// @inheritdoc IDatumTokenRewardVault
    function withdrawTo(address token, address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        uint256 amount = userTokenBalance[token][msg.sender];
        require(amount > 0, "E03");
        userTokenBalance[token][msg.sender] = 0;

        IERC20(token).safeTransfer(recipient, amount);
        emit TokenWithdrawal(msg.sender, token, amount);
    }

    // -------------------------------------------------------------------------
    // Reclaim expired budget (advertiser)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumTokenRewardVault
    function reclaimExpiredBudget(uint256 campaignId, address token) external nonReentrant {
        // Verify caller is the campaign advertiser
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        require(msg.sender == advertiser, "E18");

        // Verify campaign is ended (Completed=3, Terminated=4, Expired=5)
        IDatumCampaigns.CampaignStatus status = campaigns.getCampaignStatus(campaignId);
        require(uint8(status) >= 3, "E22");

        uint256 remaining = campaignTokenBudget[token][campaignId];
        require(remaining > 0, "E03");
        campaignTokenBudget[token][campaignId] = 0;

        IERC20(token).safeTransfer(advertiser, remaining);
        emit TokenBudgetReclaimed(campaignId, token, advertiser, remaining);
    }

    /// @notice Reject accidental ETH deposits
    receive() external payable { revert("E03"); }
}
