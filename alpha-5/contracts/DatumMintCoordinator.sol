// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./lib/ParameterRetuneGuard.sol";
import "./interfaces/IDatumMintCoordinator.sol";

/// @dev Inline interface to the optional Path-H emission engine.
///      Kept minimal: Settlement (now MintCoordinator) only needs one fn.
interface IEmissionEngine {
    function computeAndClipMint(uint256 dotPaid) external returns (uint256 effective);
}

/// @dev Inline interface to DatumMintAuthority's settlement entry point.
interface IMintAuthority {
    function mintForSettlement(
        address user, uint256 userAmt,
        address publisher, uint256 publisherAmt,
        address advertiser, uint256 advertiserAmt
    ) external;
}

/// @title  DatumMintCoordinator
/// @notice Carve-out of DATUM-token emission orchestration. Previously the
///         ~36-line inline mint block inside DatumSettlement._processBatch,
///         plus the supporting state and setters. Settlement now calls
///         `coordinate` once per batch and the coordinator owns:
///           - the MintAuthority pointer (lock-once),
///           - the optional Path-H EmissionEngine pointer (lock-once),
///           - the legacy flat-rate fallback (`mintRatePerDot`),
///           - the dust gate (`dustMintThreshold`),
///           - the user / publisher / advertiser DATUM split bps.
///
/// @dev    Per-batch cost (not per-claim): the orchestration runs exactly
///         once at the end of `_processBatch` after the inner loop, so
///         carving it out adds a single external call per settled batch.
contract DatumMintCoordinator is IDatumMintCoordinator, DatumUpgradable, ParameterRetuneGuard {
    function version() public pure override returns (uint256) { return 1; }

    /// @notice F-031 fix (2026-05-20): per-key retune cooldown setter.
    function setRetuneCooldownBlocks(uint256 blocks_) external onlyOwner {
        _setRetuneCooldownBlocks(blocks_);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Settlement contract permitted to invoke `coordinate`. The
    ///         pointer is lock-once via `plumbingLocked`.
    address public settlement;
    bool public plumbingLocked;

    // ─────────────────────────────────────────────────────────────────────
    // Emission targets (each lock-once)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice MintAuthority that issues WDATUM on behalf of the protocol.
    ///         Zero-address disables the mint flow entirely (coordinator
    ///         returns early). Lock-once.
    address public mintAuthority;

    /// @notice Optional Path-H emission engine. When non-zero, the engine
    ///         computes the per-batch mint with dynamic-rate adaptation +
    ///         daily-cap and epoch-budget clipping. Otherwise the legacy
    ///         flat-rate fallback (`mintRatePerDot`) is used. Lock-once.
    address public emissionEngine;

    // ─────────────────────────────────────────────────────────────────────
    // Parameters
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Legacy flat-rate fallback used until `emissionEngine` is wired.
    ///         Owner-tunable within `MAX_MINT_RATE`. Bootstrap value
    ///         19 DATUM/DOT in 10-decimal base.
    uint256 public mintRatePerDot = 19 * 10**10;

    /// @notice Hard ceiling on `mintRatePerDot`. The engine path enforces
    ///         its own ceiling.
    uint256 public constant MAX_MINT_RATE = 100 * 10**10;

    /// @notice Skip the mint entirely when totalMint < threshold.
    ///         Default 0.01 DATUM (1e8 base units).
    uint256 public dustMintThreshold = 10**8;

    /// @notice Per-actor DATUM split bps. Sum must equal 10000. Defaults
    ///         match TOKENOMICS §3.3: 55 / 40 / 5.
    uint16 public datumRewardUserBps       = 5500;
    uint16 public datumRewardPublisherBps  = 4000;
    uint16 public datumRewardAdvertiserBps =  500;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event SettlementSet(address indexed settlement);
    event PlumbingLocked();
    event MintAuthoritySet(address indexed authority);
    event EmissionEngineSet(address indexed engine);
    event MintRateUpdated(uint256 oldRate, uint256 newRate);
    event DustMintThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event DatumRewardSplitSet(uint16 userBps, uint16 publisherBps, uint16 advertiserBps);
    event DatumMintFailed(address indexed user, address indexed publisher, address indexed advertiser, uint256 totalMint);

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E11();
    error OnlySettlement();
    error LockedAlready();
    error AlreadySet();
    error AboveCap();

    // ─────────────────────────────────────────────────────────────────────
    // Wiring setters
    // ─────────────────────────────────────────────────────────────────────

    function setSettlement(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        settlement = addr;
        emit SettlementSet(addr);
    }

    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert LockedAlready();
        if (settlement == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Lock-once target setters
    // ─────────────────────────────────────────────────────────────────────

    function setMintAuthority(address authority) external onlyOwner {
        if (authority == address(0)) revert E00();
        if (mintAuthority != address(0)) revert AlreadySet();
        mintAuthority = authority;
        emit MintAuthoritySet(authority);
    }

    function setEmissionEngine(address engine) external onlyOwner {
        if (engine == address(0)) revert E00();
        if (emissionEngine != address(0)) revert AlreadySet();
        emissionEngine = engine;
        emit EmissionEngineSet(engine);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Tunable parameters
    // ─────────────────────────────────────────────────────────────────────

    function setMintRate(uint256 newRate) external onlyOwner whenNotFrozen {
        if (newRate > MAX_MINT_RATE) revert AboveCap();
        _guardRetune("mintRate"); // F-031: per-key retune cooldown
        uint256 old = mintRatePerDot;
        mintRatePerDot = newRate;
        emit MintRateUpdated(old, newRate);
    }

    function setDustMintThreshold(uint256 newThreshold) external onlyOwner whenNotFrozen {
        // Same ≤ 1 DATUM cap as before.
        if (newThreshold > 1 * 10**10) revert AboveCap();
        _guardRetune("dustMintThreshold");
        uint256 old = dustMintThreshold;
        dustMintThreshold = newThreshold;
        emit DustMintThresholdUpdated(old, newThreshold);
    }

    function setDatumRewardSplit(uint16 userBps, uint16 publisherBps, uint16 advertiserBps) external onlyOwner whenNotFrozen {
        if (uint256(userBps) + uint256(publisherBps) + uint256(advertiserBps) != 10000) revert E11();
        _guardRetune("datumRewardSplit");
        datumRewardUserBps = userBps;
        datumRewardPublisherBps = publisherBps;
        datumRewardAdvertiserBps = advertiserBps;
        emit DatumRewardSplitSet(userBps, publisherBps, advertiserBps);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Hot-path entry (per-batch, not per-claim)
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDatumMintCoordinator
    function coordinate(
        address user,
        address publisher,
        address advertiser,
        uint256 dotPaid
    ) external {
        if (msg.sender != settlement) revert OnlySettlement();
        if (mintAuthority == address(0) || dotPaid == 0) return;

        // ── Compute total mint ────────────────────────────────────────────
        uint256 totalMint;
        if (emissionEngine != address(0)) {
            // Path H: delegate to the engine. It clips against remaining
            // daily + epoch budgets and updates its own accumulators. If
            // the daily cap is exhausted it returns 0 and the dust gate
            // below silently skips the mint.
            try IEmissionEngine(emissionEngine).computeAndClipMint(dotPaid) returns (uint256 minted) {
                totalMint = minted;
            } catch {
                // Engine reverted (misconfigured); fail soft -- skip mint.
                totalMint = 0;
            }
        } else {
            // Legacy flat-rate fallback.
            totalMint = (dotPaid * mintRatePerDot) / (10**10);
        }
        if (totalMint < dustMintThreshold) return;

        // ── Split + mint ──────────────────────────────────────────────────
        uint256 userMint        = (totalMint * uint256(datumRewardUserBps))      / 10000;
        uint256 publisherMint   = (totalMint * uint256(datumRewardPublisherBps)) / 10000;
        // Advertiser slice absorbs any rounding drift so the sum stays exact.
        uint256 advertiserMint  = totalMint - userMint - publisherMint;

        // Authority enforces its own MINTABLE_CAP; we don't second-guess here.
        try IMintAuthority(mintAuthority).mintForSettlement(
            user,        userMint,
            publisher,   publisherMint,
            advertiser,  advertiserMint
        ) {} catch {
            // Non-critical: if the mint authority rejects (cap hit, etc.)
            // we don't want settlement to revert. Emit a signal for observers.
            emit DatumMintFailed(user, publisher, advertiser, totalMint);
        }
    }
}
