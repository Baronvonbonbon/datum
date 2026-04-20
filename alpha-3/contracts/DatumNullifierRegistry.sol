// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumNullifierRegistry.sol";

/// @title DatumNullifierRegistry
/// @notice FP-5: Per-user per-campaign per-window nullifier registry.
///
///         The ZK circuit (impression.circom) computes:
///           nullifier = Poseidon(userSecret, campaignId, windowId)
///           windowId  = floor(blockNumber / windowBlocks)
///
///         Settlement calls submitNullifier() after a successful claim. If the
///         nullifier has already been registered for that campaign, the claim is
///         rejected with reason code E73 (nullifier replay).
///
///         The registry stores nullifiers indefinitely — no GC needed because
///         each window produces a different nullifier (the windowId is committed
///         through the Poseidon hash inside the circuit).
///
///         25th contract in the Alpha-3 deployment.
contract DatumNullifierRegistry is IDatumNullifierRegistry {

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public owner;
    address public pendingOwner;
    address public settlement;

    /// @notice Number of blocks per nullifier window.
    ///         Relay bot: windowId = floor(blockNumber / windowBlocks).
    ///         Default 14400 ≈ 24h at 6s/block (Polkadot Hub).
    uint256 public windowBlocks;

    /// @dev campaignId => nullifier => used
    mapping(uint256 => mapping(bytes32 => bool)) private _used;

    event OwnershipTransferred(address indexed prev, address indexed next);
    event SettlementSet(address indexed settlement);
    event WindowBlocksUpdated(uint256 oldValue, uint256 newValue);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(uint256 _windowBlocks) {
        require(_windowBlocks > 0, "E11");
        owner = msg.sender;
        windowBlocks = _windowBlocks;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Set the settlement contract that is allowed to call submitNullifier.
    function setSettlement(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        settlement = addr;
        emit SettlementSet(addr);
    }

    /// @notice Update the window size. Does not invalidate existing nullifiers.
    function setWindowBlocks(uint256 _windowBlocks) external {
        require(msg.sender == owner, "E18");
        require(_windowBlocks > 0, "E11");
        emit WindowBlocksUpdated(windowBlocks, _windowBlocks);
        windowBlocks = _windowBlocks;
    }

    function transferOwnership(address next) external {
        require(msg.sender == owner, "E18");
        require(next != address(0), "E00");
        pendingOwner = next;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "E18");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // -------------------------------------------------------------------------
    // Settlement-only
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumNullifierRegistry
    function submitNullifier(bytes32 nullifier, uint256 campaignId) external override {
        require(msg.sender == settlement, "E18");
        require(!_used[campaignId][nullifier], "E73");
        _used[campaignId][nullifier] = true;
        emit NullifierSubmitted(campaignId, nullifier);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumNullifierRegistry
    function isUsed(uint256 campaignId, bytes32 nullifier) external view override returns (bool) {
        return _used[campaignId][nullifier];
    }
}
