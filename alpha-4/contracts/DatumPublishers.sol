// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumOwnable.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumPublisherStake.sol";
import "./interfaces/IDatumBlocklistCurator.sol";

/// @title DatumPublishers
/// @notice Publisher registry and take rate management.
///         S5: Uses global DatumPauseRegistry (consistent with all other contracts).
///         S12: Global address blocklist + per-publisher advertiser allowlist.
///         Future: blocklist management may be opened to governance control before mainnet.
contract DatumPublishers is IDatumPublishers, ReentrancyGuard, DatumOwnable {
    uint16 public constant MIN_TAKE_RATE_BPS = 3000;
    uint16 public constant MAX_TAKE_RATE_BPS = 8000;
    uint16 public constant DEFAULT_TAKE_RATE_BPS = 5000;

    uint256 public takeRateUpdateDelayBlocks;
    IDatumPauseRegistry public immutable pauseRegistry;

    mapping(address => Publisher) private _publishers;

    // B2-fix: pluggable blocklist curator. Sole source of truth for the
    // address blocklist. The curator can be any contract implementing
    // IDatumBlocklistCurator (DAO, Council, reputation system, no-op, etc.).
    // Once `blocklistCuratorLocked` is flipped, owner can no longer change
    // the curator — censorship authority is permanently delegated.
    IDatumBlocklistCurator public blocklistCurator;
    bool public blocklistCuratorLocked;
    event BlocklistCuratorSet(address indexed curator);
    event BlocklistCuratorLocked();

    // S12: Per-publisher advertiser allowlist
    mapping(address => bool) public allowlistEnabled;
    mapping(address => mapping(address => bool)) private _allowedAdvertisers;

    // BM-7: Publisher SDK version hash (integrity verification)
    mapping(address => bytes32) public sdkVersionHash;

    // Publisher profile: hot relay signing key + IPFS metadata hash
    mapping(address => address) public relaySigner;
    mapping(address => bytes32) public profileHash;

    // A3: Self-declared capability — discovery hint for SDKs and advertisers,
    // not an on-chain gate. 0=Permissive, 1=PublisherSigned, 2=DualSigned.
    mapping(address => uint8) public publisherMaxAssurance;

    /// @notice Lane selector for the publisher's tag policy. Determines which
    ///         lane gates `setPublisherTags`:
    ///           0 = Curated     — `_isTagApproved` must return true
    ///           1 = StakeGated  — TagRegistry.isTagBonded must return true
    ///           2 = Any         — no lane gate (free-form bytes32)
    ///         Defaults to 0 (Curated) for safety. Per-publisher choice;
    ///         no governance involvement.
    mapping(address => uint8) public publisherTagMode;

    /// @notice Block at which the publisher last rotated their relay signer.
    ///         Used by the rotation cooldown so an attacker briefly holding the
    ///         old key cannot keep pace with quick rotations.
    mapping(address => uint256) public relaySignerRotatedBlock;
    /// @notice Minimum blocks between consecutive setRelaySigner calls per
    ///         publisher (~1 hour at 6 s blocks). Prevents rotation oscillation
    ///         that could mask a key compromise.
    uint256 public constant RELAY_SIGNER_ROTATION_COOLDOWN = 600;

    // Safe rollout: admission whitelist (owner-managed; whitelistMode=false = open registration)
    bool public whitelistMode;
    mapping(address => bool) public approved;
    /// @notice Cypherpunk one-way switch (alpha-4 audit pass 3.5). Once flipped
    ///         via lockWhitelistMode(), the owner can no longer toggle
    ///         whitelistMode back on or approve/unapprove publishers. Publisher
    ///         registration becomes permanently open (subject only to the
    ///         independent stake gate, which has its own R-L1 lock).
    bool public whitelistModeLocked;
    event WhitelistModeLocked();

    // Stake-gated registration: if stakeGate > 0, a publisher with staked() >= stakeGate
    // bypasses the whitelist check. address(0) = stake gate disabled.
    IDatumPublisherStake public publisherStake;
    uint256 public stakeGate;
    /// @notice R-L1: One-way switch. Once flipped via lockStakeGate(), the owner
    ///         can no longer swap publisherStake or stakeGate to a malicious
    ///         contract that returns inflated `staked()` for any caller.
    bool public stakeGateLocked;

    event AllowlistToggled(address indexed publisher, bool enabled);
    event AdvertiserAllowlistUpdated(address indexed publisher, address indexed advertiser, bool allowed);
    event SdkVersionRegistered(address indexed publisher, bytes32 hash);
    event WhitelistModeSet(bool enabled);
    event PublisherApprovalSet(address indexed publisher, bool isApproved);
    event StakeGateSet(address indexed stakeContract, uint256 threshold);
    event StakeGateLocked();

    constructor(uint256 _takeRateUpdateDelayBlocks, address _pauseRegistry) {
        require(_pauseRegistry != address(0), "E00");
        takeRateUpdateDelayBlocks = _takeRateUpdateDelayBlocks;
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.pausedCampaignCreation(), "P");
        _;
    }

    // -------------------------------------------------------------------------
    // Safe rollout: admission whitelist
    // -------------------------------------------------------------------------

    /// @notice Enable or disable whitelist-only publisher registration.
    /// @dev    Cypherpunk-locked: after `lockWhitelistMode()`, this setter
    ///         reverts. The protocol commits to permanently open registration.
    function setWhitelistMode(bool enabled) external onlyOwner {
        require(!whitelistModeLocked, "locked");
        whitelistMode = enabled;
        emit WhitelistModeSet(enabled);
    }

    /// @notice Approve or revoke a publisher address for registration in whitelist mode.
    /// @dev    Same lock as setWhitelistMode — once locked, the approval list
    ///         is frozen (it has no effect anyway when whitelistMode = false).
    function setApproved(address publisher, bool isApproved) external onlyOwner {
        require(!whitelistModeLocked, "locked");
        require(publisher != address(0), "E00");
        approved[publisher] = isApproved;
        emit PublisherApprovalSet(publisher, isApproved);
    }

    /// @notice Cypherpunk one-way switch: commit to permanently open publisher
    ///         registration. Requires whitelistMode == false at the moment of
    ///         locking, so the protocol can't be locked into a permanent
    ///         allow-list dictatorship. After this call, neither setWhitelistMode
    ///         nor setApproved can be called by the owner ever again.
    function lockWhitelistMode() external onlyOwner {
        require(!whitelistMode, "still enabled");
        require(!whitelistModeLocked, "already locked");
        whitelistModeLocked = true;
        emit WhitelistModeLocked();
    }

    /// @notice Set the stake contract and minimum stake threshold for registration bypass.
    ///         stakeContract == address(0) disables stake-gated bypass entirely.
    ///         threshold == 0 with a non-zero contract also disables (effectively open).
    /// @dev R-L1: Reverts after lockStakeGate() has been called.
    function setStakeGate(address stakeContract, uint256 threshold) external onlyOwner {
        require(!stakeGateLocked, "E01");
        publisherStake = IDatumPublisherStake(stakeContract);
        stakeGate = threshold;
        emit StakeGateSet(stakeContract, threshold);
    }

    /// @notice A9-fix (2026-05-12): hard ceiling at the moment of locking. Without
    ///         this, owner could call `setStakeGate(x, MAX_UINT)` then
    ///         `lockStakeGate()` to permanently block the stake-bypass route.
    ///         10000 DOT (10^14 planck) is roughly the deployer's expected
    ///         affordability floor; calibrate per network.
    uint256 public constant MAX_STAKE_GATE_AT_LOCK = 10**14;

    /// @notice R-L1: Freeze the stake-gate configuration permanently. After this
    ///         call, setStakeGate reverts. Owner should invoke once governance
    ///         has confirmed the wiring.
    function lockStakeGate() external onlyOwner {
        require(!stakeGateLocked, "E01");
        // A9-fix: enforce the gate is set to something a normal staker can hit.
        // Caller must lower the threshold below MAX_STAKE_GATE_AT_LOCK first.
        require(stakeGate <= MAX_STAKE_GATE_AT_LOCK, "gate too high at lock");
        stakeGateLocked = true;
        emit StakeGateLocked();
    }

    /// @inheritdoc IDatumPublishers
    function registerPublisher(uint16 takeRateBps) external nonReentrant whenNotPaused {
        // M-6 audit fix: fail-CLOSED. A flagged publisher can't register; a
        // curator that reverts must be repaired before registration resumes.
        // Liveness during brief curator outages is sacrificed to honest gate
        // semantics — better to delay one registration than to whitelist
        // anyone for the duration of a misconfiguration.
        if (address(blocklistCurator) != address(0)) {
            require(!blocklistCurator.isBlocked(msg.sender), "E62");
        }
        bool stakedEnough = address(publisherStake) != address(0) &&
            stakeGate > 0 &&
            publisherStake.staked(msg.sender) >= stakeGate;
        require(!whitelistMode || approved[msg.sender] || stakedEnough, "E79");
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

    /// @notice R-L2: Cancel a pending take rate update before the delay elapses.
    ///         Lets a publisher who queued the wrong rate drop it without
    ///         waiting out the delay window.
    function cancelPendingTakeRate() external whenNotPaused {
        Publisher storage pub = _publishers[msg.sender];
        require(pub.registered, "Not registered");
        require(pub.pendingTakeRateBps != 0, "No pending update");
        uint16 cancelled = pub.pendingTakeRateBps;
        pub.pendingTakeRateBps = 0;
        pub.takeRateEffectiveBlock = 0;
        emit PublisherTakeRateCancelled(msg.sender, cancelled);
    }

    function getPublisher(address publisher) external view returns (Publisher memory) {
        return _publishers[publisher];
    }

    function isRegisteredWithRate(address publisher) external view returns (bool, uint16) {
        Publisher storage p = _publishers[publisher];
        return (p.registered, p.takeRateBps);
    }

    // -------------------------------------------------------------------------
    // Blocklist (curator-managed)
    // -------------------------------------------------------------------------

    /// @notice B2: returns true iff the configured curator flags this address.
    ///         When curator is address(0), no addresses are blocked.
    ///         Fail-OPEN on curator revert (liveness over policy) — callers
    ///         that need fail-closed semantics (Settlement L1+) must use
    ///         `isBlockedStrict` instead.
    function isBlocked(address addr) external view returns (bool) {
        IDatumBlocklistCurator c = blocklistCurator;
        if (address(c) == address(0)) return false;
        try c.isBlocked(addr) returns (bool b) {
            return b;
        } catch {
            return false; // fail-open on curator reverts (liveness over policy)
        }
    }

    /// @notice H-3 audit fix: strict blocklist read. Propagates curator
    ///         reverts to the caller. Used by Settlement at AssuranceLevel ≥1
    ///         where the advertiser's cosig implies the blocklist is part of
    ///         the trust path and a silent fail-open contradicts that.
    function isBlockedStrict(address addr) external view returns (bool) {
        IDatumBlocklistCurator c = blocklistCurator;
        if (address(c) == address(0)) return false;
        // No try/catch — let the curator revert bubble.
        return c.isBlocked(addr);
    }

    /// @notice B2-fix: set the curator contract. Pass address(0) to disable.
    function setBlocklistCurator(address curator) external onlyOwner {
        require(!blocklistCuratorLocked, "curator-locked");
        blocklistCurator = IDatumBlocklistCurator(curator);
        emit BlocklistCuratorSet(curator);
    }

    /// @notice B2-fix: lock the curator permanently. After this, the owner can
    ///         no longer change the curator, block addresses, or process unblocks
    ///         — the curator is the sole censorship authority. Irreversible.
    function lockBlocklistCurator() external onlyOwner {
        require(!blocklistCuratorLocked, "already locked");
        blocklistCuratorLocked = true;
        emit BlocklistCuratorLocked();
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
    /// @dev Enforces a cooldown between rotations so an attacker briefly
    ///      controlling the old key can't sandwich a rotation event.
    function setRelaySigner(address signer) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        uint256 lastRotated = relaySignerRotatedBlock[msg.sender];
        require(
            lastRotated == 0 || block.number >= lastRotated + RELAY_SIGNER_ROTATION_COOLDOWN,
            "E22"
        );
        relaySigner[msg.sender] = signer;
        relaySignerRotatedBlock[msg.sender] = block.number;
        emit RelaySignerUpdated(msg.sender, signer);
    }

    /// @notice Set the IPFS CID (as bytes32) for publisher off-chain metadata.
    function setProfile(bytes32 hash) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        require(hash != bytes32(0), "E00");
        profileHash[msg.sender] = hash;
        emit ProfileUpdated(msg.sender, hash);
    }

    /// @notice A3: Self-declare the maximum AssuranceLevel this publisher
    ///         supports. Discovery signal only — claim acceptance is decided
    ///         per-batch by cryptographic proof. Lowering or raising is
    ///         permitted at any time; publishers can freely upgrade as they
    ///         build out cosign infrastructure or downgrade if they retire it.
    function setPublisherMaxAssurance(uint8 level) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        require(level <= 2, "E11");
        publisherMaxAssurance[msg.sender] = level;
        emit PublisherMaxAssuranceSet(msg.sender, level);
    }

    /// @notice Set the publisher's tag-policy lane. See `publisherTagMode`.
    function setPublisherTagMode(uint8 mode) external whenNotPaused {
        require(_publishers[msg.sender].registered, "Not registered");
        require(mode <= 2, "E11");
        publisherTagMode[msg.sender] = mode;
        emit PublisherTagModeSet(msg.sender, mode);
    }
}
