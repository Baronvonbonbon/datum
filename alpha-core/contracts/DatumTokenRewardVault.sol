// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumPlumbingLockable.sol";
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
contract DatumTokenRewardVault is IDatumTokenRewardVault, ReentrancyGuard, DatumPlumbingLockable {
    function version() public pure virtual override returns (uint256) { return 1; }

    using SafeERC20 for IERC20;
    address public settlement;
    IDatumCampaigns public campaigns;

    // token => user => balance
    mapping(address => mapping(address => uint256)) public userTokenBalance;
    // token => campaignId => remaining budget
    mapping(address => mapping(uint256 => uint256)) public campaignTokenBudget;

    // ── Enumeration for upgrade migration (redeploy-migrate-rewire) ──
    // Multi-token: track the token set, and per-token the users with a balance
    // and campaigns with budget, plus recovery registrants. A successor's
    // `_migrate` copies each; `migrateFundsTo` sweeps every token's balance.
    address[] private _tokens;
    mapping(address => bool) private _tokenTracked;
    mapping(address => address[]) private _tokenUsers;
    mapping(address => mapping(address => bool)) private _tokenUserTracked;
    mapping(address => uint256[]) private _tokenCampaigns;
    mapping(address => mapping(uint256 => bool)) private _tokenCampaignTracked;
    address[] private _recoveryUsers;
    mapping(address => bool) private _recoveryTracked;
    bool public fundsMigratedOut;
    event FundsMigratedOut(address indexed successor, address indexed token, uint256 amount);

    function _trackToken(address t) internal {
        if (t != address(0) && !_tokenTracked[t]) { _tokenTracked[t] = true; _tokens.push(t); }
    }
    function _trackTokenUser(address t, address u) internal {
        if (u != address(0) && !_tokenUserTracked[t][u]) { _tokenUserTracked[t][u] = true; _tokenUsers[t].push(u); }
    }
    function _trackTokenCampaign(address t, uint256 c) internal {
        if (!_tokenCampaignTracked[t][c]) { _tokenCampaignTracked[t][c] = true; _tokenCampaigns[t].push(c); }
    }
    function _trackRecoveryUser(address u) internal {
        if (u != address(0) && !_recoveryTracked[u]) { _recoveryTracked[u] = true; _recoveryUsers.push(u); }
    }

    // -------------------------------------------------------------------------
    // G-8 mirror (2026-05-21): time-locked recovery-address mechanism
    // -------------------------------------------------------------------------
    //
    // Mirrors the pattern from DatumPaymentVault.setRecoveryAddress: users
    // pre-register a recovery (cold wallet); after `recoveryDelayBlocks`,
    // anyone can trigger `emergencyWithdraw` to drain a list of token
    // balances of the original account to the recovery. One-shot: recovery
    // clears after use.
    //
    // Asymmetry vs PaymentVault: this vault is per-token, so emergency
    // withdrawal accepts a tokens[] array. Caller enumerates which tokens
    // to drain in the single one-shot call.

    mapping(address => address) public recoveryAddress;
    mapping(address => uint64) public recoveryEffectiveBlock;

    uint64 public recoveryDelayBlocks = 14400; // ~24h
    uint64 public constant MIN_RECOVERY_DELAY = 1_440;   // ~6h
    uint64 public constant MAX_RECOVERY_DELAY = 432_000; // ~30d

    event RecoveryAddressStaged(address indexed user, address indexed recovery, uint64 effectiveBlock);
    event RecoveryAddressCancelled(address indexed user);
    event EmergencyTokenWithdrawn(address indexed user, address indexed recovery, address indexed token, uint256 amount);
    event RecoveryDelayBlocksSet(uint64 blocks_);

    constructor(address _campaigns) {
        require(_campaigns != address(0), "E00");
        campaigns = IDatumCampaigns(_campaigns);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @dev Cypherpunk lock-once: settlement is the only address that may
    ///      credit token rewards. Hot-swap = drain advertiser deposits.
    function setSettlement(address addr) external onlyOwner whenPlumbingUnlocked {
        require(addr != address(0), "E00");
        settlement = addr;
    }

    // -------------------------------------------------------------------------
    // ERC sidecar on/off switches (governance-settable; not lock-once)
    // -------------------------------------------------------------------------

    /// @notice Master switch for ERC-20 sidecar rewards. When false,
    ///         `creditReward` no-ops (settlement still succeeds) so no new token
    ///         rewards accrue. Already-credited balances stay withdrawable and
    ///         advertiser budgets stay reclaimable. Default on.
    bool public tokenRewardsEnabled = true;

    /// @notice Per-reward-token block. Default false (allowed). Lets governance
    ///         disable a specific token without flipping the master switch.
    mapping(address => bool) public tokenRewardBlocked;

    /// @notice ParameterGovernance — normal-ops toggle authority via proposal.
    address public parameterGovernance;
    /// @notice DatumCouncil — emergency toggle authority (instant N-of-M).
    address public council;

    event TokenRewardsEnabledSet(bool enabled);
    event TokenRewardBlockedSet(address indexed token, bool blocked);
    event ParameterGovernanceSet(address indexed pg);
    event CouncilSet(address indexed council);

    function setParameterGovernance(address pg) external onlyOwner {
        require(pg != address(0), "E00");
        parameterGovernance = pg;
        emit ParameterGovernanceSet(pg);
    }

    function setCouncil(address c) external onlyOwner {
        require(c != address(0), "E00");
        council = c;
        emit CouncilSet(c);
    }

    /// @dev Owner (Timelock/Council later), ParameterGovernance (proposal flow),
    ///      or Council (emergency override) may flip the sidecar switches.
    modifier onlyToggleAuth() {
        require(
            msg.sender == owner() ||
            msg.sender == parameterGovernance ||
            (council != address(0) && msg.sender == council),
            "E18"
        );
        _;
    }

    /// @notice Master on/off for ERC sidecar crediting. Toggleable repeatedly.
    function setTokenRewardsEnabled(bool enabled) external onlyToggleAuth whenNotFrozen {
        tokenRewardsEnabled = enabled;
        emit TokenRewardsEnabledSet(enabled);
    }

    /// @notice Block/unblock a specific reward token. Blocked tokens stop
    ///         accruing new rewards; existing balances remain withdrawable.
    function setTokenRewardBlocked(address token, bool blocked) external onlyToggleAuth whenNotFrozen {
        require(token != address(0), "E00");
        tokenRewardBlocked[token] = blocked;
        emit TokenRewardBlockedSet(token, blocked);
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
        _trackToken(token);
        _trackTokenCampaign(token, campaignId);
        emit TokenBudgetDeposited(campaignId, token, amount);
    }

    // -------------------------------------------------------------------------
    // Credit (Settlement only)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumTokenRewardVault
    function creditReward(uint256 campaignId, address token, address user, uint256 amount) external {
        require(msg.sender == settlement, "E25");
        require(user != address(0), "E00");

        // Sidecar master switch / per-token block — when off, no new rewards
        // accrue but settlement still succeeds (mirrors the budget==0 skip).
        if (!tokenRewardsEnabled || tokenRewardBlocked[token]) {
            emit RewardCreditSkipped(campaignId, token, user); // AUDIT-019
            return;
        }

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
        _trackToken(token);
        _trackTokenUser(token, user);
        emit TokenRewardCredited(campaignId, token, user, credit);
    }

    // -------------------------------------------------------------------------
    // Withdrawal (user pull pattern)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumTokenRewardVault
    function withdraw(address token) external nonReentrant whenNotFrozen {
        uint256 amount = userTokenBalance[token][msg.sender];
        require(amount > 0, "E03");
        userTokenBalance[token][msg.sender] = 0;

        IERC20(token).safeTransfer(msg.sender, amount);
        emit TokenWithdrawal(msg.sender, token, amount);
    }

    /// @inheritdoc IDatumTokenRewardVault
    function withdrawTo(address token, address recipient) external nonReentrant whenNotFrozen {
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
    function reclaimExpiredBudget(uint256 campaignId, address token) external nonReentrant whenNotFrozen {
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

    // -------------------------------------------------------------------------
    // G-8 mirror (2026-05-21): time-locked recovery
    // -------------------------------------------------------------------------

    /// @notice Stage a recovery address. The recovery does NOT take immediate
    ///         effect; it activates after `recoveryDelayBlocks` blocks. During
    ///         the delay window, the original account can cancel via
    ///         `cancelRecoveryAddress`. Re-staging overwrites prior state and
    ///         restarts the delay.
    function setRecoveryAddress(address recovery) external whenNotFrozen {
        require(recovery != address(0), "E00");
        require(recovery != msg.sender, "E11");
        recoveryAddress[msg.sender] = recovery;
        uint64 effective = uint64(block.number) + recoveryDelayBlocks;
        recoveryEffectiveBlock[msg.sender] = effective;
        _trackRecoveryUser(msg.sender);
        emit RecoveryAddressStaged(msg.sender, recovery, effective);
    }

    /// @notice Cancel any pending or active recovery.
    function cancelRecoveryAddress() external whenNotFrozen {
        require(recoveryAddress[msg.sender] != address(0), "E01");
        recoveryAddress[msg.sender] = address(0);
        recoveryEffectiveBlock[msg.sender] = 0;
        emit RecoveryAddressCancelled(msg.sender);
    }

    /// @notice Pull listed token balances of `originalAccount` to the
    ///         registered recovery. Permissionless trigger — funds always
    ///         go to the registered recovery. Reverts if recovery is not
    ///         yet active. One-shot: clears the recovery after the call.
    /// @dev    Caller enumerates which tokens to drain. At least one token
    ///         must transfer a non-zero amount, else reverts E03. If a
    ///         caller wants to recover further tokens, the user must
    ///         re-stage and wait the delay again.
    function emergencyWithdraw(address originalAccount, address[] calldata tokens)
        external
        nonReentrant
        whenNotFrozen
    {
        address recovery = recoveryAddress[originalAccount];
        require(recovery != address(0), "E01");
        uint64 effective = recoveryEffectiveBlock[originalAccount];
        require(effective != 0 && block.number >= uint256(effective), "E70");
        require(tokens.length > 0, "E11");

        uint256 totalDrained;
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (token == address(0)) continue;
            uint256 amt = userTokenBalance[token][originalAccount];
            if (amt == 0) continue;
            userTokenBalance[token][originalAccount] = 0;
            totalDrained += amt;
            emit EmergencyTokenWithdrawn(originalAccount, recovery, token, amt);
            emit TokenWithdrawal(originalAccount, token, amt);
            IERC20(token).safeTransfer(recovery, amt);
        }
        require(totalDrained > 0, "E03");

        recoveryAddress[originalAccount] = address(0);
        recoveryEffectiveBlock[originalAccount] = 0;
        emit RecoveryAddressCancelled(originalAccount);
    }

    function setRecoveryDelayBlocks(uint64 blocks_) external onlyOwner whenNotFrozen {
        require(blocks_ >= MIN_RECOVERY_DELAY && blocks_ <= MAX_RECOVERY_DELAY, "E11");
        recoveryDelayBlocks = blocks_;
        emit RecoveryDelayBlocksSet(blocks_);
    }

    function recoveryActivatesAt(address user) external view returns (uint64) {
        return recoveryEffectiveBlock[user];
    }

    function recoveryActive(address user) external view returns (bool) {
        uint64 e = recoveryEffectiveBlock[user];
        return e != 0 && block.number >= uint256(e) && recoveryAddress[user] != address(0);
    }

    // -------------------------------------------------------------------------
    // Upgrade migration (redeploy-migrate-rewire)
    // -------------------------------------------------------------------------

    function tokenCount() external view returns (uint256) { return _tokens.length; }
    function tokenAt(uint256 i) external view returns (address) { return _tokens[i]; }
    function tokenUserCount(address token) external view returns (uint256) { return _tokenUsers[token].length; }
    function tokenUserAt(address token, uint256 i) external view returns (address) { return _tokenUsers[token][i]; }
    function tokenCampaignCount(address token) external view returns (uint256) { return _tokenCampaigns[token].length; }
    function tokenCampaignAt(address token, uint256 i) external view returns (uint256) { return _tokenCampaigns[token][i]; }
    function recoveryUserCount() external view returns (uint256) { return _recoveryUsers.length; }
    function recoveryUserAt(uint256 i) external view returns (address) { return _recoveryUsers[i]; }

    /// @dev Copy per-(token,user) balances + per-(token,campaign) budgets +
    ///      recovery state from a frozen predecessor. Structural refs
    ///      (settlement / campaigns) are re-wired on the fresh contract. The
    ///      custodied ERC-20s move via `migrateFundsTo`.
    function _migrate(address oldContract) internal override {
        DatumTokenRewardVault old = DatumTokenRewardVault(payable(oldContract));
        recoveryDelayBlocks = old.recoveryDelayBlocks();
        // Preserve sidecar switch state + toggle authorities across the upgrade.
        tokenRewardsEnabled = old.tokenRewardsEnabled();
        parameterGovernance = old.parameterGovernance();
        council = old.council();
        uint256 nt = old.tokenCount();
        for (uint256 i = 0; i < nt; i++) {
            address token = old.tokenAt(i);
            _trackToken(token);
            // Carry forward any per-token block (token set is enumerable).
            if (old.tokenRewardBlocked(token)) tokenRewardBlocked[token] = true;
            uint256 nu = old.tokenUserCount(token);
            for (uint256 j = 0; j < nu; j++) {
                address u = old.tokenUserAt(token, j);
                userTokenBalance[token][u] = old.userTokenBalance(token, u);
                _trackTokenUser(token, u);
            }
            uint256 ncmp = old.tokenCampaignCount(token);
            for (uint256 j = 0; j < ncmp; j++) {
                uint256 cid = old.tokenCampaignAt(token, j);
                campaignTokenBudget[token][cid] = old.campaignTokenBudget(token, cid);
                _trackTokenCampaign(token, cid);
            }
        }
        uint256 nr = old.recoveryUserCount();
        for (uint256 i = 0; i < nr; i++) {
            address ru = old.recoveryUserAt(i);
            recoveryAddress[ru] = old.recoveryAddress(ru);
            recoveryEffectiveBlock[ru] = old.recoveryEffectiveBlock(ru);
            _trackRecoveryUser(ru);
        }
    }

    /// @notice Sweep every custodied ERC-20's balance to a successor during an
    ///         upgrade so it can honour migrated balances + budgets.
    ///         Governance-gated, frozen-only, one-shot.
    function migrateFundsTo(address successor) external onlyGovernance nonReentrant {
        require(frozen, "not frozen");
        require(!fundsMigratedOut, "already swept");
        require(successor != address(0), "E00");
        fundsMigratedOut = true;
        uint256 nt = _tokens.length;
        for (uint256 i = 0; i < nt; i++) {
            address token = _tokens[i];
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) {
                emit FundsMigratedOut(successor, token, bal);
                IERC20(token).safeTransfer(successor, bal);
            }
        }
    }

    /// @notice Reject accidental ETH deposits
    receive() external payable whenNotFrozen { revert("E03"); }
}
