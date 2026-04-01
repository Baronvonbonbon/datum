// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IDatumPaymentVault.sol";
import "./interfaces/ISystem.sol";

/// @title DatumPaymentVault
/// @notice Pull-payment vault for publisher, user, and protocol balances.
///         Extracted from DatumSettlement (alpha) to free PVM bytecode headroom.
///
///         Only the authorized Settlement contract can credit balances via
///         creditSettlement(). Withdrawals are pull-pattern with ReentrancyGuard.
///
///         Design: DOT is sent directly from BudgetLedger to this Vault via
///         deductAndTransfer(). Settlement then calls creditSettlement() (non-payable)
///         to record how the DOT should be split among publisher/user/protocol.
///         Single _send() site to avoid resolc codegen bug with multiple transfer() sites.
contract DatumPaymentVault is IDatumPaymentVault, ReentrancyGuard, Ownable {
    ISystem private constant SYSTEM = ISystem(0x0000000000000000000000000000000000000900);
    address private constant SYSTEM_ADDR = 0x0000000000000000000000000000000000000900;

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

    constructor() Ownable(msg.sender) {}

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        settlement = addr;
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "E00");
        super.transferOwnership(newOwner);
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
    function withdrawUser() external nonReentrant {
        uint256 amount = userBalance[msg.sender];
        require(amount > 0, "E03");
        userBalance[msg.sender] = 0;
        emit UserWithdrawal(msg.sender, amount);
        _send(msg.sender, amount);
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
    // Internal
    // -------------------------------------------------------------------------

    /// @dev Single native-transfer site — avoids resolc codegen bug where multiple
    ///      transfer() sites produce broken RISC-V.
    ///      O3: Dust guard via minimumBalance() precompile on PolkaVM.
    function _send(address to, uint256 amount) internal {
        if (SYSTEM_ADDR.code.length > 0) {
            require(amount >= SYSTEM.minimumBalance(), "E58");
        }
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "E02");
    }

    // -------------------------------------------------------------------------
    // Receive
    // -------------------------------------------------------------------------

    receive() external payable {}
}
