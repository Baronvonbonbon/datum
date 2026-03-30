// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title DatumPublishers
/// @notice Publisher registry and take rate management.
///         S5: Uses global DatumPauseRegistry (consistent with all other contracts).
///         S12: Global address blocklist + per-publisher advertiser allowlist.
///         Future: blocklist management may be opened to governance control before mainnet.
contract DatumPublishers is IDatumPublishers, ReentrancyGuard, Ownable {
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

    event AddressBlocked(address indexed addr);
    event AddressUnblocked(address indexed addr);
    event AllowlistToggled(address indexed publisher, bool enabled);
    event AdvertiserAllowlistUpdated(address indexed publisher, address indexed advertiser, bool allowed);
    event SdkVersionRegistered(address indexed publisher, bytes32 hash);

    constructor(uint256 _takeRateUpdateDelayBlocks, address _pauseRegistry) Ownable(msg.sender) {
        require(_pauseRegistry != address(0), "E00");
        takeRateUpdateDelayBlocks = _takeRateUpdateDelayBlocks;
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.paused(), "P");
        _;
    }

    /// @inheritdoc IDatumPublishers
    function registerPublisher(uint16 takeRateBps) external nonReentrant whenNotPaused {
        require(!blocked[msg.sender], "E62");
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
            categoryBitmask: 0,
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

    /// @inheritdoc IDatumPublishers
    function setCategories(uint256 bitmask) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        _publishers[msg.sender].categoryBitmask = bitmask;
        emit CategoriesUpdated(msg.sender, bitmask);
    }

    function getPublisher(address publisher) external view returns (Publisher memory) {
        return _publishers[publisher];
    }

    function getCategories(address publisher) external view returns (uint256) {
        return _publishers[publisher].categoryBitmask;
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
}
