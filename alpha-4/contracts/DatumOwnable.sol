// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title DatumOwnable
/// @notice Shared Ownable2Step base for all DATUM owner-gated contracts.
///         - Uses E18 error code for unauthorized access (consistent with DATUM error codes).
///         - Blocks renounceOwnership (protocol contracts must always have an owner).
///         - Requires non-zero newOwner on transfer.
abstract contract DatumOwnable is Ownable2Step {
    constructor() Ownable(msg.sender) {}

    function _checkOwner() internal view override {
        require(owner() == msg.sender, "E18");
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "E00");
        super.transferOwnership(newOwner);
    }

    function acceptOwnership() public override {
        require(msg.sender == pendingOwner(), "E18");
        _transferOwnership(msg.sender);
    }

    function renounceOwnership() public override onlyOwner {
        revert("E18");
    }
}
