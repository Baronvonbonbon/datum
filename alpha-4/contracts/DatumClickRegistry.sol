// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "./interfaces/IDatumClickRegistry.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title DatumClickRegistry
/// @notice Tracks impression→click sessions for CPC (cost-per-click) fraud prevention.
///
///         Protocol flow:
///           1. Extension reports impression; relay records an impression nonce N on-chain
///              via the claim chain (no direct ClickRegistry interaction at impression time).
///           2. User clicks the ad. Extension sends AD_CLICK with impressionNonce N.
///           3. Relay calls recordClick(user, campaignId, impressionNonce).
///           4. User submits a type-1 claim referencing clickSessionHash = keccak256(user, campaign, N).
///           5. DatumClaimValidator calls hasUnclaimed to confirm the session exists.
///           6. DatumSettlement calls markClaimed after the claim settles — prevents replay.
///
///         Security properties:
///           - One click per impression nonce: recordClick reverts on duplicate session.
///           - One settlement per click: markClaimed reverts if already claimed.
///           - Session hash binds user + campaign + nonce together.
///
///         Authorization:
///           - recordClick: gated to relay contract.
///           - markClaimed: gated to settlement contract.
///           - hasUnclaimed: public view.
contract DatumClickRegistry is IDatumClickRegistry, DatumOwnable {
    // -------------------------------------------------------------------------
    // Authorization
    // -------------------------------------------------------------------------

    address public relay;
    address public settlement;

    /// @notice D1a cypherpunk plumbing lock. ClickRegistry is a session-state
    ///         plumbing contract; both protocol-ref setters live under this one
    ///         switch. Pre-lock: owner can swap to fix wiring. Post-lock:
    ///         frozen forever.
    bool public plumbingLocked;
    event PlumbingLocked();
    event ContractReferenceChanged(string name, address oldAddr, address newAddr);

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @dev sessionHash → 0: not recorded, 1: recorded (unclaimed), 2: claimed
    mapping(bytes32 => uint8) private _sessions;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @dev D1a plumbing-lock pattern: both setters gated by `plumbingLocked`.
    function setRelay(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("relay", relay, addr);
        relay = addr;
    }

    function setSettlement(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("settlement", settlement, addr);
        settlement = addr;
    }

    /// @notice D1a: commit both ClickRegistry refs permanently.
    function lockPlumbing() external onlyOwner {
        require(!plumbingLocked, "already locked");
        require(relay != address(0), "relay unset");
        require(settlement != address(0), "settlement unset");
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // -------------------------------------------------------------------------
    // Core
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumClickRegistry
    function recordClick(
        address user,
        uint256 campaignId,
        bytes32 impressionNonce
    ) external {
        require(msg.sender == relay, "E25");
        bytes32 sh = _sessionHash(user, campaignId, impressionNonce);
        require(_sessions[sh] == 0, "E90"); // E90: click session already recorded
        _sessions[sh] = 1;
        emit ClickRecorded(sh, user, campaignId);
    }

    /// @inheritdoc IDatumClickRegistry
    function markClaimed(
        address user,
        uint256 campaignId,
        bytes32 impressionNonce
    ) external {
        require(msg.sender == settlement, "E25");
        bytes32 sh = _sessionHash(user, campaignId, impressionNonce);
        require(_sessions[sh] == 1, "E90"); // E90: session not recorded or already claimed
        _sessions[sh] = 2;
        emit ClickClaimed(sh);
    }

    /// @inheritdoc IDatumClickRegistry
    function hasUnclaimed(
        address user,
        uint256 campaignId,
        bytes32 impressionNonce
    ) external view returns (bool) {
        return _sessions[_sessionHash(user, campaignId, impressionNonce)] == 1;
    }

    /// @inheritdoc IDatumClickRegistry
    function sessionHash(
        address user,
        uint256 campaignId,
        bytes32 impressionNonce
    ) external pure returns (bytes32) {
        return _sessionHash(user, campaignId, impressionNonce);
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _sessionHash(
        address user,
        uint256 campaignId,
        bytes32 impressionNonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(user, campaignId, impressionNonce));
    }
}
