// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumOwnable.sol";

/// @title DatumZKStake
/// @notice Path A anti-sybil: explicit DATUM deposit + withdrawal lockup
///         backing the ZK stake gate. Off-chain stakeRoot builder reads
///         `staked(user)` from this contract (NOT raw DATUM balance) so a
///         user must actually lock funds with a cooldown to count.
///
///         Withdrawal flow:
///           1. `requestWithdrawal(amount)` — staked drops immediately
///              (next stakeRoot commit reflects new lower balance), and the
///              amount enters a pending bucket with `readyAt = block + LOCKUP`.
///           2. `executeWithdrawal()` — after lockup, transfers DATUM out.
///
///         Any new withdrawal request RESETS the lockup clock — this defeats
///         the "rolling exit" attack where an attacker pre-queues continuous
///         small withdrawals and times them around fraud activity.
///
///         Rationale: turns sybil from a priced-only market (10 personas =
///         10× minStake locked while active) into a TIME-priced market
///         (10 personas = 10× minStake locked for at LEAST LOCKUP_BLOCKS
///         after the persona's last claim). With LOCKUP_BLOCKS=432,000 (~30d
///         at 6s/block), a sybil operator can't churn identities faster than
///         once per month per capital pool — and slashing (future work) can
///         be applied during the cooldown.
contract DatumZKStake is DatumOwnable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice ~30 days at 6s/block. Withdrawals require this many blocks
    ///         between request and execute. NOT user-tunable; chosen at
    ///         deploy and immutable.
    uint256 public constant LOCKUP_BLOCKS = 432_000;

    /// @notice The DATUM token this contract custodies.
    IERC20 public immutable token;

    /// @notice Active stake per user. The off-chain root builder reads this
    ///         and constructs the Merkle leaf `Poseidon(userCommitment, staked)`.
    mapping(address => uint256) public staked;

    struct PendingWithdrawal {
        uint256 amount;
        uint256 readyAt;  // block number
    }
    mapping(address => PendingWithdrawal) public pending;

    /// @notice Total DATUM held in the contract — sum of all staked + all pending.
    ///         Invariant check helper for off-chain monitoring.
    uint256 public totalLocked;

    event Deposited(address indexed user, uint256 amount, uint256 newStaked);
    event WithdrawalRequested(address indexed user, uint256 amount, uint256 readyAt);
    event WithdrawalExecuted(address indexed user, uint256 amount);

    constructor(address _token) {
        require(_token != address(0), "E00");
        token = IERC20(_token);
    }

    // -------------------------------------------------------------------------
    // User flow
    // -------------------------------------------------------------------------

    /// @notice Stake DATUM. Caller must have approved this contract first.
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "E11");
        // pull tokens before mutating state (SafeERC20 reverts on failure)
        token.safeTransferFrom(msg.sender, address(this), amount);
        staked[msg.sender] += amount;
        totalLocked += amount;
        emit Deposited(msg.sender, amount, staked[msg.sender]);
    }

    /// @notice Begin unstaking `amount`. Drops `staked[msg.sender]` immediately
    ///         so subsequent stakeRoot commits reflect the lower balance — a
    ///         user cannot claim while a withdrawal is in flight if their
    ///         remaining stake falls below the campaign's `minStake`.
    ///         If a withdrawal is already pending, the new amount is ADDED to
    ///         it and the lockup clock RESETS to block.number + LOCKUP_BLOCKS.
    ///         This is intentional: continuous request-staggering can't shorten
    ///         the average exit time.
    function requestWithdrawal(uint256 amount) external nonReentrant {
        require(amount > 0, "E11");
        require(staked[msg.sender] >= amount, "E03");
        staked[msg.sender] -= amount;
        PendingWithdrawal storage p = pending[msg.sender];
        p.amount += amount;
        p.readyAt = block.number + LOCKUP_BLOCKS;  // RESET on every request
        emit WithdrawalRequested(msg.sender, amount, p.readyAt);
    }

    /// @notice Execute a pending withdrawal once the lockup has elapsed.
    function executeWithdrawal() external nonReentrant {
        PendingWithdrawal storage p = pending[msg.sender];
        uint256 amount = p.amount;
        require(amount > 0, "E03");
        require(block.number >= p.readyAt, "E37");
        // Clear before transfer (reentrancy hygiene; SafeERC20 + nonReentrant already cover us)
        p.amount = 0;
        p.readyAt = 0;
        totalLocked -= amount;
        token.safeTransfer(msg.sender, amount);
        emit WithdrawalExecuted(msg.sender, amount);
    }

    /// @notice User can fold a pending withdrawal back into active stake.
    ///         No cooldown penalty for changing your mind. Resets pending to 0.
    function cancelWithdrawal() external nonReentrant {
        PendingWithdrawal storage p = pending[msg.sender];
        uint256 amount = p.amount;
        require(amount > 0, "E03");
        p.amount = 0;
        p.readyAt = 0;
        staked[msg.sender] += amount;
        emit Deposited(msg.sender, amount, staked[msg.sender]);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Convenience: blocks remaining until `user`'s pending withdrawal
    ///         is executable. 0 if no pending or already executable.
    function blocksUntilReady(address user) external view returns (uint256) {
        PendingWithdrawal storage p = pending[user];
        if (p.amount == 0) return 0;
        if (block.number >= p.readyAt) return 0;
        return p.readyAt - block.number;
    }
}
