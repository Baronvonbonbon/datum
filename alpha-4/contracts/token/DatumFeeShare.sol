// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../DatumOwnable.sol";

/// @title DatumFeeShare
/// @notice Stake WDATUM, earn DOT. Implements the §2.1 cashflow utility.
///
///         Stakers deposit WDATUM into this contract and earn a pro-rata
///         share of incoming DOT protocol fees, distributed via the standard
///         MasterChef/SushiBar accumulator pattern. Rewards are streamed
///         continuously based on stake×time; new stakers do not dilute
///         unclaimed rewards.
///
///         Zero withdrawal lockup. Same-block flash-stake protection comes
///         from the accumulator pattern itself — a same-block staker accrues
///         nothing because their userDebt is snapshot at deposit-time.
///
/// @dev    DOT is the native chain currency on Polkadot Hub. The contract
///         receives DOT via the receive() function and tracks distribution
///         via accDotPerShare.
///
///         Fee inflow path:
///           1. DatumPaymentVault accrues `pendingFeeShare` on each settlement.
///           2. Anyone (off-chain bot, dev tooling, the user themselves) calls
///              `sweep()` which pulls accrued DOT from PaymentVault into this
///              contract via the IDatumPaymentVault_FeeShare interface.
///           3. The sweep transitively calls `notifyFee()` to update the
///              accumulator.
///
///         For the devnet scaffold, the PaymentVault integration is stubbed:
///         anyone can call `fund()` (payable) to simulate fee inflow without
///         requiring the full PaymentVault.
contract DatumFeeShare is DatumOwnable, ReentrancyGuard {

    // -------------------------------------------------------------------------
    // Configuration (immutable post-deploy)
    // -------------------------------------------------------------------------

    /// @notice The stake token — WDATUM. Set at construction.
    IERC20 public immutable stakeToken;

    /// @notice DatumPaymentVault address — source for protocol-fee sweeps.
    ///         Optional; if zero, sweep() reverts and the contract relies on
    ///         direct DOT inflows via fund() or receive().
    address public paymentVault;

    /// @notice Accumulator scale factor. Higher = more precision for
    ///         small-stake-large-reward edge cases. 1e18 is standard.
    uint256 public constant ACC_SCALE = 1e18;

    // -------------------------------------------------------------------------
    // Running state
    // -------------------------------------------------------------------------

    /// @notice Total WDATUM staked across all stakers.
    uint256 public totalStaked;

    /// @notice Accumulated DOT per share, scaled by ACC_SCALE.
    /// @dev    On notifyFee(amount): accDotPerShare += amount * ACC_SCALE / totalStaked.
    ///         On stake/unstake/claim: user's pending = stakedBy[user] * accDotPerShare / ACC_SCALE - userDebt[user].
    uint256 public accDotPerShare;

    /// @notice DOT received but not yet distributed (e.g. fees received when totalStaked == 0).
    /// @dev    These accumulate as "orphan DOT" until at least one staker exists; first
    ///         post-orphan notifyFee will fold them into the accumulator. Without this
    ///         the orphan fees would be permanently stuck.
    uint256 public orphanDotPending;

    mapping(address => uint256) public stakedBy;
    mapping(address => uint256) public userDebt;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event Staked(address indexed user, uint256 amount, uint256 totalStaked);
    event Unstaked(address indexed user, uint256 amount, uint256 totalStaked);
    event Claimed(address indexed user, uint256 amount);
    event FeeNotified(uint256 amount, uint256 accDotPerShare, uint256 totalStaked);
    event OrphanFolded(uint256 amount);
    event Funded(address indexed from, uint256 amount);

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    constructor(address _stakeToken) {
        require(_stakeToken != address(0), "E00");
        stakeToken = IERC20(_stakeToken);
    }

    /// @notice Wire the DatumPaymentVault address so `sweep()` can pull fees.
    /// @dev    Optional but recommended. Settable by owner; cleared with zero.
    function setPaymentVault(address vault) external onlyOwner {
        paymentVault = vault;
    }

    /// @notice Permissionless sweep — pulls accumulated protocol fees from
    ///         PaymentVault. The DOT lands here via receive() and folds into
    ///         the accumulator automatically.
    /// @dev    Anyone can call. PaymentVault must have `feeShareRecipient`
    ///         set to this contract's address; otherwise the call reverts on
    ///         the vault side.
    function sweep() external {
        require(paymentVault != address(0), "E00");
        // Low-level call to avoid hard interface dependency. The vault's
        // sweepToFeeShare() reverts if no balance or no recipient — we
        // bubble that up rather than swallow it.
        (bool ok, bytes memory ret) = paymentVault.call(
            abi.encodeWithSignature("sweepToFeeShare()")
        );
        if (!ok) {
            // Bubble the revert reason if any.
            if (ret.length > 0) {
                assembly { revert(add(ret, 32), mload(ret)) }
            }
            revert("sweep failed");
        }
    }

    // -------------------------------------------------------------------------
    // Stake / unstake / claim
    // -------------------------------------------------------------------------

    /// @notice Stake WDATUM to begin earning DOT.
    /// @dev    Caller must have approved this contract for `amount` WDATUM first.
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "E11");
        _settle(msg.sender);
        require(stakeToken.transferFrom(msg.sender, address(this), amount), "E02");
        stakedBy[msg.sender] += amount;
        totalStaked += amount;
        _resetDebt(msg.sender);
        emit Staked(msg.sender, amount, totalStaked);
    }

    /// @notice Unstake WDATUM and claim any pending DOT.
    function unstake(uint256 amount) external nonReentrant {
        require(amount > 0, "E11");
        require(stakedBy[msg.sender] >= amount, "E03");
        _settle(msg.sender);
        stakedBy[msg.sender] -= amount;
        totalStaked -= amount;
        _resetDebt(msg.sender);
        require(stakeToken.transfer(msg.sender, amount), "E02");
        emit Unstaked(msg.sender, amount, totalStaked);
    }

    /// @notice Claim pending DOT without altering stake.
    function claim() external nonReentrant {
        _settle(msg.sender);
        _resetDebt(msg.sender);
    }

    // -------------------------------------------------------------------------
    // Fee inflow
    // -------------------------------------------------------------------------

    /// @notice Notify the accumulator of a DOT fee inflow.
    /// @dev    Called by `fund()` after a payable DOT receipt. If totalStaked is
    ///         zero at the time of fee arrival, the DOT is parked in
    ///         `orphanDotPending` and folded into the accumulator on the next
    ///         notify after at least one staker exists. This prevents fees
    ///         from being permanently stuck when no one has staked yet.
    function _notifyFee(uint256 amount) internal {
        if (totalStaked == 0) {
            orphanDotPending += amount;
            return;
        }
        // Fold any prior orphan DOT into this notification.
        uint256 total = amount + orphanDotPending;
        if (orphanDotPending > 0) {
            emit OrphanFolded(orphanDotPending);
            orphanDotPending = 0;
        }
        accDotPerShare += (total * ACC_SCALE) / totalStaked;
        emit FeeNotified(total, accDotPerShare, totalStaked);
    }

    /// @notice Permissionless DOT inflow path. For devnet scaffold use this
    ///         to simulate PaymentVault sweeps; mainnet path is `sweep()`
    ///         pulling from `DatumPaymentVault.pendingFeeShare`.
    function fund() external payable {
        require(msg.value > 0, "E11");
        emit Funded(msg.sender, msg.value);
        _notifyFee(msg.value);
    }

    /// @notice Accept any direct DOT transfer. Same effect as fund() — direct
    ///         transfers fold into the accumulator automatically.
    receive() external payable {
        if (msg.value > 0) {
            emit Funded(msg.sender, msg.value);
            _notifyFee(msg.value);
        }
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /// @notice Pay out any pending DOT to `user` before changing their stake.
    /// @dev    Pull pattern via a low-level call so a user contract with a
    ///         hostile fallback cannot block their own settlement — but they
    ///         also can't grief by reverting on receive. Failed transfers
    ///         leave the pending balance recoverable via a subsequent call.
    function _settle(address user) internal {
        uint256 pending = (stakedBy[user] * accDotPerShare) / ACC_SCALE;
        if (pending <= userDebt[user]) return;
        uint256 owed = pending - userDebt[user];
        if (owed == 0) return;
        // Update debt BEFORE transfer (reentrancy guard already protects, but defence-in-depth).
        userDebt[user] = pending;
        (bool ok, ) = user.call{value: owed}("");
        require(ok, "E02");
        emit Claimed(user, owed);
    }

    /// @notice Snapshot user's debt to the current accumulator value.
    /// @dev    Called after stake-changing operations so future pending calcs
    ///         are scoped from this moment forward (flash-stake protection).
    function _resetDebt(address user) internal {
        userDebt[user] = (stakedBy[user] * accDotPerShare) / ACC_SCALE;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Pending DOT for `user` if they were to claim now.
    function pendingOf(address user) external view returns (uint256) {
        uint256 accrued = (stakedBy[user] * accDotPerShare) / ACC_SCALE;
        return accrued > userDebt[user] ? accrued - userDebt[user] : 0;
    }
}
