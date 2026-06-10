// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  MockOpenGovRouter
/// @notice Minimal IDatumRouter_Upgradable shim for tests that need to fire
///         lock-once functions guarded by `whenOpenGovPhase`. Pre-F-004 the
///         modifier silently passed when the router was unset, so tests
///         could call `lockX()` directly. Post-F-004 the modifier is
///         fail-closed; tests deploy this mock, point `setRouter(mock)`
///         at it, and the lock fires.
///
/// @dev    Test-only contract. Not deployed to production. Owner-tunable
///         phase value so tests can also exercise the pre-OpenGov revert
///         path explicitly (set phase to 0 or 1, then assert revert).
contract MockOpenGovRouter {
    uint8 public phase = 2;     // OpenGov by default
    address public governor;

    function setPhase(uint8 p) external {
        phase = p;
    }

    function setGovernor(address g) external {
        governor = g;
    }
}
