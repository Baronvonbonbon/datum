// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title  DatumAdvertiserRegistry
/// @notice Standalone advertiser-side registry — the symmetric counterpart of
///         DatumPublishers (relaySigner + profileHash + rotation cooldown), so
///         the advertiser half of dual-sig settlement has its own contract
///         instead of living inside the already-EIP-170-tight DatumCampaigns.
///
///         An advertiser registers:
///           - `advertiserRelaySigner`: the hot key (or shared co-signing
///             service identity) authorized to produce the advertiser's batch
///             co-signature. address(0) ⇒ the advertiser signs personally.
///           - `advertiserProfileHash`: an IPFS CID (bytes32) for off-chain
///             metadata that advertises the co-signer ENDPOINT, so a relay can
///             discover WHERE to fetch the advertiser cosig
///             (campaign → advertiser → profileHash → metadata → URL), the same
///             way a publisher's relay endpoint is discovered.
///
/// @dev    Migration model (DatumUpgradable): this is a NEW contract — a pure
///         addition. Deploy → setRouter → wire readers; no state migration.
///         DatumDualSigSettlement can be pointed here for advertiser-relay-signer
///         resolution in a later coordinated upgrade (it currently reads
///         DatumCampaigns.getAdvertiserRelaySigner); until then this registry
///         drives off-chain endpoint discovery for relays. The mappings/getters
///         intentionally match DatumCampaigns' advertiser API so a settlement
///         read can switch sources without an interface change.
contract DatumAdvertiserRegistry is DatumUpgradable {
    function version() public pure override returns (uint256) { return 1; }

    error E00();   // zero value
    error E22();   // rotation cooldown not elapsed
    error Paused();

    // ── Pause registry (settlement-pause gates rotations during triage) ──
    IDatumPauseRegistry public immutable pauseRegistry;

    // ── Advertiser relay signer (delegated batch co-signing authority) ──
    mapping(address => address) public advertiserRelaySigner;
    mapping(address => uint256) public advertiserRelaySignerRotatedBlock;
    /// @notice Anti-sandwich rotation cooldown, mirroring
    ///         DatumPublishers.RELAY_SIGNER_ROTATION_COOLDOWN — a key briefly
    ///         controlling the old signer can't sandwich a rotation event.
    uint256 public constant RELAY_SIGNER_ROTATION_COOLDOWN = 600;
    event AdvertiserRelaySignerSet(address indexed advertiser, address indexed signer);

    // ── Off-chain profile pointer (carries the co-signer endpoint) ──
    mapping(address => bytes32) public advertiserProfileHash;
    event AdvertiserProfileSet(address indexed advertiser, bytes32 hash);

    constructor(address _pauseRegistry) {
        if (_pauseRegistry == address(0)) revert E00();
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    /// @notice Set (or clear with address(0)) the advertiser's relay signer.
    ///         Caller is the advertiser (cold key); the cold key is the sole
    ///         authority over this mapping.
    function setAdvertiserRelaySigner(address signer) external whenNotFrozen {
        if (pauseRegistry.pausedSettlement()) revert Paused();
        _rotateRelaySigner(signer);
    }

    /// @notice Set the off-chain metadata pointer (IPFS CID as bytes32) that
    ///         advertises this advertiser's co-signer endpoint.
    function setAdvertiserProfile(bytes32 hash) external whenNotFrozen {
        if (pauseRegistry.pausedSettlement()) revert Paused();
        if (hash == bytes32(0)) revert E00();
        advertiserProfileHash[msg.sender] = hash;
        emit AdvertiserProfileSet(msg.sender, hash);
    }

    /// @notice Atomically rotate the relay signer and refresh the profile in
    ///         one tx (mirror of DatumPublishers.setRelaySignerAndProfile).
    function setAdvertiserRelaySignerAndProfile(address signer, bytes32 hash) external whenNotFrozen {
        if (pauseRegistry.pausedSettlement()) revert Paused();
        if (hash == bytes32(0)) revert E00();
        _rotateRelaySigner(signer);
        advertiserProfileHash[msg.sender] = hash;
        emit AdvertiserProfileSet(msg.sender, hash);
    }

    function _rotateRelaySigner(address signer) internal {
        uint256 lastRotated = advertiserRelaySignerRotatedBlock[msg.sender];
        if (!(lastRotated == 0 || block.number >= lastRotated + RELAY_SIGNER_ROTATION_COOLDOWN)) revert E22();
        advertiserRelaySigner[msg.sender] = signer;
        advertiserRelaySignerRotatedBlock[msg.sender] = block.number;
        emit AdvertiserRelaySignerSet(msg.sender, signer);
    }

    // ── Readers (match the DatumCampaigns advertiser API for drop-in reads) ──
    function getAdvertiserRelaySigner(address advertiser) external view returns (address) {
        return advertiserRelaySigner[advertiser];
    }

    function getAdvertiserProfileHash(address advertiser) external view returns (bytes32) {
        return advertiserProfileHash[advertiser];
    }
}
