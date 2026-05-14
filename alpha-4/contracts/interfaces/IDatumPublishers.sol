// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumPublishers
/// @notice Interface for DATUM publisher registry and take rate management.
interface IDatumPublishers {
    struct Publisher {
        address addr;
        uint16 takeRateBps;
        uint16 pendingTakeRateBps;
        uint256 takeRateEffectiveBlock;
        bool registered;
    }

    event PublisherRegistered(address indexed publisher, uint16 takeRateBps);
    event PublisherTakeRateQueued(address indexed publisher, uint16 newTakeRateBps, uint256 effectiveBlock);
    event PublisherTakeRateApplied(address indexed publisher, uint16 newTakeRateBps);
    /// @notice R-L2: Emitted when a publisher cancels a queued take-rate update.
    event PublisherTakeRateCancelled(address indexed publisher, uint16 cancelledTakeRateBps);
    event RelaySignerUpdated(address indexed publisher, address indexed signer);
    event ProfileUpdated(address indexed publisher, bytes32 hash);

    function registerPublisher(uint16 takeRateBps) external;
    function updateTakeRate(uint16 newTakeRateBps) external;
    function applyTakeRateUpdate() external;

    function getPublisher(address publisher) external view returns (Publisher memory);
    function isRegisteredWithRate(address publisher) external view returns (bool, uint16);
    function takeRateUpdateDelayBlocks() external view returns (uint256);
    function DEFAULT_TAKE_RATE_BPS() external view returns (uint16);

    // S12: Global blocklist
    function isBlocked(address addr) external view returns (bool);
    // H-3 audit fix: strict variant — propagates curator revert instead of
    // fail-open. Settlement L1+ uses this so the fail-closed gate is reachable.
    function isBlockedStrict(address addr) external view returns (bool);

    // S12: Per-publisher allowlist
    function allowlistEnabled(address publisher) external view returns (bool);
    function isAllowedAdvertiser(address publisher, address advertiser) external view returns (bool);

    /// @notice Batch variant of setAllowedAdvertiser. Caps the array length
    ///         at MAX_ALLOWLIST_BATCH to keep one tx finishable inside the
    ///         block gas budget. Per-entry behaviour is identical to the
    ///         single-call form: emits AdvertiserAllowlistUpdated for each.
    function setAllowedAdvertisers(address[] calldata advertisers, bool[] calldata allowed) external;

    // Publisher profile (hot key + metadata hash)
    function relaySigner(address publisher) external view returns (address);
    function profileHash(address publisher) external view returns (bytes32);
    function setRelaySigner(address signer) external;
    function setProfile(bytes32 hash) external;

    // A3: AssuranceLevel — publisher self-declared capability signal.
    // 0 = Permissive (any path), 1 = PublisherSigned, 2 = DualSigned.
    // This is purely a discovery hint for SDKs/advertisers; on-chain
    // claim acceptance is decided by cryptographic proof on each batch,
    // not by this declaration. A publisher who actually cosigns L1/L2
    // claims will be accepted regardless of what they declare here.
    event PublisherMaxAssuranceSet(address indexed publisher, uint8 level);
    function publisherMaxAssurance(address publisher) external view returns (uint8);
    function setPublisherMaxAssurance(uint8 level) external;

    // PublisherTagMode — per-publisher lane selector for tag policy.
    // 0 = Curated, 1 = StakeGated, 2 = Any. Default 0.
    event PublisherTagModeSet(address indexed publisher, uint8 mode);
    function publisherTagMode(address publisher) external view returns (uint8);
    function setPublisherTagMode(uint8 mode) external;
}
