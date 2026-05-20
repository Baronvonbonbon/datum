// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumUpgradable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumPaymentVault.sol";

/// @title DatumPaymentVault
/// @notice Pull-payment vault for publisher, user, and protocol balances.
///
///         Only the authorized Settlement contract can credit balances via
///         creditSettlement(). Withdrawals are pull-pattern with ReentrancyGuard.
///
///         Design: DOT is sent directly from BudgetLedger to this Vault via
///         deductAndTransfer(). Settlement then calls creditSettlement() (non-payable)
///         to record how the DOT should be split among publisher/user/protocol.
contract DatumPaymentVault is IDatumPaymentVault, PaseoSafeSender, DatumUpgradable {
    function version() public pure override returns (uint256) { return 1; }


    // -------------------------------------------------------------------------
    // Authorization
    // -------------------------------------------------------------------------

    address public settlement;

    // -------------------------------------------------------------------------
    // Pull-payment balances
    // -------------------------------------------------------------------------

    mapping(address => uint256) public publisherBalance;
    mapping(address => uint256) public userBalance;
    uint256 public protocolBalance;

    // -------------------------------------------------------------------------
    // G-8 first close (2026-05-20): time-locked recovery-address mechanism
    // -------------------------------------------------------------------------
    //
    // Closes gaps-in-checks-and-balances.md G-8 (No emergency unstake for
    // users). Users pre-register a recovery address (cold wallet); after
    // `recoveryDelayBlocks`, the recovery address itself can pull the
    // original address's vault balances (both user + publisher slots) to
    // itself via emergencyWithdraw.
    //
    // Anti-attack property: an attacker who steals the hot key cannot
    // just-in-time set a new recovery and drain. The change-recovery flow
    // is delayed too, so the legitimate user has a recovery-window during
    // which they can cancel via cancelRecoveryAddress (if they still have
    // hot-key access) OR — if the original recovery is the cold wallet —
    // simply wait it out: the attacker's re-registration can't activate
    // before the original recovery's existing delay window expires.

    /// @notice Recovery address per original account. address(0) = unset.
    mapping(address => address) public recoveryAddress;
    /// @notice Block at which the recovery address becomes effective.
    ///         Setting/changing recovery stages the change; it doesn't take
    ///         immediate effect.
    mapping(address => uint64) public recoveryEffectiveBlock;

    /// @notice Delay between setRecoveryAddress and the recovery becoming
    ///         active. Bounded by [MIN_RECOVERY_DELAY, MAX_RECOVERY_DELAY].
    ///         Default 14400 (~24h @ 6s).
    uint64 public recoveryDelayBlocks = 14400;
    uint64 public constant MIN_RECOVERY_DELAY = 1_440;   // ~6h
    uint64 public constant MAX_RECOVERY_DELAY = 432_000; // ~30d

    event RecoveryAddressStaged(address indexed user, address indexed recovery, uint64 effectiveBlock);
    event RecoveryAddressCancelled(address indexed user);
    event EmergencyWithdrawn(address indexed user, address indexed recovery, uint256 userAmount, uint256 publisherAmount);
    event RecoveryDelayBlocksSet(uint64 blocks_);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @dev Cypherpunk lock-once: settlement is the only address that may credit
    ///      this vault. Hot-swap = ability to credit arbitrary balances. Frozen
    ///      after first non-zero write.
    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(settlement == address(0), "already set");
        settlement = addr;
    }

    // ── §2.1 DatumFeeShare integration ────────────────────────────────────
    /// @notice Optional FeeShare recipient. When set, accumulated protocol fees
    ///         can be permissionlessly swept to this address via sweepToFeeShare().
    ///         When zero (default), only the owner-pull withdrawProtocol() path
    ///         exists. Setting and clearing are both allowed (cleared by passing
    ///         address(0)) so governance can pause the auto-route if needed.
    address public feeShareRecipient;

    /// @notice A7-fix (2026-05-12): one-way lock. Once locked, the owner can no
    ///         longer redirect protocol fees to a different recipient. Mirrors
    ///         the lockGuardianSet credible-commitment pattern. Operators should
    ///         set the final FeeShare contract, verify, then lock.
    bool public feeShareRecipientLocked;

    event FeeShareRecipientSet(address indexed recipient);
    event SweptToFeeShare(address indexed recipient, uint256 amount);
    event FeeShareRecipientLocked();

    function setFeeShareRecipient(address recipient) external onlyOwner {
        require(!feeShareRecipientLocked, "fee-share locked");
        feeShareRecipient = recipient;
        emit FeeShareRecipientSet(recipient);
    }

    /// @notice A7-fix: freeze the FeeShare recipient permanently.
    function lockFeeShareRecipient() external onlyOwner whenOpenGovPhase {
        require(!feeShareRecipientLocked, "already locked");
        require(feeShareRecipient != address(0), "set first");
        feeShareRecipientLocked = true;
        emit FeeShareRecipientLocked();
    }

    /// @notice Push the entire accumulated protocol fee to the configured
    ///         FeeShare recipient. Permissionless — anyone can call.
    /// @dev    The recipient is expected to be a DatumFeeShare contract whose
    ///         `receive()` folds the inflow into its accumulator. If no
    ///         recipient is configured this reverts; use withdrawProtocol() instead.
    function sweepToFeeShare() external nonReentrant whenNotFrozen {
        address recipient = feeShareRecipient;
        require(recipient != address(0), "E00");
        uint256 amount = protocolBalance;
        require(amount > 0, "E03");
        protocolBalance = 0;
        emit SweptToFeeShare(recipient, amount);
        _send(recipient, amount);
    }

    // -------------------------------------------------------------------------
    // Credit (Settlement only)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumPaymentVault
    /// @dev Non-payable: DOT already at Vault from BudgetLedger.deductAndTransfer().
    ///      Settlement calls this to record the balance split.
    function creditSettlement(
        address publisher, uint256 pubAmount,
        address user, uint256 userAmount,
        uint256 protocolAmount
    ) external {
        require(msg.sender == settlement, "E25");

        publisherBalance[publisher] += pubAmount;
        userBalance[user] += userAmount;
        protocolBalance += protocolAmount;

        emit SettlementCredited(publisher, user, pubAmount + userAmount + protocolAmount);
    }

    // -------------------------------------------------------------------------
    // Withdrawals
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumPaymentVault
    function withdrawPublisher() external nonReentrant whenNotFrozen {
        uint256 amount = publisherBalance[msg.sender];
        require(amount > 0, "E03");
        publisherBalance[msg.sender] = 0;
        emit PublisherWithdrawal(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @inheritdoc IDatumPaymentVault
    function withdrawPublisherTo(address recipient) external nonReentrant whenNotFrozen {
        require(recipient != address(0), "E00");
        uint256 amount = publisherBalance[msg.sender];
        require(amount > 0, "E03");
        publisherBalance[msg.sender] = 0;
        emit PublisherWithdrawal(msg.sender, amount);
        _send(recipient, amount);
    }

    /// @inheritdoc IDatumPaymentVault
    function withdrawUser() external nonReentrant whenNotFrozen {
        uint256 amount = userBalance[msg.sender];
        require(amount > 0, "E03");
        userBalance[msg.sender] = 0;
        emit UserWithdrawal(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @inheritdoc IDatumPaymentVault
    function withdrawUserTo(address recipient) external nonReentrant whenNotFrozen {
        require(recipient != address(0), "E00");
        uint256 amount = userBalance[msg.sender];
        require(amount > 0, "E03");
        userBalance[msg.sender] = 0;
        emit UserWithdrawal(msg.sender, amount);
        _send(recipient, amount);
    }

    /// @inheritdoc IDatumPaymentVault
    function withdrawProtocol(address recipient) external onlyOwner nonReentrant {
        require(recipient != address(0), "E00");
        uint256 amount = protocolBalance;
        require(amount > 0, "E03");
        protocolBalance = 0;
        emit ProtocolWithdrawal(recipient, amount);
        _send(recipient, amount);
    }

    // -------------------------------------------------------------------------
    // G-8 first close (2026-05-20): time-locked recovery address
    // -------------------------------------------------------------------------

    /// @notice Stage a recovery address. The recovery does NOT take immediate
    ///         effect; it activates after `recoveryDelayBlocks` blocks. During
    ///         the delay window, the original account can call
    ///         `cancelRecoveryAddress` to abort. Calling this with a new
    ///         address overwrites any prior staging — including a previously
    ///         active recovery — and restarts the delay.
    /// @dev    Anti-attack: even if an attacker steals the hot key and calls
    ///         this to redirect funds, they cannot pull balances until the
    ///         delay elapses. The legitimate user — having detected the
    ///         compromise off-chain — has the full delay window to cancel.
    function setRecoveryAddress(address recovery) external whenNotFrozen {
        require(recovery != address(0), "E00");
        require(recovery != msg.sender, "E11"); // recovery must be a different address
        recoveryAddress[msg.sender] = recovery;
        uint64 effective = uint64(block.number) + recoveryDelayBlocks;
        recoveryEffectiveBlock[msg.sender] = effective;
        emit RecoveryAddressStaged(msg.sender, recovery, effective);
    }

    /// @notice Cancel any pending or active recovery. The original account
    ///         can call this at any time, including after the delay has
    ///         elapsed (e.g. to rotate to a new recovery via subsequent
    ///         setRecoveryAddress).
    function cancelRecoveryAddress() external whenNotFrozen {
        require(recoveryAddress[msg.sender] != address(0), "E01");
        recoveryAddress[msg.sender] = address(0);
        recoveryEffectiveBlock[msg.sender] = 0;
        emit RecoveryAddressCancelled(msg.sender);
    }

    /// @notice Pull both userBalance + publisherBalance of `originalAccount`
    ///         to the registered recovery address. Permissionless from the
    ///         recovery's perspective — anyone CAN call this, but only the
    ///         registered recovery RECEIVES funds. Reverts if recovery is
    ///         not yet active or not registered.
    /// @dev    Both balances are pulled in a single call so the user
    ///         doesn't need to enumerate which slot has funds. Either or
    ///         both can be zero — the call still succeeds and clears the
    ///         recovery (one-shot semantics: after emergency withdrawal,
    ///         the user must re-register if they want to recover again).
    function emergencyWithdraw(address originalAccount) external nonReentrant whenNotFrozen {
        address recovery = recoveryAddress[originalAccount];
        require(recovery != address(0), "E01");
        uint64 effective = recoveryEffectiveBlock[originalAccount];
        require(effective != 0 && block.number >= uint256(effective), "E70");
        // Caller can be anyone — funds always go to the registered recovery.
        // Anyone-can-trigger keeps the flow gas-bearable even if the
        // recovery key is on a cold device that doesn't want to fund gas.
        uint256 uAmt = userBalance[originalAccount];
        uint256 pAmt = publisherBalance[originalAccount];
        require(uAmt > 0 || pAmt > 0, "E03");
        if (uAmt > 0) userBalance[originalAccount] = 0;
        if (pAmt > 0) publisherBalance[originalAccount] = 0;
        // One-shot: clear the recovery state so a second emergencyWithdraw
        // requires a fresh registration. Avoids a stale recovery sitting
        // active indefinitely after a single use.
        recoveryAddress[originalAccount] = address(0);
        recoveryEffectiveBlock[originalAccount] = 0;
        emit EmergencyWithdrawn(originalAccount, recovery, uAmt, pAmt);
        emit RecoveryAddressCancelled(originalAccount);
        if (uAmt > 0) emit UserWithdrawal(originalAccount, uAmt);
        if (pAmt > 0) emit PublisherWithdrawal(originalAccount, pAmt);
        _send(recovery, uAmt + pAmt);
    }

    /// @notice Owner-tunable recovery delay. Bounded by
    ///         [MIN_RECOVERY_DELAY, MAX_RECOVERY_DELAY]. Set high enough
    ///         that users have time to detect compromise and react;
    ///         set low enough that legitimate recovery isn't painful.
    function setRecoveryDelayBlocks(uint64 blocks_) external onlyOwner whenNotFrozen {
        require(blocks_ >= MIN_RECOVERY_DELAY && blocks_ <= MAX_RECOVERY_DELAY, "E11");
        recoveryDelayBlocks = blocks_;
        emit RecoveryDelayBlocksSet(blocks_);
    }

    /// @notice View: block at which a staged recovery activates. Returns
    ///         0 when no recovery is registered for `user`.
    function recoveryActivatesAt(address user) external view returns (uint64) {
        return recoveryEffectiveBlock[user];
    }

    /// @notice View: true iff `user` has a registered + active recovery.
    function recoveryActive(address user) external view returns (bool) {
        uint64 e = recoveryEffectiveBlock[user];
        return e != 0 && block.number >= uint256(e) && recoveryAddress[user] != address(0);
    }

    // -------------------------------------------------------------------------
    // L-2: Dust sweep — recover sub-ED balances locked in mappings
    // -------------------------------------------------------------------------

    /// @notice Hard cap on the sweep `threshold` parameter. Prevents the owner
    ///         from disguising a balance-drain as a "dust sweep" by passing a
    ///         large threshold. 1e16 planck = 0.001 DOT, comfortably below any
    ///         reasonable existential deposit on Polkadot Hub. (M-2)
    uint256 public constant MAX_DUST_THRESHOLD = 1e16;

    /// @notice Sweep sub-threshold publisher balances to treasury. Clears dust that is
    ///         unwithdrawable due to existential deposit requirements.
    /// @param accounts Publisher addresses to sweep
    /// @param threshold Minimum balance to keep (sweep amounts below this); capped at MAX_DUST_THRESHOLD
    /// @param treasury Recipient for swept dust
    function sweepPublisherDust(
        address[] calldata accounts,
        uint256 threshold,
        address treasury
    ) external onlyOwner nonReentrant {
        require(treasury != address(0), "E00");
        require(threshold <= MAX_DUST_THRESHOLD, "E16"); // M-2: prevent drain disguised as sweep
        uint256 total;
        for (uint256 i = 0; i < accounts.length; i++) {
            uint256 bal = publisherBalance[accounts[i]];
            if (bal > 0 && bal < threshold) {
                total += bal;
                publisherBalance[accounts[i]] = 0;
            }
        }
        if (total > 0) _send(treasury, total);
    }

    /// @notice Sweep sub-threshold user balances to treasury.
    function sweepUserDust(
        address[] calldata accounts,
        uint256 threshold,
        address treasury
    ) external onlyOwner nonReentrant {
        require(treasury != address(0), "E00");
        require(threshold <= MAX_DUST_THRESHOLD, "E16"); // M-2: prevent drain disguised as sweep
        uint256 total;
        for (uint256 i = 0; i < accounts.length; i++) {
            uint256 bal = userBalance[accounts[i]];
            if (bal > 0 && bal < threshold) {
                total += bal;
                userBalance[accounts[i]] = 0;
            }
        }
        if (total > 0) _send(treasury, total);
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    /// @dev Single native-transfer site. Routes through `_safeSend` so the
    ///      Paseo eth-rpc denomination bug (A2) cannot lock funds.
    function _send(address to, uint256 amount) internal {
        _safeSend(to, amount);
    }

    // -------------------------------------------------------------------------
    // Receive
    // -------------------------------------------------------------------------

    receive() external payable whenNotFrozen {}
}
