// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
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
contract DatumNullifierRegistry is IDatumNullifierRegistry, Ownable2Step {

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public settlement;
    /// @notice AUDIT-017: Campaigns contract for campaign existence check in submitNullifier.
    address public campaigns;

    /// @notice Number of blocks per nullifier window.
    ///         Relay bot: windowId = floor(blockNumber / windowBlocks).
    ///         Default 14400 ≈ 24h at 6s/block (Polkadot Hub).
    uint256 public windowBlocks;

    /// @dev campaignId => nullifier => used
    mapping(uint256 => mapping(bytes32 => bool)) private _used;

    event SettlementSet(address indexed settlement);
    event WindowBlocksUpdated(uint256 oldValue, uint256 newValue);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(uint256 _windowBlocks) Ownable(msg.sender) {
        require(_windowBlocks > 0, "E11");
        windowBlocks = _windowBlocks;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Set the campaigns contract for campaign existence checks.
    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        campaigns = addr;
    }

    /// @notice Set the settlement contract that is allowed to call submitNullifier.
    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        settlement = addr;
        emit SettlementSet(addr);
    }

    /// @notice Update the window size. Does not invalidate existing nullifiers.
    function setWindowBlocks(uint256 _windowBlocks) external onlyOwner {
        require(_windowBlocks > 0, "E11");
        emit WindowBlocksUpdated(windowBlocks, _windowBlocks);
        windowBlocks = _windowBlocks;
    }

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

    // -------------------------------------------------------------------------
    // Settlement-only
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumNullifierRegistry
    function submitNullifier(bytes32 nullifier, uint256 campaignId) external override {
        require(msg.sender == settlement, "E18");
        // AUDIT-017: Verify campaign exists (non-zero status) before registering nullifier
        if (campaigns != address(0)) {
            (bool cOk, bytes memory cRet) = campaigns.staticcall(
                abi.encodeWithSelector(bytes4(0xe3c76d2e), campaignId) // getCampaignForSettlement
            );
            require(cOk && cRet.length >= 128, "E01");
            uint8 status = abi.decode(cRet, (uint8));
            require(status > 0, "E01"); // campaign does not exist
        }
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
