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

    // S12: Global address blocklist (owner-managed). Legacy path — OR-merged with
    // the curator. Deprecated by B2-fix in favor of the swappable curator below.
    mapping(address => bool) public blocked;

    // B2-fix (2026-05-12): pluggable blocklist curator. When non-zero, `isBlocked`
    // OR-merges the curator's verdict with the legacy `blocked[]` map. The
    // curator can be any contract implementing IDatumBlocklistCurator (DAO,
    // Council, reputation system, no-op, etc.). Once `blocklistCuratorLocked`
    // is flipped, owner can no longer change the curator and `blockAddress` /
    // `executeUnblock` revert — censorship authority is permanently delegated.
    IDatumBlocklistCurator public blocklistCurator;
    bool public blocklistCuratorLocked;
    event BlocklistCuratorSet(address indexed curator);
    event BlocklistCuratorLocked();

    // C-5: Timelock-gated unblock — unblock requires 48h delay, block is instant (protective)
    mapping(address => uint256) public pendingUnblockTime;  // 0 = no pending unblock
    uint256 public constant UNBLOCK_DELAY = 172800;  // 48 hours in seconds

    event UnblockProposed(address indexed addr, uint256 effectiveTime);
    event UnblockCancelled(address indexed addr);

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

    // Stake-gated registration: if stakeGate > 0, a publisher with staked() >= stakeGate
    // bypasses the whitelist check. address(0) = stake gate disabled.
    IDatumPublisherStake public publisherStake;
    uint256 public stakeGate;
    /// @notice R-L1: One-way switch. Once flipped via lockStakeGate(), the owner
    ///         can no longer swap publisherStake or stakeGate to a malicious
    ///         contract that returns inflated `staked()` for any caller.
    bool public stakeGateLocked;

    event AddressBlocked(address indexed addr);
    event AddressUnblocked(address indexed addr);
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
        require(!blocked[msg.sender], "E62");
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
    // S12: Global blocklist (owner-managed)
    // -------------------------------------------------------------------------

    /// @notice Instantly block an address (protective action — no delay needed).
    /// @dev B2-fix: reverts once the curator is locked. Censorship authority
    ///      transfers fully to the curator at that point.
    function blockAddress(address addr) external onlyOwner {
        require(!blocklistCuratorLocked, "curator-locked");
        require(addr != address(0), "E00");
        blocked[addr] = true;
        // Cancel any pending unblock for this address
        if (pendingUnblockTime[addr] != 0) {
            pendingUnblockTime[addr] = 0;
            emit UnblockCancelled(addr);
        }
        emit AddressBlocked(addr);
    }

    /// @notice C-5: Propose unblocking an address. Takes effect after UNBLOCK_DELAY.
    function proposeUnblock(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(blocked[addr], "E01");
        pendingUnblockTime[addr] = block.timestamp + UNBLOCK_DELAY;
        emit UnblockProposed(addr, pendingUnblockTime[addr]);
    }

    /// @notice C-5: Execute a pending unblock after the delay has elapsed.
    /// @dev B2-fix: once curator is locked, the owner cannot unblock legacy
    ///      entries (curator becomes the sole authority). Pre-lock unblocks
    ///      remain available so deployer can drain the legacy map before
    ///      delegating fully.
    function executeUnblock(address addr) external onlyOwner {
        require(!blocklistCuratorLocked, "curator-locked");
        require(addr != address(0), "E00");
        require(pendingUnblockTime[addr] != 0, "E01");
        require(block.timestamp >= pendingUnblockTime[addr], "E37");
        pendingUnblockTime[addr] = 0;
        blocked[addr] = false;
        emit AddressUnblocked(addr);
    }

    /// @notice Cancel a pending unblock.
    function cancelUnblock(address addr) external onlyOwner {
        require(pendingUnblockTime[addr] != 0, "E01");
        pendingUnblockTime[addr] = 0;
        emit UnblockCancelled(addr);
    }

    /// @notice B2-fix: returns true if EITHER the legacy `blocked[]` map flags
    ///         this address OR the configured curator does. When curator is
    ///         address(0), only the legacy map is consulted (back-compat).
    ///         Once the deployer transitions to a real curator and calls
    ///         lockBlocklistCurator, the curator becomes the sole authority and
    ///         the legacy map is frozen (no new entries possible).
    function isBlocked(address addr) external view returns (bool) {
        if (blocked[addr]) return true;
        IDatumBlocklistCurator c = blocklistCurator;
        if (address(c) == address(0)) return false;
        try c.isBlocked(addr) returns (bool b) {
            return b;
        } catch {
            return false; // fail-open on curator reverts (liveness over policy)
        }
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
}
