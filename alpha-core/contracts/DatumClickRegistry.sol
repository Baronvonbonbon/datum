// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
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
contract DatumClickRegistry is IDatumClickRegistry, DatumUpgradable {
    function version() public pure virtual override returns (uint256) { return 1; }

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
    function lockPlumbing() external onlyOwner whenOpenGovPhase {
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
    ) external whenNotFrozen {
        require(msg.sender == relay, "E25");
        bytes32 sh = _sessionHash(user, campaignId, impressionNonce);
        require(_effectiveStatus(user, campaignId, impressionNonce, sh) == 0, "E90"); // not recorded anywhere
        _sessions[sh] = 1;
        emit ClickRecorded(sh, user, campaignId);
    }

    /// @inheritdoc IDatumClickRegistry
    function markClaimed(
        address user,
        uint256 campaignId,
        bytes32 impressionNonce
    ) external whenNotFrozen {
        require(msg.sender == settlement, "E25");
        bytes32 sh = _sessionHash(user, campaignId, impressionNonce);
        require(_effectiveStatus(user, campaignId, impressionNonce, sh) == 1, "E90"); // recorded + unclaimed (here or in a predecessor)
        _sessions[sh] = 2; // claim locally; claimed status overrides a predecessor's "1"
        emit ClickClaimed(sh);
    }

    /// @inheritdoc IDatumClickRegistry
    function hasUnclaimed(
        address user,
        uint256 campaignId,
        bytes32 impressionNonce
    ) external view returns (bool) {
        bytes32 sh = _sessionHash(user, campaignId, impressionNonce);
        return _effectiveStatus(user, campaignId, impressionNonce, sh) == 1;
    }

    /// @notice Chained raw session status by hash: 0=none, 1=recorded, 2=claimed.
    ///         Walks the predecessor chain (successors call this when chaining on
    ///         a fix-carrying predecessor). Hash-only, so it can only chain to
    ///         predecessors that also expose `sessionStatus`.
    function sessionStatus(bytes32 sh) public view returns (uint8) {
        uint8 local = _sessions[sh];
        if (local != 0) return local;
        address pred = migrationSource;
        if (pred == address(0)) return 0;
        try DatumClickRegistry(pred).sessionStatus(sh) returns (uint8 s) { return s; } catch { return 0; }
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

    // -------------------------------------------------------------------------
    // Upgrade migration (predecessor-chain — sessions are append-only state)
    // -------------------------------------------------------------------------

    /// @dev Sessions are not copied; a successor consults the frozen predecessor
    ///      on a local miss. `migrate()` records `migrationSource`; only the
    ///      scalar refs are re-wired (relay/settlement) on the fresh contract.
    function _migrate(address) internal override {}

    /// @dev Effective status across the chain, given the decomposed session
    ///      args. Prefers the predecessor's chained `sessionStatus(sh)` (a
    ///      fix-carrying predecessor); for a PRE-FIX deployed predecessor that
    ///      only exposes `hasUnclaimed(user,campaignId,nonce)`, falls back to it.
    ///      CAVEAT: a CLAIMED (status 2) session in such a pre-fix predecessor is
    ///      invisible to this fallback (hasUnclaimed only reports status==1), so
    ///      it could be re-recorded post-upgrade. Settlement-level replay guards
    ///      (nullifiers / per-claim checks) bound the impact; every upgrade after
    ///      the first chains on raw status and is fully precise.
    function _effectiveStatus(
        address user,
        uint256 campaignId,
        bytes32 impressionNonce,
        bytes32 sh
    ) internal view returns (uint8) {
        uint8 local = _sessions[sh];
        if (local != 0) return local;
        address pred = migrationSource;
        if (pred == address(0)) return 0;
        try DatumClickRegistry(pred).sessionStatus(sh) returns (uint8 s) {
            return s;
        } catch {
            if (IDatumClickRegistry(pred).hasUnclaimed(user, campaignId, impressionNonce)) return 1;
            return 0;
        }
    }
}
