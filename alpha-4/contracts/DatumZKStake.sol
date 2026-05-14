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

    /// @notice Per-address Poseidon-secret commitment = Poseidon(secret).
    ///         Must be set BEFORE the user's first deposit (or atomically with
    ///         it via `depositWith`). Lock-once: cannot be changed after the
    ///         user has any active stake. The off-chain root builder uses this
    ///         to construct the Merkle leaf Poseidon(userCommitment, staked).
    mapping(address => bytes32) public userCommitment;
    event UserCommitmentSet(address indexed user, bytes32 commitment);

    struct PendingWithdrawal {
        uint256 amount;
        uint256 readyAt;  // block number
    }
    mapping(address => PendingWithdrawal) public pending;

    /// @notice Total DATUM held in the contract — sum of all staked + all pending.
    ///         Invariant check helper for off-chain monitoring.
    uint256 public totalLocked;

    /// @notice Authorized slashers (Settlement, Governance contracts).
    ///         Owner-managed up until `slashersLocked` is flipped.
    mapping(address => bool) public isSlasher;
    bool public slashersLocked;
    /// @notice Where slashed funds go. Required to be non-zero at slash time
    ///         (H-1 audit fix) so slashed DATUM can never be orphaned in this
    ///         contract. Set before `lockSlashers()`.
    address public slashRecipient;

    /// @notice H-2 audit fix: max fraction of a user's slashable balance that
    ///         a single slash call may consume, in bps. Defaults to 5000 (50%).
    ///         Governance-tunable up to 10000 (100%). Multi-call slashes are
    ///         possible — the cap is defense-in-depth against a compromised
    ///         slasher draining everyone in one call.
    uint16 public maxSlashBpsPerCall = 5000;
    event MaxSlashBpsPerCallSet(uint16 bps);

    event SlasherSet(address indexed who, bool authorized);
    event SlashersLocked();
    event SlashRecipientSet(address indexed recipient);
    event Slashed(address indexed user, uint256 fromStaked, uint256 fromPending, address indexed by);

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

    /// @notice Set / change your Poseidon-secret commitment. Lock-once: only
    ///         allowed while you have ZERO active stake AND zero pending
    ///         withdrawal. After your first deposit it is permanently fixed
    ///         (changing it mid-stake would orphan your funds from the secret).
    function setUserCommitment(bytes32 commitment) external {
        require(commitment != bytes32(0), "E11");
        require(staked[msg.sender] == 0 && pending[msg.sender].amount == 0, "locked-by-stake");
        userCommitment[msg.sender] = commitment;
        emit UserCommitmentSet(msg.sender, commitment);
    }

    /// @notice One-shot deposit-and-commit. Convenience for first-time users
    ///         who haven't set their commitment yet. Reverts if a different
    ///         commitment is already on file.
    function depositWith(bytes32 commitment, uint256 amount) external nonReentrant {
        require(commitment != bytes32(0), "E11");
        bytes32 cur = userCommitment[msg.sender];
        if (cur == bytes32(0)) {
            userCommitment[msg.sender] = commitment;
            emit UserCommitmentSet(msg.sender, commitment);
        } else {
            require(cur == commitment, "commitment-mismatch");
        }
        _deposit(msg.sender, amount);
    }

    /// @notice Stake DATUM. Caller must have approved this contract first AND
    ///         have a userCommitment on file (else deposit reverts E01 — set
    ///         one via `setUserCommitment` or use `depositWith`).
    function deposit(uint256 amount) external nonReentrant {
        require(userCommitment[msg.sender] != bytes32(0), "E01");
        _deposit(msg.sender, amount);
    }

    function _deposit(address user, uint256 amount) internal {
        require(amount > 0, "E11");
        // pull tokens before mutating state (SafeERC20 reverts on failure)
        token.safeTransferFrom(user, address(this), amount);
        staked[user] += amount;
        totalLocked += amount;
        emit Deposited(user, amount, staked[user]);
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

    // -------------------------------------------------------------------------
    // Slashing
    // -------------------------------------------------------------------------

    function setSlasher(address who, bool authorized) external onlyOwner {
        require(!slashersLocked, "slashers-locked");
        require(who != address(0), "E00");
        isSlasher[who] = authorized;
        emit SlasherSet(who, authorized);
    }

    function setSlashRecipient(address r) external onlyOwner {
        require(r != address(0), "E00");
        slashRecipient = r;
        emit SlashRecipientSet(r);
    }

    /// @notice H-2 audit fix: governance-tunable per-call slash ceiling.
    function setMaxSlashBpsPerCall(uint16 bps) external onlyOwner {
        require(bps > 0 && bps <= 10000, "E11");
        maxSlashBpsPerCall = bps;
        emit MaxSlashBpsPerCallSet(bps);
    }

    /// @notice Lock the slasher set permanently. After this, isSlasher entries
    ///         cannot be added or removed; the slashing authority is fixed.
    function lockSlashers() external onlyOwner {
        require(!slashersLocked, "already locked");
        slashersLocked = true;
        emit SlashersLocked();
    }

    /// @notice Slash a user's stake. Pulls from pending FIRST (since pending
    ///         is in-flight to the user) before touching active stake. This
    ///         ordering means a malicious user cannot dodge slash by queueing
    ///         a withdrawal — pending funds are at risk until executed.
    /// @param user            User to slash.
    /// @param amount          Total amount to remove.
    /// @return fromStaked     How much came from active stake.
    /// @return fromPending    How much came from pending.
    function slash(address user, uint256 amount) external nonReentrant returns (uint256 fromStaked, uint256 fromPending) {
        require(isSlasher[msg.sender], "E18");
        require(amount > 0, "E11");
        // H-1: recipient must be set so slashed funds can never orphan.
        require(slashRecipient != address(0), "no-recipient");

        // H-2: cap a single slash at maxSlashBpsPerCall of the user's total
        //      slashable balance. Defense-in-depth — a compromised slasher
        //      cannot drain everyone in one call.
        uint256 totalSlashable = staked[user] + pending[user].amount;
        uint256 callCap = (totalSlashable * uint256(maxSlashBpsPerCall)) / 10000;
        if (amount > callCap) amount = callCap;
        require(amount > 0, "E03");

        uint256 remaining = amount;

        PendingWithdrawal storage p = pending[user];
        if (p.amount > 0) {
            uint256 takeP = p.amount >= remaining ? remaining : p.amount;
            p.amount -= takeP;
            remaining -= takeP;
            fromPending = takeP;
            if (p.amount == 0) p.readyAt = 0;
        }
        if (remaining > 0) {
            uint256 takeS = staked[user] >= remaining ? remaining : staked[user];
            staked[user] -= takeS;
            remaining -= takeS;
            fromStaked = takeS;
        }
        uint256 realized = fromStaked + fromPending;
        require(realized > 0, "E03");
        totalLocked -= realized;

        // H-1: recipient is required non-zero above; orphan-funds path removed.
        token.safeTransfer(slashRecipient, realized);

        emit Slashed(user, fromStaked, fromPending, msg.sender);
    }
}
