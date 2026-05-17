// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "./interfaces/IDatumPeopleChainIdentity.sol";

/// @title DatumPeopleChainIdentity
/// @notice On-chain cache of Polkadot People Chain identity verification state.
///
///         ## Architectural rationale
///
///         People Chain lives on a separate system parachain from Polkadot Hub
///         (where pallet-revive runs our EVM bytecode). A synchronous cross-chain
///         lookup from inside `DatumSettlement._processBatch` is not feasible
///         today: pallet-revive does not yet expose a synchronous XCM-Query
///         precompile, and even when it does, blocking settlement on a
///         cross-chain round-trip would gate user payouts on People Chain
///         liveness — a textbook anti-pattern.
///
///         We therefore use the **request / response cache** pattern: the
///         canonical source of truth remains People Chain, but a per-user
///         snapshot lives here with an expiry block. Settlement only reads the
///         snapshot. There are two write paths:
///
///         1. **XCM-Response path (target)** — once a trusted XCM dispatcher
///            precompile is wired on pallet-revive, the People Chain runtime
///            (or a permissionless requester via XCM) delivers a `Transact`
///            call into `submitAttestation` proving the user's current
///            judgement. The dispatcher address holds the role bit
///            `WRITER_XCM`.
///
///         2. **Oracle bridge path (today)** — an EOA the deployer designates
///            (the `oracleReporter`) reads People Chain identity state off-chain
///            and writes it here. This is the same pattern as the existing
///            reputation reporter and is deployable on Paseo today. The owner
///            can `lockOracleReporter()` to permanently disable this path once
///            the XCM dispatcher is live, making the cache fully trustless.
///
///         Both paths terminate in the same `_setRecord` internal call. The
///         interface to Settlement (`isVerified`) is identical regardless of
///         which writer produced the record — keeping the gate logic simple
///         and the upgrade path one-way.
///
///         ## User-side controls
///
///         - `forgetMe()` lets any user purge their own cached record. Useful
///           after revoking identity on People Chain, or for users who object
///           to the cache existing even though it's public info.
///         - There is no mechanism for any other party to delete a user's
///           record — expiry is the only other removal path.
///
///         ## Levels
///
///         Mirrors People Chain registrar judgments:
///           0 = None / Unknown
///           1 = Reasonable
///           2 = KnownGood
///
///         Levels are monotone: a `minLevel` check passes for any record at or
///         above the threshold (KnownGood satisfies a Reasonable-floor gate).
contract DatumPeopleChainIdentity is IDatumPeopleChainIdentity, DatumOwnable {
    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    /// @dev Per-user cached record.
    mapping(address => IdentityRecord) private _records;

    /// @notice Off-chain EOA bridge writer. Address(0) disables this path.
    /// @dev    Set by owner; one-way disabled via `lockOracleReporter`.
    address public oracleReporter;

    /// @notice Permanently disables the oracle-bridge writer path. Once true,
    ///         only the XCM dispatcher can submit attestations. One-way.
    bool public oracleReporterLocked;

    /// @notice Future-facing XCM dispatcher (a pallet-revive precompile or
    ///         a trusted relayer contract that wraps People Chain XCM
    ///         responses). Address(0) until pallet-revive ships the XCM
    ///         primitive we need.
    address public xcmDispatcher;

    /// @notice One-way lock that prevents post-deploy rotation of the XCM
    ///         dispatcher. Set true after Paseo testnet validation; mainnet
    ///         deploys assert this is true before the first settlement.
    bool public xcmDispatcherLocked;

    /// @notice Default validity window (in Hub blocks) used when a writer
    ///         submits without an explicit `validityBlocks`. Defaults to
    ///         ~7 days (100,800 @ 6s blocks). Owner-tunable, bounded.
    uint64 public defaultValidityBlocks = 100_800;

    /// @notice Hard floor & ceiling on `validityBlocks` writes. The floor stops
    ///         a malicious writer from filing one-block records that flap;
    ///         the ceiling keeps stale records from outlasting realistic
    ///         identity-judgment timescales on People Chain.
    uint64 public constant MIN_VALIDITY_BLOCKS = 600;        // ~1 hour
    uint64 public constant MAX_VALIDITY_BLOCKS = 1_440_000;  // ~100 days

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event OracleReporterSet(address indexed reporter);
    event OracleReporterLocked();
    event XcmDispatcherSet(address indexed dispatcher);
    event XcmDispatcherLocked();
    event DefaultValidityBlocksSet(uint64 blocks);

    /// @notice Emitted on every accepted attestation write (XCM or oracle).
    event IdentityAttested(
        address indexed user,
        uint8           level,
        uint64          expiryBlock,
        address         writer
    );

    /// @notice Emitted when a user purges their own record via `forgetMe`.
    event IdentityForgotten(address indexed user);

    /// @notice Emitted on `requestIdentityRefresh`. Off-chain bridges watch
    ///         this to know when to re-query People Chain and post a refresh.
    ///         Anyone can emit (no auth) — it costs gas and is purely an
    ///         off-chain signal. Once the XCM dispatcher is live, this event
    ///         can be replaced by a direct on-chain XCM-query call.
    event IdentityRefreshRequested(address indexed user, address indexed requester);

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setOracleReporter(address reporter) external onlyOwner {
        require(!oracleReporterLocked, "locked");
        oracleReporter = reporter;
        emit OracleReporterSet(reporter);
    }

    /// @notice One-way lock that permanently disables the oracle-bridge path,
    ///         leaving the XCM dispatcher as the sole writer. Call this once
    ///         the XCM dispatcher is wired and proven on mainnet.
    function lockOracleReporter() external onlyOwner {
        oracleReporterLocked = true;
        oracleReporter = address(0);
        emit OracleReporterLocked();
    }

    function setXcmDispatcher(address dispatcher) external onlyOwner {
        require(!xcmDispatcherLocked, "dispatcher-locked");
        xcmDispatcher = dispatcher;
        emit XcmDispatcherSet(dispatcher);
    }

    /// @notice One-way lock that pins the XCM dispatcher permanently.
    ///         Call after Paseo testnet ratifies the dispatcher → cache
    ///         flow. Pairs with lockOracleReporter for full trustlessness.
    function lockXcmDispatcher() external onlyOwner {
        require(xcmDispatcher != address(0), "E00");
        xcmDispatcherLocked = true;
        emit XcmDispatcherLocked();
    }

    function setDefaultValidityBlocks(uint64 blocks_) external onlyOwner {
        require(blocks_ >= MIN_VALIDITY_BLOCKS && blocks_ <= MAX_VALIDITY_BLOCKS, "E11");
        defaultValidityBlocks = blocks_;
        emit DefaultValidityBlocksSet(blocks_);
    }

    // -------------------------------------------------------------------------
    // Writer paths
    // -------------------------------------------------------------------------

    /// @notice Submit an attestation for `user`. Callable by either configured
    ///         writer (XCM dispatcher OR oracle reporter). `validityBlocks` of
    ///         zero uses the configured default.
    ///
    ///         level must be in [0, 2]. level=0 with any validity acts as an
    ///         explicit "no verification on file" stamp — useful for the bridge
    ///         to clear lapsed records without waiting for expiry.
    function submitAttestation(
        address user,
        uint8   level,
        uint64  validityBlocks
    ) external {
        require(
            (xcmDispatcher != address(0) && msg.sender == xcmDispatcher) ||
            (oracleReporter != address(0) && msg.sender == oracleReporter),
            "E18"
        );
        require(user != address(0), "E00");
        require(level <= 2, "E11");

        uint64 vb = validityBlocks == 0 ? defaultValidityBlocks : validityBlocks;
        require(vb >= MIN_VALIDITY_BLOCKS && vb <= MAX_VALIDITY_BLOCKS, "E11");

        _setRecord(user, level, vb);
    }

    /// @notice Batch variant for bridges that catch up on many users at once.
    ///         Same per-entry semantics as `submitAttestation`.
    function submitAttestationBatch(
        address[] calldata users,
        uint8[]   calldata levels,
        uint64[]  calldata validityBlocksArr
    ) external {
        require(
            (xcmDispatcher != address(0) && msg.sender == xcmDispatcher) ||
            (oracleReporter != address(0) && msg.sender == oracleReporter),
            "E18"
        );
        uint256 n = users.length;
        require(n == levels.length && n == validityBlocksArr.length, "E11");
        require(n > 0 && n <= 64, "E11");

        for (uint256 i = 0; i < n; i++) {
            address u = users[i];
            uint8   l = levels[i];
            uint64  vb = validityBlocksArr[i] == 0 ? defaultValidityBlocks : validityBlocksArr[i];
            require(u != address(0), "E00");
            require(l <= 2, "E11");
            require(vb >= MIN_VALIDITY_BLOCKS && vb <= MAX_VALIDITY_BLOCKS, "E11");
            _setRecord(u, l, vb);
        }
    }

    function _setRecord(address user, uint8 level, uint64 validityBlocks) internal {
        uint64 expiry = uint64(block.number) + validityBlocks;
        _records[user] = IdentityRecord({
            level: level,
            expiryBlock: expiry,
            lastUpdatedBlock: uint64(block.number)
        });
        emit IdentityAttested(user, level, expiry, msg.sender);
    }

    // -------------------------------------------------------------------------
    // User self-actions
    // -------------------------------------------------------------------------

    /// @notice Caller purges their own cached record. After this, `isVerified`
    ///         returns false until a writer re-attests.
    function forgetMe() external {
        delete _records[msg.sender];
        emit IdentityForgotten(msg.sender);
    }

    /// @notice Off-chain signal that someone wants `user`'s record refreshed.
    ///         Pure event — no state changes, no auth. Bridges/oracles watch
    ///         these to know when to spend the query budget on a re-attest.
    ///         When pallet-revive ships a permissionless XCM-query primitive,
    ///         this becomes a real cross-chain call.
    function requestIdentityRefresh(address user) external {
        require(user != address(0), "E00");
        emit IdentityRefreshRequested(user, msg.sender);
    }

    // -------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumPeopleChainIdentity
    function isVerified(address user, uint8 minLevel) external view override returns (bool) {
        if (minLevel == 0) return true; // gate disabled at level 0
        IdentityRecord storage r = _records[user];
        if (r.level < minLevel) return false;
        if (block.number >= r.expiryBlock) return false;
        return true;
    }

    /// @inheritdoc IDatumPeopleChainIdentity
    function getIdentity(address user) external view override returns (IdentityRecord memory) {
        IdentityRecord storage r = _records[user];
        // Return zeroed record if expired so callers don't see stale level/expiry.
        if (block.number >= r.expiryBlock) {
            return IdentityRecord({level: 0, expiryBlock: 0, lastUpdatedBlock: r.lastUpdatedBlock});
        }
        return r;
    }

    /// @inheritdoc IDatumPeopleChainIdentity
    function expiryBlock(address user) external view override returns (uint64) {
        return _records[user].expiryBlock;
    }
}
