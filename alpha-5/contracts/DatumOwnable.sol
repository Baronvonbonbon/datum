// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title DatumOwnable
/// @notice Shared Ownable2Step base for all DATUM owner-gated contracts.
///         - Uses E18 error code for unauthorized access (consistent with DATUM error codes).
///         - Requires non-zero newOwner on transfer.
///         - `renounceOwnership` is the OZ default: a single owner call sets
///           owner = address(0). Cypherpunk-aligned: lets the protocol commit
///           to no-admin permanence once every per-ref `lockX` has been called.
///           FOOTGUN: bricks every onlyOwner setter forever — callers must
///           verify each contract's lock state before invoking.
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

    /// @notice F-005 fix (2026-05-20): renounceOwnership is permanently
    ///         disabled. OZ Ownable exposes it for credible-neutrality
    ///         commitments, but every DATUM contract relies on a working
    ///         owner for at least one of: setRouter (without which the
    ///         contract can never reach the upgrade ladder), lock-once
    ///         wiring, or migrate(). Firing renounce before all those
    ///         are set bricks the contract irreversibly. The cypherpunk
    ///         commitment surface is the per-contract `lock*()` cluster
    ///         — phase-gated on OpenGov — not blanket renunciation.
    function renounceOwnership() public pure override {
        revert("renounce-disabled");
    }
}
