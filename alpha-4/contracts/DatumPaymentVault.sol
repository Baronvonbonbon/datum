// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumOwnable.sol";
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
contract DatumPaymentVault is IDatumPaymentVault, ReentrancyGuard, DatumOwnable {

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
    // Constructor
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        settlement = addr;
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
    function withdrawPublisher() external nonReentrant {
        uint256 amount = publisherBalance[msg.sender];
        require(amount > 0, "E03");
        publisherBalance[msg.sender] = 0;
        emit PublisherWithdrawal(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @inheritdoc IDatumPaymentVault
    function withdrawPublisherTo(address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        uint256 amount = publisherBalance[msg.sender];
        require(amount > 0, "E03");
        publisherBalance[msg.sender] = 0;
        emit PublisherWithdrawal(msg.sender, amount);
        _send(recipient, amount);
    }

    /// @inheritdoc IDatumPaymentVault
    function withdrawUser() external nonReentrant {
        uint256 amount = userBalance[msg.sender];
        require(amount > 0, "E03");
        userBalance[msg.sender] = 0;
        emit UserWithdrawal(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @inheritdoc IDatumPaymentVault
    function withdrawUserTo(address recipient) external nonReentrant {
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
    // L-2: Dust sweep — recover sub-ED balances locked in mappings
    // -------------------------------------------------------------------------

    /// @notice Sweep sub-threshold publisher balances to treasury. Clears dust that is
    ///         unwithdrawable due to existential deposit requirements.
    /// @param accounts Publisher addresses to sweep
    /// @param threshold Minimum balance to keep (sweep amounts below this)
    /// @param treasury Recipient for swept dust
    function sweepPublisherDust(
        address[] calldata accounts,
        uint256 threshold,
        address treasury
    ) external onlyOwner nonReentrant {
        require(treasury != address(0), "E00");
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

    /// @dev Single native-transfer site. Transfer failure caught by E02.
    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "E02");
    }

    // -------------------------------------------------------------------------
    // Receive
    // -------------------------------------------------------------------------

    receive() external payable {}
}
