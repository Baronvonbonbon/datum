// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test helper: receive value, then forward it to a recipient via .call{value}
///      Used to verify contract-to-EOA native transfers work on pallet-revive.
contract MockTransfer {
    function sendBack(address payable recipient) external payable {
        (bool ok,) = recipient.call{value: msg.value}("");
        require(ok, "transfer failed");
    }

    function sendFrom(address payable recipient, uint256 amount) external {
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "transfer failed");
    }

    receive() external payable {}
}

/// @dev Mimics DatumSettlement's withdraw pattern: storage write + emit + .call{value}
///      Used to isolate what specifically fails on pallet-revive.
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract MockWithdraw is ReentrancyGuard {
    mapping(address => uint256) public balances;
    event Withdrawal(address indexed to, uint256 amount);

    function deposit(address account, uint256 amount) external payable {
        require(msg.value == amount, "wrong value");
        balances[account] += amount;
    }

    // Pattern A: exact copy of DatumSettlement.withdrawPublisherPayment
    function withdrawFull(address payable recipient) external nonReentrant {
        uint256 amount = balances[recipient];
        require(amount > 0, "E03");
        balances[recipient] = 0;
        emit Withdrawal(recipient, amount);
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "E02");
    }

    // Pattern B: no ReentrancyGuard
    function withdrawNoGuard(address payable recipient) external {
        uint256 amount = balances[recipient];
        require(amount > 0, "E03");
        balances[recipient] = 0;
        emit Withdrawal(recipient, amount);
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "E02");
    }

    // Pattern C: no event
    function withdrawNoEvent(address payable recipient) external nonReentrant {
        uint256 amount = balances[recipient];
        require(amount > 0, "E03");
        balances[recipient] = 0;
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "E02");
    }

    // Pattern D: no storage write (just send whatever we have)
    function withdrawNoWrite(address payable recipient, uint256 amount) external nonReentrant {
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "E02");
    }

    // Pattern E: use transfer instead of call
    function withdrawTransfer(address payable recipient) external nonReentrant {
        uint256 amount = balances[recipient];
        require(amount > 0, "E03");
        balances[recipient] = 0;
        emit Withdrawal(recipient, amount);
        recipient.transfer(amount);
    }

    receive() external payable {}
}
