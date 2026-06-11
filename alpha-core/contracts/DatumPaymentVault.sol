// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
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
contract DatumPaymentVault is IDatumPaymentVault, PaseoSafeSender, DatumUpgradable, EIP712 {
    function version() public pure virtual override returns (uint256) { return 1; }

    /// @dev EIP-712 domain for gasless (signature-authorized) withdrawals.
    constructor() EIP712("DatumPaymentVault", "1") {}


    // -------------------------------------------------------------------------
    // Authorization
    // -------------------------------------------------------------------------

    address public settlement;

    /// @notice Cypherpunk posture: the settlement-crediter reference is
    ///         phase-conditional lock-once. While false, the phased governor
    ///         (owner) can re-point `settlement` — needed when a coordinated
    ///         upgrade deploys a fresh Settlement. `lockSettlementRef()`
    ///         (OpenGov-gated) freezes it permanently for the end-state.
    bool public settlementRefLocked;
    event SettlementRefLocked();

    // -------------------------------------------------------------------------
    // Pull-payment balances
    // -------------------------------------------------------------------------

    mapping(address => uint256) public publisherBalance;
    mapping(address => uint256) public userBalance;
    uint256 public protocolBalance;

    // -------------------------------------------------------------------------
    // Enumeration for upgrade migration (DatumUpgradable redeploy-migrate-rewire)
    // -------------------------------------------------------------------------
    //
    // Balances live in non-iterable mappings, so a successor can't enumerate
    // who holds funds. Track every address that is ever credited (or registers
    // a recovery) so `_migrate` can copy each entry from a frozen predecessor.
    // The native DOT itself is moved separately by `migrateFundsTo` — accounting
    // and funds are migrated by distinct, governance-gated steps.
    //
    // NOTE: a contract deployed BEFORE this machinery existed has no holder set
    // to read, so it cannot be the `_migrate` SOURCE on-chain — that first
    // transition is handled operationally (coexist + drain, see migrateFundsTo
    // doc). From THIS version forward every upgrade is clean.
    address[] private _holders;
    mapping(address => bool) private _isHolder;

    function _track(address a) internal {
        if (a != address(0) && !_isHolder[a]) {
            _isHolder[a] = true;
            _holders.push(a);
        }
    }

    /// @notice Number of distinct balance/recovery holders (migration enumeration).
    function holderCount() external view returns (uint256) { return _holders.length; }
    /// @notice Holder at index `i` (migration enumeration).
    function holderAt(uint256 i) external view returns (address) { return _holders[i]; }

    // -------------------------------------------------------------------------
    // Gasless withdrawal (EIP-712 signature-authorized) — staged, see withdrawUserBySig
    // -------------------------------------------------------------------------

    /// @notice Per-user nonce for signature-authorized withdrawals (replay guard).
    mapping(address => uint256) public withdrawNonce;

    /// @dev EIP-712 typed-data struct the user signs off-chain to authorize a
    ///      third party to submit (and pay gas for) a withdrawal on their behalf.
    bytes32 public constant WITHDRAW_AUTH_TYPEHASH = keccak256(
        "WithdrawAuth(address user,address recipient,uint256 maxFee,uint256 nonce,uint256 deadline)"
    );

    event UserWithdrawalBySig(
        address indexed user, address indexed recipient, address indexed submitter, uint256 net, uint256 fee
    );

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

    /// @dev settlement is the only address that may credit this vault — a
    ///      hot-swap means the ability to credit arbitrary balances. Per the
    ///      cypherpunk posture this is phase-conditional: re-pointable by the
    ///      phased governor (for coordinated upgrades that redeploy Settlement)
    ///      until lockSettlementRef() fires at OpenGov, after which it's frozen.
    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(!settlementRefLocked, "locked");
        settlement = addr;
    }

    /// @notice Cypherpunk end-state lock for the settlement-crediter ref.
    ///         OpenGov-gated; once fired, setSettlement reverts permanently.
    function lockSettlementRef() external onlyOwner whenOpenGovPhase {
        require(settlement != address(0), "set first");
        require(!settlementRefLocked, "already locked");
        settlementRefLocked = true;
        emit SettlementRefLocked();
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
    ) external whenNotFrozen {
        require(msg.sender == settlement, "E25");

        publisherBalance[publisher] += pubAmount;
        userBalance[user] += userAmount;
        protocolBalance += protocolAmount;
        if (pubAmount > 0) _track(publisher);
        if (userAmount > 0) _track(user);

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

    /// @notice Gasless user withdrawal. The balance owner signs a `WithdrawAuth`
    ///         off-chain (no gas needed); any submitter — an off-chain worker /
    ///         relay — broadcasts it here, pays the gas, and is reimbursed up to
    ///         the user-authorized `maxFee` out of the withdrawn balance. The rest
    ///         goes to `recipient` (or the user when `recipient == address(0)`).
    ///
    ///         Non-custodial by construction: the submitter cannot take more than
    ///         `maxFee` (user-signed), cannot redirect the net (user-signed
    ///         recipient), and cannot replay (per-user nonce + block deadline).
    ///         The fee always pays `msg.sender`, so submission is permissionless
    ///         and competitive. Mirrors the permissionless dual-sig settle path.
    /// @param user      balance owner who signed the authorization
    /// @param recipient destination for the net amount; address(0) → `user`
    /// @param maxFee    max fee (planck) the user authorizes for the submitter
    /// @param deadline  last block number at which the authorization is valid
    /// @param sig       user's EIP-712 signature over the WithdrawAuth struct
    function withdrawUserBySig(
        address user,
        address recipient,
        uint256 maxFee,
        uint256 deadline,
        bytes calldata sig
    ) external nonReentrant whenNotFrozen {
        require(block.number <= deadline, "E81"); // authorization expired
        uint256 nonce = withdrawNonce[user];
        bytes32 structHash = keccak256(
            abi.encode(WITHDRAW_AUTH_TYPEHASH, user, recipient, maxFee, nonce, deadline)
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), sig);
        require(signer == user, "E82"); // signature does not match `user`
        withdrawNonce[user] = nonce + 1; // consume nonce BEFORE any transfer (replay guard, CEI)

        uint256 amount = userBalance[user];
        require(amount > 0, "E03");
        uint256 fee = maxFee < amount ? maxFee : amount; // never exceed the balance
        uint256 net = amount - fee;
        address dest = recipient == address(0) ? user : recipient;

        userBalance[user] = 0; // effects before interactions
        emit UserWithdrawal(user, net); // keep the existing event for indexers
        emit UserWithdrawalBySig(user, dest, msg.sender, net, fee);
        if (fee > 0) _send(msg.sender, fee); // reimburse the submitter
        if (net > 0) _send(dest, net);
    }

    /// @notice EIP-712 domain separator (for off-chain signers building the digest).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
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
        _track(msg.sender);
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
    ///         large threshold. 1e16 wei = 0.01 DOT (18-dec wei), comfortably
    ///         below any reasonable existential deposit on Polkadot Hub. (M-2)
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
    // Upgrade migration (DatumUpgradable redeploy-migrate-rewire)
    // -------------------------------------------------------------------------

    /// @notice One-shot: true once this vault's native DOT has been swept to a
    ///         successor during an upgrade. Guards against a double sweep.
    bool public fundsMigratedOut;
    event FundsMigratedOut(address indexed successor, uint256 amount);

    /// @notice Copy balance ACCOUNTING from a frozen predecessor vault.
    /// @dev    Called by DatumUpgradable.migrate (governance-gated; old must be
    ///         frozen and a lower version). Copies protocolBalance + every
    ///         enumerated holder's user/publisher balance, withdraw nonce, and
    ///         recovery state. The native DOT is moved separately by the
    ///         predecessor's `migrateFundsTo` so the two steps are independently
    ///         auditable. `settlement` and `feeShareRecipient` are intentionally
    ///         NOT copied — they are re-wired post-migrate (the "rewire" leg),
    ///         pointing the fresh vault at the live Settlement/FeeShare.
    ///
    ///         Small-set loop; if the holder set ever outgrows a single tx,
    ///         paginate by overriding migrate() entirely.
    function _migrate(address oldContract) internal override {
        DatumPaymentVault old = DatumPaymentVault(payable(oldContract));
        protocolBalance = old.protocolBalance();
        recoveryDelayBlocks = old.recoveryDelayBlocks();
        uint256 n = old.holderCount();
        for (uint256 i = 0; i < n; i++) {
            address a = old.holderAt(i);
            publisherBalance[a] = old.publisherBalance(a);
            userBalance[a] = old.userBalance(a);
            withdrawNonce[a] = old.withdrawNonce(a);
            recoveryAddress[a] = old.recoveryAddress(a);
            recoveryEffectiveBlock[a] = old.recoveryEffectiveBlock(a);
            _track(a);
        }
    }

    /// @notice Sweep the vault's entire native balance to a successor vault
    ///         during an upgrade, so the successor (which received the balance
    ///         accounting via `_migrate`) is solvent.
    /// @dev    Governance-gated and callable ONLY while frozen: a live vault
    ///         can never be drained this way, and freezing first blocks all
    ///         further credits/withdrawals so the swept total is final. One-shot.
    ///         The successor must accept native DOT (its `receive()` does, while
    ///         unfrozen). Routed through `_safeSend`, so any sub-10^6 remainder
    ///         is queued as claimable Paseo dust rather than reverting.
    function migrateFundsTo(address successor) external onlyGovernance nonReentrant {
        require(frozen, "not frozen");
        require(!fundsMigratedOut, "already swept");
        require(successor != address(0), "E00");
        fundsMigratedOut = true;
        uint256 bal = address(this).balance;
        emit FundsMigratedOut(successor, bal);
        if (bal > 0) _send(successor, bal);
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
