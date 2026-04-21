// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title DatumPublishers
/// @notice Publisher registry and take rate management.
///         S5: Uses global DatumPauseRegistry (consistent with all other contracts).
///         S12: Global address blocklist + per-publisher advertiser allowlist.
///         Future: blocklist management may be opened to governance control before mainnet.
contract DatumPublishers is IDatumPublishers, ReentrancyGuard, Ownable2Step {
    uint16 public constant MIN_TAKE_RATE_BPS = 3000;
    uint16 public constant MAX_TAKE_RATE_BPS = 8000;
    uint16 public constant DEFAULT_TAKE_RATE_BPS = 5000;

    uint256 public takeRateUpdateDelayBlocks;
    IDatumPauseRegistry public pauseRegistry;

    mapping(address => Publisher) private _publishers;

    // S12: Global address blocklist (owner-managed, timelock-gated pre-mainnet)
    mapping(address => bool) public blocked;

    // S12: Per-publisher advertiser allowlist
    mapping(address => bool) public allowlistEnabled;
    mapping(address => mapping(address => bool)) private _allowedAdvertisers;

    // BM-7: Publisher SDK version hash (integrity verification)
    mapping(address => bytes32) public sdkVersionHash;

    // Publisher profile: hot relay signing key + IPFS metadata hash
    mapping(address => address) public relaySigner;
    mapping(address => bytes32) public profileHash;

    // Safe rollout: admission whitelist (owner-managed; whitelistMode=false = open registration)
    bool public whitelistMode;
    mapping(address => bool) public approved;

    event AddressBlocked(address indexed addr);
    event AddressUnblocked(address indexed addr);
    event AllowlistToggled(address indexed publisher, bool enabled);
    event AdvertiserAllowlistUpdated(address indexed publisher, address indexed advertiser, bool allowed);
    event SdkVersionRegistered(address indexed publisher, bytes32 hash);
    event WhitelistModeSet(bool enabled);
    event PublisherApprovalSet(address indexed publisher, bool isApproved);

    constructor(uint256 _takeRateUpdateDelayBlocks, address _pauseRegistry) Ownable(msg.sender) {
        require(_pauseRegistry != address(0), "E00");
        takeRateUpdateDelayBlocks = _takeRateUpdateDelayBlocks;
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.paused(), "P");
        _;
    }

    // -------------------------------------------------------------------------
    // Safe rollout: admission whitelist
    // -------------------------------------------------------------------------

    /// @notice Enable or disable whitelist-only publisher registration.
    function setWhitelistMode(bool enabled) external onlyOwner {
        whitelistMode = enabled;
        emit WhitelistModeSet(enabled);
    }

    /// @notice Approve or revoke a publisher address for registration in whitelist mode.
    function setApproved(address publisher, bool isApproved) external onlyOwner {
        require(publisher != address(0), "E00");
        approved[publisher] = isApproved;
        emit PublisherApprovalSet(publisher, isApproved);
    }

    /// @inheritdoc IDatumPublishers
    function registerPublisher(uint16 takeRateBps) external nonReentrant whenNotPaused {
        require(!blocked[msg.sender], "E62");
        require(!whitelistMode || approved[msg.sender], "E79");
        require(!_publishers[msg.sender].registered, "Already registered");
        require(
            takeRateBps >= MIN_TAKE_RATE_BPS && takeRateBps <= MAX_TAKE_RATE_BPS,
            "Take rate out of range"
        );

        _publishers[msg.sender] = Publisher({
            addr: msg.sender,
            takeRateBps: takeRateBps,
            pendingTakeRateBps: 0,
            takeRateEffectiveBlock: 0,
            registered: true
        });

        emit PublisherRegistered(msg.sender, takeRateBps);
    }

    /// @inheritdoc IDatumPublishers
    function updateTakeRate(uint16 newTakeRateBps) external nonReentrant whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        require(
            newTakeRateBps >= MIN_TAKE_RATE_BPS && newTakeRateBps <= MAX_TAKE_RATE_BPS,
            "Take rate out of range"
        );
        require(newTakeRateBps != _publishers[msg.sender].takeRateBps, "E15");
        // AUDIT-016: Prevent overwriting a pending update that hasn't been applied yet
        require(_publishers[msg.sender].pendingTakeRateBps == 0, "E78");

        Publisher storage pub = _publishers[msg.sender];
        pub.pendingTakeRateBps = newTakeRateBps;
        pub.takeRateEffectiveBlock = block.number + takeRateUpdateDelayBlocks;

        emit PublisherTakeRateQueued(msg.sender, newTakeRateBps, pub.takeRateEffectiveBlock);
    }

    /// @inheritdoc IDatumPublishers
    function applyTakeRateUpdate() external nonReentrant whenNotPaused {
        Publisher storage pub = _publishers[msg.sender];
        require(pub.registered, "Not registered");
        require(pub.pendingTakeRateBps != 0, "No pending update");
        require(block.number >= pub.takeRateEffectiveBlock, "Delay not elapsed");

        pub.takeRateBps = pub.pendingTakeRateBps;
        pub.pendingTakeRateBps = 0;
        pub.takeRateEffectiveBlock = 0;

        emit PublisherTakeRateApplied(msg.sender, pub.takeRateBps);
    }

    function getPublisher(address publisher) external view returns (Publisher memory) {
        return _publishers[publisher];
    }

    function isRegisteredWithRate(address publisher) external view returns (bool, uint16) {
        Publisher storage p = _publishers[publisher];
        return (p.registered, p.takeRateBps);
    }

    // -------------------------------------------------------------------------
    // S12: Global blocklist (owner-managed)
    // -------------------------------------------------------------------------

    function blockAddress(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        blocked[addr] = true;
        emit AddressBlocked(addr);
    }

    function unblockAddress(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        blocked[addr] = false;
        emit AddressUnblocked(addr);
    }

    function isBlocked(address addr) external view returns (bool) {
        return blocked[addr];
    }

    // -------------------------------------------------------------------------
    // S12: Per-publisher advertiser allowlist
    // -------------------------------------------------------------------------

    function setAllowlistEnabled(bool enabled) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        allowlistEnabled[msg.sender] = enabled;
        emit AllowlistToggled(msg.sender, enabled);
    }

    function setAllowedAdvertiser(address advertiser, bool allowed) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        require(advertiser != address(0), "E00");
        _allowedAdvertisers[msg.sender][advertiser] = allowed;
        emit AdvertiserAllowlistUpdated(msg.sender, advertiser, allowed);
    }

    function isAllowedAdvertiser(address publisher, address advertiser) external view returns (bool) {
        return _allowedAdvertisers[publisher][advertiser];
    }

    // -------------------------------------------------------------------------
    // BM-7: SDK version registry (integrity verification)
    // -------------------------------------------------------------------------

    function registerSdkVersion(bytes32 hash) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        require(hash != bytes32(0), "E00");
        sdkVersionHash[msg.sender] = hash;
        emit SdkVersionRegistered(msg.sender, hash);
    }

    function getSdkVersion(address publisher) external view returns (bytes32) {
        return sdkVersionHash[publisher];
    }

    // -------------------------------------------------------------------------
    // Publisher profile: relay signer + IPFS metadata hash
    // -------------------------------------------------------------------------

    /// @notice Set (or clear) the relay signing key for this publisher.
    ///         signer == address(0) clears the relay signer (falls back to publisher wallet).
    function setRelaySigner(address signer) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        relaySigner[msg.sender] = signer;
        emit RelaySignerUpdated(msg.sender, signer);
    }

    /// @notice Set the IPFS CID (as bytes32) for publisher off-chain metadata.
    function setProfile(bytes32 hash) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        require(hash != bytes32(0), "E00");
        profileHash[msg.sender] = hash;
        emit ProfileUpdated(msg.sender, hash);
    }
}
