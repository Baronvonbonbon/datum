// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @notice Test fixture: a contract whose receive() and fallback() always revert.
///         Used to prove the M-1 pull-pattern fix: a contract advertiser with a
///         hostile fallback cannot DoS Lifecycle / Settlement, because refunds
///         and bond returns are queued in mappings rather than pushed via .call.
contract MockRejectingReceiver {
    /// @dev Lets the test orchestrate calls *from* this contract — needed so
    ///      we can use it as a campaign advertiser (msg.sender) while still
    ///      having receive() reject native transfers.
    function call(address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory)
    {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        require(ok, "MockRejectingReceiver: inner call failed");
        return ret;
    }

    receive() external payable { revert("MockRejectingReceiver: receive reverts"); }
    fallback() external payable { revert("MockRejectingReceiver: fallback reverts"); }
}
